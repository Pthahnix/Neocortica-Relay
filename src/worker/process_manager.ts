// Worker-side CC child process lifecycle manager

import { spawn, type ChildProcess } from "node:child_process";
import { watch, type FSWatcher, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";

export interface ProcessManagerOptions {
  workspaceDir: string;
  allowedTools: string[];
  envConfig?: Record<string, string>;
  stallTimeoutMs?: number;
}

export interface CCEvents {
  report: (filePath: string) => void;
  exit: (code: number | null, signal: string | null) => void;
  error: (err: Error) => void;
  sessionId: (id: string) => void;
}

declare interface ProcessManager {
  on<K extends keyof CCEvents>(event: K, listener: CCEvents[K]): this;
  emit<K extends keyof CCEvents>(event: K, ...args: Parameters<CCEvents[K]>): boolean;
}

const DEFAULT_STALL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

class ProcessManager extends EventEmitter {
  private proc: ChildProcess | null = null;
  private watcher: FSWatcher | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private _sessionId: string | null = null;
  private stdout = "";
  private stderr = "";

  private readonly inboxDir: string;
  private readonly outboxDir: string;
  private readonly experimentDir: string;
  private readonly allowedTools: string[];
  private readonly envConfig: Record<string, string>;
  private readonly stallTimeoutMs: number;

  constructor(opts: ProcessManagerOptions) {
    super();
    this.inboxDir = join(opts.workspaceDir, "inbox");
    this.outboxDir = join(opts.workspaceDir, "outbox");
    this.experimentDir = join(opts.workspaceDir, "experiment");
    this.allowedTools = opts.allowedTools;
    this.envConfig = opts.envConfig ?? {};
    this.stallTimeoutMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  }

  get sessionId(): string | null {
    return this._sessionId;
  }

  get isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  /** Spawn CC for initial task execution. */
  spawnCC(taskPath: string): void {
    if (this.isRunning) {
      throw new Error("CC process already running");
    }

    this.ensureDirs();
    const args = this.buildArgs(["-p", `$(cat ${taskPath})`]);

    this.proc = spawn("claude", args, {
      cwd: this.experimentDir,
      shell: true,
      env: { ...process.env, ...this.envConfig },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.attachHandlers();
    this.watchOutbox();
    this.resetStallTimer();
  }

  /** Resume CC after checkpoint with feedback. */
  resumeCC(sessionId: string, feedbackPath: string): void {
    if (this.isRunning) {
      throw new Error("CC process already running");
    }

    const args = this.buildArgs([
      "--resume", sessionId,
      "-p", `$(cat ${feedbackPath})`,
    ]);

    this.proc = spawn("claude", args, {
      cwd: this.experimentDir,
      shell: true,
      env: { ...process.env, ...this.envConfig },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.attachHandlers();
    this.watchOutbox();
    this.resetStallTimer();
  }

  /** Kill the CC process (SIGTERM → 10s → SIGKILL). */
  killCC(): Promise<void> {
    return new Promise((resolve) => {
      this.clearStallTimer();
      this.stopWatcher();

      if (!this.proc || this.proc.exitCode !== null) {
        resolve();
        return;
      }

      const forceKillTimer = setTimeout(() => {
        if (this.proc && this.proc.exitCode === null) {
          this.proc.kill("SIGKILL");
        }
      }, 10_000);

      this.proc.once("exit", () => {
        clearTimeout(forceKillTimer);
        resolve();
      });

      this.proc.kill("SIGTERM");
    });
  }

  getStdout(): string {
    return this.stdout;
  }

  getStderr(): string {
    return this.stderr;
  }

  /** Clean up all resources. */
  destroy(): void {
    this.clearStallTimer();
    this.stopWatcher();
    if (this.proc && this.proc.exitCode === null) {
      this.proc.kill("SIGKILL");
    }
  }

  private buildArgs(prefix: string[]): string[] {
    const tools = this.allowedTools.join(",");
    return [
      ...prefix,
      "--output-format", "json",
      "--allowedTools", tools,
    ];
  }

  private attachHandlers(): void {
    if (!this.proc) return;

    this.stdout = "";
    this.stderr = "";

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      this.stdout += text;
      this.tryExtractSessionId(text);
      this.resetStallTimer();
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      this.stderr += chunk.toString();
      this.resetStallTimer();
    });

    this.proc.on("exit", (code, signal) => {
      this.clearStallTimer();
      this.stopWatcher();
      this.emit("exit", code, signal);
    });

    this.proc.on("error", (err) => {
      this.clearStallTimer();
      this.stopWatcher();
      this.emit("error", err);
    });
  }

  private tryExtractSessionId(text: string): void {
    try {
      const parsed = JSON.parse(text);
      if (parsed.session_id && !this._sessionId) {
        this._sessionId = parsed.session_id;
        this.emit("sessionId", parsed.session_id);
      }
    } catch {
      // Partial or non-JSON output, ignore
    }
  }

  private watchOutbox(): void {
    this.stopWatcher();
    if (!existsSync(this.outboxDir)) {
      mkdirSync(this.outboxDir, { recursive: true });
    }

    const seen = new Set(readdirSync(this.outboxDir));

    this.watcher = watch(this.outboxDir, (event, filename) => {
      if (event === "rename" && filename && !seen.has(filename)) {
        seen.add(filename);
        if (filename.startsWith("report_") && filename.endsWith(".json")) {
          this.resetStallTimer();
          this.emit("report", join(this.outboxDir, filename));
        }
      }
    });
  }

  private resetStallTimer(): void {
    this.clearStallTimer();
    if (this.stallTimeoutMs > 0 && this.isRunning) {
      this.stallTimer = setTimeout(() => {
        if (this.isRunning) {
          this.emit("error", new Error("Process stalled: no activity for " + this.stallTimeoutMs + "ms"));
          this.killCC();
        }
      }, this.stallTimeoutMs);
    }
  }

  private clearStallTimer(): void {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private stopWatcher(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private ensureDirs(): void {
    for (const dir of [this.inboxDir, this.outboxDir, this.experimentDir]) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }
  }
}

export { ProcessManager };
