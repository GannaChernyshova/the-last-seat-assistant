import { traceable } from "langsmith/traceable";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { parseMcpJson } from "../mcp/client.ts";
import type { WorkflowOutcome } from "../shared/types.ts";

function toolResultForTrace(result: CallToolResult): Record<string, unknown> {
  try {
    const payload = parseMcpJson(result);
    const reservation = payload.reservation;
    if (reservation && typeof reservation === "object") {
      return {
        isError: Boolean(result.isError),
        result: {
          ...payload,
          reservation: {
            id: "id" in reservation ? reservation.id : undefined,
            requestId: "requestId" in reservation ? reservation.requestId : undefined,
            workshopId: "workshopId" in reservation ? reservation.workshopId : undefined,
            workshopTitle: "workshopTitle" in reservation ? reservation.workshopTitle : undefined,
            createdAt: "createdAt" in reservation ? reservation.createdAt : undefined
          }
        }
      };
    }
    return { isError: Boolean(result.isError), result: payload };
  } catch {
    return { isError: Boolean(result.isError), contentTypes: result.content.map((item) => item.type) };
  }
}

export function traceMcpCall(
  context: {
    workflowId: string;
    requestId: string;
    tool: string;
    arguments: Record<string, unknown>;
    attempt: number;
  },
  call: () => Promise<CallToolResult>
): Promise<CallToolResult> {
  return traceable(call, {
    name: `mcp_${context.tool}`,
    run_type: "tool",
    tags: ["mcp", "streamable-http", context.tool],
    metadata: {
      workflowId: context.workflowId,
      requestId: context.requestId,
      route: "workshop-mcp-server"
    },
    processInputs: () => ({ tool: context.tool, attempt: context.attempt }),
    processOutputs: (result) => ({
      toolCall: { tool: context.tool, arguments: context.arguments, attempt: context.attempt },
      toolResult: toolResultForTrace(result)
    })
  })();
}

export function summarizeOutcome(outcome: WorkflowOutcome) {
  return {
    status: outcome.status,
    requestId: outcome.requestId,
    durationMs: outcome.durationMs,
    attempts: outcome.attempts,
    toolCalls: outcome.modelToolCalls,
    reservation: outcome.reservation
      ? { id: outcome.reservation.id, workshopId: outcome.reservation.workshopId }
      : undefined
  };
}

export async function traceBooking(
  context: { requestId: string; attendeeId: string },
  tracing: { enabled: boolean },
  run: () => Promise<WorkflowOutcome>
): Promise<WorkflowOutcome> {
  let traceId: string | undefined;
  const outcome = await traceable(run, {
    name: "the_last_seat_workflow",
    run_type: "chain",
    tags: ["the-last-seat", "booking-app"],
    metadata: { ...context, modelApi: "chat-completions", toolProtocol: "mcp-streamable-http" },
    on_start: (runTree) => { traceId = runTree?.id; },
    processInputs: () => context,
    processOutputs: summarizeOutcome
  })();
  if (tracing.enabled && traceId) {
    outcome.langsmithTraceId = traceId;
  }
  return outcome;
}
