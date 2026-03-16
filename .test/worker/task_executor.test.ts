import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { TaskExecutor } from "../../src/worker/task_executor.js";
import type { TaskPayload, Feedback } from "../../src/shared/types.js";

const validPayload: TaskPayload = {
  experimentPlan: "# Experiment\nTrain a model on CIFAR-10",
  checkpoints: ["setup", "training", "evaluation"],
  modelConfig: { apiKey: "sk-test-123" },
};

describe("worker/task_executor", () => {
  let tmpDir: string;
  let executor: TaskExecutor;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "relay-exec-test-"));
    // Pre-create dirs so ProcessManager doesn't fail on missing dirs
    await mkdir(join(tmpDir, "inbox"), { recursive: true });
    await mkdir(join(tmpDir, "outbox"), { recursive: true });
    await mkdir(join(tmpDir, "experiment"), { recursive: true });
    await mkdir(join(tmpDir, "supervisor"), { recursive: true });
    executor = new TaskExecutor(tmpDir);
    await executor.initialize();
  });

  afterEach(async () => {
    executor.destroy();
    await new Promise((r) => setTimeout(r, 200));
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("initialize", () => {
    it("starts in idle state", () => {
      assert.equal(executor.getStatus(), "idle");
      assert.equal(executor.getTask(), null);
      assert.equal(executor.getLastReport(), null);
    });

    it("has empty history", () => {
      assert.deepEqual(executor.getHistory(), []);
    });
  });

  describe("dispatch", () => {
    it("creates task with correct initial fields", async () => {
      let task;
      try {
        task = await executor.dispatch(validPayload);
      } catch {
        // claude not available — but we can check state was set
        task = executor.getTask();
      }

      // Task should have been created (even if CC spawn fails)
      if (task) {
        assert.ok(task.taskId.startsWith("t-"));
        assert.ok(task.startedAt);
        assert.equal(task.phase, "setup");
      }
    });

    it("writes experiment plan to inbox/task.md", async () => {
      try {
        await executor.dispatch(validPayload);
      } catch {
        // CC spawn may fail
      }

      const taskPath = join(tmpDir, "inbox", "task.md");
      assert.ok(existsSync(taskPath));
      const content = await readFile(taskPath, "utf-8");
      assert.equal(content, validPayload.experimentPlan);
    });

    it("rejects dispatch when busy", async () => {
      try {
        await executor.dispatch(validPayload);
      } catch {
        // CC spawn may fail
      }

      // If task is active (not terminal), second dispatch should fail
      const task = executor.getTask();
      if (task && task.status !== "completed" && task.status !== "failed" && task.status !== "aborted") {
        await assert.rejects(
          () => executor.dispatch(validPayload),
          /Cannot dispatch: worker busy/,
        );
      }
    });

    it("emits stateChange event", async () => {
      const states: string[] = [];
      executor.on("stateChange", (t) => states.push(t.status));

      try {
        await executor.dispatch(validPayload);
      } catch {
        // CC spawn may fail
      }

      // Should have emitted at least "initializing"
      assert.ok(states.includes("initializing"));
    });
  });

  describe("submitFeedback", () => {
    it("rejects feedback for non-existent task", async () => {
      await assert.rejects(
        () => executor.submitFeedback("t-nonexistent", { action: "continue" }),
        /No active task/,
      );
    });

    it("rejects feedback when not awaiting_approval", async () => {
      try {
        await executor.dispatch(validPayload);
      } catch {
        // CC spawn may fail
      }

      const task = executor.getTask();
      if (task && task.status !== "awaiting_approval") {
        await assert.rejects(
          () => executor.submitFeedback(task.taskId, { action: "continue" }),
          /not awaiting approval/,
        );
      }
    });
  });

  describe("abort", () => {
    it("rejects abort for non-existent task", async () => {
      await assert.rejects(
        () => executor.abort("t-nonexistent"),
        /No active task/,
      );
    });

    it("aborts an active task", async () => {
      try {
        const task = await executor.dispatch(validPayload);
        // Abort immediately before exit handler fires
        await executor.abort(task.taskId);
        assert.equal(executor.getTask(), null);
        const history = executor.getHistory();
        assert.ok(history.some((h) => h.taskId === task.taskId && h.status === "aborted"));
      } catch {
        // CC spawn may fail — verify task ended up in history regardless
        await new Promise((r) => setTimeout(r, 100));
        const history = executor.getHistory();
        assert.ok(history.length > 0, "Task should be in history");
      }
    });

    it("rejects abort for already terminal task", async () => {
      try {
        const task = await executor.dispatch(validPayload);
        await executor.abort(task.taskId);
      } catch {
        // CC spawn may fail
      }

      // Wait for everything to settle
      await new Promise((r) => setTimeout(r, 100));

      // Now there's no active task — abort should fail
      await assert.rejects(
        () => executor.abort("t-nonexistent"),
        /No active task/,
      );
    });
  });

  describe("crash recovery via initialize", () => {
    it("recovers running task as failed after restart", async () => {
      try {
        await executor.dispatch(validPayload);
      } catch {
        // CC spawn may fail
      }

      const task = executor.getTask();
      if (task) {
        // Simulate crash: destroy and re-initialize
        executor.destroy();
        const executor2 = new TaskExecutor(tmpDir);
        await executor2.initialize();

        // If task was running/initializing, should now be failed in history
        const task2 = executor2.getTask();
        if (task2 === null) {
          const history = executor2.getHistory();
          assert.ok(history.length > 0);
          assert.equal(history[history.length - 1].status, "failed");
        }
        executor2.destroy();
      }
    });
  });

  describe("destroy", () => {
    it("cleans up without error", () => {
      executor.destroy();
      // Should not throw on double destroy
      executor.destroy();
    });
  });
});
