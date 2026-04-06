/**
 * Tests for router_get_config and router_set_config MCP tools.
 *
 * Tests the client methods, tool registration, text formatting,
 * and error handling. Uses mocked fetch for isolation.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RouterClient, type ConfigResponse } from "../src/client.js";
import {
  registerGetConfigTool,
  formatConfigText,
} from "../src/tools/get-config.js";
import { registerSetConfigTool } from "../src/tools/set-config.js";

// ---------------------------------------------------------------
// Test data
// ---------------------------------------------------------------

const MOCK_CONFIG_DEFAULT: ConfigResponse = {
  provider_scope: "all",
  capability_threshold: 0.7,
  baseline_model: "gpt-4o",
  log_level: "INFO",
  overrides: [],
};

const MOCK_CONFIG_WITH_OVERRIDES: ConfigResponse = {
  provider_scope: "anthropic",
  capability_threshold: 0.5,
  baseline_model: "gpt-4o",
  log_level: "DEBUG",
  overrides: ["capability_threshold", "log_level", "provider_scope"],
};

const MOCK_CONFIG_AFTER_SET: ConfigResponse = {
  provider_scope: "openai",
  capability_threshold: 0.7,
  baseline_model: "gpt-4o",
  log_level: "INFO",
  overrides: ["provider_scope"],
};

// ---------------------------------------------------------------
// RouterClient.getConfig tests
// ---------------------------------------------------------------

describe("RouterClient.getConfig", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("calls GET /v1/config", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_CONFIG_DEFAULT),
    });
    globalThis.fetch = mockFetch;

    const client = new RouterClient({ baseUrl: "http://localhost:3838" });
    const result = await client.getConfig();

    expect(mockFetch).toHaveBeenCalledOnce();
    const url = new URL(mockFetch.mock.calls[0][0]);
    expect(url.pathname).toBe("/v1/config");
    expect(mockFetch.mock.calls[0][1].method).toBe("GET");
    expect(result.provider_scope).toBe("all");
  });

  it("sends Authorization header when apiKey is set", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_CONFIG_DEFAULT),
    });
    globalThis.fetch = mockFetch;

    const client = new RouterClient({
      baseUrl: "http://localhost:3838",
      apiKey: "test-key",
    });
    await client.getConfig();

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["Authorization"]).toBe("Bearer test-key");
  });

  it("throws on non-OK response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: () => Promise.resolve("Missing auth"),
    });
    globalThis.fetch = mockFetch;

    const client = new RouterClient({ baseUrl: "http://localhost:3838" });
    await expect(client.getConfig()).rejects.toThrow("Router API error: 401");
  });

  it("throws on network error", async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValue(new Error("Connection refused"));
    globalThis.fetch = mockFetch;

    const client = new RouterClient({ baseUrl: "http://localhost:3838" });
    await expect(client.getConfig()).rejects.toThrow("Connection refused");
  });
});

// ---------------------------------------------------------------
// RouterClient.setConfig tests
// ---------------------------------------------------------------

describe("RouterClient.setConfig", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("calls PATCH /v1/config with JSON body", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_CONFIG_AFTER_SET),
    });
    globalThis.fetch = mockFetch;

    const client = new RouterClient({ baseUrl: "http://localhost:3838" });
    const result = await client.setConfig({ provider_scope: "openai" });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(new URL(url).pathname).toBe("/v1/config");
    expect(opts.method).toBe("PATCH");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(opts.body)).toEqual({ provider_scope: "openai" });
    expect(result.provider_scope).toBe("openai");
  });

  it("sends null values for field reset", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_CONFIG_DEFAULT),
    });
    globalThis.fetch = mockFetch;

    const client = new RouterClient({ baseUrl: "http://localhost:3838" });
    await client.setConfig({ provider_scope: null });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.provider_scope).toBeNull();
  });

  it("sends Authorization header when apiKey is set", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(MOCK_CONFIG_AFTER_SET),
    });
    globalThis.fetch = mockFetch;

    const client = new RouterClient({
      baseUrl: "http://localhost:3838",
      apiKey: "secret",
    });
    await client.setConfig({ log_level: "DEBUG" });

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(headers["Authorization"]).toBe("Bearer secret");
  });

  it("throws on 422 validation error", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      statusText: "Unprocessable Entity",
      text: () => Promise.resolve("Invalid provider_scope"),
    });
    globalThis.fetch = mockFetch;

    const client = new RouterClient({ baseUrl: "http://localhost:3838" });
    await expect(
      client.setConfig({ provider_scope: "invalid" as "all" }),
    ).rejects.toThrow("Router API error: 422");
  });

  it("throws on network error", async () => {
    const mockFetch = vi
      .fn()
      .mockRejectedValue(new Error("Connection refused"));
    globalThis.fetch = mockFetch;

    const client = new RouterClient({ baseUrl: "http://localhost:3838" });
    await expect(
      client.setConfig({ capability_threshold: 0.5 }),
    ).rejects.toThrow("Connection refused");
  });
});

// ---------------------------------------------------------------
// formatConfigText tests
// ---------------------------------------------------------------

describe("formatConfigText", () => {
  it("includes all config fields", () => {
    const text = formatConfigText(MOCK_CONFIG_DEFAULT);
    expect(text).toContain("Provider Scope:");
    expect(text).toContain("Capability Threshold:");
    expect(text).toContain("Baseline Model:");
    expect(text).toContain("Log Level:");
  });

  it("shows no overrides message for defaults", () => {
    const text = formatConfigText(MOCK_CONFIG_DEFAULT);
    expect(text).toContain("No runtime overrides active");
  });

  it("shows override fields when present", () => {
    const text = formatConfigText(MOCK_CONFIG_WITH_OVERRIDES);
    expect(text).toContain("Runtime Overrides:");
    expect(text).toContain("provider_scope");
    expect(text).toContain("capability_threshold");
    expect(text).toContain("Restart clears all overrides");
  });

  it("displays correct values", () => {
    const text = formatConfigText(MOCK_CONFIG_DEFAULT);
    expect(text).toContain("all");
    expect(text).toContain("0.7");
    expect(text).toContain("gpt-4o");
    expect(text).toContain("INFO");
  });
});

// ---------------------------------------------------------------
// Tool registration tests
// ---------------------------------------------------------------

describe("registerGetConfigTool", () => {
  it("registers the tool on the server without throwing", () => {
    const server = new McpServer({ name: "test", version: "0.0.1" });
    const client = new RouterClient({ baseUrl: "http://localhost:3838" });

    expect(() => registerGetConfigTool(server, client)).not.toThrow();
  });
});

describe("registerSetConfigTool", () => {
  it("registers the tool on the server without throwing", () => {
    const server = new McpServer({ name: "test", version: "0.0.1" });
    const client = new RouterClient({ baseUrl: "http://localhost:3838" });

    expect(() => registerSetConfigTool(server, client)).not.toThrow();
  });
});
