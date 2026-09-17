import "dotenv/config";
import { createBackend, listen, type BackendEnvironment } from "./server.ts";

const env: BackendEnvironment = {
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgresql://last_seat:last_seat@localhost:5432/last_seat",
  MCP_URL: process.env.MCP_URL ?? "http://localhost:3101/mcp",
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  MODEL_TIMEOUT_MS: process.env.MODEL_TIMEOUT_MS,
  MCP_TIMEOUT_MS: process.env.MCP_TIMEOUT_MS,
  WORKFLOW_DEADLINE_MS: process.env.WORKFLOW_DEADLINE_MS,
  MODEL_MAX_RETRIES: process.env.MODEL_MAX_RETRIES,
  MCP_MAX_RETRIES: process.env.MCP_MAX_RETRIES
};

const backend = await createBackend(env);
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const server = await listen(backend, port);
console.log(`The Last Seat API listening on http://localhost:${port}`);

const shutdown = async (): Promise<void> => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await backend.close();
};

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
