import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskTracker } from "../../src/local/task_tracker.js";
import type { TaskInfo } from "../../src/shared/types.js";

function makeTask(id: string, status = "running" as TaskInfo["status"]): TaskInfo {
  return {
    taskId: id,
    status,
    phase: "training",
    startedAt: "2026-03-16T00:00:00.000Z",
    updatedAt: "2026-03-16T00:00:00.000Z",
  };
}

describe("local/task_tracker", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "relay-tracker-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("load", () => {
    it("starts empty when no file exists", async () => {
      const tracker = new TaskTracker(tmpDir);
      await tracker.load();
      assert.equal(tracker.size, 0);
    });
  });

  describe("track", () => {
    it("tracks a new task with workerId", async () => {
      const tracker = new TaskTracker(tmpDir);
      await tracker.load();

      const tracked = await tracker.track(makeTask("t-1"), "w-1");
      assert.equal(tracked.taskId, "t-1");
      assert.equal(tracked.workerId, "w-1");
      assert.equal(tracker.size, 1);
    });

    it("persists to disk", async () => {
      const tracker = new TaskTracker(tmpDir);
      await tracker.load();
      await tracker.track(makeTask("t-1"), "w-1");

      const raw = await readFile(join(tmpDir, "tasks.json"), "utf-8");
      const data = JSON.parse(raw);
      assert.equal(data.length, 1);
      assert.equal(data[0].taskId, "t-1");
      assert.equal(data[0].workerId, "w-1");
    });
  });

  describe("update", () => {
    it("updates task fields", async () => {
      const tracker = new TaskTracker(tmpDir);
      await tracker.load();
      await tracker.track(makeTask("t-1"), "w-1");

      await tracker.update("t-1", { status: "awaiting_approval", phase: "eval" });
      const task = tracker.get("t-1")!;
      assert.equal(task.status, "awaiting_approval");
      assert.equal(task.phase, "eval");
      assert.notEqual(task.updatedAt, "2026-03-16T00:00:00.000Z");
    });

    it("throws for unknown task", async () => {
      const tracker = new TaskTracker(tmpDir);
      await tracker.load();

      await assert.rejects(
        () => tracker.update("t-nonexistent", { status: "completed" }),
        /Task not found/,
      );
    });
  });

  describe("get", () => {
    it("returns undefined for unknown task", async () => {
      const tracker = new TaskTracker(tmpDir);
      await tracker.load();
      assert.equal(tracker.get("t-nonexistent"), undefined);
    });
  });

  describe("list", () => {
    it("lists all tasks", async () => {
      const tracker = new TaskTracker(tmpDir);
      await tracker.load();
      await tracker.track(makeTask("t-1"), "w-1");
      await tracker.track(makeTask("t-2"), "w-2");
      await tracker.track(makeTask("t-3", "completed"), "w-1");

      assert.equal(tracker.list().length, 3);
    });

    it("filters by status", async () => {
      const tracker = new TaskTracker(tmpDir);
      await tracker.load();
      await tracker.track(makeTask("t-1", "running"), "w-1");
      await tracker.track(makeTask("t-2", "completed"), "w-2");
      await tracker.track(makeTask("t-3", "running"), "w-1");

      const running = tracker.list({ status: "running" });
      assert.equal(running.length, 2);
    });

    it("filters by workerId", async () => {
      const tracker = new TaskTracker(tmpDir);
      await tracker.load();
      await tracker.track(makeTask("t-1"), "w-1");
      await tracker.track(makeTask("t-2"), "w-2");
      await tracker.track(makeTask("t-3"), "w-1");

      const w1Tasks = tracker.list({ workerId: "w-1" });
      assert.equal(w1Tasks.length, 2);
    });

    it("filters by both status and workerId", async () => {
      const tracker = new TaskTracker(tmpDir);
      await tracker.load();
      await tracker.track(makeTask("t-1", "running"), "w-1");
      await tracker.track(makeTask("t-2", "completed"), "w-1");
      await tracker.track(makeTask("t-3", "running"), "w-2");

      const result = tracker.list({ status: "running", workerId: "w-1" });
      assert.equal(result.length, 1);
      assert.equal(result[0].taskId, "t-1");
    });
  });

  describe("active", () => {
    it("returns only non-terminal tasks", async () => {
      const tracker = new TaskTracker(tmpDir);
      await tracker.load();
      await tracker.track(makeTask("t-1", "running"), "w-1");
      await tracker.track(makeTask("t-2", "completed"), "w-2");
      await tracker.track(makeTask("t-3", "failed"), "w-1");
      await tracker.track(makeTask("t-4", "awaiting_approval"), "w-3");

      const active = tracker.active();
      assert.equal(active.length, 2);
      assert.ok(active.some((t) => t.taskId === "t-1"));
      assert.ok(active.some((t) => t.taskId === "t-4"));
    });
  });

  describe("activeForWorker", () => {
    it("returns active task for a worker", async () => {
      const tracker = new TaskTracker(tmpDir);
      await tracker.load();
      await tracker.track(makeTask("t-1", "completed"), "w-1");
      await tracker.track(makeTask("t-2", "running"), "w-1");

      const active = tracker.activeForWorker("w-1");
      assert.equal(active?.taskId, "t-2");
    });

    it("returns undefined when no active task", async () => {
      const tracker = new TaskTracker(tmpDir);
      await tracker.load();
      await tracker.track(makeTask("t-1", "completed"), "w-1");

      assert.equal(tracker.activeForWorker("w-1"), undefined);
    });
  });

  describe("persistence across instances", () => {
    it("survives reload", async () => {
      const t1 = new TaskTracker(tmpDir);
      await t1.load();
      await t1.track(makeTask("t-1"), "w-1");
      await t1.track(makeTask("t-2", "completed"), "w-2");

      const t2 = new TaskTracker(tmpDir);
      await t2.load();
      assert.equal(t2.size, 2);
      assert.equal(t2.get("t-1")?.workerId, "w-1");
      assert.equal(t2.get("t-2")?.status, "completed");
    });
  });
});
