import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import express from "express";
import { z } from "zod";
import { LastSeatWorkflow } from "../agent/workflow.ts";
import { DEFAULT_WORKFLOW_CONFIG } from "../agent/config.ts";
import { traceBooking } from "../observability/workflow.ts";
import {
  createPool,
  getDemoState,
  migrate,
  resetDemoData
} from "../db/database.ts";
import type { WorkflowConfig } from "../shared/types.ts";
import { configureLangSmith } from "../observability/langsmith.ts";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

const runInputSchema = z.object({
  prompt: z.string().min(1).default(
    "Find an afternoon workshop about testing AI applications and reserve a seat for me."
  ),
  attendee: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    email: z.string().email()
  }),
  requestId: z.string().uuid().optional()
});

export interface BackendEnvironment {
  DATABASE_URL: string;
  MCP_URL: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  MODEL_TIMEOUT_MS?: string;
  MCP_TIMEOUT_MS?: string;
  WORKFLOW_DEADLINE_MS?: string;
  MODEL_MAX_RETRIES?: string;
  MCP_MAX_RETRIES?: string;
}

interface StartedBackend {
  app: express.Express;
  close(): Promise<void>;
}

function integer(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function workflowConfig(env: BackendEnvironment): WorkflowConfig {
  return {
    modelTimeoutMs: integer(env.MODEL_TIMEOUT_MS, DEFAULT_WORKFLOW_CONFIG.modelTimeoutMs),
    mcpTimeoutMs: integer(env.MCP_TIMEOUT_MS, DEFAULT_WORKFLOW_CONFIG.mcpTimeoutMs),
    workflowDeadlineMs: integer(env.WORKFLOW_DEADLINE_MS, DEFAULT_WORKFLOW_CONFIG.workflowDeadlineMs),
    modelMaxRetries: integer(env.MODEL_MAX_RETRIES, DEFAULT_WORKFLOW_CONFIG.modelMaxRetries),
    mcpMaxRetries: integer(env.MCP_MAX_RETRIES, DEFAULT_WORKFLOW_CONFIG.mcpMaxRetries)
  };
}

function openAiApiKey(env: BackendEnvironment): string {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required to run the browser application");
  }
  return env.OPENAI_API_KEY;
}

export async function createBackend(env: BackendEnvironment): Promise<StartedBackend> {
  const langsmith = configureLangSmith();
  const modelApiKey = openAiApiKey(env);
  const config = workflowConfig(env);
  const workflow = new LastSeatWorkflow({
    mcpUrl: env.MCP_URL,
    modelApiKey,
    ...(env.OPENAI_MODEL ? { modelName: env.OPENAI_MODEL } : {})
  });
  const pool = createPool(env.DATABASE_URL);
  await migrate(pool);
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      modelApi: "chat-completions",
      retries: "disabled-by-default",
      langsmith
    });
  });

  app.get("/api/state", async (_req, res) => {
    res.json(await getDemoState(pool));
  });

  app.post("/api/reset", async (_req, res) => {
    await resetDemoData(pool);
    res.json(await getDemoState(pool));
  });

  app.post("/api/run", async (req, res) => {
    const parsed = runInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", issues: parsed.error.issues });
      return;
    }
    const requestId = parsed.data.requestId ?? randomUUID();
    const outcome = await traceBooking(
      { requestId, attendeeId: parsed.data.attendee.id },
      langsmith,
      () => workflow.run({ ...parsed.data, requestId, config })
    );
    res.json({ outcome, state: await getDemoState(pool) });
  });

  const uiDirectory = path.resolve(moduleDirectory, "../../dist/ui");
  app.use(express.static(uiDirectory));
  app.get("/{*path}", (_req, res, next) => {
    res.sendFile(path.join(uiDirectory, "index.html"), (error) => {
      if (error) next();
    });
  });

  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      const message = error instanceof Error ? error.message : "Unexpected server error";
      res.status(500).json({ error: message });
    }
  );

  return {
    app,
    async close(): Promise<void> {
      await pool.end();
    }
  };
}

export async function listen(
  backend: StartedBackend,
  port: number,
  host = "0.0.0.0"
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = backend.app.listen(port, host, () => resolve(server));
    server.once("error", reject);
  });
}
