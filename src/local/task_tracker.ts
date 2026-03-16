// Local-side task tracker — aggregates task state across workers

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { TaskInfo, TaskStatus } from "../shared/types.js";
import { TERMINAL_STATUSES } from "../shared/types.js";

const TASKS_FILENAME = "tasks.json";

export interface TrackedTask extends TaskInfo {
  workerId: string;
}

export class TaskTracker {
  private readonly filePath: string;
  private tasks: Map<string, TrackedTask> = new Map();

  constructor(dataDir: string) {
    this.filePath = join(dataDir, TASKS_FILENAME);
  }

  /** Load from disk. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const entries = JSON.parse(raw) as TrackedTask[];
      this.tasks = new Map(entries.map((t) => [t.taskId, t]));
    } catch {
      this.tasks = new Map();
    }
  }

  /** Persist to disk. */
  async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const entries = Array.from(this.tasks.values());
    await writeFile(this.filePath, JSON.stringify(entries, null, 2), "utf-8");
  }

  /** Track a newly dispatched task. */
  async track(taskInfo: TaskInfo, workerId: string): Promise<TrackedTask> {
    const tracked: TrackedTask = { ...taskInfo, workerId };
    this.tasks.set(tracked.taskId, tracked);
    await this.save();
    return tracked;
  }

  /** Update task status from worker poll. */
  async update(taskId: string, updates: Partial<Pick<TaskInfo, "status" | "phase" | "progress" | "error">>): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    Object.assign(task, updates, {
      updatedAt: new Date().toISOString(),
    });
    await this.save();
  }

  /** Get a task by ID. */
  get(taskId: string): TrackedTask | undefined {
    return this.tasks.get(taskId);
  }

  /** List all tasks, optionally filtered by status. */
  list(filter?: { status?: TaskStatus; workerId?: string }): TrackedTask[] {
    let result = Array.from(this.tasks.values());
    if (filter?.status) {
      result = result.filter((t) => t.status === filter.status);
    }
    if (filter?.workerId) {
      result = result.filter((t) => t.workerId === filter.workerId);
    }
    return result;
  }

  /** Get active (non-terminal) tasks. */
  active(): TrackedTask[] {
    return Array.from(this.tasks.values()).filter(
      (t) => !TERMINAL_STATUSES.has(t.status),
    );
  }

  /** Get active task for a specific worker (at most one). */
  activeForWorker(workerId: string): TrackedTask | undefined {
    return Array.from(this.tasks.values()).find(
      (t) => t.workerId === workerId && !TERMINAL_STATUSES.has(t.status),
    );
  }

  /** Get count of all tracked tasks. */
  get size(): number {
    return this.tasks.size;
  }
}
