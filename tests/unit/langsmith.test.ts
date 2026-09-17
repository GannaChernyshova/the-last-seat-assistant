import { configureLangSmith } from "../../src/observability/langsmith.ts";

describe("LangSmith configuration", () => {
  const original = {
    tracing: process.env.LANGSMITH_TRACING,
    endpoint: process.env.LANGSMITH_ENDPOINT,
    apiKey: process.env.LANGSMITH_API_KEY,
    project: process.env.LANGSMITH_PROJECT,
    hideInputs: process.env.LANGSMITH_HIDE_INPUTS
  };

  afterEach(() => {
    const restore = (name: string, value: string | undefined): void => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("LANGSMITH_TRACING", original.tracing);
    restore("LANGSMITH_ENDPOINT", original.endpoint);
    restore("LANGSMITH_API_KEY", original.apiKey);
    restore("LANGSMITH_PROJECT", original.project);
    restore("LANGSMITH_HIDE_INPUTS", original.hideInputs);
  });

  it("stays disabled without tracing credentials", () => {
    process.env.LANGSMITH_TRACING = "false";
    delete process.env.LANGSMITH_API_KEY;

    expect(configureLangSmith()).toMatchObject({
      enabled: false,
      project: "The Last Seat",
      inputPrivacy: "hidden"
    });
  });

  it("enables the requested project and forces model-input privacy", () => {
    process.env.LANGSMITH_TRACING = "true";
    process.env.LANGSMITH_API_KEY = "test-key";
    process.env.LANGSMITH_PROJECT = "The Last Seat";
    process.env.LANGSMITH_HIDE_INPUTS = "false";

    expect(configureLangSmith()).toMatchObject({
      enabled: true,
      project: "The Last Seat",
      endpoint: "https://api.smith.langchain.com",
      inputPrivacy: "hidden"
    });
    expect(process.env.LANGSMITH_HIDE_INPUTS).toBe("true");
  });
});
