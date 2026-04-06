/**
 * router_set_config MCP tool.
 *
 * "Change the routing config" — applies partial config updates
 * as runtime overrides. In-memory only, cleared on restart.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RouterClient } from "../client.js";
/**
 * Register the router_set_config tool on an MCP server.
 */
export declare function registerSetConfigTool(server: McpServer, client: RouterClient): void;
//# sourceMappingURL=set-config.d.ts.map