// Worker HTTP server — Express 5 endpoints for task management

import express, { type Request, type Response, type NextFunction } from "express";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, resolve } from "node:path";
import { TaskExecutor } from "./task_executor.js";
import { validateTaskPayload } from "../shared/types.js";
import type { TaskPayload, Feedback, FeedbackAction } from "../shared/types.js";

const RELAY_AUTH_TOKEN = process.env.RELAY_AUTH_TOKEN ?? "";
const RELAY_PORT = parseInt(process.env.RELAY_PORT ?? "8080", 10);
const RELAY_WORKSPACE = process.env.RELAY_WORKSPACE ?? "/workspace";

export function createApp(executor: TaskExecutor): express.Express {
  const app = express();
  app.use(express.json());

  // Auth middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/health") return next();

    const token = req.headers.authorization?.replace("Bearer ", "");
    if (!RELAY_AUTH_TOKEN || token === RELAY_AUTH_TOKEN) {
      return next();
    }
    res.status(401).json({ error: "Unauthorized" });
  });

  // GET /health
  app.get("/health", (_req: Request, res: Response) => {
    const task = executor.getTask();
    const uptime = process.uptime();
    res.json({
      status: task ? "busy" : "ok",
      uptime: Math.floor(uptime),
      currentTask: task ? { taskId: task.taskId, status: task.status } : undefined,
    });
  });

  // POST /task
  app.post("/task", async (req: Request, res: Response) => {
    const payload = req.body as TaskPayload;
    const error = validateTaskPayload(payload);
    if (error) {
      res.status(400).json({ error });
      return;
    }

    try {
      const task = await executor.dispatch(payload);
      res.status(201).json(task);
    } catch (err: any) {
      res.status(409).json({ error: err.message });
    }
  });

  // GET /task/:id/status
  app.get("/task/:id/status", (req: Request, res: Response) => {
    const task = executor.getTask();
    if (task && task.taskId === req.params.id) {
      res.json(task);
      return;
    }
    // Check history
    const hist = executor.getHistory().find((t) => t.taskId === req.params.id);
    if (hist) {
      res.json(hist);
      return;
    }
    res.status(404).json({ error: "Task not found" });
  });

  // GET /task/:id/report
  app.get("/task/:id/report", (req: Request, res: Response) => {
    const task = executor.getTask();
    if (!task || task.taskId !== req.params.id) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const report = executor.getLastReport();
    if (!report) {
      res.status(404).json({ error: "No report available" });
      return;
    }
    res.json(report);
  });

  // POST /task/:id/feedback
  app.post("/task/:id/feedback", async (req: Request, res: Response) => {
    const { action, message } = req.body as { action?: string; message?: string };
    if (!action || !["continue", "revise", "abort"].includes(action)) {
      res.status(400).json({ error: "Invalid feedback action" });
      return;
    }

    const feedback: Feedback = { action: action as FeedbackAction, message };

    try {
      await executor.submitFeedback(req.params.id, feedback);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(409).json({ error: err.message });
    }
  });

  // GET /task/:id/files/*filepath
  app.get("/task/:id/files/*filepath", async (req: Request, res: Response) => {
    const task = executor.getTask();
    const hist = executor.getHistory().find((t) => t.taskId === req.params.id);
    if ((!task || task.taskId !== req.params.id) && !hist) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    const filePath = req.params.filepath as string | undefined;
    if (!filePath) {
      res.status(400).json({ error: "File path required" });
      return;
    }

    // Path traversal protection
    const experimentDir = resolve(RELAY_WORKSPACE, "experiment");
    const fullPath = resolve(experimentDir, normalize(filePath));
    if (!fullPath.startsWith(experimentDir)) {
      res.status(403).json({ error: "Path traversal not allowed" });
      return;
    }

    try {
      const fileStat = await stat(fullPath);
      if (fileStat.size > 10 * 1024 * 1024) {
        res.status(413).json({ error: "File too large (>10MB)" });
        return;
      }

      const content = await readFile(fullPath);
      // Try to send as text, fall back to base64
      try {
        const text = content.toString("utf-8");
        res.json({ path: filePath, encoding: "utf-8", content: text });
      } catch {
        res.json({ path: filePath, encoding: "base64", content: content.toString("base64") });
      }
    } catch {
      res.status(404).json({ error: "File not found" });
    }
  });

  // POST /task/:id/abort
  app.post("/task/:id/abort", async (req: Request, res: Response) => {
    try {
      await executor.abort(req.params.id);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(409).json({ error: err.message });
    }
  });

  return app;
}

// Start server when run directly
async function main() {
  const executor = new TaskExecutor(RELAY_WORKSPACE);
  await executor.initialize();

  const app = createApp(executor);
  app.listen(RELAY_PORT, () => {
    console.log(`Worker server listening on port ${RELAY_PORT}`);
    console.log(`Workspace: ${RELAY_WORKSPACE}`);
  });
}

// Only run main if this is the entry point
const isMain = process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js");
if (isMain) {
  main().catch((err) => {
    console.error("Failed to start worker server:", err);
    process.exit(1);
  });
}
