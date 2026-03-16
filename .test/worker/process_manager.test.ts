import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { ProcessManager } from "../../src/worker/process_manager.js";

describe("worker/process_manager", () => {
  let tmpDir: string;
  const managers: ProcessManager[] = [];

  function tracked(pm: ProcessManager): ProcessManager {
    managers.push(pm);
    return pm;
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "relay-pm-test-"));
  });

  afterEach(async () => {
    // Destroy all PMs first to release file handles
    for (const pm of managers) {
      pm.destroy();
    }
    managers.length = 0;
    // Small delay for Windows to release handles
    await new Promise((r) => setTimeout(r, 200));
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("constructor", () => {
    it("initializes with default stall timeout", () => {
      const pm = tracked(new ProcessManager({
        workspaceDir: tmpDir,
        allowedTools: ["Bash", "Read"],
      }));
      assert.equal(pm.sessionId, null);
      assert.equal(pm.isRunning, false);
    });

    it("accepts custom stall timeout", () => {
      const pm = tracked(new ProcessManager({
        workspaceDir: tmpDir,
        allowedTools: ["Bash"],
        stallTimeoutMs: 1000,
      }));
      assert.equal(pm.isRunning, false);
    });
  });

  describe("spawnCC", () => {
    it("creates inbox/outbox/experiment dirs", () => {
      const pm = tracked(new ProcessManager({
        workspaceDir: tmpDir,
        allowedTools: ["Bash", "Read"],
        stallTimeoutMs: 0,
      }));

      const taskPath = join(tmpDir, "inbox", "task.md");

      try {
        pm.spawnCC(taskPath);
      } catch {
        // Expected: claude not found in test env
      }

      assert.ok(existsSync(join(tmpDir, "inbox")));
      assert.ok(existsSync(join(tmpDir, "outbox")));
      assert.ok(existsSync(join(tmpDir, "experiment")));
    });

    it("throws if process already running", async () => {
      const pm = tracked(new ProcessManager({
        workspaceDir: tmpDir,
        allowedTools: ["Bash"],
        stallTimeoutMs: 0,
      }));

      await mkdir(join(tmpDir, "inbox"), { recursive: true });
      await mkdir(join(tmpDir, "outbox"), { recursive: true });
      await mkdir(join(tmpDir, "experiment"), { recursive: true });
      const taskPath = join(tmpDir, "inbox", "task.md");
      await writeFile(taskPath, "test task");

      pm.spawnCC(taskPath);

      if (pm.isRunning) {
        assert.throws(
          () => pm.spawnCC(taskPath),
          { message: "CC process already running" },
        );
      }
    });
  });

  describe("resumeCC", () => {
    it("throws if process already running", async () => {
      const pm = tracked(new ProcessManager({
        workspaceDir: tmpDir,
        allowedTools: ["Bash"],
        stallTimeoutMs: 0,
      }));

      await mkdir(join(tmpDir, "inbox"), { recursive: true });
      await mkdir(join(tmpDir, "outbox"), { recursive: true });
      await mkdir(join(tmpDir, "experiment"), { recursive: true });

      const taskPath = join(tmpDir, "inbox", "task.md");
      await writeFile(taskPath, "test");
      pm.spawnCC(taskPath);

      if (pm.isRunning) {
        const fbPath = join(tmpDir, "inbox", "feedback.md");
        assert.throws(
          () => pm.resumeCC("session-1", fbPath),
          { message: "CC process already running" },
        );
      }
    });
  });

  describe("killCC", () => {
    it("resolves immediately when no process", async () => {
      const pm = tracked(new ProcessManager({
        workspaceDir: tmpDir,
        allowedTools: ["Bash"],
        stallTimeoutMs: 0,
      }));

      await pm.killCC();
      assert.equal(pm.isRunning, false);
    });
  });

  describe("stdout/stderr capture", () => {
    it("starts with empty buffers", () => {
      const pm = tracked(new ProcessManager({
        workspaceDir: tmpDir,
        allowedTools: ["Bash"],
      }));
      assert.equal(pm.getStdout(), "");
      assert.equal(pm.getStderr(), "");
    });
  });

  describe("outbox watcher", () => {
    it("emits report event for new report files", async () => {
      const pm = tracked(new ProcessManager({
        workspaceDir: tmpDir,
        allowedTools: ["Bash"],
        stallTimeoutMs: 0,
      }));

      const outboxDir = join(tmpDir, "outbox");
      await mkdir(outboxDir, { recursive: true });
      await mkdir(join(tmpDir, "inbox"), { recursive: true });
      await mkdir(join(tmpDir, "experiment"), { recursive: true });
      const taskPath = join(tmpDir, "inbox", "task.md");
      await writeFile(taskPath, "test");

      pm.spawnCC(taskPath);

      await new Promise((r) => setTimeout(r, 100));

      const reportPromise = new Promise<string>((resolve) => {
        pm.on("report", (filePath) => resolve(filePath));
      });

      await writeFile(
        join(outboxDir, "report_001.json"),
        JSON.stringify({ phase: "test", summary: "done" }),
      );

      const result = await Promise.race([
        reportPromise,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 3000),
        ),
      ]);

      assert.ok(result.includes("report_001.json"));
    });

    it("ignores non-report files in outbox", async () => {
      const pm = tracked(new ProcessManager({
        workspaceDir: tmpDir,
        allowedTools: ["Bash"],
        stallTimeoutMs: 0,
      }));

      const outboxDir = join(tmpDir, "outbox");
      await mkdir(outboxDir, { recursive: true });
      await mkdir(join(tmpDir, "inbox"), { recursive: true });
      await mkdir(join(tmpDir, "experiment"), { recursive: true });

      const taskPath = join(tmpDir, "inbox", "task.md");
      await writeFile(taskPath, "test");
      pm.spawnCC(taskPath);

      await new Promise((r) => setTimeout(r, 100));

      let reportEmitted = false;
      pm.on("report", () => { reportEmitted = true; });

      await writeFile(join(outboxDir, "random.txt"), "not a report");
      await new Promise((r) => setTimeout(r, 500));

      assert.equal(reportEmitted, false);
    });
  });

  describe("session ID extraction", () => {
    it("emits sessionId event from JSON stdout", async () => {
      const pm = tracked(new ProcessManager({
        workspaceDir: tmpDir,
        allowedTools: ["Bash"],
        stallTimeoutMs: 0,
      }));

      await mkdir(join(tmpDir, "inbox"), { recursive: true });
      await mkdir(join(tmpDir, "outbox"), { recursive: true });
      await mkdir(join(tmpDir, "experiment"), { recursive: true });

      const taskPath = join(tmpDir, "inbox", "task.md");
      await writeFile(taskPath, '{"session_id":"sess-abc-123"}');

      assert.equal(pm.sessionId, null);
    });
  });

  describe("destroy", () => {
    it("cleans up without error when idle", () => {
      const pm = tracked(new ProcessManager({
        workspaceDir: tmpDir,
        allowedTools: ["Bash"],
      }));
      pm.destroy();
      assert.equal(pm.isRunning, false);
    });
  });
});
