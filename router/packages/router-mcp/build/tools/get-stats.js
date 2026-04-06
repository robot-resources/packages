/**
 * router_get_stats MCP tool.
 *
 * "How much am I saving?" — returns cost savings data from the Router proxy.
 */
import * as z from "zod/v4";
/**
 * Input schema for the router_get_stats tool.
 */
const inputSchema = z.object({
    period: z
        .enum(["weekly", "monthly", "all"])
        .default("weekly")
        .describe("Time period for stats: weekly (7 days), monthly (30 days), or all time"),
    task_type: z
        .string()
        .optional()
        .describe("Filter by task type (coding, reasoning, analysis, simple_qa, creative, general)"),
    provider: z
        .string()
        .optional()
        .describe("Filter by provider (openai, anthropic, google)"),
});
/**
 * Output schema matching the /v1/stats response.
 */
const outputSchema = z.object({
    period: z.string(),
    total_requests: z.number(),
    total_cost_saved: z.number(),
    total_cost_actual: z.number(),
    total_cost_baseline: z.number(),
    average_savings_per_request: z.number(),
    breakdown_by_task_type: z.record(z.string(), z.object({ count: z.number(), cost_saved: z.number() })),
    breakdown_by_provider: z.record(z.string(), z.object({ count: z.number(), cost_saved: z.number() })),
});
/**
 * Format stats into human-readable text for the LLM.
 */
function formatStatsText(stats) {
    const lines = [];
    lines.push(`Router Cost Savings (${stats.period})`);
    lines.push("─".repeat(40));
    if (stats.total_requests === 0) {
        lines.push("No routing data for this period.");
        return lines.join("\n");
    }
    lines.push(`Total Requests:      ${stats.total_requests.toLocaleString()}`);
    lines.push(`Total Cost Saved:    $${stats.total_cost_saved.toFixed(4)}`);
    lines.push(`Actual Cost:         $${stats.total_cost_actual.toFixed(4)}`);
    lines.push(`Baseline Cost:       $${stats.total_cost_baseline.toFixed(4)}`);
    lines.push(`Avg Saved/Request:   $${stats.average_savings_per_request.toFixed(6)}`);
    const taskTypes = Object.entries(stats.breakdown_by_task_type);
    if (taskTypes.length > 0) {
        lines.push("");
        lines.push("By Task Type:");
        for (const [type, data] of taskTypes) {
            lines.push(`  ${type.padEnd(16)} ${data.count} reqs, $${data.cost_saved.toFixed(4)} saved`);
        }
    }
    const providers = Object.entries(stats.breakdown_by_provider);
    if (providers.length > 0) {
        lines.push("");
        lines.push("By Provider:");
        for (const [prov, data] of providers) {
            lines.push(`  ${prov.padEnd(16)} ${data.count} reqs, $${data.cost_saved.toFixed(4)} saved`);
        }
    }
    return lines.join("\n");
}
/**
 * Register the router_get_stats tool on an MCP server.
 */
export function registerGetStatsTool(server, client) {
    server.registerTool("router_get_stats", {
        title: "Router Get Stats",
        description: "Get routing cost savings statistics from Robot Resources Router. " +
            "Shows how much money has been saved by intelligent model routing, " +
            "with breakdowns by task type and provider.",
        inputSchema,
        outputSchema,
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    }, async ({ period, task_type, provider }) => {
        try {
            const stats = await client.getStats({
                period,
                task_type,
                provider,
            });
            return {
                content: [{ type: "text", text: formatStatsText(stats) }],
                structuredContent: stats,
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            return {
                content: [
                    {
                        type: "text",
                        text: `Failed to fetch stats: ${message}. Is the Router proxy running on localhost:3838?`,
                    },
                ],
                isError: true,
            };
        }
    });
}
//# sourceMappingURL=get-stats.js.map