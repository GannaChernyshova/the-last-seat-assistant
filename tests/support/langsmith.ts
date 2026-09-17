import "dotenv/config";
import { awaitAllCallbacks } from "@langchain/core/callbacks/promises";
import { traceable } from "langsmith/traceable";
import { RunTree } from "langsmith/run_trees";
import { configureLangSmith } from "../../src/observability/langsmith.ts";
import type { WorkflowOutcome } from "../../src/shared/types.ts";
import type { Scenario } from "./scenarios.ts";
import { summarizeOutcome } from "../../src/observability/workflow.ts";

interface TestTrace {
  testName: string;
  scenario: Scenario;
  requestId: string;
  attendeeId: string;
}

export async function runWithTestTrace(
  trace: TestTrace,
  runWorkflow: () => Promise<WorkflowOutcome>
): Promise<WorkflowOutcome> {
  configureLangSmith();
  const tracedWorkflow = traceable(runWorkflow, {
    name: trace.testName,
    run_type: "chain",
    tags: ["the-last-seat", "integration-test", trace.scenario],
    metadata: {
      source: "vitest",
      ...trace,
      modelService: "microcks",
      toolProtocol: "mcp-streamable-http"
    },
    processInputs: () => ({
      requestId: trace.requestId,
      scenario: trace.scenario,
      attendeeId: trace.attendeeId
    }),
    processOutputs: summarizeOutcome
  });

  return tracedWorkflow();
}

export async function flushTestTraces(): Promise<void> {
  await Promise.all([
    awaitAllCallbacks(),
    RunTree.getSharedClient().awaitPendingTraceBatches()
  ]);
}
