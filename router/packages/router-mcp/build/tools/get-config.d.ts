/**
 * router_get_config MCP tool.
 *
 * "What's the current routing config?" — returns effective config
 * (env-var defaults merged with runtime overrides).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RouterClient, ConfigResponse } from "../client.js";
/**
 * Format config response into human-readable text for the LLM.
 */
export declare function formatConfigText(data: ConfigResponse): string;
/**
 * Register the router_get_config tool on an MCP server.
 */
export declare function registerGetConfigTool(server: McpServer, client: RouterClient): void;
//# sourceMappingURL=get-config.d.ts.map