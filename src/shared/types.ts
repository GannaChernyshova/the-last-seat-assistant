import type { z } from "zod";
import type { reservationSchema, workshopSchema } from "./contracts.ts";

export interface Attendee {
  id: string;
  name: string;
  email: string;
}

export type Workshop = z.infer<typeof workshopSchema>;
export type Reservation = z.infer<typeof reservationSchema>;

export type TimelineKind =
  | "workflow"
  | "model"
  | "tool"
  | "database"
  | "timeout"
  | "retry"
  | "recovery";

export interface TimelineEvent {
  id: string;
  at: string;
  elapsedMs: number;
  kind: TimelineKind;
  phase: string;
  label: string;
  status: "started" | "succeeded" | "failed" | "unknown" | "info";
  metadata?: Record<string, unknown>;
}

export interface AttemptCounts {
  model: number;
  search: number;
  reserve: number;
  reconcile: number;
}

export interface WorkflowOutcome {
  workflowId: string;
  requestId: string;
  status: "unknown" | "confirmed" | "unavailable" | "failed";
  message: string;
  reservation?: Reservation;
  timeline: TimelineEvent[];
  attempts: AttemptCounts;
  modelToolCalls: Array<{ name: string; arguments: unknown; callId: string }>;
  durationMs: number;
  langsmithTraceId?: string;
}

export interface WorkflowConfig {
  modelTimeoutMs: number;
  mcpTimeoutMs: number;
  workflowDeadlineMs: number;
  modelMaxRetries: number;
  mcpMaxRetries: number;
}

export interface RunWorkflowInput {
  prompt: string;
  attendee: Attendee;
  requestId?: string;
  config?: Partial<WorkflowConfig>;
}

export interface DemoState {
  workshops: Workshop[];
  reservations: Reservation[];
}
