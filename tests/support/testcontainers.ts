import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MicrocksContainer,
  type StartedMicrocksContainer
} from "@microcks/microcks-testcontainers";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer
} from "@testcontainers/postgresql";
import {
  ToxiProxyContainer,
  type StartedToxiProxyContainer
} from "@testcontainers/toxiproxy";
import {
  GenericContainer,
  Network,
  Wait,
  type StartedTestContainer,
  type StartedNetwork
} from "testcontainers";
import type { Pool } from "pg";
import { createPool, migrate, resetDemoData } from "../../src/db/database.ts";
import { WORKSHOP_MCP_PORT } from "../../src/mcp/server.ts";
import { ToxiproxyController } from "./toxiproxy.ts";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDirectory, "../..");

const IMAGES = {
  postgres: "postgres:17.6-alpine",
  microcks: "docker.io/microcks/microcks-uber:1.14.0",
  toxiproxy: "ghcr.io/shopify/toxiproxy:2.12.0",
  mcp: "the-last-seat-mcp:local"
} as const;

interface TestcontainersEndpoints {
  modelBaseUrl: string;
  mcpUrl: string;
}

export interface TestcontainersStack {
  endpoints: TestcontainersEndpoints;
  pool: Pool;
  toxiproxy: ToxiproxyController;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function startTestcontainers(): Promise<TestcontainersStack> {
  let network: StartedNetwork | undefined;
  let postgres: StartedPostgreSqlContainer | undefined;
  let microcks: StartedMicrocksContainer | undefined;
  let toxiproxy: StartedToxiProxyContainer | undefined;
  let mcpContainer: StartedTestContainer | undefined;
  let pool: Pool | undefined;

  try {
    // The database and mocked model are independent, so start them together.
    network = await new Network().start();
    const [postgresResult, microcksResult] = await Promise.allSettled([
      new PostgreSqlContainer(IMAGES.postgres)
        .withDatabase("last_seat")
        .withUsername("last_seat")
        .withPassword("last_seat")
        .withNetwork(network)
        .withNetworkAliases("postgres")
        .start(),
      new MicrocksContainer(IMAGES.microcks)
        .withMainArtifacts([
          path.join(projectRoot, "microcks/openai-chat-completions.yaml")
        ])
        .withNetwork(network)
        .withNetworkAliases("microcks")
        .start()
    ]);
    // Keep successful starts available for cleanup even if the other service failed.
    postgres = postgresResult.status === "fulfilled" ? postgresResult.value : undefined;
    microcks = microcksResult.status === "fulfilled" ? microcksResult.value : undefined;
    if (!postgres || !microcks) {
      throw new AggregateError(
        [postgresResult, microcksResult].flatMap((result) =>
          result.status === "rejected" ? [result.reason] : []
        ),
        "Could not start the test database and model"
      );
    }

    pool = createPool(postgres.getConnectionUri());
    await migrate(pool);
    await resetDemoData(pool);

    // Tests build and run the same MCP container used by Docker Compose.
    const mcpImage = await GenericContainer.fromDockerfile(projectRoot, "Dockerfile.mcp")
      .withCache(true)
      .build(IMAGES.mcp, { deleteOnExit: false });
    const internalDatabaseUrl =
      `postgresql://${encodeURIComponent(postgres.getUsername())}:` +
      `${encodeURIComponent(postgres.getPassword())}@postgres:5432/` +
      encodeURIComponent(postgres.getDatabase());
    mcpContainer = await mcpImage
      .withEnvironment({
        DATABASE_URL: internalDatabaseUrl,
        PORT: String(WORKSHOP_MCP_PORT)
      })
      .withExposedPorts(WORKSHOP_MCP_PORT)
      .withNetwork(network)
      .withNetworkAliases("workshop-mcp-server")
      .withWaitStrategy(
        Wait.forHttp("/health", WORKSHOP_MCP_PORT).forStatusCode(200)
      )
      .withStartupTimeout(120_000)
      .start();
    // Model and MCP traffic get separate, independently controlled proxy routes.
    toxiproxy = await new ToxiProxyContainer(IMAGES.toxiproxy)
      .withNetwork(network)
      .withNetworkAliases("toxiproxy")
      .start();
    const modelProxy = await toxiproxy.createProxy({
      name: "model-api",
      upstream: "microcks:8080"
    });
    const mcpProxy = await toxiproxy.createProxy({
      name: "workshop-mcp",
      upstream: `workshop-mcp-server:${WORKSHOP_MCP_PORT}`
    });
    const toxiproxyControlUrl = `http://${toxiproxy.getHost()}:${toxiproxy.getMappedPort(8474)}`;
    const microcksPath = microcks.getRestMockEndpointPath(
      "OpenAI Chat Completions",
      "1.0.0"
    );
    const endpoints: TestcontainersEndpoints = {
      modelBaseUrl: `http://${modelProxy.host}:${modelProxy.port}${microcksPath}/v1`,
      mcpUrl: `http://${mcpProxy.host}:${mcpProxy.port}/mcp`
    };
    const toxiproxyController = new ToxiproxyController(
      toxiproxyControlUrl,
      "model-api",
      "workshop-mcp"
    );
    const containers = { network, postgres, microcks, toxiproxy, mcpContainer };
    const database = pool;

    return {
      endpoints,
      pool: database,
      toxiproxy: toxiproxyController,
      async reset(): Promise<void> {
        await toxiproxyController.reset();
        await resetDemoData(database);
      },
      async close(): Promise<void> {
        await toxiproxyController.reset().catch(() => undefined);
        await database.end().catch(() => undefined);
        await containers.toxiproxy.stop().catch(() => undefined);
        await containers.mcpContainer.stop().catch(() => undefined);
        await containers.microcks.stop().catch(() => undefined);
        await containers.postgres.stop().catch(() => undefined);
        await containers.network.stop().catch(() => undefined);
      }
    };
  } catch (error) {
    await pool?.end().catch(() => undefined);
    await toxiproxy?.stop().catch(() => undefined);
    await mcpContainer?.stop().catch(() => undefined);
    await microcks?.stop().catch(() => undefined);
    await postgres?.stop().catch(() => undefined);
    await network?.stop().catch(() => undefined);
    throw error;
  }
}
