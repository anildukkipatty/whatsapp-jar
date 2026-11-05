import type { LanguageModelUsage, ProviderMetadata } from "ai";

type Price = { input: number; cacheWrite5m: number; cacheWrite1h: number; cacheRead: number; output: number };

/**
 * USD per million tokens, standard API rates, from
 * https://platform.claude.com/docs/en/about-claude/pricing (checked 2026-11-05).
 *
 * A model missing from this table shows tokens with no cost. Haiku 5.5 is left
 * out on purpose: its price depends on each request's prompt length.
 */
export const PRICES: Record<string, Price> = {
  "claude-fable-5-1": { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25, output: 50 },
  "claude-fable-5": { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1, output: 50 },
  "claude-opus-5-5": { input: 4, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20 },
  "claude-opus-5": { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
  "claude-opus-4-8": { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
  "claude-opus-4-7": { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
  "claude-opus-4-6": { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
  "claude-sonnet-5-5": { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.1, output: 10 },
  "claude-sonnet-5": { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2, output: 10 },
  "claude-sonnet-4-6": { input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3, output: 15 },
  "claude-haiku-4-5": { input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5 },
};

/** Refusals in these categories are billed even with no output. All others are free. */
const BILLED_REFUSAL_CATEGORIES = new Set(["bio", "frontier_llm", "reasoning_extraction"]);

export type TurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Null once any step can't be priced, so a total is never partly made up. */
  costUsd: number | null;
};

export const emptyUsage = (): TurnUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
});

export const hasUsage = (usage: TurnUsage) => usage.inputTokens + usage.outputTokens > 0;

export type BilledStep = {
  usage: LanguageModelUsage;
  response: { modelId: string };
  finishReason: string;
  content: unknown[];
  providerMetadata?: ProviderMetadata;
};

function stepCost(step: BilledStep): number | null {
  const anthropic = step.providerMetadata?.anthropic as
    | { stopDetails?: { category?: string | null }; iterations?: { type: string }[] | null }
    | undefined;

  if (step.finishReason === "content-filter" && !step.content.length) {
    const category = anthropic?.stopDetails?.category;
    if (!category || !BILLED_REFUSAL_CATEGORIES.has(category)) return 0;
  }

  // A declined attempt before a fallback may or may not be billed, and the
  // response doesn't say which, so any figure here could be wrong.
  const iterations = anthropic?.iterations ?? [];
  if (iterations.some((i) => i.type === "fallback_message") && iterations.some((i) => i.type === "message")) {
    return null;
  }

  // The model that actually ran, which a fallback can make different from the one requested.
  const price = PRICES[step.response.modelId];
  const { noCacheTokens, cacheReadTokens, cacheWriteTokens } = step.usage.inputTokenDetails;
  const output = step.usage.outputTokens;
  if (!price || noCacheTokens === undefined || output === undefined) return null;

  const raw = step.usage.raw as { cache_creation?: { ephemeral_1h_input_tokens?: number } } | undefined;
  const write1h = raw?.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const write5m = (cacheWriteTokens ?? 0) - write1h;

  return (
    (noCacheTokens * price.input +
      (cacheReadTokens ?? 0) * price.cacheRead +
      write5m * price.cacheWrite5m +
      write1h * price.cacheWrite1h +
      output * price.output) /
    1_000_000
  );
}

export function addStep(total: TurnUsage, step: BilledStep) {
  const cost = stepCost(step);
  total.inputTokens += step.usage.inputTokens ?? 0;
  total.outputTokens += step.usage.outputTokens ?? 0;
  total.cacheReadTokens += step.usage.inputTokenDetails.cacheReadTokens ?? 0;
  total.cacheWriteTokens += step.usage.inputTokenDetails.cacheWriteTokens ?? 0;
  total.costUsd = total.costUsd === null || cost === null ? null : total.costUsd + cost;
}
