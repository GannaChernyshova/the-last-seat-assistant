import { randomUUID } from "node:crypto";
import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage
} from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import {
  bookingTools,
  searchInputSchema,
  reserveInputSchema,
  workshopSchema,
  reservationSchema
} from "../shared/contracts.ts";
import { DEFAULT_WORKFLOW_CONFIG } from "./config.ts";
import { traceMcpCall } from "../observability/workflow.ts";
import { parseMcpJson, WorkshopMcpClient } from "../mcp/client.ts";
import type {
  AttemptCounts,
  Reservation,
  RunWorkflowInput,
  TimelineEvent,
  TimelineKind,
  WorkflowOutcome
} from "../shared/types.ts";

interface WorkflowDependencies {
  mcpUrl: string;
  modelApiKey: string;
  modelName?: string;
  modelBaseUrl?: string;
  modelHeaders?: Record<string, string>;
}

class Deadline {
  readonly startedAt = Date.now();
  readonly controller = new AbortController();
  readonly limitMs: number;
  private readonly timer: NodeJS.Timeout;

  constructor(limitMs: number) {
    this.limitMs = limitMs;
    this.timer = setTimeout(
      () => this.controller.abort(new Error("Overall workflow deadline exceeded")),
      limitMs
    );
  }

  remainingMs(): number {
    return Math.max(0, this.limitMs - (Date.now() - this.startedAt));
  }

  timeoutFor(configuredMs: number): number {
    const remaining = this.remainingMs();
    if (remaining <= 0 || this.controller.signal.aborted) {
      throw new Error("Overall workflow deadline exceeded");
    }
    return Math.max(1, Math.min(configuredMs, remaining));
  }

  assertCanStart(phase: string): void {
    if (this.remainingMs() <= 0 || this.controller.signal.aborted) {
      throw new Error(`Overall workflow deadline exceeded before ${phase}`);
    }
  }

  close(): void {
    clearTimeout(this.timer);
  }
}

class Timeline {
  private readonly events: TimelineEvent[] = [];
  private readonly startedAt: number;

  constructor(startedAt: number) {
    this.startedAt = startedAt;
  }

  add(
    kind: TimelineKind,
    phase: string,
    label: string,
    status: TimelineEvent["status"],
    metadata?: Record<string, unknown>
  ): void {
    const occurredAt = new Date();
    this.events.push({
      id: randomUUID(),
      at: occurredAt.toISOString(),
      elapsedMs: Math.max(0, occurredAt.getTime() - this.startedAt),
      kind,
      phase,
      label,
      status,
      ...(metadata ? { metadata } : {})
    });
  }

  all(): TimelineEvent[] {
    return [...this.events];
  }
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /timeout|timed out|deadline|aborted/i.test(`${error.name} ${error.message}`);
}

function modelErrorMetadata(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") {
    return {};
  }
  const value = error as Record<string, unknown>;
  return {
    ...(typeof value.status === "number" ? { status: value.status } : {}),
    ...(typeof value.code === "string" ? { code: value.code } : {}),
    ...(typeof value.type === "string" ? { type: value.type } : {})
  };
}

function modelFailureMessage(error: unknown): string {
  if (isTimeout(error)) {
    return "The model did not respond within the configured timeout. No booking action was taken.";
  }

  const metadata = modelErrorMetadata(error);
  const message = error instanceof Error ? error.message : "";
  if (
    metadata.code === "credit_balance_exhausted" ||
    /no credits|credit balance exhausted/i.test(message)
  ) {
    return "OpenAI reports that the organization associated with this API key has no prepaid credits available. Check that the key belongs to the organization showing your balance.";
  }
  if (metadata.code === "project_spend_limit_exceeded") {
    return "The OpenAI project associated with this API key has reached its spend limit.";
  }
  if (metadata.code === "organization_spend_limit_exceeded") {
    return "The OpenAI organization associated with this API key has reached its spend limit.";
  }
  if (
    metadata.code === "organization_usage_limit_exceeded" ||
    metadata.type === "insufficient_quota"
  ) {
    return "OpenAI rejected the request because the configured API key has no available quota. Check its organization, project, and usage limits.";
  }
  if (metadata.status === 401) {
    return "The model service rejected the configured API key. Check OPENAI_API_KEY and restart the application.";
  }
  if (metadata.status === 429) {
    return "The model service rate-limited the booking request. No booking action was taken; try again later.";
  }
  return "The model request failed before the booking could complete.";
}

function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part && "text" in part ? String(part.text) : ""
      )
      .join("");
  }
  return "";
}

export class LastSeatWorkflow {
  private readonly dependencies: WorkflowDependencies;

  constructor(dependencies: WorkflowDependencies) {
    this.dependencies = dependencies;
  }

  async run(input: RunWorkflowInput): Promise<WorkflowOutcome> {
    const workflowId = randomUUID();
    const requestId = input.requestId ?? randomUUID();
    const config = { ...DEFAULT_WORKFLOW_CONFIG, ...input.config };
    const deadline = new Deadline(config.workflowDeadlineMs);
    const timeline = new Timeline(deadline.startedAt);
    const attempts: AttemptCounts = { model: 0, search: 0, reserve: 0, reconcile: 0 };
    const modelToolCalls: WorkflowOutcome["modelToolCalls"] = [];
    const mcp = new WorkshopMcpClient(
      this.dependencies.mcpUrl,
      input.attendee,
      requestId
    );

    let hasSearchResults = false;
    let authoritativeReservation: Reservation | undefined;
    let terminalStatus: WorkflowOutcome["status"] | undefined;
    let finalMessage = "The workflow ended without a result.";

    const finish = (status: WorkflowOutcome["status"], message: string): WorkflowOutcome => {
      timeline.add("workflow", "complete", "Workflow completed", "info", { status });
      return {
        workflowId,
        requestId,
        status,
        message,
        ...(authoritativeReservation ? { reservation: authoritativeReservation } : {}),
        timeline: timeline.all(),
        attempts,
        modelToolCalls,
        durationMs: Date.now() - deadline.startedAt
      };
    };

    timeline.add("workflow", "start", "Booking intent accepted", "started", {
      requestId
    });

    try {
      deadline.assertCanStart("MCP initialization");
      timeline.add("tool", "mcp.initialize", "Initialize MCP session", "started");
      const discoveredTools = await mcp.connectAndDiscover(
        deadline.timeoutFor(config.mcpTimeoutMs),
        deadline.controller.signal
      );
      for (const requiredTool of [
        "search_workshops",
        "reserve_seat",
        "get_reservation"
      ]) {
        if (!discoveredTools.includes(requiredTool)) {
          throw new Error(`MCP server did not expose ${requiredTool}`);
        }
      }
      timeline.add("tool", "mcp.discover", "Discovered three MCP tools", "succeeded", {
        tools: discoveredTools,
        sessionId: mcp.sessionId
      });

      const baseModel = new ChatOpenAI({
        model: this.dependencies.modelName ?? "gpt-5-mini",
        apiKey: this.dependencies.modelApiKey,
        maxRetries: 0,
        timeout: config.modelTimeoutMs,
        useResponsesApi: false,
        ...(this.dependencies.modelBaseUrl || this.dependencies.modelHeaders
          ? {
              configuration: {
                ...(this.dependencies.modelBaseUrl
                  ? { baseURL: this.dependencies.modelBaseUrl }
                  : {}),
                ...(this.dependencies.modelHeaders
                  ? { defaultHeaders: this.dependencies.modelHeaders }
                  : {})
              }
            }
          : {})
      });

      const messages: BaseMessage[] = [
        new SystemMessage(
          "You are a conference booking agent. Search before booking. Never invent availability. " +
            "The application injects attendee identity and idempotency keys; do not request or supply them."
        ),
        new HumanMessage(input.prompt)
      ];

      let modelCallNumber = 0;
      let lastToolFailed = false;
      let lastToolChoice = "auto";

      const invokeModel = async () => {
        modelCallNumber += 1;
        lastToolChoice =
          authoritativeReservation || terminalStatus === "unavailable" || lastToolFailed
            ? "none"
            : hasSearchResults
              ? "reserve_seat"
              : "search_workshops";
        const model = baseModel.bindTools(bookingTools, {
          tool_choice: lastToolChoice,
          parallel_tool_calls: false,
          strict: true
        });
        let lastError: unknown;
        for (let attempt = 1; attempt <= config.modelMaxRetries + 1; attempt += 1) {
          deadline.assertCanStart("model call");
          attempts.model += 1;
          if (attempt > 1) {
            timeline.add("retry", "model.request", "Retry model request", "started", {
              callNumber: modelCallNumber,
              attempt
            });
          }
          timeline.add("model", "model.request", "Request model", "started", {
            callNumber: modelCallNumber,
            attempt,
            messageCount: messages.length,
            toolChoice: lastToolChoice
          });
          try {
            const response = await model.invoke(messages, {
              signal: deadline.controller.signal,
              runName: "model_chat_completions",
              tags: ["model", "chat-completions"],
              metadata: {
                workflowId,
                requestId,
                callNumber: modelCallNumber,
                attempt,
                toolChoice: lastToolChoice,
                api: "chat-completions",
                route: "model-api"
              }
            });
            timeline.add("model", "model.response", "Model responded", "succeeded", {
              callNumber: modelCallNumber,
              attempt,
              toolCalls: (response.tool_calls ?? []).map((call) => ({
                name: call.name,
                callId: call.id
              })),
              finishReason: response.response_metadata.finish_reason
            });
            return response;
          } catch (error) {
            lastError = error;
            timeline.add(
              isTimeout(error) ? "timeout" : "model",
              "model.response",
              isTimeout(error) ? "Model request timed out" : "Model request failed",
              "failed",
              {
                callNumber: modelCallNumber,
                attempt,
                ...modelErrorMetadata(error)
              }
            );
            if (attempt > config.modelMaxRetries) {
              throw error;
            }
          }
        }
        throw lastError;
      };

      const callMcp = async (
        name: "search_workshops" | "reserve_seat" | "get_reservation",
        args: Record<string, unknown>,
        maxRetries: number
      ) => {
        let lastError: unknown;
        for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
          deadline.assertCanStart(`${name} tool call`);
          if (name === "search_workshops") attempts.search += 1;
          if (name === "reserve_seat") attempts.reserve += 1;
          if (name === "get_reservation") attempts.reconcile += 1;
          if (attempt > 1) {
            timeline.add("retry", `tool.${name}`, `Retry ${name}`, "started", {
              attempt
            });
          }
          timeline.add("tool", `tool.${name}`, `Call ${name} over MCP`, "started", {
            attempt,
            arguments: args
          });
          try {
            const result = await traceMcpCall(
              { workflowId, requestId, tool: name, arguments: args, attempt },
              () => mcp.callTool(
                name,
                args,
                deadline.timeoutFor(config.mcpTimeoutMs),
                deadline.controller.signal
              )
            );
            timeline.add(
              "tool",
              `tool.${name}`,
              `${name} returned`,
              result.isError ? "failed" : "succeeded",
              { attempt, result: parseMcpJson(result) }
            );
            return result;
          } catch (error) {
            lastError = error;
            // A timed-out write has an unknown outcome. It must be reconciled, not blindly retried.
            const shouldRetry = name !== "reserve_seat" && attempt <= maxRetries;
            if (!shouldRetry) {
              throw error;
            }
            timeline.add(
              isTimeout(error) ? "timeout" : "tool",
              `tool.${name}`,
              isTimeout(error) ? `${name} timed out` : `${name} failed`,
              "failed",
              { attempt }
            );
          }
        }
        throw lastError;
      };

      for (let turn = 0; turn < 6; turn += 1) {
        let response;
        try {
          response = await invokeModel();
        } catch (error) {
          if (authoritativeReservation) {
            timeline.add(
              "recovery",
              "fallback.confirmation",
              "Use authoritative reservation after final model failure",
              "succeeded"
            );
            terminalStatus = "confirmed";
            finalMessage = `Reservation confirmed for ${authoritativeReservation.workshopTitle}. The final model explanation was unavailable.`;
            break;
          }
          terminalStatus = "failed";
          finalMessage = modelFailureMessage(error);
          break;
        }

        messages.push(response);
        const toolCalls = response.tool_calls ?? [];
        if (toolCalls.length === 0) {
          if (authoritativeReservation) {
            terminalStatus = "confirmed";
            finalMessage = contentText(response.content) ||
              `Reservation confirmed for ${authoritativeReservation.workshopTitle}.`;
          } else if (terminalStatus === "unavailable") {
            finalMessage = contentText(response.content) || finalMessage;
          } else if (lastToolFailed) {
            terminalStatus = "failed";
            finalMessage = contentText(response.content) || "The booking tool failed.";
          } else {
            terminalStatus = "failed";
            finalMessage = lastToolChoice === "search_workshops"
              ? "The model did not call search_workshops, so no availability was invented and no reservation was attempted."
              : "The model stopped without producing a booking result.";
          }
          break;
        }

        if (toolCalls.length !== 1) {
          terminalStatus = "failed";
          finalMessage = "The booking workflow accepts exactly one tool call per model turn.";
          break;
        }

        const toolCall = toolCalls[0];
        if (!toolCall) {
          throw new Error("Model returned an empty tool-call list");
        }
        const callId = toolCall.id ?? `call-${modelCallNumber}`;
        modelToolCalls.push({ name: toolCall.name, arguments: toolCall.args, callId });

        if (toolCall.name === "search_workshops") {
          const parsed = searchInputSchema.safeParse(toolCall.args);
          if (!parsed.success) {
            timeline.add("tool", "tool.validation", "Reject invalid search arguments", "failed", {
              issues: parsed.error.issues
            });
            terminalStatus = "failed";
            finalMessage = "The model supplied invalid arguments; no tool was executed.";
            break;
          }
          try {
            const toolResult = await callMcp(
              "search_workshops",
              parsed.data,
              config.mcpMaxRetries
            );
            const payload = parseMcpJson(toolResult);
            const parsedPayload = z
              .object({ status: z.literal("ok"), workshops: z.array(workshopSchema) })
              .parse(payload);
            hasSearchResults = parsedPayload.workshops.length > 0;
            if (!hasSearchResults) {
              terminalStatus = "unavailable";
              finalMessage = "No workshops match your requested topic and time of day.";
              break;
            }
            messages.push(
              new ToolMessage({
                content: JSON.stringify(payload),
                tool_call_id: callId,
                status: toolResult.isError ? "error" : "success",
                name: "search_workshops"
              })
            );
          } catch (error) {
            timeline.add(
              isTimeout(error) ? "timeout" : "tool",
              "tool.search_workshops",
              isTimeout(error) ? "Workshop search timed out" : "Workshop search failed",
              "failed"
            );
            terminalStatus = "failed";
            finalMessage = isTimeout(error)
              ? "Workshop availability is temporarily unavailable because the search timed out. No reservation was attempted."
              : "Workshop search failed. No reservation was attempted.";
            break;
          }
          continue;
        }

        if (toolCall.name === "reserve_seat") {
          const parsed = reserveInputSchema.safeParse(toolCall.args);
          if (!parsed.success) {
            timeline.add("tool", "tool.validation", "Reject invalid reservation arguments", "failed", {
              issues: parsed.error.issues
            });
            terminalStatus = "failed";
            finalMessage = "The model supplied invalid reservation arguments; the database was not changed.";
            break;
          }

          try {
            const toolResult = await callMcp("reserve_seat", parsed.data, 0);
            const payload = parseMcpJson(toolResult);
            lastToolFailed = Boolean(toolResult.isError);
            if (!toolResult.isError && payload.status === "confirmed") {
              authoritativeReservation = reservationSchema.parse(payload.reservation);
              terminalStatus = "confirmed";
              timeline.add("database", "reservation.commit", "Reservation is authoritative", "succeeded", {
                reservationId: authoritativeReservation.id,
                replayed: payload.replayed
              });
            } else if (!toolResult.isError && payload.status === "unavailable") {
              terminalStatus = "unavailable";
              finalMessage = String(payload.reason ?? "The workshop has no remaining seats.");
            }
            messages.push(
              new ToolMessage({
                content: JSON.stringify(payload),
                tool_call_id: callId,
                status: toolResult.isError ? "error" : "success",
                name: "reserve_seat"
              })
            );
          } catch (error) {
            if (!isTimeout(error)) {
              timeline.add("tool", "tool.reserve_seat", "Reservation call failed", "failed");
              terminalStatus = "failed";
              finalMessage = "The reservation tool failed before an outcome was returned.";
              break;
            }

            terminalStatus = "failed";
            timeline.add(
              "timeout",
              "tool.reserve_seat",
              "Reservation response timed out; outcome is unknown",
              "unknown",
              { requestId }
            );

            try {
              deadline.assertCanStart("reservation reconciliation");
              timeline.add(
                "recovery",
                "reservation.reconcile",
                "Reconcile the idempotency key",
                "started",
                { requestId }
              );
              const reconciliation = await callMcp(
                "get_reservation",
                { requestId },
                config.mcpMaxRetries
              );
              const payload = parseMcpJson(reconciliation);
              if (payload.status !== "confirmed") {
                terminalStatus = "unknown";
                finalMessage = "The reservation outcome remains unknown; retry reconciliation with the same request ID.";
                break;
              }
              authoritativeReservation = reservationSchema.parse(payload.reservation);
              terminalStatus = "confirmed";
              timeline.add(
                "recovery",
                "reservation.reconcile",
                "Recovered the committed reservation without another write",
                "succeeded",
                { reservationId: authoritativeReservation.id }
              );
              messages.push(
                new ToolMessage({
                  content: JSON.stringify({
                    status: "confirmed",
                    reservation: authoritativeReservation,
                    replayed: true,
                    recovered: true
                  }),
                  tool_call_id: callId,
                  status: "success",
                  name: "reserve_seat"
                })
              );
            } catch (reconciliationError) {
              terminalStatus = "unknown";
              finalMessage = "The reservation may have committed, but reconciliation did not complete before the deadline.";
              timeline.add(
                isTimeout(reconciliationError) ? "timeout" : "recovery",
                "reservation.reconcile",
                "Reservation reconciliation failed",
                "failed"
              );
              break;
            }
          }
          continue;
        }

        timeline.add("tool", "tool.validation", "Reject unknown tool name", "failed", {
          name: toolCall.name
        });
        terminalStatus = "failed";
        finalMessage = `The model requested an unknown tool: ${toolCall.name}.`;
        break;
      }

      if (!terminalStatus) {
        terminalStatus = authoritativeReservation ? "confirmed" : "failed";
        finalMessage = authoritativeReservation
          ? `Reservation confirmed for ${authoritativeReservation.workshopTitle}.`
          : "The agent exceeded its bounded turn limit without a booking.";
      }
      return finish(terminalStatus, finalMessage);
    } catch (error) {
      timeline.add(
        isTimeout(error) ? "timeout" : "workflow",
        "workflow.error",
        isTimeout(error) ? "Workflow deadline exceeded" : "Workflow failed",
        "failed",
        { error: error instanceof Error ? error.message : String(error) }
      );
      return finish(
        authoritativeReservation ? "confirmed" : "failed",
        authoritativeReservation
          ? `Reservation confirmed for ${authoritativeReservation.workshopTitle}. The explanation step did not complete.`
          : error instanceof Error
            ? error.message
            : "The workflow failed"
      );
    } finally {
      deadline.close();
      await mcp.close().catch(() => undefined);
    }
  }
}
