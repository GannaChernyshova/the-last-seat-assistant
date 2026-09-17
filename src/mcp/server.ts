import { AsyncLocalStorage } from "node:async_hooks";
import type { Server } from "node:http";
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Pool } from "pg";
import {
  registerWorkshopTools,
  type TrustedBookingContext
} from "./tools.ts";

export const WORKSHOP_MCP_PORT = 3101;

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

interface StartedWorkshopMcpServer {
  close(): Promise<void>;
}

function header(request: Request, name: string): string | undefined {
  const value = request.header(name);
  return value && value.length > 0 ? value : undefined;
}

function bookingContext(request: Request): TrustedBookingContext | undefined {
  const attendeeId = header(request, "x-attendee-id");
  const attendeeName = header(request, "x-attendee-name");
  const attendeeEmail = header(request, "x-attendee-email");
  const requestId = header(request, "x-booking-request-id");
  if (!attendeeId || !attendeeName || !attendeeEmail || !requestId) return undefined;

  return {
    attendee: { id: attendeeId, name: attendeeName, email: attendeeEmail },
    requestId
  };
}

export async function startWorkshopMcpServer(
  pool: Pool,
  options: { host?: string; port?: number } = {}
): Promise<StartedWorkshopMcpServer> {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const context = new AsyncLocalStorage<TrustedBookingContext | undefined>();
  const sessions = new Map<string, SessionEntry>();

  const createSessionServer = (): McpServer => {
    const server = new McpServer({ name: "the-last-seat-workshops", version: "1.0.0" });
    registerWorkshopTools(server, pool, () => context.getStore());
    return server;
  };

  app.get("/health", (_request, response) => {
    response.json({ status: "ok", protocol: "mcp-streamable-http" });
  });

  const handlePost = async (request: Request, response: Response): Promise<void> => {
    const sessionId = header(request, "mcp-session-id");
    let session = sessionId ? sessions.get(sessionId) : undefined;

    if (!session && !sessionId && isInitializeRequest(request.body)) {
      const server = createSessionServer();
      let transport!: StreamableHTTPServerTransport;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (initializedSessionId) => {
          sessions.set(initializedSessionId, { transport, server });
        }
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      session = { server, transport };
    }

    if (!session) {
      response.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Invalid or missing MCP session" },
        id: null
      });
      return;
    }

    await context.run(bookingContext(request), async () => {
      await session.transport.handleRequest(request, response, request.body);
    });
  };

  app.post("/mcp", (request, response) => {
    void handlePost(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal MCP error"
          },
          id: null
        });
      }
    });
  });

  const handleSessionRequest = async (
    request: Request,
    response: Response
  ): Promise<void> => {
    const sessionId = header(request, "mcp-session-id");
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      response.status(400).send("Invalid or missing MCP session");
      return;
    }
    await session.transport.handleRequest(request, response);
  };

  app.get("/mcp", handleSessionRequest);
  app.delete("/mcp", handleSessionRequest);

  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? WORKSHOP_MCP_PORT;
  const httpServer = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(port, host, () => resolve(listening));
    listening.once("error", reject);
  });

  return {
    async close(): Promise<void> {
      await Promise.allSettled(
        [...sessions.values()].map(async ({ transport, server }) => {
          await transport.close();
          await server.close();
        })
      );
      sessions.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}
