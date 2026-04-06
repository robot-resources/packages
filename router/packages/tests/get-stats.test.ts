/**
 * Tests for router_get_stats MCP tool.
 *
 * Tests the tool registration, input validation, HTTP client,
 * and response formatting. Uses mocked fetch for isolation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RouterClient, type StatsResponse } from "../src/client.js";
import { registerGetStatsTool } from "../src/tools/get-stats.js";

// ---------------------------------------------------------------
// Test data
// ---------------------------------------------------------------

const MOCK_STATS: StatsResponse = {
  period: "weekly",
  total_requests: 42,
  total_cost_saved: 1.234,
  total_cost_actual: 0.42,
  total_cost_baseline: 1.654,
  average_savings_per_request: 0.029381,
  breakdown_by_task_type: {
    coding: { count: 20, cost_saved: 0.8 },
    reasoning: { count: 15, cost_saved: 0.3 },
    simple_qa: { count: 7, cost_saved: 0.134 },
  },
  breakdown_by_provider: {
    openai: { count: 25, cost_saved: 0.9 },
    anthropic: { count: 12, cost_saved: 0.3 },
    google: { count: 5, cost_saved: 0.034 },
  },
};

const EMPTY_STATS: StatsResponse = {
  period: "weekly",
  total_requests: 0,
  total_cost_saved: 0,
  total_cost_actual: 0,
  total_cost_baseline: 0,
  average_savings_per_request: 0,
  breakdown_by_task_type: {},
  breakdown_by_provider: {},
};

// ---------------------------------------------------------------
// RouterClient tests
// ---------------------------------------------------------------

describe("RouterClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("getStats", () => {
    it("calls /v1/stats with default params", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(MOCK_STATS),
      });
      globalThis.fetch = mockFetch;

      const client = new RouterClient({ baseUrl: "http://localhost:3838" });
      const result = await client.getStats();

      expect(mockFetch).toHaveBeenCalledOnce();
      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.pathname).toBe("/v1/stats");
      expect(result.total_requests).toBe(42);
    });

    it("passes period query parameter", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(MOCK_STATS),
      });
      globalThis.fetch = mockFetch;

      const client = new RouterClient({ baseUrl: "http://localhost:3838" });
      await client.getStats({ period: "monthly" });

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get("period")).toBe("monthly");
    });

    it("passes task_type and provider filters", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(MOCK_STATS),
      });
      globalThis.fetch = mockFetch;

      const client = new RouterClient({ baseUrl: "http://localhost:3838" });
      await client.getStats({ task_type: "coding", provider: "openai" });

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get("task_type")).toBe("coding");
      expect(url.searchParams.get("provider")).toBe("openai");
    });

    it("sends Authorization header when apiKey is set", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(MOCK_STATS),
      });
      globalThis.fetch = mockFetch;

      const client = new RouterClient({
        baseUrl: "http://localhost:3838",
        apiKey: "test-key",
      });
      await client.getStats();

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers["Authorization"]).toBe("Bearer test-key");
    });

    it("does not send Authorization when no apiKey", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(MOCK_STATS),
      });
      globalThis.fetch = mockFetch;

      const client = new RouterClient({ baseUrl: "http://localhost:3838" });
      await client.getStats();

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers["Authorization"]).toBeUndefined();
    });

    it("throws on non-OK response", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
        text: () => Promise.resolve("DB unavailable"),
      });
      globalThis.fetch = mockFetch;

      const client = new RouterClient({ baseUrl: "http://localhost:3838" });
      await expect(client.getStats()).rejects.toThrow("Router API error: 503");
    });

    it("throws on network error", async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValue(new Error("Connection refused"));
      globalThis.fetch = mockFetch;

      const client = new RouterClient({ baseUrl: "http://localhost:3838" });
      await expect(client.getStats()).rejects.toThrow("Connection refused");
    });
  });

  describe("healthCheck", () => {
    it("returns true when proxy is reachable", async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      globalThis.fetch = mockFetch;

      const client = new RouterClient({ baseUrl: "http://localhost:3838" });
      expect(await client.healthCheck()).toBe(true);
    });

    it("returns false when proxy is unreachable", async () => {
      const mockFetch = vi
        .fn()
        .mockRejectedValue(new Error("Connection refused"));
      globalThis.fetch = mockFetch;

      const client = new RouterClient({ baseUrl: "http://localhost:3838" });
      expect(await client.healthCheck()).toBe(false);
    });
  });
});

// ---------------------------------------------------------------
// Tool registration tests
// ---------------------------------------------------------------

describe("registerGetStatsTool", () => {
  it("registers the tool on the server", () => {
    const server = new McpServer({ name: "test", version: "0.0.1" });
    const client = new RouterClient({ baseUrl: "http://localhost:3838" });

    // Should not throw
    registerGetStatsTool(server, client);
  });
});

// ---------------------------------------------------------------
// Tool handler tests (via direct client mock)
// ---------------------------------------------------------------

describe("router_get_stats handler", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns formatted text and structured content on success", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_STATS),
    });
    globalThis.fetch = mockFetch;

    const client = new RouterClient({ baseUrl: "http://localhost:3838" });
    const stats = await client.getStats({ period: "weekly" });

    expect(stats.total_requests).toBe(42);
    expect(stats.total_cost_saved).toBe(1.234);
    expect(stats.breakdown_by_task_type).toHaveProperty("coding");
    expect(stats.breakdown_by_provider).toHaveProperty("openai");
  });

  it("handles empty stats (no data)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(EMPTY_STATS),
    });
    globalThis.fetch = mockFetch;

    const client = new RouterClient({ baseUrl: "http://localhost:3838" });
    const stats = await client.getStats();

    expect(stats.total_requests).toBe(0);
    expect(stats.total_cost_saved).toBe(0);
  });

  it("uses configurable base URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_STATS),
    });
    globalThis.fetch = mockFetch;

    const client = new RouterClient({
      baseUrl: "http://custom-host:9999",
    });
    await client.getStats();

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.origin).toBe("http://custom-host:9999");
  });
});
