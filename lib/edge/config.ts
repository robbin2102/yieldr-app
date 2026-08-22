/**
 * Env-driven config for the MVP wallet-only edge pipeline and the periodic
 * reasoning agent. Centralized here so every call site reads the same
 * defaults instead of re-parsing process.env inline.
 */

/** Hours between periodic edge-reasoning runs per wallet. Configurable so ops can tune cadence without a redeploy of the cron schedule itself. */
export const EDGE_REASONING_INTERVAL_HOURS = Number(process.env.EDGE_REASONING_INTERVAL_HOURS) || 6;

/** OpenAI chat model used for the periodic edge-reasoning agent. */
export const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

/** Hard cap enforced on the reasoning agent's output, per product spec. */
export const EDGE_REASONING_MAX_WORDS = 300;
