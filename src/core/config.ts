function intEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Read on each access so tests can change values at runtime. */
export const config = {
  get model() {
    return process.env.AGENT_MODEL || "claude-opus-5-5";
  },
  get effort() {
    return (process.env.AGENT_EFFORT || "medium") as "low" | "medium" | "high" | "xhigh" | "max";
  },
  get historyTokenBudget() {
    return intEnv("HISTORY_TOKEN_BUDGET", 24_000);
  },
  /** A remote MCP server whose tools the agent can use. Unset means none. */
  get mcpUrl() {
    return process.env.MCP_URL?.trim() || "";
  },
  /** The server's guide for the model. Defaults to SKILL.md beside the MCP endpoint. */
  get mcpSkillUrl() {
    return process.env.MCP_SKILL_URL?.trim() || "";
  },
  /** Offer only these tools from the server. Empty means all of them. */
  get mcpTools() {
    return new Set((process.env.MCP_TOOLS ?? "").split(",").map((name) => name.trim()).filter(Boolean));
  },
  /**
   * "markets" restricts the agent to Indian market data. "general" leaves it an
   * open assistant. Markets is the default once an MCP server is connected.
   */
  get marketsOnly() {
    const scope = process.env.AGENT_SCOPE?.trim();
    return scope ? scope === "markets" : Boolean(this.mcpUrl);
  },
  /** Chat replies often come 5 to 60 minutes apart, which a 5-minute cache would miss. */
  get cacheTtl() {
    return process.env.PROMPT_CACHE_TTL === "5m" ? ("5m" as const) : ("1h" as const);
  },
  /** A batch is ready once the thread has been quiet this long... */
  get debounceMs() {
    return intEnv("DEBOUNCE_MS", 3_000);
  },
  /** ...or once its oldest message has waited this long, so nonstop typing can't starve it. */
  get debounceMaxMs() {
    return intEnv("DEBOUNCE_MAX_MS", 15_000);
  },
  get pollMs() {
    return intEnv("WORKER_POLL_MS", 500);
  },
  get leaseMs() {
    return intEnv("LEASE_MS", 60_000);
  },
  get turnTimeoutMs() {
    return intEnv("TURN_TIMEOUT_MS", 5 * 60_000);
  },
  get retryBaseMs() {
    return intEnv("RETRY_BASE_MS", 5_000);
  },
  maxTurnAttempts: 3,
  maxConcurrentTurns: 8,
  maxSteps: 12,
  maxMessageChars: 16_000,
};
