// Worker-side persistent state management (state.json)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { PersistedState, TaskInfo } from "../shared/types.js";
import { TERMINAL_STATUSES } from "../shared/types.js";

const STATE_FILENAME = "state.json";

function defaultState(): PersistedState {
  return {
    task: null,
    sessionId: null,
    feedbackCounter: 0,
    history: [],
  };
}

export class StateStore {
  private readonly filePath: string;
  private state: PersistedState;

  constructor(workspaceDir: string) {
    this.filePath = join(workspaceDir, "supervisor", STATE_FILENAME);
    this.state = defaultState();
  }

  /** Load state from disk. If missing or corrupt, start fresh. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      this.state = JSON.parse(raw) as PersistedState;
    } catch {
      this.state = defaultState();
    }
  }

  /** Crash recovery: mark interrupted tasks as failed. */
  recoverFromCrash(): void {
    const task = this.state.task;
    if (!task) return;

    if (task.status === "running" || task.status === "initializing") {
      task.status = "failed";
      task.error = "Worker restarted while task was in progress";
      task.updatedAt = new Date().toISOString();
      this.state.history.push({ ...task });
      this.state.task = null;
      this.state.sessionId = null;
    }
    // awaiting_approval survives restart — CC was already paused
  }

  /** Persist current state to disk. */
  async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.state, null, 2), "utf-8");
  }

  /** Load + recover + save in one call (typical startup sequence). */
  async initialize(): Promise<void> {
    await this.load();
    this.recoverFromCrash();
    await this.save();
  }

  get current(): PersistedState {
    return this.state;
  }

  getTask(): TaskInfo | null {
    return this.state.task;
  }

  getSessionId(): string | null {
    return this.state.sessionId;
  }

  getFeedbackCounter(): number {
    return this.state.feedbackCounter;
  }

  getHistory(): TaskInfo[] {
    return this.state.history;
  }

  /** Set the current task and persist. */
  async setTask(task: TaskInfo, sessionId?: string): Promise<void> {
    this.state.task = task;
    if (sessionId !== undefined) {
      this.state.sessionId = sessionId;
    }
    await this.save();
  }

  /** Update fields on the current task and persist. */
  async updateTask(updates: Partial<Pick<TaskInfo, "status" | "phase" | "progress" | "error">>): Promise<void> {
    if (!this.state.task) {
      throw new Error("No active task to update");
    }
    Object.assign(this.state.task, updates, {
      updatedAt: new Date().toISOString(),
    });

    // If terminal, move to history and clear current
    if (TERMINAL_STATUSES.has(this.state.task.status)) {
      this.state.history.push({ ...this.state.task });
      this.state.task = null;
      this.state.sessionId = null;
    }

    await this.save();
  }

  /** Increment and return the feedback counter. */
  async nextFeedbackCounter(): Promise<number> {
    this.state.feedbackCounter += 1;
    await this.save();
    return this.state.feedbackCounter;
  }

  /** Reset state to defaults and persist. */
  async reset(): Promise<void> {
    this.state = defaultState();
    await this.save();
  }
}
