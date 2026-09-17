import { createServer, request as forward, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { TestcontainersStack } from "./testcontainers.ts";

interface FaultPlan {
  model?: "first" | "confirmation";
  tool?: "search_workshops" | "reserve_seat";
  modelLatencyMs?: number;
  mcpLatencyMs?: number;
}

// This test-only relay inspects real protocol requests before forwarding them
// through Toxiproxy. The application has no knowledge of fault injection.
export async function startFaultProxy(stack: TestcontainersStack, plan: FaultPlan) {
  let modelFaultUsed = false;
  let toolFaultUsed = false;
  const errors: unknown[] = [];

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const json = body.length ? JSON.parse(body.toString()) : {};
    const isModel = req.url?.startsWith("/model/");

    if (isModel && !modelFaultUsed && plan.model) {
      const hasReservation = (json.messages ?? []).some(
        (message: { role: string; content?: string }) => {
          if (message.role !== "tool" || !message.content) return false;
          return JSON.parse(message.content).status === "confirmed";
        }
      );
      if (plan.model === "first" || hasReservation) {
        await stack.toxiproxy.setModelLatency(plan.modelLatencyMs ?? 0);
        modelFaultUsed = true;
      }
    }

    if (!isModel) {
      if (!toolFaultUsed && plan.tool && json.method === "tools/call" && json.params?.name === plan.tool) {
        await stack.toxiproxy.setMcpLatency(plan.mcpLatencyMs ?? 0);
        toolFaultUsed = true;
      } else if (toolFaultUsed && (json.method === "tools/call" || req.method === "DELETE")) {
        // Recovery/cleanup uses a healthy connection after the selected call failed.
        await stack.toxiproxy.clearMcpLatency();
      }
    }

    const target = isModel
      ? new URL(`${stack.endpoints.modelBaseUrl}${req.url!.slice("/model".length)}`)
      : new URL(stack.endpoints.mcpUrl);
    const upstream = forward(target, {
      method: req.method,
      headers: { ...req.headers, host: target.host },
      agent: false
    }, (reply) => {
      res.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(res);
      reply.on("error", (error) => res.destroy(error));
    });
    res.on("close", () => upstream.destroy());
    upstream.on("error", (error) => {
      if (!res.destroyed) {
        errors.push(error);
        res.destroy(error);
      }
    });
    upstream.end(body);
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      errors.push(error);
      res.writeHead(502).end("Fault proxy failed");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    endpoints: { modelBaseUrl: `${baseUrl}/model`, mcpUrl: `${baseUrl}/mcp` },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      await stack.toxiproxy.reset();
      if (errors.length) throw new AggregateError(errors, "Fault proxy failed");
    }
  };
}
