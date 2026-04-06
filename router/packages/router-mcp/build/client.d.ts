/**
 * HTTP client for the Router proxy at localhost:3838.
 *
 * All MCP tools communicate with the Router via this client
 * rather than accessing the SQLite database directly.
 */
export interface StatsResponse {
    period: string;
    total_requests: number;
    total_cost_saved: number;
    total_cost_actual: number;
    total_cost_baseline: number;
    average_savings_per_request: number;
    breakdown_by_task_type: Record<string, {
        count: number;
        cost_saved: number;
    }>;
    breakdown_by_provider: Record<string, {
        count: number;
        cost_saved: number;
    }>;
}
export interface CompareModelEntry {
    name: string;
    provider: string;
    capability_score: number;
    cost_per_1k_input: number;
    cost_per_1k_output: number;
    savings_vs_baseline_percent: number;
    meets_threshold: boolean;
    rank: number;
}
export interface CompareRecommended {
    name: string;
    provider: string;
    capability_score: number;
    cost_per_1k_input: number;
    savings_vs_baseline_percent: number;
}
export interface CompareResponse {
    task_type: string;
    threshold: number;
    baseline_model: string;
    models: CompareModelEntry[];
    recommended: CompareRecommended | null;
    total_models: number;
    capable_models: number;
}
export interface ConfigResponse {
    provider_scope: string;
    capability_threshold: number;
    baseline_model: string;
    log_level: string;
    overrides: string[];
}
export interface RouterClientConfig {
    baseUrl: string;
    apiKey?: string;
    timeoutMs: number;
}
export declare class RouterClient {
    private config;
    constructor(config?: Partial<RouterClientConfig>);
    /**
     * Fetch routing stats from GET /v1/stats.
     */
    getStats(params?: {
        period?: "weekly" | "monthly" | "all";
        task_type?: string;
        provider?: string;
    }): Promise<StatsResponse>;
    /**
     * Compare models for a task type from GET /v1/models/compare.
     */
    compareModels(params: {
        task_type: string;
        threshold?: number;
        provider?: string;
    }): Promise<CompareResponse>;
    /**
     * Fetch current config from GET /v1/config.
     */
    getConfig(): Promise<ConfigResponse>;
    /**
     * Update config via PATCH /v1/config.
     */
    setConfig(updates: Partial<{
        provider_scope: string | null;
        capability_threshold: number | null;
        baseline_model: string | null;
        log_level: string | null;
    }>): Promise<ConfigResponse>;
    /**
     * Health check — verify Router proxy is reachable.
     */
    healthCheck(): Promise<boolean>;
}
//# sourceMappingURL=client.d.ts.map