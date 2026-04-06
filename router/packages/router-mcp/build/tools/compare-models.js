/**
 * router_compare_models MCP tool.
 *
 * "What's the best model for this task?" — returns ranked models
 * with capability scores, costs, and savings vs baseline.
 */
import * as z from "zod/v4";
/**
 * Input schema for the router_compare_models tool.
 */
const inputSchema = z.object({
    task_type: z
        .enum([
        "coding",
        "reasoning",
        "analysis",
        "simple_qa",
        "creative",
        "general",
    ])
        .describe("Task type to compare models for"),
    threshold: z
        .number()
        .min(0)
        .max(1)
        .default(0.7)
        .describe("Minimum capability score (0.0–1.0). Models below this are still shown but marked as not meeting threshold"),
    provider: z
        .string()
        .optional()
        .describe("Filter by provider (openai, anthropic, google)"),
});
/**
 * Output schema matching the /v1/models/compare response.
 */
const outputSchema = z.object({
    task_type: z.string(),
    threshold: z.number(),
    baseline_model: z.string(),
    models: z.array(z.object({
        name: z.string(),
        provider: z.string(),
        capability_score: z.number(),
        cost_per_1k_input: z.number(),
        cost_per_1k_output: z.number(),
        savings_vs_baseline_percent: z.number(),
        meets_threshold: z.boolean(),
        rank: z.number(),
    })),
    recommended: z
        .object({
        name: z.string(),
        provider: z.string(),
        capability_score: z.number(),
        cost_per_1k_input: z.number(),
        savings_vs_baseline_percent: z.number(),
    })
        .nullable(),
    total_models: z.number(),
    capable_models: z.number(),
});
/**
 * Format compare response into human-readable text for the LLM.
 */
export function formatCompareText(data) {
    const lines = [];
    lines.push(`Model Comparison for "${data.task_type}" tasks`);
    lines.push("─".repeat(50));
    lines.push(`Threshold: ${data.threshold} | Baseline: ${data.baseline_model}`);
    lines.push(`Total: ${data.total_models} models | Capable: ${data.capable_models}`);
    if (data.models.length === 0) {
        lines.push("\nNo models found for the specified filters.");
        return lines.join("\n");
    }
    if (data.recommended) {
        lines.push("");
        lines.push(`Recommended: ${data.recommended.name} (${data.recommended.provider})`);
        lines.push(`  Capability: ${data.recommended.capability_score} | Cost: $${data.recommended.cost_per_1k_input}/1k | Saves ${data.recommended.savings_vs_baseline_percent}%`);
    }
    lines.push("");
    lines.push("All Models (cheapest first):");
    lines.push(`${"#".padEnd(3)} ${"Model".padEnd(30)} ${"Provider".padEnd(12)} ${"Cap".padEnd(6)} ${"$/1k".padEnd(10)} ${"Saves".padEnd(8)} Meets`);
    lines.push("─".repeat(80));
    for (const m of data.models) {
        const meets = m.meets_threshold ? "YES" : " no";
        lines.push(`${String(m.rank).padEnd(3)} ${m.name.padEnd(30)} ${m.provider.padEnd(12)} ${m.capability_score.toFixed(2).padEnd(6)} $${m.cost_per_1k_input.toFixed(6).padStart(9)} ${(m.savings_vs_baseline_percent.toFixed(1) + "%").padEnd(8)} ${meets}`);
    }
    return lines.join("\n");
}
/**
 * Register the router_compare_models tool on an MCP server.
 */
export function registerCompareModelsTool(server, client) {
    server.registerTool("router_compare_models", {
        title: "Router Compare Models",
        description: "Compare available LLM models for a specific task type. " +
            "Returns all models ranked by cost with capability scores, " +
            "savings vs baseline, and a recommendation for the cheapest " +
            "model that meets the capability threshold.",
        inputSchema,
        outputSchema,
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    }, async ({ task_type, threshold, provider }) => {
        try {
            const data = await client.compareModels({
                task_type,
                threshold,
                provider,
            });
            return {
                content: [
                    { type: "text", text: formatCompareText(data) },
                ],
                structuredContent: data,
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Unknown error";
            return {
                content: [
                    {
                        type: "text",
                        text: `Failed to compare models: ${message}. Is the Router proxy running on localhost:3838?`,
                    },
                ],
                isError: true,
            };
        }
    });
}
//# sourceMappingURL=compare-models.js.map