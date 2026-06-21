/** Cheapest Claude model for tool-calling + vision agents — keep in sync with config.py DEFAULT_MODEL. */
export const ANTHROPIC_AGENT_MODEL =
  process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";
