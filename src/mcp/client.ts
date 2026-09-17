import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Attendee } from "../shared/types.ts";

export class WorkshopMcpClient {
  private readonly client = new Client({ name: "the-last-seat-agent", version: "1.0.0" });
  private readonly transport: StreamableHTTPClientTransport;
  private connected = false;
  private discoveredTools: string[] = [];

  constructor(url: string, attendee: Attendee, requestId: string) {
    this.transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: {
        headers: {
          "x-attendee-id": attendee.id,
          "x-attendee-name": attendee.name,
          "x-attendee-email": attendee.email,
          "x-booking-request-id": requestId
        }
      },
      reconnectionOptions: {
        maxRetries: 0,
        initialReconnectionDelay: 50,
        maxReconnectionDelay: 50,
        reconnectionDelayGrowFactor: 1
      }
    });
  }

  async connectAndDiscover(timeoutMs: number, signal: AbortSignal): Promise<string[]> {
    if (!this.connected) {
      await this.client.connect(this.transport, { timeout: timeoutMs, signal });
      const result = await this.client.listTools(undefined, { timeout: timeoutMs, signal });
      this.discoveredTools = result.tools.map((tool) => tool.name);
      this.connected = true;
    }
    return [...this.discoveredTools];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<CallToolResult> {
    if (!this.connected) {
      throw new Error("MCP client must be initialized and tools discovered before execution");
    }
    const result = await this.client.callTool(
      { name, arguments: args },
      CallToolResultSchema,
      { timeout: timeoutMs, signal }
    );
    return CallToolResultSchema.parse(result);
  }

  get sessionId(): string | undefined {
    return this.transport.sessionId;
  }

  async close(timeoutMs = 1_000): Promise<void> {
    this.connected = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.transport.terminateSession(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("MCP session cleanup timed out")), timeoutMs);
        })
      ]);
    } finally {
      clearTimeout(timer);
      await this.client.close();
    }
  }
}

export function parseMcpJson(result: CallToolResult): Record<string, unknown> {
  if (result.structuredContent) return result.structuredContent;

  const textContent = result.content.find((item) => item.type === "text");
  if (!textContent || textContent.type !== "text") {
    throw new Error("MCP tool returned no JSON text content");
  }
  return JSON.parse(textContent.text) as Record<string, unknown>;
}
