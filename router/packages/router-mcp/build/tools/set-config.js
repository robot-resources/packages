/**
 * router_set_config MCP tool.
 *
 * "Change the routing config" — applies partial config updates
 * as runtime overrides. In-memory only, cleared on restart.
 */
import * as z from "zod/v4";
/**
 * Input schema for the router_set_config tool.
 */
const inputSchema = z.object({
    provider_scope: z
        .enum(["all", "anthropic", "openai", "google"])
        .nullish()
        .describe('Provider scope for routing. "all" uses all providers, or restrict to one. Send null to reset to default.'),
    capability_threshold: z
        .number()
        .min(0)
        .max(1)
        .nullish()
        .describe("Minimum capability score for model selection (0.0–1.0). Lower = cheaper but less capable. Send null to reset to default."),
    baseline_model: z
        .string()
        .nullish()
        .describe("Baseline model for savings comparison (e.g., gpt-4o). Must exist in models database. Send null to reset to default."),
    log_level: z
        .enum(["DEBUG", "INFO", "WARNING", "ERROR"])
        .nullish()
        .describe("Logging verbosity level. Send null to reset to default."),
});
/**
 * Output schema matching the PATCH /v1/config response.
 */
const outputSchema = z.object({
    provider_scope: z.string(),
    capability_threshold: z.number(),
    baseline_model: z.string(),
    log_level: z.string(),
    overrides: z.array(z.string()),
});
/**
 * Format config response after update.
 */
function formatSetConfigText(data) {
    const lines = [];
    lines.push("Config Updated Successfully");
    lines.push("─".repeat(40));
    lines.push(`Provider Scope:       ${data.provider_scope}`);
    lines.push(`Capability Threshold: ${data.capability_threshold}`);
    lines.push(`Baseline Model:       ${data.baseline_model}`);
    lines.push(`Log Level:            ${data.log_level}`);
    if (data.overrides.length > 0) {
        lines.push("");
        lines.push(`Active Overrides: ${data.overrides.join(", ")}`);
    }
    lines.push("");
    lines.push("Note: Overrides are in-memory only. Restart clears all overrides.");
    return lines.join("\n");
}
/**
 * Register the router_set_config tool on an MCP server.
 */
export function registerSetConfigTool(server, client) {
    server.registerTool("router_set_config", {
        title: "Router Set Config",
        description: "Update Router routing configuration at runtime. " +
            "Only provide fields you want to change — other fields keep " +
            "their current values. Send null for a field to reset it to " +
            "the env-var default. Overrides are in-memory only and cleared " +
            "on proxy restart.",
        inputSchema,
        outputSchema,
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    }, async (params) => {
        try {
            // Build updates object — only include fields that were provided
            const updates = {};
            if (params.provider_scope !== undefined)
                updates.provider_scope = params.provider_scope;
            if (params.capability_threshold !== undefined)
                updates.capability_threshold = params.capability_threshold;
            if (params.baseline_model !== undefined)
                updates.baseline_model = params.baseline_model;
            if (params.log_level !== undefined)
                updates.log_level = params.log_level;
            const data = await client.setConfig(updates);
            return {
                content: [
                    { type: "text", text: formatSetConfigText(data) },
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
                        text: `Failed to update config: ${message}. Is the Router proxy running on localhost:3838?`,
                    },
                ],
                isError: true,
            };
        }
    });
}
//# sourceMappingURL=set-config.js.map