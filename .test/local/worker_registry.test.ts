import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkerRegistry } from "../../src/local/worker_registry.js";

describe("local/worker_registry", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "relay-reg-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("load", () => {
    it("starts empty when no file exists", async () => {
      const reg = new WorkerRegistry(tmpDir);
      await reg.load();
      assert.equal(reg.size, 0);
      assert.deepEqual(reg.list(), []);
    });
  });

  describe("register", () => {
    it("registers a worker and assigns ID", async () => {
      const reg = new WorkerRegistry(tmpDir);
      await reg.load();

      const entry = await reg.register("https://pod-123.proxy.runpod.net", "gpu-1");
      assert.ok(entry.workerId.startsWith("w-"));
      assert.equal(entry.url, "https://pod-123.proxy.runpod.net");
      assert.equal(entry.name, "gpu-1");
      assert.ok(entry.registeredAt);
      assert.equal(reg.size, 1);
    });

    it("strips trailing slashes from URL", async () => {
      const reg = new WorkerRegistry(tmpDir);
      await reg.load();

      const entry = await reg.register("https://pod-123.proxy.runpod.net///");
      assert.equal(entry.url, "https://pod-123.proxy.runpod.net");
    });

    it("rejects duplicate URL", async () => {
      const reg = new WorkerRegistry(tmpDir);
      await reg.load();

      await reg.register("https://pod-123.proxy.runpod.net");
      await assert.rejects(
        () => reg.register("https://pod-123.proxy.runpod.net"),
        /already registered/,
      );
    });

    it("persists to disk", async () => {
      const reg = new WorkerRegistry(tmpDir);
      await reg.load();
      await reg.register("https://pod-1.proxy.runpod.net", "w1");

      const raw = await readFile(join(tmpDir, "workers.json"), "utf-8");
      const data = JSON.parse(raw);
      assert.equal(data.length, 1);
      assert.equal(data[0].name, "w1");
    });
  });

  describe("unregister", () => {
    it("removes a worker", async () => {
      const reg = new WorkerRegistry(tmpDir);
      await reg.load();

      const entry = await reg.register("https://pod-1.proxy.runpod.net");
      assert.equal(reg.size, 1);

      await reg.unregister(entry.workerId);
      assert.equal(reg.size, 0);
      assert.equal(reg.get(entry.workerId), undefined);
    });

    it("throws for unknown worker", async () => {
      const reg = new WorkerRegistry(tmpDir);
      await reg.load();

      await assert.rejects(
        () => reg.unregister("w-nonexistent"),
        /Worker not found/,
      );
    });
  });

  describe("get / list", () => {
    it("retrieves worker by ID", async () => {
      const reg = new WorkerRegistry(tmpDir);
      await reg.load();

      const entry = await reg.register("https://pod-1.proxy.runpod.net", "gpu-1");
      const found = reg.get(entry.workerId);
      assert.deepEqual(found, entry);
    });

    it("lists multiple workers", async () => {
      const reg = new WorkerRegistry(tmpDir);
      await reg.load();

      await reg.register("https://pod-1.proxy.runpod.net", "w1");
      await reg.register("https://pod-2.proxy.runpod.net", "w2");
      await reg.register("https://pod-3.proxy.runpod.net", "w3");

      const list = reg.list();
      assert.equal(list.length, 3);
      assert.ok(list.some((w) => w.name === "w1"));
      assert.ok(list.some((w) => w.name === "w2"));
      assert.ok(list.some((w) => w.name === "w3"));
    });
  });

  describe("updateHealth", () => {
    it("updates health info", async () => {
      const reg = new WorkerRegistry(tmpDir);
      await reg.load();

      const entry = await reg.register("https://pod-1.proxy.runpod.net");
      await reg.updateHealth(entry.workerId, {
        status: "busy",
        uptime: 3600,
        currentTask: { taskId: "t-1", status: "running" },
      });

      const updated = reg.get(entry.workerId)!;
      assert.equal(updated.lastHealth?.status, "busy");
      assert.equal(updated.lastHealth?.uptime, 3600);
    });

    it("throws for unknown worker", async () => {
      const reg = new WorkerRegistry(tmpDir);
      await reg.load();

      await assert.rejects(
        () => reg.updateHealth("w-nonexistent", { status: "ok", uptime: 0 }),
        /Worker not found/,
      );
    });
  });

  describe("persistence across instances", () => {
    it("survives reload", async () => {
      const reg1 = new WorkerRegistry(tmpDir);
      await reg1.load();
      await reg1.register("https://pod-1.proxy.runpod.net", "w1");
      await reg1.register("https://pod-2.proxy.runpod.net", "w2");

      const reg2 = new WorkerRegistry(tmpDir);
      await reg2.load();
      assert.equal(reg2.size, 2);
      assert.ok(reg2.list().some((w) => w.name === "w1"));
      assert.ok(reg2.list().some((w) => w.name === "w2"));
    });
  });
});
