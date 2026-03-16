import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../../src/worker/server.js";
import { TaskExecutor } from "../../src/worker/task_executor.js";

/** Minimal HTTP test helper — no external deps. */
function request(
  server: http.Server,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode!, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode!, body: raw });
          }
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

describe("worker/server", () => {
  let tmpDir: string;
  let executor: TaskExecutor;
  let server: http.Server;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "relay-srv-test-"));
    await mkdir(join(tmpDir, "inbox"), { recursive: true });
    await mkdir(join(tmpDir, "outbox"), { recursive: true });
    await mkdir(join(tmpDir, "experiment"), { recursive: true });
    await mkdir(join(tmpDir, "supervisor"), { recursive: true });

    executor = new TaskExecutor(tmpDir);
    await executor.initialize();

    const app = createApp(executor);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  afterEach(async () => {
    executor.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise((r) => setTimeout(r, 200));
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("GET /health", () => {
    it("returns ok status when idle", async () => {
      const res = await request(server, "GET", "/health");
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "ok");
      assert.equal(typeof res.body.uptime, "number");
      assert.equal(res.body.currentTask, undefined);
    });

    it("does not require auth", async () => {
      // Even with wrong auth, health should work
      const res = await request(server, "GET", "/health", undefined, {
        Authorization: "Bearer wrong-token",
      });
      assert.equal(res.status, 200);
    });
  });

  describe("POST /task", () => {
    it("rejects invalid payload", async () => {
      const res = await request(server, "POST", "/task", {
        experimentPlan: "",
        checkpoints: [],
        modelConfig: { apiKey: "" },
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.error);
    });

    it("accepts valid payload", async () => {
      const res = await request(server, "POST", "/task", {
        experimentPlan: "# Test\nDo something",
        checkpoints: ["step1"],
        modelConfig: { apiKey: "sk-test" },
      });
      // 201 if dispatch succeeded, 409 if CC spawn failed
      assert.ok([201, 409].includes(res.status));
    });
  });

  describe("GET /task/:id/status", () => {
    it("returns 404 for unknown task", async () => {
      const res = await request(server, "GET", "/task/t-unknown/status");
      assert.equal(res.status, 404);
    });
  });

  describe("GET /task/:id/report", () => {
    it("returns 404 for unknown task", async () => {
      const res = await request(server, "GET", "/task/t-unknown/report");
      assert.equal(res.status, 404);
    });
  });

  describe("POST /task/:id/feedback", () => {
    it("rejects invalid action", async () => {
      const res = await request(server, "POST", "/task/t-1/feedback", {
        action: "invalid",
      });
      assert.equal(res.status, 400);
    });

    it("returns 409 for non-existent task", async () => {
      const res = await request(server, "POST", "/task/t-1/feedback", {
        action: "continue",
      });
      assert.equal(res.status, 409);
    });
  });

  describe("POST /task/:id/abort", () => {
    it("returns 409 for non-existent task", async () => {
      const res = await request(server, "POST", "/task/t-1/abort");
      assert.equal(res.status, 409);
    });
  });

  describe("GET /task/:id/files/*", () => {
    it("returns 404 for unknown task", async () => {
      const res = await request(server, "GET", "/task/t-1/files/test.txt");
      assert.equal(res.status, 404);
    });
  });
});
