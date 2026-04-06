/**
 * router_get_stats MCP tool.
 *
 * "How much am I saving?" — returns cost savings data from the Router proxy.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RouterClient } from "../client.js";
/**
 * Register the router_get_stats tool on an MCP server.
 */
export declare function registerGetStatsTool(server: McpServer, client: RouterClient): void;
//# sourceMappingURL=get-stats.d.ts.map