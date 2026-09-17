import type { WorkflowConfig } from "../shared/types.ts";

export const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = {
  modelTimeoutMs: 20_000,
  mcpTimeoutMs: 2_000,
  workflowDeadlineMs: 60_000,
  modelMaxRetries: 0,
  mcpMaxRetries: 0
};
