import { createPool } from "../db/database.ts";
import {
  startWorkshopMcpServer,
  WORKSHOP_MCP_PORT
} from "./server.ts";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const configuredPort = Number.parseInt(
  process.env.PORT ?? String(WORKSHOP_MCP_PORT),
  10
);
if (!Number.isInteger(configuredPort) || configuredPort <= 0) {
  throw new Error("PORT must be a positive integer");
}

const pool = createPool(databaseUrl);
await pool.query("SELECT 1");
const mcpServer = await startWorkshopMcpServer(pool, {
  host: "0.0.0.0",
  port: configuredPort
});

console.log(`Workshop MCP server listening on 0.0.0.0:${configuredPort}`);

let closing = false;
const shutdown = async (): Promise<void> => {
  if (closing) return;
  closing = true;
  await mcpServer.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
};

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
