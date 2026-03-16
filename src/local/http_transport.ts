// Local-side HTTP transport — communicates with worker HTTP servers

import type {
  TaskPayload,
  TaskInfo,
  Report,
  Feedback,
  HealthInfo,
} from "../shared/types.js";

export interface ITransport {
  health(workerUrl: string): Promise<HealthInfo>;
  dispatch(workerUrl: string, payload: TaskPayload): Promise<TaskInfo>;
  status(workerUrl: string, taskId: string): Promise<TaskInfo>;
  report(workerUrl: string, taskId: string): Promise<Report>;
  feedback(workerUrl: string, taskId: string, fb: Feedback): Promise<void>;
  files(workerUrl: string, taskId: string, filePath: string): Promise<{ path: string; encoding: string; content: string }>;
  abort(workerUrl: string, taskId: string): Promise<void>;
}

export interface HttpTransportOptions {
  authToken: string;
  timeoutMs?: number;
  retries?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;

export class HttpTransport implements ITransport {
  private readonly authToken: string;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(opts: HttpTransportOptions) {
    this.authToken = opts.authToken;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retries = opts.retries ?? DEFAULT_RETRIES;
  }

  async health(workerUrl: string): Promise<HealthInfo> {
    return this.request("GET", `${workerUrl}/health`);
  }

  async dispatch(workerUrl: string, payload: TaskPayload): Promise<TaskInfo> {
    return this.request("POST", `${workerUrl}/task`, payload);
  }

  async status(workerUrl: string, taskId: string): Promise<TaskInfo> {
    return this.request("GET", `${workerUrl}/task/${taskId}/status`);
  }

  async report(workerUrl: string, taskId: string): Promise<Report> {
    return this.request("GET", `${workerUrl}/task/${taskId}/report`);
  }

  async feedback(workerUrl: string, taskId: string, fb: Feedback): Promise<void> {
    await this.request("POST", `${workerUrl}/task/${taskId}/feedback`, fb);
  }

  async files(workerUrl: string, taskId: string, filePath: string): Promise<{ path: string; encoding: string; content: string }> {
    return this.request("GET", `${workerUrl}/task/${taskId}/files/${filePath}`);
  }

  async abort(workerUrl: string, taskId: string): Promise<void> {
    await this.request("POST", `${workerUrl}/task/${taskId}/abort`);
  }

  private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

        const opts: RequestInit = {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}),
          },
          signal: controller.signal,
        };

        if (body && (method === "POST" || method === "PUT")) {
          opts.body = JSON.stringify(body);
        }

        const res = await fetch(url, opts);
        clearTimeout(timer);

        if (!res.ok) {
          const errBody = await res.json().catch(() => ({ error: res.statusText }));
          const msg = (errBody as any).error ?? `HTTP ${res.status}`;
          throw new TransportError(msg, res.status);
        }

        const text = await res.text();
        if (!text) return undefined as T;
        return JSON.parse(text) as T;
      } catch (err: any) {
        lastError = err;
        // Don't retry on 4xx client errors
        if (err instanceof TransportError && err.statusCode >= 400 && err.statusCode < 500) {
          throw err;
        }
        // Don't retry on last attempt
        if (attempt === this.retries) break;
        // Exponential backoff
        await sleep(Math.min(1000 * 2 ** attempt, 5000));
      }
    }

    throw lastError ?? new Error("Request failed");
  }
}

export class TransportError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "TransportError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
