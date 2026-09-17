export class ToxiproxyController {
  constructor(
    private readonly controlUrl: string,
    private readonly modelProxyName: string,
    private readonly mcpProxyName: string
  ) {}

  private async removeToxic(proxyName: string, toxicName: string): Promise<void> {
    const key = `${proxyName}/${toxicName}`;
    const response = await fetch(
      `${this.controlUrl}/proxies/${encodeURIComponent(proxyName)}/toxics/${encodeURIComponent(toxicName)}`,
      { method: "DELETE" }
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`Could not remove toxic ${key}: ${response.status} ${await response.text()}`);
    }
  }

  private async setLatency(
    proxyName: string,
    toxicName: string,
    latencyMs: number
  ): Promise<void> {
    await this.removeToxic(proxyName, toxicName);
    if (latencyMs <= 0) {
      return;
    }
    const response = await fetch(
      `${this.controlUrl}/proxies/${encodeURIComponent(proxyName)}/toxics`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: toxicName,
          type: "latency",
          stream: "downstream", // The request reaches the server before its reply is delayed.
          toxicity: 1,
          attributes: { latency: Math.round(latencyMs), jitter: 0 }
        })
      }
    );
    if (!response.ok) {
      throw new Error(
        `Could not add toxic ${proxyName}/${toxicName}: ${response.status} ${await response.text()}`
      );
    }
  }

  setModelLatency(latencyMs: number): Promise<void> {
    return this.setLatency(this.modelProxyName, "model-downstream-latency", latencyMs);
  }

  setMcpLatency(latencyMs: number): Promise<void> {
    return this.setLatency(this.mcpProxyName, "mcp-downstream-latency", latencyMs);
  }

  clearModelLatency(): Promise<void> {
    return this.removeToxic(this.modelProxyName, "model-downstream-latency");
  }

  clearMcpLatency(): Promise<void> {
    return this.removeToxic(this.mcpProxyName, "mcp-downstream-latency");
  }

  async reset(): Promise<void> {
    await Promise.all([this.clearModelLatency(), this.clearMcpLatency()]);
  }
}
