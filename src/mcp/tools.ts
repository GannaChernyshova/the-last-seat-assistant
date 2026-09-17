import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Pool } from "pg";
import { z } from "zod";
import {
  getReservation,
  IdempotencyConflictError,
  reserveSeat,
  searchWorkshops,
  WorkshopNotFoundError
} from "../db/database.ts";
import type { Attendee } from "../shared/types.ts";
import { searchInputSchema, reserveInputSchema } from "../shared/contracts.ts";

export interface TrustedBookingContext {
  attendee: Attendee;
  requestId: string;
}

function jsonResult(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value
  };
}

function errorResult(error: unknown): CallToolResult {
  const known = error instanceof IdempotencyConflictError ||
    error instanceof WorkshopNotFoundError;
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "error",
          code: known ? error.code : "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : "Unknown tool error"
        })
      }
    ]
  };
}

export function registerWorkshopTools(
  server: McpServer,
  pool: Pool,
  getContext: () => TrustedBookingContext | undefined
): void {
  server.registerTool(
    "search_workshops",
    {
      title: "Search conference workshops",
      description: "Search real conference inventory by topic and time of day.",
      inputSchema: searchInputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ topic, timeOfDay }): Promise<CallToolResult> => {
      const workshops = await searchWorkshops(pool, { topic, timeOfDay });
      return jsonResult({ status: "ok", workshops });
    }
  );

  server.registerTool(
    "reserve_seat",
    {
      title: "Reserve one workshop seat",
      description:
        "Reserve a seat. Attendee identity and the idempotent booking request ID come from trusted application context.",
      inputSchema: reserveInputSchema,
      annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
    },
    async ({ workshopId }): Promise<CallToolResult> => {
      const context = getContext();
      if (!context) {
        return errorResult(new Error("Trusted booking context is missing"));
      }
      try {
        return jsonResult(await reserveSeat(pool, {
          workshopId,
          attendee: context.attendee,
          requestId: context.requestId
        }));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "get_reservation",
    {
      title: "Reconcile a booking request",
      description: "Retrieve the authoritative result of an earlier booking operation.",
      inputSchema: { requestId: z.string().uuid() },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ requestId }): Promise<CallToolResult> => {
      const context = getContext();
      if (!context || context.requestId !== requestId) {
        return errorResult(
          new Error("The request ID does not match trusted application context")
        );
      }
      return jsonResult(await getReservation(pool, requestId));
    }
  );
}
