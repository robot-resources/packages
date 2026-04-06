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
  breakdown_by_task_type: Record<
    string,
    { count: number; cost_saved: number }
  >;
  breakdown_by_provider: Record<
    string,
    { count: number; cost_saved: number }
  >;
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

const DEFAULT_CONFIG: RouterClientConfig = {
  baseUrl: process.env.ROUTER_URL ?? "http://localhost:3838",
  apiKey: process.env.ROUTER_API_KEY,
  timeoutMs: 10_000,
};

export class RouterClient {
  private config: RouterClientConfig;

  constructor(config?: Partial<RouterClientConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Fetch routing stats from GET /v1/stats.
   */
  async getStats(params?: {
    period?: "weekly" | "monthly" | "all";
    task_type?: string;
    provider?: string;
  }): Promise<StatsResponse> {
    const url = new URL("/v1/stats", this.config.baseUrl);

    if (params?.period) url.searchParams.set("period", params.period);
    if (params?.task_type) url.searchParams.set("task_type", params.task_type);
    if (params?.provider) url.searchParams.set("provider", params.provider);

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs,
    );

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Router API error: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`,
        );
      }

      return (await response.json()) as StatsResponse;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Compare models for a task type from GET /v1/models/compare.
   */
  async compareModels(params: {
    task_type: string;
    threshold?: number;
    provider?: string;
  }): Promise<CompareResponse> {
    const url = new URL("/v1/models/compare", this.config.baseUrl);

    url.searchParams.set("task_type", params.task_type);
    if (params.threshold !== undefined)
      url.searchParams.set("threshold", String(params.threshold));
    if (params.provider) url.searchParams.set("provider", params.provider);

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs,
    );

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Router API error: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`,
        );
      }

      return (await response.json()) as CompareResponse;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Fetch current config from GET /v1/config.
   */
  async getConfig(): Promise<ConfigResponse> {
    const url = new URL("/v1/config", this.config.baseUrl);

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs,
    );

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Router API error: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`,
        );
      }

      return (await response.json()) as ConfigResponse;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Update config via PATCH /v1/config.
   */
  async setConfig(updates: Partial<{
    provider_scope: string | null;
    capability_threshold: number | null;
    baseline_model: string | null;
    log_level: string | null;
  }>): Promise<ConfigResponse> {
    const url = new URL("/v1/config", this.config.baseUrl);

    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
    };
    if (this.config.apiKey) {
      headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs,
    );

    try {
      const response = await fetch(url.toString(), {
        method: "PATCH",
        headers,
        body: JSON.stringify(updates),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Router API error: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`,
        );
      }

      return (await response.json()) as ConfigResponse;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Health check — verify Router proxy is reachable.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const url = new URL("/health", this.config.baseUrl);
      const response = await fetch(url.toString(), {
        method: "GET",
        signal: AbortSignal.timeout(3_000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
