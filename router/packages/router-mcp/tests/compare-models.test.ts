/**
 * Tests for router_compare_models MCP tool.
 *
 * Tests the client method, tool registration, text formatting,
 * and error handling. Uses mocked fetch for isolation.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RouterClient, type CompareResponse } from "../src/client.js";
import { registerCompareModelsTool, formatCompareText } from "../src/tools/compare-models.js";

// ---------------------------------------------------------------
// Test data
// ---------------------------------------------------------------

const MOCK_COMPARE: CompareResponse = {
  task_type: "coding",
  threshold: 0.7,
  baseline_model: "gpt-4o",
  models: [
    {
      name: "gpt-4o-mini",
      provider: "openai",
      capability_score: 0.75,
      cost_per_1k_input: 0.00015,
      cost_per_1k_output: 0.0006,
      savings_vs_baseline_percent: 94.0,
      meets_threshold: true,
      rank: 1,
    },
    {
      name: "claude-3.5-haiku",
      provider: "anthropic",
      capability_score: 0.82,
      cost_per_1k_input: 0.0008,
      cost_per_1k_output: 0.004,
      savings_vs_baseline_percent: 68.0,
      meets_threshold: true,
      rank: 2,
    },
    {
      name: "gpt-4o",
      provider: "openai",
      capability_score: 0.92,
      cost_per_1k_input: 0.0025,
      cost_per_1k_output: 0.01,
      savings_vs_baseline_percent: 0.0,
      meets_threshold: true,
      rank: 3,
    },
  ],
  recommended: {
    name: "gpt-4o-mini",
    provider: "openai",
    capability_score: 0.75,
    cost_per_1k_input: 0.00015,
    savings_vs_baseline_percent: 94.0,
  },
  total_models: 3,
  capable_models: 3,
};

const EMPTY_COMPARE: CompareResponse = {
  task_type: "coding",
  threshold: 0.99,
  baseline_model: "gpt-4o",
  models: [],
  recommended: null,
  total_models: 0,
  capable_models: 0,
};

const NO_CAPABLE_COMPARE: CompareResponse = {
  task_type: "coding",
  threshold: 1.0,
  baseline_model: "gpt-4o",
  models: [
    {
      name: "gpt-4o-mini",
      provider: "openai",
      capability_score: 0.75,
      cost_per_1k_input: 0.00015,
      cost_per_1k_output: 0.0006,
      savings_vs_baseline_percent: 94.0,
      meets_threshold: false,
      rank: 1,
    },
  ],
  recommended: null,
  total_models: 1,
  capable_models: 0,
};

// ---------------------------------------------------------------
// RouterClient.compareModels tests
// ---------------------------------------------------------------

describe("RouterClient.compareModels", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("calls /v1/models/compare with task_type", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_COMPARE),
    });
    globalThis.fetch = mockFetch;

    const client = new RouterClient({ baseUrl: "http://localhost:3838" });
    const result = await client.compareModels({ task_type: "coding" });

    expect(mockFetch).toHaveBeenCalledOnce();
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe("/v1/models/compare");
    expect(url.searchParams.get("task_type")).toBe("coding");
    expect(result.task_type).toBe("coding");
  });

  it("passes threshold and provider params", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_COMPARE),
    });
    globalThis.fetch = mockFetch;

    const client = new RouterClient({ baseUrl: "http://localhost:3838" });
    await client.compareModels({
      task_type: "reasoning",
      threshold: 0.85,
      provider: "anthropic",
    });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.get("task_type")).toBe("reasoning");
    expect(url.searchParams.get("threshold")).toBe("0.85");
    expect(url.searchParams.get("provider")).toBe("anthropic");
  });

  it("omits optional params when not provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_COMPARE),
    });
    globalThis.fetch = mockFetch;

    const client = new RouterClient({ baseUrl: "http://localhost:3838" });
    await client.compareModels({ task_type: "coding" });

    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.searchParams.has("threshold")).toBe(false);
    expect(url.searchParams.has("provider")).toBe(false);
  });

  it("sends Authorization header when apiKey is set", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_COMPARE),
    });
    globalThis.fetch = mockFetch;

    const client = new RouterClient({
      baseUrl: "http://localhost:3838",
      apiKey: "test-key",
    });
    await client.compareModels({ task_type: "coding" });

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["Authorization"]).toBe("Bearer test-key");
  });

  it("throws on non-OK response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      statusText: "Unprocessable Entity",
      text: () => Promise.resolve("Invalid task_type"),
    });
    globalThis.fetch = mockFetch;

    const client = new RouterClient({ baseUrl: "http://localhost:3838" });
    await expect(
      client.compareModels({ task_type: "coding" }),
    ).rejects.toThrow("Router API error: 422");
  });

  it("throws on network error", async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValue(new Error("Connection refused"));
    globalThis.fetch = mockFetch;

    const client = new RouterClient({ baseUrl: "http://localhost:3838" });
    await expect(
      client.compareModels({ task_type: "coding" }),
    ).rejects.toThrow("Connection refused");
  });
});

// ---------------------------------------------------------------
// formatCompareText tests
// ---------------------------------------------------------------

describe("formatCompareText", () => {
  it("includes task type header", () => {
    const text = formatCompareText(MOCK_COMPARE);
    expect(text).toContain('Model Comparison for "coding" tasks');
  });

  it("includes threshold and baseline info", () => {
    const text = formatCompareText(MOCK_COMPARE);
    expect(text).toContain("Threshold: 0.7");
    expect(text).toContain("Baseline: gpt-4o");
  });

  it("includes total and capable counts", () => {
    const text = formatCompareText(MOCK_COMPARE);
    expect(text).toContain("Total: 3 models");
    expect(text).toContain("Capable: 3");
  });

  it("includes recommended model", () => {
    const text = formatCompareText(MOCK_COMPARE);
    expect(text).toContain("Recommended: gpt-4o-mini (openai)");
    expect(text).toContain("Saves 94%");
  });

  it("lists all models with rank", () => {
    const text = formatCompareText(MOCK_COMPARE);
    expect(text).toContain("gpt-4o-mini");
    expect(text).toContain("claude-3.5-haiku");
    expect(text).toContain("gpt-4o");
  });

  it("shows YES/no for meets_threshold", () => {
    const text = formatCompareText(NO_CAPABLE_COMPARE);
    expect(text).toContain(" no");
    expect(text).not.toContain("YES");
  });

  it("handles empty models list", () => {
    const text = formatCompareText(EMPTY_COMPARE);
    expect(text).toContain("No models found");
  });

  it("omits recommended section when null", () => {
    const text = formatCompareText(EMPTY_COMPARE);
    expect(text).not.toContain("Recommended:");
  });
});

// ---------------------------------------------------------------
// Tool registration tests
// ---------------------------------------------------------------

describe("registerCompareModelsTool", () => {
  it("registers the tool on the server without throwing", () => {
    const server = new McpServer({ name: "test", version: "0.0.1" });
    const client = new RouterClient({ baseUrl: "http://localhost:3838" });

    expect(() => registerCompareModelsTool(server, client)).not.toThrow();
  });
});
