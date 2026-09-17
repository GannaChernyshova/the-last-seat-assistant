import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import type { TestcontainersStack } from "../support/testcontainers.ts";
import { startTestcontainers } from "../support/testcontainers.ts";
import { LastSeatWorkflow } from "../../src/agent/workflow.ts";
import { startFaultProxy } from "../support/fault-proxy.ts";
import { flushTestTraces, runWithTestTrace } from "../support/langsmith.ts";
import { getDemoState, searchWorkshops } from "../../src/db/database.ts";
import { parseMcpJson, WorkshopMcpClient } from "../../src/mcp/client.ts";
import type {
  Attendee,
  DemoState,
  WorkflowConfig,
  WorkflowOutcome
} from "../../src/shared/types.ts";
import type { Scenario } from "../support/scenarios.ts";

const PROMPT =
  "Find an afternoon workshop about testing AI applications and reserve a seat for me.";
const TARGET_WORKSHOP_ID = "ws-testing-agentic-workflows";
const CLIENT_TIMEOUT_MS = 250;
const MODEL_RESPONSE_LATENCY_MS = 900;
const MCP_RESPONSE_LATENCY_MS = 800;
const LATE_RESPONSE_SETTLE_MS = MODEL_RESPONSE_LATENCY_MS + 50;
const MAX_BOUNDED_DURATION_MS = 1_500;

const ANNA: Attendee = {
  id: "attendee-anna",
  name: "Anna Developer",
  email: "anna@example.test"
};
const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = {
  modelTimeoutMs: 800,
  mcpTimeoutMs: 450,
  workflowDeadlineMs: 5_000,
  modelMaxRetries: 0,
  mcpMaxRetries: 0
};

let testcontainers: TestcontainersStack;

beforeAll(async () => {
  testcontainers = await startTestcontainers();
}, 180_000);

beforeEach(async () => {
  await testcontainers.reset();
});

afterAll(async () => {
  await testcontainers?.close();
  await flushTestTraces();
});

describe("The Last Seat agentic workflow", () => {
  it("[happy path] books exactly one seat", async () => {
    const outcome = await runScenario("happy");
    const state = await getDemoState(testcontainers.pool);

    expect(outcome.status).toBe("confirmed");
    expect(outcome.reservation?.requestId).toBe(outcome.requestId);
    expect(outcome.attempts).toEqual({ model: 3, search: 1, reserve: 1, reconcile: 0 });
    expect(outcome.modelToolCalls).toEqual([
      {
        name: "search_workshops",
        arguments: { topic: "testing AI applications", timeOfDay: "afternoon" },
        callId: "call_search_001"
      },
      {
        name: "reserve_seat",
        arguments: { workshopId: TARGET_WORKSHOP_ID },
        callId: "call_reserve_001"
      }
    ]);
    expect(state.reservations).toHaveLength(1);
    expect(remainingSeats(state)).toBe(0);
  });

  it("[slow model] bounds the initial response and executes no tools", async () => {
    const startedAt = Date.now();
    const outcome = await runScenario("model_timeout", {
      toxiproxy: { modelLatencyMs: MODEL_RESPONSE_LATENCY_MS },
      config: { modelTimeoutMs: CLIENT_TIMEOUT_MS }
    });
    const elapsed = Date.now() - startedAt;
    const state = await getDemoState(testcontainers.pool);

    expect(outcome.status).toBe("failed");
    expect(outcome.message).toContain("No booking action was taken");
    expect(outcome.attempts).toEqual({ model: 1, search: 0, reserve: 0, reconcile: 0 });
    expect(elapsed).toBeGreaterThanOrEqual(CLIENT_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(MAX_BOUNDED_DURATION_MS);
    expect(outcome.modelToolCalls).toHaveLength(0);
    expect(state.reservations).toHaveLength(0);

    // Let the prescribed delayed reply drain. A late model response cannot resume an ended loop.
    await delay(LATE_RESPONSE_SETTLE_MS);
    expect((await getDemoState(testcontainers.pool)).reservations).toHaveLength(0);
  });

  it("[empty search] stops after one search when no workshops match", async () => {
    await testcontainers.pool.query("UPDATE workshops SET tags = '{}', title = 'Unrelated', description = 'Unrelated'");
    const outcome = await runScenario("happy");

    expect(outcome.status).toBe("unavailable");
    expect(outcome.message).toContain("No workshops match");
    expect(outcome.attempts).toEqual({ model: 1, search: 1, reserve: 0, reconcile: 0 });
    expect((await getDemoState(testcontainers.pool)).reservations).toHaveLength(0);
  });

  it("[search ordering] orders matching workshops by schedule", async () => {
    const workshops = await searchWorkshops(testcontainers.pool, { topic: "testing", timeOfDay: "afternoon" });
    expect(workshops.map((workshop) => workshop.id)).toEqual([
      "ws-evaluating-rag", TARGET_WORKSHOP_ID
    ]);
  });

  it("[session cleanup] releases the server session when the client closes", async () => {
    const client = new WorkshopMcpClient(testcontainers.endpoints.mcpUrl, ANNA, randomUUID());
    try {
      await client.connectAndDiscover(1_000, new AbortController().signal);
      const sessionId = client.sessionId!;
      await client.close();
      const response = await fetch(testcontainers.endpoints.mcpUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("Invalid or missing MCP session");
    } finally {
      await client.close();
    }
  });

  it("[slow search] reports unavailable without fabricating or booking", async () => {
    const outcome = await runScenario("search_timeout", {
      toxiproxy: { mcpLatencyMs: MCP_RESPONSE_LATENCY_MS },
      config: { mcpTimeoutMs: CLIENT_TIMEOUT_MS }
    });
    const state = await getDemoState(testcontainers.pool);

    expect(outcome.status).toBe("failed");
    expect(outcome.message).toContain("availability is temporarily unavailable");
    expect(outcome.attempts).toEqual({ model: 1, search: 1, reserve: 0, reconcile: 0 });
    expect(outcome.modelToolCalls[0]?.arguments).toEqual({
      topic: "testing AI applications",
      timeOfDay: "afternoon"
    });
    expect(state.reservations).toHaveLength(0);
  });

  it("[delayed explanation] keeps the confirmed reservation", async () => {
    const outcome = await runScenario("final_model_timeout", {
      toxiproxy: { modelLatencyMs: MODEL_RESPONSE_LATENCY_MS },
      config: { modelTimeoutMs: CLIENT_TIMEOUT_MS }
    });
    const state = await getDemoState(testcontainers.pool);

    expect(outcome.status).toBe("confirmed");
    expect(outcome.message).toContain("final model explanation was unavailable");
    expect(outcome.reservation).toBeDefined();
    expect(outcome.attempts).toEqual({ model: 3, search: 1, reserve: 1, reconcile: 0 });
    expect(state.reservations).toHaveLength(1);
    expect(outcome.timeline.some((event) => event.phase === "fallback.confirmation")).toBe(true);

    await delay(LATE_RESPONSE_SETTLE_MS);
    expect((await getDemoState(testcontainers.pool)).reservations).toHaveLength(1);
  });

  it("[idempotency] absorbs a repeated reservation tool call", async () => {
    const outcome = await runScenario("repeated_reservation");
    const state = await getDemoState(testcontainers.pool);
    const reserveCalls = outcome.modelToolCalls.filter((call) => call.name === "reserve_seat");

    expect(outcome.status).toBe("confirmed");
    expect(outcome.attempts).toEqual({ model: 4, search: 1, reserve: 2, reconcile: 0 });
    expect(reserveCalls).toHaveLength(2);
    expect(reserveCalls[0]?.arguments).toEqual(reserveCalls[1]?.arguments);
    expect(state.reservations).toHaveLength(1);
    expect(remainingSeats(state)).toBe(0);
  });

  it("[reservation timeout] reconciles a committed write without booking again", async () => {
    const outcome = await runScenario("happy", {
      toxiproxy: { tool: "reserve_seat", mcpLatencyMs: MCP_RESPONSE_LATENCY_MS },
      config: { mcpTimeoutMs: CLIENT_TIMEOUT_MS }
    });
    const state = await getDemoState(testcontainers.pool);

    expect(outcome.status).toBe("confirmed");
    expect(outcome.attempts).toEqual({ model: 3, search: 1, reserve: 1, reconcile: 1 });
    expect(state.reservations).toHaveLength(1);
    expect(remainingSeats(state)).toBe(0);
    expect(outcome.reservation?.id).toBe(state.reservations[0]?.id);
  });

  it("[validation] rejects invalid tool arguments before MCP or database mutation", async () => {
    const outcome = await runScenario("invalid_arguments");
    const state = await getDemoState(testcontainers.pool);

    expect(outcome.status).toBe("failed");
    expect(outcome.message).toContain("invalid reservation arguments");
    expect(outcome.attempts.reserve).toBe(0);
    expect(reservationCall(outcome)?.arguments).toEqual({
      workshopId: 42,
      requestId: "untrusted-model-value"
    });
    expect(state.reservations).toHaveLength(0);
  });

  it("[tool error] surfaces the error without mutating the database", async () => {
    const outcome = await runScenario("tool_error");
    const state = await getDemoState(testcontainers.pool);

    expect(outcome.status).toBe("failed");
    expect(outcome.modelToolCalls.at(-1)?.arguments).toEqual({ workshopId: "ws-does-not-exist" });
    expect(outcome.attempts.reserve).toBe(1);
    expect(state.reservations).toHaveLength(0);
  });

  it("[concurrency] allows only one of two attendees to win the final seat", async () => {
    const bob: Attendee = { id: "attendee-bob", name: "Bob Builder", email: "bob@example.test" };
    const [annaOutcome, bobOutcome] = await Promise.all([
      runScenario("happy", { attendee: ANNA }),
      runScenario("happy", { attendee: bob })
    ]);
    const state = await getDemoState(testcontainers.pool);

    expect([annaOutcome.status, bobOutcome.status].sort()).toEqual(["confirmed", "unavailable"]);
    expect(annaOutcome.attempts.reserve).toBe(1);
    expect(bobOutcome.attempts.reserve).toBe(1);
    expect(state.reservations).toHaveLength(1);
    expect(remainingSeats(state)).toBe(0);
  });

  it("[idempotency conflict] rejects key reuse for another attendee", async () => {
    const requestId = randomUUID();
    const first = await runScenario("happy", { requestId, attendee: ANNA });
    expect(first.status).toBe("confirmed");

    const conflictingClient = new WorkshopMcpClient(
      testcontainers.endpoints.mcpUrl,
      { id: "attendee-eve", name: "Eve Example", email: "eve@example.test" },
      requestId
    );
    const signal = new AbortController().signal;
    await conflictingClient.connectAndDiscover(1_000, signal);
    const result = await conflictingClient.callTool(
      "reserve_seat",
      { workshopId: TARGET_WORKSHOP_ID },
      1_000,
      signal
    );
    await conflictingClient.close();

    expect(result.isError).toBe(true);
    expect(JSON.stringify(parseMcpJson(result))).toContain("IDEMPOTENCY_CONFLICT");
    expect((await getDemoState(testcontainers.pool)).reservations).toHaveLength(1);
  });

  it("[mock contract] makes unmatched Microcks conversations fail visibly", async () => {
    const response = await fetch(`${testcontainers.endpoints.modelBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mock-scenario": "not-a-real-scenario"
      },
      body: JSON.stringify({ model: "microcks-gpt", messages: [] })
    });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("Unexpected model request");
  });
});

interface RunScenarioOptions {
  attendee?: Attendee;
  requestId?: string;
  toxiproxy?: {
    tool?: "reserve_seat";
    modelLatencyMs?: number;
    mcpLatencyMs?: number;
  };
  config?: Partial<WorkflowConfig>;
}

async function runScenario(
  scenario: Scenario,
  options: RunScenarioOptions = {}
): Promise<WorkflowOutcome> {
  const attendee = options.attendee ?? ANNA;
  const requestId = options.requestId ?? randomUUID();
  const testName = expect.getState().currentTestName ?? `[${scenario}] workflow`;
  const proxy = options.toxiproxy ? await startFaultProxy(testcontainers, {
    ...options.toxiproxy,
    ...(scenario === "model_timeout" ? { model: "first" as const } : {}),
    ...(scenario === "final_model_timeout" ? { model: "confirmation" as const } : {}),
    ...(scenario === "search_timeout" ? { tool: "search_workshops" as const } : {})
  }) : undefined;
  const endpoints = proxy?.endpoints ?? testcontainers.endpoints;

  try {
    const workflow = new LastSeatWorkflow({
      modelBaseUrl: endpoints.modelBaseUrl,
      modelApiKey: "test-only-openai-compatible-key",
      modelName: "microcks-gpt",
      modelHeaders: { "x-mock-scenario": scenario },
      mcpUrl: endpoints.mcpUrl
    });

    return await runWithTestTrace(
      { testName, scenario, requestId, attendeeId: attendee.id },
      () => workflow.run({
        prompt: PROMPT,
        attendee,
        requestId,
        config: { ...DEFAULT_WORKFLOW_CONFIG, ...options.config }
      })
    );
  } finally {
    await proxy?.close();
  }
}

function reservationCall(outcome: WorkflowOutcome) {
  return outcome.modelToolCalls.find((call) => call.name === "reserve_seat");
}

function remainingSeats(state: DemoState): number | undefined {
  return state.workshops.find((workshop) => workshop.id === TARGET_WORKSHOP_ID)
    ?.remainingCapacity;
}
