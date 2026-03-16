import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../../src/worker/state_store.js";
import type { TaskInfo } from "../../src/shared/types.js";

function makeTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
  return {
    taskId: "t-1",
    status: "running",
    phase: "training",
    startedAt: "2026-03-16T00:00:00.000Z",
    updatedAt: "2026-03-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("worker/state_store", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "relay-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("initialize", () => {
    it("creates default state when no file exists", async () => {
      const store = new StateStore(tmpDir);
      await store.initialize();

      assert.equal(store.getTask(), null);
      assert.equal(store.getSessionId(), null);
      assert.equal(store.getFeedbackCounter(), 0);
      assert.deepEqual(store.getHistory(), []);
    });

    it("persists state file on initialize", async () => {
      const store = new StateStore(tmpDir);
      await store.initialize();

      const raw = await readFile(
        join(tmpDir, "supervisor", "state.json"),
        "utf-8",
      );
      const parsed = JSON.parse(raw);
      assert.equal(parsed.task, null);
      assert.equal(parsed.feedbackCounter, 0);
    });
  });

  describe("setTask / getTask", () => {
    it("stores and retrieves a task", async () => {
      const store = new StateStore(tmpDir);
      await store.initialize();

      const task = makeTask();
      await store.setTask(task, "session-abc");

      assert.deepEqual(store.getTask(), task);
      assert.equal(store.getSessionId(), "session-abc");
    });

    it("persists task to disk", async () => {
      const store = new StateStore(tmpDir);
      await store.initialize();
      await store.setTask(makeTask(), "s-1");

      // Load in a new instance
      const store2 = new StateStore(tmpDir);
      await store2.load();
      assert.equal(store2.getTask()?.taskId, "t-1");
      assert.equal(store2.getSessionId(), "s-1");
    });
  });

  describe("updateTask", () => {
    it("updates task fields and timestamp", async () => {
      const store = new StateStore(tmpDir);
      await store.initialize();
      await store.setTask(makeTask());

      await store.updateTask({ phase: "evaluation", progress: "50%" });

      const task = store.getTask()!;
      assert.equal(task.phase, "evaluation");
      assert.equal(task.progress, "50%");
      assert.notEqual(task.updatedAt, "2026-03-16T00:00:00.000Z");
    });

    it("moves task to history on terminal status", async () => {
      const store = new StateStore(tmpDir);
      await store.initialize();
      await store.setTask(makeTask(), "s-1");

      await store.updateTask({ status: "completed" });

      assert.equal(store.getTask(), null);
      assert.equal(store.getSessionId(), null);
      assert.equal(store.getHistory().length, 1);
      assert.equal(store.getHistory()[0].status, "completed");
    });

    it("throws when no active task", async () => {
      const store = new StateStore(tmpDir);
      await store.initialize();

      await assert.rejects(
        () => store.updateTask({ phase: "x" }),
        { message: "No active task to update" },
      );
    });
  });

  describe("crash recovery", () => {
    it("marks running task as failed on restart", async () => {
      const store = new StateStore(tmpDir);
      await store.initialize();
      await store.setTask(makeTask({ status: "running" }), "s-1");

      // Simulate restart
      const store2 = new StateStore(tmpDir);
      await store2.initialize();

      assert.equal(store2.getTask(), null);
      assert.equal(store2.getSessionId(), null);
      assert.equal(store2.getHistory().length, 1);
      assert.equal(store2.getHistory()[0].status, "failed");
      assert.ok(store2.getHistory()[0].error?.includes("restarted"));
    });

    it("marks initializing task as failed on restart", async () => {
      const store = new StateStore(tmpDir);
      await store.initialize();
      await store.setTask(makeTask({ status: "initializing" }));

      const store2 = new StateStore(tmpDir);
      await store2.initialize();

      assert.equal(store2.getTask(), null);
      assert.equal(store2.getHistory().length, 1);
      assert.equal(store2.getHistory()[0].status, "failed");
    });

    it("preserves awaiting_approval task on restart", async () => {
      const store = new StateStore(tmpDir);
      await store.initialize();
      await store.setTask(makeTask({ status: "awaiting_approval" }), "s-1");

      const store2 = new StateStore(tmpDir);
      await store2.initialize();

      assert.equal(store2.getTask()?.status, "awaiting_approval");
      assert.equal(store2.getSessionId(), "s-1");
    });
  });

  describe("feedbackCounter", () => {
    it("increments monotonically", async () => {
      const store = new StateStore(tmpDir);
      await store.initialize();

      assert.equal(await store.nextFeedbackCounter(), 1);
      assert.equal(await store.nextFeedbackCounter(), 2);
      assert.equal(await store.nextFeedbackCounter(), 3);
    });

    it("survives restart", async () => {
      const store = new StateStore(tmpDir);
      await store.initialize();
      await store.nextFeedbackCounter();
      await store.nextFeedbackCounter();

      const store2 = new StateStore(tmpDir);
      await store2.load();
      assert.equal(store2.getFeedbackCounter(), 2);
      assert.equal(await store2.nextFeedbackCounter(), 3);
    });
  });

  describe("reset", () => {
    it("clears all state", async () => {
      const store = new StateStore(tmpDir);
      await store.initialize();
      await store.setTask(makeTask(), "s-1");
      await store.nextFeedbackCounter();

      await store.reset();

      assert.equal(store.getTask(), null);
      assert.equal(store.getSessionId(), null);
      assert.equal(store.getFeedbackCounter(), 0);
      assert.deepEqual(store.getHistory(), []);
    });
  });

  describe("history accumulation", () => {
    it("accumulates multiple completed tasks", async () => {
      const store = new StateStore(tmpDir);
      await store.initialize();

      await store.setTask(makeTask({ taskId: "t-1" }));
      await store.updateTask({ status: "completed" });

      await store.setTask(makeTask({ taskId: "t-2" }));
      await store.updateTask({ status: "failed", error: "OOM" });

      await store.setTask(makeTask({ taskId: "t-3" }));
      await store.updateTask({ status: "aborted" });

      const history = store.getHistory();
      assert.equal(history.length, 3);
      assert.equal(history[0].taskId, "t-1");
      assert.equal(history[1].taskId, "t-2");
      assert.equal(history[1].error, "OOM");
      assert.equal(history[2].taskId, "t-3");
    });
  });
});
