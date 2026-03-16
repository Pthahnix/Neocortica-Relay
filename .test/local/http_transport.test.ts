import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { HttpTransport, TransportError } from "../../src/local/http_transport.js";

/** Create a simple mock HTTP server. */
function createMockServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ server: http.Server; url: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("local/http_transport", () => {
  let mockServer: http.Server;
  let baseUrl: string;

  afterEach(async () => {
    if (mockServer) await closeServer(mockServer);
  });

  describe("health", () => {
    it("returns health info", async () => {
      const mock = await createMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", uptime: 100 }));
      });
      mockServer = mock.server;
      baseUrl = mock.url;

      const transport = new HttpTransport({ authToken: "test-token" });
      const health = await transport.health(baseUrl);
      assert.equal(health.status, "ok");
      assert.equal(health.uptime, 100);
    });
  });

  describe("dispatch", () => {
    it("sends payload and returns task info", async () => {
      const mock = await createMockServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const payload = JSON.parse(body);
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            taskId: "t-1",
            status: "running",
            phase: payload.checkpoints[0],
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }));
        });
      });
      mockServer = mock.server;
      baseUrl = mock.url;

      const transport = new HttpTransport({ authToken: "test-token" });
      const task = await transport.dispatch(baseUrl, {
        experimentPlan: "# Test",
        checkpoints: ["step1"],
        modelConfig: { apiKey: "sk-test" },
      });
      assert.equal(task.taskId, "t-1");
      assert.equal(task.phase, "step1");
    });
  });

  describe("status", () => {
    it("returns task status", async () => {
      const mock = await createMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          taskId: "t-1", status: "running", phase: "training",
          startedAt: "2026-01-01", updatedAt: "2026-01-01",
        }));
      });
      mockServer = mock.server;
      baseUrl = mock.url;

      const transport = new HttpTransport({ authToken: "test-token" });
      const info = await transport.status(baseUrl, "t-1");
      assert.equal(info.status, "running");
    });
  });

  describe("report", () => {
    it("returns report", async () => {
      const mock = await createMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          phase: "training", summary: "Done", details: "# Report", files: [],
        }));
      });
      mockServer = mock.server;
      baseUrl = mock.url;

      const transport = new HttpTransport({ authToken: "test-token" });
      const report = await transport.report(baseUrl, "t-1");
      assert.equal(report.phase, "training");
      assert.equal(report.summary, "Done");
    });
  });

  describe("feedback", () => {
    it("sends feedback", async () => {
      let receivedBody = "";
      const mock = await createMockServer((req, res) => {
        req.on("data", (c) => (receivedBody += c));
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        });
      });
      mockServer = mock.server;
      baseUrl = mock.url;

      const transport = new HttpTransport({ authToken: "test-token" });
      await transport.feedback(baseUrl, "t-1", { action: "continue", message: "LGTM" });
      const parsed = JSON.parse(receivedBody);
      assert.equal(parsed.action, "continue");
      assert.equal(parsed.message, "LGTM");
    });
  });

  describe("abort", () => {
    it("sends abort request", async () => {
      let method = "";
      const mock = await createMockServer((req, res) => {
        method = req.method!;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      mockServer = mock.server;
      baseUrl = mock.url;

      const transport = new HttpTransport({ authToken: "test-token" });
      await transport.abort(baseUrl, "t-1");
      assert.equal(method, "POST");
    });
  });

  describe("auth header", () => {
    it("sends Bearer token", async () => {
      let authHeader = "";
      const mock = await createMockServer((req, res) => {
        authHeader = req.headers.authorization ?? "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", uptime: 0 }));
      });
      mockServer = mock.server;
      baseUrl = mock.url;

      const transport = new HttpTransport({ authToken: "my-secret" });
      await transport.health(baseUrl);
      assert.equal(authHeader, "Bearer my-secret");
    });
  });

  describe("error handling", () => {
    it("throws TransportError on 4xx", async () => {
      const mock = await createMockServer((_req, res) => {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Task not found" }));
      });
      mockServer = mock.server;
      baseUrl = mock.url;

      const transport = new HttpTransport({ authToken: "test", retries: 0 });
      await assert.rejects(
        () => transport.health(baseUrl),
        (err: any) => {
          assert.ok(err instanceof TransportError);
          assert.equal(err.statusCode, 404);
          assert.ok(err.message.includes("Task not found"));
          return true;
        },
      );
    });

    it("does not retry on 4xx errors", async () => {
      let callCount = 0;
      const mock = await createMockServer((_req, res) => {
        callCount++;
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad request" }));
      });
      mockServer = mock.server;
      baseUrl = mock.url;

      const transport = new HttpTransport({ authToken: "test", retries: 2 });
      await assert.rejects(() => transport.health(baseUrl));
      assert.equal(callCount, 1);
    });

    it("retries on 5xx errors", async () => {
      let callCount = 0;
      const mock = await createMockServer((_req, res) => {
        callCount++;
        if (callCount < 3) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal error" }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", uptime: 0 }));
        }
      });
      mockServer = mock.server;
      baseUrl = mock.url;

      const transport = new HttpTransport({ authToken: "test", retries: 2 });
      const health = await transport.health(baseUrl);
      assert.equal(health.status, "ok");
      assert.equal(callCount, 3);
    });
  });

  describe("files", () => {
    it("returns file content", async () => {
      const mock = await createMockServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ path: "model.pt", encoding: "base64", content: "AAAA" }));
      });
      mockServer = mock.server;
      baseUrl = mock.url;

      const transport = new HttpTransport({ authToken: "test" });
      const file = await transport.files(baseUrl, "t-1", "model.pt");
      assert.equal(file.path, "model.pt");
      assert.equal(file.encoding, "base64");
    });
  });
});
