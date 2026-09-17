interface LangSmithStatus {
  enabled: boolean;
  project: string;
  endpoint: string;
  inputPrivacy: "hidden";
}

function envTrue(value: string | undefined): boolean {
  return value?.toLowerCase() === "true";
}

/**
 * Apply safe demo defaults before LangChain or traceable creates a run.
 * Model inputs stay private; tool names, arguments, and results are recorded by
 * the explicit MCP child spans instead.
 */
export function configureLangSmith(): LangSmithStatus {
  const requested = envTrue(process.env.LANGSMITH_TRACING);
  const hasApiKey = Boolean(process.env.LANGSMITH_API_KEY?.trim());

  if (requested) {
    process.env.LANGSMITH_PROJECT ||= "The Last Seat";
    process.env.LANGSMITH_ENDPOINT ||= "https://api.smith.langchain.com";
    process.env.LANGSMITH_HIDE_INPUTS = "true";
    if (!hasApiKey) {
      // Avoid background export failures for a partially configured local checkout.
      process.env.LANGSMITH_TRACING = "false";
    }
  }

  return {
    enabled: requested && hasApiKey,
    project: process.env.LANGSMITH_PROJECT || "The Last Seat",
    endpoint: process.env.LANGSMITH_ENDPOINT || "https://api.smith.langchain.com",
    inputPrivacy: "hidden"
  };
}
