/**
 * E2E tests for the Router MCP server.
 *
 * Spawns the MCP server as a child process, connects via stdio,
 * and tests all 4 tools through the MCP protocol.
 *
 * Uses a lightweight HTTP mock server to simulate the Router proxy.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as http from "node:http";
import * as path from "node:path";

// ---------------------------------------------------------------
// Mock HTTP server — simulates Router proxy at localhost:3838
// ---------------------------------------------------------------

const MOCK_STATS = {
  period: "weekly",
  total_requests: 42,
  total_cost_saved: 1.234,
  total_cost_actual: 0.42,
  total_cost_baseline: 1.654,
  average_savings_per_request: 0.029381,
  breakdown_by_task_type: {
    coding: { count: 20, cost_saved: 0.8 },
  },
  breakdown_by_provider: {
    openai: { count: 25, cost_saved: 0.9 },
  },
};

const MOCK_COMPARE = {
  task_type: "coding",
  threshold: 0.7,
  baseline_model: "gpt-4o",
  models: [
    {
      name: "gpt-4o-mini",
      provider: "openai",
      capability_score: 0.82,
      cost_per_1k_input: 0.00015,
      cost_per_1k_output: 0.0006,
      savings_vs_baseline_percent: 94.0,
      meets_threshold: true,
      rank: 1,
    },
  ],
  recommended: {
    name: "gpt-4o-mini",
    provider: "openai",
    capability_score: 0.82,
    cost_per_1k_input: 0.00015,
    savings_vs_baseline_percent: 94.0,
  },
  total_models: 14,
  capable_models: 10,
};

const MOCK_CONFIG = {
  provider_scope: "all",
  capability_threshold: 0.7,
  baseline_model: "gpt-4o",
  log_level: "INFO",
  overrides: [],
};

let mockServer: http.Server;
let mockPort: number;

function createMockServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");

      const url = new URL(req.url ?? "/", `http://localhost`);

      if (url.pathname === "/v1/stats") {
        res.writeHead(200);
        res.end(JSON.stringify(MOCK_STATS));
      } else if (url.pathname === "/v1/models/compare") {
        res.writeHead(200);
        res.end(JSON.stringify(MOCK_COMPARE));
      } else if (url.pathname === "/v1/config" && req.method === "GET") {
        res.writeHead(200);
        res.end(JSON.stringify(MOCK_CONFIG));
      } else if (url.pathname === "/v1/config" && req.method === "PATCH") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const updates = JSON.parse(body);
          const updated = { ...MOCK_CONFIG, ...updates, overrides: Object.keys(updates) };
          res.writeHead(200);
          res.end(JSON.stringify(updated));
        });
      } else if (url.pathname === "/health") {
        res.writeHead(200);
        res.end(JSON.stringify({ status: "ok" }));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Not found" }));
      }
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

// ---------------------------------------------------------------
// E2E test suite
// ---------------------------------------------------------------

describe("MCP Server E2E", () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    // Start mock HTTP server
    const mock = await createMockServer();
    mockServer = mock.server;
    mockPort = mock.port;

    // Spawn MCP server as child process
    const serverPath = path.resolve(__dirname, "../build/index.js");
    transport = new StdioClientTransport({
      command: "node",
      args: [serverPath],
      env: {
        ...process.env,
        ROUTER_URL: `http://127.0.0.1:${mockPort}`,
      },
    });

    client = new Client({ name: "e2e-test", version: "1.0.0" });
    await client.connect(transport);
  }, 15_000);

  afterAll(async () => {
    await client?.close();
    mockServer?.close();
  });

  // ---------------------------------------------------------------
  // Tool discovery
  // ---------------------------------------------------------------

  it("lists all 4 tools", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(4);
  });

  it("tool names match expected set", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "router_compare_models",
      "router_get_config",
      "router_get_stats",
      "router_set_config",
    ]);
  });

  it("all tools have descriptions", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.description!.length).toBeGreaterThan(10);
    }
  });

  // ---------------------------------------------------------------
  // router_get_stats
  // ---------------------------------------------------------------

  it("router_get_stats returns stats through protocol", async () => {
    const result = await client.callTool({
      name: "router_get_stats",
      arguments: { period: "weekly" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);

    // Text content should contain cost savings info
    const textContent = result.content.find(
      (c: { type: string }) => c.type === "text",
    );
    expect(textContent).toBeDefined();
    expect((textContent as { text: string }).text).toContain("Cost Savings");
    expect((textContent as { text: string }).text).toContain("42");
  });

  it("router_get_stats with default params works", async () => {
    const result = await client.callTool({
      name: "router_get_stats",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
  });

  // ---------------------------------------------------------------
  // router_compare_models
  // ---------------------------------------------------------------

  it("router_compare_models returns comparison through protocol", async () => {
    const result = await client.callTool({
      name: "router_compare_models",
      arguments: { task_type: "coding" },
    });

    expect(result.isError).toBeFalsy();
    const textContent = result.content.find(
      (c: { type: string }) => c.type === "text",
    );
    expect(textContent).toBeDefined();
    expect((textContent as { text: string }).text).toContain("coding");
  });

  it("router_compare_models with threshold works", async () => {
    const result = await client.callTool({
      name: "router_compare_models",
      arguments: { task_type: "reasoning", threshold: 0.8 },
    });

    expect(result.isError).toBeFalsy();
  });

  // ---------------------------------------------------------------
  // router_get_config
  // ---------------------------------------------------------------

  it("router_get_config returns config through protocol", async () => {
    const result = await client.callTool({
      name: "router_get_config",
      arguments: {},
    });

    expect(result.isError).toBeFalsy();
    const textContent = result.content.find(
      (c: { type: string }) => c.type === "text",
    );
    expect(textContent).toBeDefined();
    const text = (textContent as { text: string }).text;
    expect(text).toContain("Provider Scope");
    expect(text).toContain("Capability Threshold");
  });

  // ---------------------------------------------------------------
  // router_set_config
  // ---------------------------------------------------------------

  it("router_set_config applies config through protocol", async () => {
    const result = await client.callTool({
      name: "router_set_config",
      arguments: { provider_scope: "anthropic" },
    });

    expect(result.isError).toBeFalsy();
    const textContent = result.content.find(
      (c: { type: string }) => c.type === "text",
    );
    expect(textContent).toBeDefined();
    expect((textContent as { text: string }).text).toContain("anthropic");
  });

  // ---------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------

  it("tool with proxy unreachable returns isError", async () => {
    // Create a separate client connected to server with bad ROUTER_URL
    const serverPath = path.resolve(__dirname, "../build/index.js");
    const badTransport = new StdioClientTransport({
      command: "node",
      args: [serverPath],
      env: {
        ...process.env,
        ROUTER_URL: "http://127.0.0.1:1", // unreachable port
      },
    });

    const badClient = new Client({ name: "e2e-error-test", version: "1.0.0" });
    await badClient.connect(badTransport);

    try {
      const result = await badClient.callTool({
        name: "router_get_stats",
        arguments: { period: "weekly" },
      });

      expect(result.isError).toBe(true);
      const textContent = result.content.find(
        (c: { type: string }) => c.type === "text",
      );
      expect((textContent as { text: string }).text).toContain("Failed to fetch");
    } finally {
      await badClient.close();
    }
  }, 15_000);
});
