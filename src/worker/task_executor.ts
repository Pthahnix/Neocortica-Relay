// Worker-side task executor — state machine + checkpoint flow
// Coordinates StateStore and ProcessManager

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { StateStore } from "./state_store.js";
import { ProcessManager } from "./process_manager.js";
import type {
  TaskPayload,
  TaskInfo,
  Report,
  Feedback,
  TaskStatus,
} from "../shared/types.js";
import { ALLOWED_TOOLS_WHITELIST, TERMINAL_STATUSES } from "../shared/types.js";

export interface TaskExecutorEvents {
  stateChange: (task: TaskInfo) => void;
  report: (report: Report) => void;
  completed: (task: TaskInfo) => void;
  failed: (task: TaskInfo) => void;
}

declare interface TaskExecutor {
  on<K extends keyof TaskExecutorEvents>(event: K, listener: TaskExecutorEvents[K]): this;
  emit<K extends keyof TaskExecutorEvents>(event: K, ...args: Parameters<TaskExecutorEvents[K]>): boolean;
}

class TaskExecutor extends EventEmitter {
  private readonly store: StateStore;
  private pm: ProcessManager | null = null;
  private readonly workspaceDir: string;
  private lastReport: Report | null = null;

  constructor(workspaceDir: string) {
    super();
    this.workspaceDir = workspaceDir;
    this.store = new StateStore(workspaceDir);
  }

  /** Initialize: load persisted state, recover from crash. */
  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  /** Get current task info. */
  getTask(): TaskInfo | null {
    return this.store.getTask();
  }

  /** Get current status. */
  getStatus(): TaskStatus {
    return this.store.getTask()?.status ?? "idle";
  }

  /** Get last received report. */
  getLastReport(): Report | null {
    return this.lastReport;
  }

  /** Get task history. */
  getHistory(): TaskInfo[] {
    return this.store.getHistory();
  }

  /** Dispatch a new task. */
  async dispatch(payload: TaskPayload): Promise<TaskInfo> {
    const current = this.store.getTask();
    if (current && !TERMINAL_STATUSES.has(current.status)) {
      throw new Error(`Cannot dispatch: worker busy with task ${current.taskId} (${current.status})`);
    }

    const taskId = `t-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const task: TaskInfo = {
      taskId,
      status: "initializing",
      phase: payload.checkpoints[0] ?? "start",
      startedAt: now,
      updatedAt: now,
    };

    await this.store.setTask(task);
    this.lastReport = null;
    this.emit("stateChange", task);

    // Write task file to inbox
    const inboxDir = join(this.workspaceDir, "inbox");
    const taskPath = join(inboxDir, "task.md");
    await writeFile(taskPath, payload.experimentPlan, "utf-8");

    // Create ProcessManager and spawn CC
    const allowedTools = payload.allowedTools ?? [...ALLOWED_TOOLS_WHITELIST];
    this.pm = new ProcessManager({
      workspaceDir: this.workspaceDir,
      allowedTools,
      envConfig: payload.envConfig,
      stallTimeoutMs: payload.stallTimeoutMs,
    });

    this.attachPMHandlers(taskId);
    this.pm.spawnCC(taskPath);

    // Transition to running
    await this.store.updateTask({ status: "running" });
    const updated = this.store.getTask();
    if (updated) this.emit("stateChange", updated);

    return { ...task, status: "running" };
  }

  /** Submit feedback for an awaiting_approval task. */
  async submitFeedback(taskId: string, feedback: Feedback): Promise<void> {
    const task = this.store.getTask();
    if (!task || task.taskId !== taskId) {
      throw new Error(`No active task with id ${taskId}`);
    }
    if (task.status !== "awaiting_approval") {
      throw new Error(`Task ${taskId} is not awaiting approval (status: ${task.status})`);
    }

    if (feedback.action === "abort") {
      await this.abort(taskId);
      return;
    }

    // Write feedback file
    const counter = await this.store.nextFeedbackCounter();
    const feedbackPath = join(this.workspaceDir, "inbox", `feedback_${counter}.md`);
    const content = buildFeedbackContent(feedback);
    await writeFile(feedbackPath, content, "utf-8");

    // Resume CC
    const sessionId = this.store.getSessionId();
    if (!sessionId) {
      throw new Error("No session ID available for resume");
    }

    await this.store.updateTask({ status: "running" });
    const updated = this.store.getTask();
    if (updated) this.emit("stateChange", updated);

    this.pm?.resumeCC(sessionId, feedbackPath);
  }

  /** Abort the current task. */
  async abort(taskId: string): Promise<void> {
    const task = this.store.getTask();
    if (!task || task.taskId !== taskId) {
      throw new Error(`No active task with id ${taskId}`);
    }
    if (TERMINAL_STATUSES.has(task.status)) {
      throw new Error(`Task ${taskId} already in terminal state: ${task.status}`);
    }

    // Kill process first, then update state
    if (this.pm) {
      // Remove listeners to prevent exit handler from racing
      this.pm.removeAllListeners();
      await this.pm.killCC();
      this.pm.destroy();
      this.pm = null;
    }

    // Re-check task is still active (defensive)
    const current = this.store.getTask();
    if (current && current.taskId === taskId && !TERMINAL_STATUSES.has(current.status)) {
      await this.store.updateTask({ status: "aborted" });
    }

    this.emit("stateChange", { ...task, status: "aborted", updatedAt: new Date().toISOString() });
  }

  /** Clean up resources. */
  destroy(): void {
    if (this.pm) {
      this.pm.destroy();
      this.pm = null;
    }
  }

  private attachPMHandlers(taskId: string): void {
    if (!this.pm) return;

    this.pm.on("sessionId", async (id) => {
      await this.store.setTask(this.store.getTask()!, id);
    });

    this.pm.on("report", async (filePath) => {
      try {
        const raw = readFileSync(filePath, "utf-8");
        const report = JSON.parse(raw) as Report;
        this.lastReport = report;

        await this.store.updateTask({
          status: "awaiting_approval",
          phase: report.phase,
          progress: report.summary,
        });

        const updated = this.store.getTask();
        if (updated) this.emit("stateChange", updated);
        this.emit("report", report);
      } catch {
        // Malformed report file — log but don't crash
      }
    });

    this.pm.on("exit", async (code) => {
      const task = this.store.getTask();
      if (!task || task.taskId !== taskId) return;

      // If already in terminal or awaiting_approval, don't override
      if (TERMINAL_STATUSES.has(task.status) || task.status === "awaiting_approval") {
        return;
      }

      if (code === 0) {
        await this.store.updateTask({ status: "completed" });
        this.emit("completed", { ...task, status: "completed" });
      } else {
        await this.store.updateTask({
          status: "failed",
          error: `CC exited with code ${code}`,
        });
        this.emit("failed", { ...task, status: "failed" });
      }
    });

    this.pm.on("error", async (err) => {
      const task = this.store.getTask();
      if (!task || task.taskId !== taskId) return;
      if (TERMINAL_STATUSES.has(task.status)) return;

      await this.store.updateTask({
        status: "failed",
        error: err.message,
      });
      this.emit("failed", { ...task, status: "failed", error: err.message });
    });
  }
}

function buildFeedbackContent(feedback: Feedback): string {
  const lines: string[] = [];
  lines.push(`# Feedback: ${feedback.action}`);
  if (feedback.message) {
    lines.push("");
    lines.push(feedback.message);
  }
  return lines.join("\n");
}

export { TaskExecutor };
