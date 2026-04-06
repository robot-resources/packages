/**
 * router_get_config MCP tool.
 *
 * "What's the current routing config?" — returns effective config
 * (env-var defaults merged with runtime overrides).
 */
import * as z from "zod/v4";
/**
 * Output schema matching the GET /v1/config response.
 */
const outputSchema = z.object({
    provider_scope: z.string(),
    capability_threshold: z.number(),
    baseline_model: z.string(),
    log_level: z.string(),
    overrides: z.array(z.string()),
});
/**
 * Format config response into human-readable text for the LLM.
 */
export function formatConfigText(data) {
    const lines = [];
    lines.push("Router Configuration");
    lines.push("─".repeat(40));
    lines.push(`Provider Scope:       ${data.provider_scope}`);
    lines.push(`Capability Threshold: ${data.capability_threshold}`);
    lines.push(`Baseline Model:       ${data.baseline_model}`);
    lines.push(`Log Level:            ${data.log_level}`);
    if (data.overrides.length > 0) {
        lines.push("");
        lines.push(`Runtime Overrides: ${data.overrides.join(", ")}`);
        lines.push("(These fields have been modified at runtime. Restart clears all overrides.)");
    }
    else {
        lines.push("");
        lines.push("No runtime overrides active (using env-var defaults).");
    }
    return lines.join("\n");
}
/**
 * Register the router_get_config tool on an MCP server.
 */
export function registerGetConfigTool(server, client) {
    server.registerTool("router_get_config", {
        title: "Router Get Config",
        description: "Get the current Router routing configuration. " +
            "Returns effective config (env-var defaults merged with any " +
            "runtime overrides). Shows provider_scope, capability_threshold, " +
            "baseline_model, log_level, and which fields are overridden.",
        inputSchema: z.object({}),
        outputSchema,
        annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
    }, async () => {
        try {
            const data = await client.getConfig();
            return {
                content: [
                    { type: "text", text: formatConfigText(data) },
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
                        text: `Failed to get config: ${message}. Is the Router proxy running on localhost:3838?`,
                    },
                ],
                isError: true,
            };
        }
    });
}
//# sourceMappingURL=get-config.js.map