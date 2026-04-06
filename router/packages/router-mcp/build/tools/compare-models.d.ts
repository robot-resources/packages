/**
 * router_compare_models MCP tool.
 *
 * "What's the best model for this task?" — returns ranked models
 * with capability scores, costs, and savings vs baseline.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RouterClient, CompareResponse } from "../client.js";
/**
 * Format compare response into human-readable text for the LLM.
 */
export declare function formatCompareText(data: CompareResponse): string;
/**
 * Register the router_compare_models tool on an MCP server.
 */
export declare function registerCompareModelsTool(server: McpServer, client: RouterClient): void;
//# sourceMappingURL=compare-models.d.ts.map