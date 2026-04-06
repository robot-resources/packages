/**
 * HTTP client for the Router proxy at localhost:3838.
 *
 * All MCP tools communicate with the Router via this client
 * rather than accessing the SQLite database directly.
 */
const DEFAULT_CONFIG = {
    baseUrl: process.env.ROUTER_URL ?? "http://localhost:3838",
    apiKey: process.env.ROUTER_API_KEY,
    timeoutMs: 10_000,
};
export class RouterClient {
    config;
    constructor(config) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    /**
     * Fetch routing stats from GET /v1/stats.
     */
    async getStats(params) {
        const url = new URL("/v1/stats", this.config.baseUrl);
        if (params?.period)
            url.searchParams.set("period", params.period);
        if (params?.task_type)
            url.searchParams.set("task_type", params.task_type);
        if (params?.provider)
            url.searchParams.set("provider", params.provider);
        const headers = {
            Accept: "application/json",
        };
        if (this.config.apiKey) {
            headers["Authorization"] = `Bearer ${this.config.apiKey}`;
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
        try {
            const response = await fetch(url.toString(), {
                method: "GET",
                headers,
                signal: controller.signal,
            });
            if (!response.ok) {
                const body = await response.text().catch(() => "");
                throw new Error(`Router API error: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`);
            }
            return (await response.json());
        }
        finally {
            clearTimeout(timeout);
        }
    }
    /**
     * Compare models for a task type from GET /v1/models/compare.
     */
    async compareModels(params) {
        const url = new URL("/v1/models/compare", this.config.baseUrl);
        url.searchParams.set("task_type", params.task_type);
        if (params.threshold !== undefined)
            url.searchParams.set("threshold", String(params.threshold));
        if (params.provider)
            url.searchParams.set("provider", params.provider);
        const headers = {
            Accept: "application/json",
        };
        if (this.config.apiKey) {
            headers["Authorization"] = `Bearer ${this.config.apiKey}`;
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
        try {
            const response = await fetch(url.toString(), {
                method: "GET",
                headers,
                signal: controller.signal,
            });
            if (!response.ok) {
                const body = await response.text().catch(() => "");
                throw new Error(`Router API error: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`);
            }
            return (await response.json());
        }
        finally {
            clearTimeout(timeout);
        }
    }
    /**
     * Fetch current config from GET /v1/config.
     */
    async getConfig() {
        const url = new URL("/v1/config", this.config.baseUrl);
        const headers = {
            Accept: "application/json",
        };
        if (this.config.apiKey) {
            headers["Authorization"] = `Bearer ${this.config.apiKey}`;
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
        try {
            const response = await fetch(url.toString(), {
                method: "GET",
                headers,
                signal: controller.signal,
            });
            if (!response.ok) {
                const body = await response.text().catch(() => "");
                throw new Error(`Router API error: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`);
            }
            return (await response.json());
        }
        finally {
            clearTimeout(timeout);
        }
    }
    /**
     * Update config via PATCH /v1/config.
     */
    async setConfig(updates) {
        const url = new URL("/v1/config", this.config.baseUrl);
        const headers = {
            Accept: "application/json",
            "Content-Type": "application/json",
        };
        if (this.config.apiKey) {
            headers["Authorization"] = `Bearer ${this.config.apiKey}`;
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
        try {
            const response = await fetch(url.toString(), {
                method: "PATCH",
                headers,
                body: JSON.stringify(updates),
                signal: controller.signal,
            });
            if (!response.ok) {
                const body = await response.text().catch(() => "");
                throw new Error(`Router API error: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`);
            }
            return (await response.json());
        }
        finally {
            clearTimeout(timeout);
        }
    }
    /**
     * Health check — verify Router proxy is reachable.
     */
    async healthCheck() {
        try {
            const url = new URL("/health", this.config.baseUrl);
            const response = await fetch(url.toString(), {
                method: "GET",
                signal: AbortSignal.timeout(3_000),
            });
            return response.ok;
        }
        catch {
            return false;
        }
    }
}
//# sourceMappingURL=client.js.map