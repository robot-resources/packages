#!/usr/bin/env node
/**
 * Robot Resources Router MCP Server.
 *
 * Provides stats, config, and model comparison tools
 * for the Router LLM routing proxy via MCP protocol.
 *
 * Transport: stdio (standard for local MCP servers).
 * Communicates with Router proxy at localhost:3838 via HTTP.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RouterClient } from "./client.js";
import { registerGetStatsTool } from "./tools/get-stats.js";
import { registerCompareModelsTool } from "./tools/compare-models.js";
import { registerGetConfigTool } from "./tools/get-config.js";
import { registerSetConfigTool } from "./tools/set-config.js";
const server = new McpServer({
    name: "router-mcp",
    version: "0.1.0",
});
const client = new RouterClient({
    baseUrl: process.env.ROUTER_URL ?? "http://localhost:3838",
    apiKey: process.env.ROUTER_API_KEY,
});
// Register tools
registerGetStatsTool(server, client);
registerCompareModelsTool(server, client);
registerGetConfigTool(server, client);
registerSetConfigTool(server, client);
// Connect via stdio
const transport = new StdioServerTransport();
await server.connect(transport);
//# sourceMappingURL=index.js.map