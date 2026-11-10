function numEnv(name: string, fallback: number) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Read on each access so tests can change values at runtime. */
export const waConfig = {
  /** WhatsApp gives no time zone, so every WhatsApp user gets this one. Limits reset at its midnight. */
  get timeZone() {
    return process.env.WHATSAPP_TIMEZONE || "Asia/Kolkata";
  },
  /** True lets any number chat. Without it only allowedNumbers are answered. */
  get open() {
    return process.env.WHATSAPP_OPEN === "true";
  },
  /** Phone numbers in digits (country code first), or full chat ids such as 123@lid. */
  get allowedNumbers() {
    const list = (process.env.WHATSAPP_ALLOWED_NUMBERS ?? "")
      .split(",")
      .map((entry) => entry.trim().replace(/^\+/, ""))
      .filter(Boolean);
    return new Set(list);
  },
  /**
   * Per number, per day. All limits are off (0) unless set, which suits internal
   * testing. Cost is still recorded on every turn either way. Suggested values
   * once it opens to the public: 30 messages and $2.
   */
  get dailyMessages() {
    return numEnv("WHATSAPP_DAILY_MESSAGES", 0);
  },
  get dailyUsd() {
    return numEnv("WHATSAPP_DAILY_USD", 0);
  },
  /** Across all WhatsApp numbers, per day. Off unless set. */
  get globalDailyMessages() {
    return numEnv("WHATSAPP_GLOBAL_DAILY_MESSAGES", 0);
  },
  get globalDailyUsd() {
    return numEnv("WHATSAPP_GLOBAL_DAILY_USD", 0);
  },
  get sessionDir() {
    return process.env.WHATSAPP_SESSION_DIR || ".whatsapp-session";
  },
  deliveryPollMs: 1_000,
  maxDeliveryAttempts: 5,
  tenantName: "WhatsApp",
};
