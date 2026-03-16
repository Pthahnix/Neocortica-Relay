// Local-side worker registry — manages worker connections and persistence

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { WorkerEntry, HealthInfo } from "../shared/types.js";
import { randomUUID } from "node:crypto";

const REGISTRY_FILENAME = "workers.json";

export class WorkerRegistry {
  private readonly filePath: string;
  private workers: Map<string, WorkerEntry> = new Map();

  constructor(dataDir: string) {
    this.filePath = join(dataDir, REGISTRY_FILENAME);
  }

  /** Load registry from disk. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      const entries = JSON.parse(raw) as WorkerEntry[];
      this.workers = new Map(entries.map((w) => [w.workerId, w]));
    } catch {
      this.workers = new Map();
    }
  }

  /** Persist registry to disk. */
  async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const entries = Array.from(this.workers.values());
    await writeFile(this.filePath, JSON.stringify(entries, null, 2), "utf-8");
  }

  /** Register a new worker. Returns the assigned worker ID. */
  async register(url: string, name?: string): Promise<WorkerEntry> {
    // Check for duplicate URL
    for (const w of this.workers.values()) {
      if (w.url === url) {
        throw new Error(`Worker already registered with URL: ${url}`);
      }
    }

    const entry: WorkerEntry = {
      workerId: `w-${randomUUID().slice(0, 8)}`,
      url: url.replace(/\/+$/, ""), // strip trailing slashes
      name,
      registeredAt: new Date().toISOString(),
    };

    this.workers.set(entry.workerId, entry);
    await this.save();
    return entry;
  }

  /** Unregister a worker by ID. */
  async unregister(workerId: string): Promise<void> {
    if (!this.workers.has(workerId)) {
      throw new Error(`Worker not found: ${workerId}`);
    }
    this.workers.delete(workerId);
    await this.save();
  }

  /** Get a worker by ID. */
  get(workerId: string): WorkerEntry | undefined {
    return this.workers.get(workerId);
  }

  /** List all registered workers. */
  list(): WorkerEntry[] {
    return Array.from(this.workers.values());
  }

  /** Update health info for a worker. */
  async updateHealth(workerId: string, health: HealthInfo): Promise<void> {
    const worker = this.workers.get(workerId);
    if (!worker) {
      throw new Error(`Worker not found: ${workerId}`);
    }
    worker.lastHealth = health;
    await this.save();
  }

  /** Get count of registered workers. */
  get size(): number {
    return this.workers.size;
  }
}
