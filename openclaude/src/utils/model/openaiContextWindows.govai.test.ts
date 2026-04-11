/**
 * openaiContextWindows.govai.test.ts
 *
 * Regression guard for the GovAI custom LiteLLM aliases.
 *
 * Background: OpenClaude calls getOpenAIContextWindow() during every turn
 * to decide whether to trigger its auto-compact path. When the alias is
 * unknown, it falls back to a conservative 8k default — and OpenClaude's
 * own system prompt + tool definitions are ~18.6K tokens, which means
 * EVERY turn would auto-compact instead of running the user's task.
 *
 * The visible failure mode (before this guard existed): a user asking
 * "list files in the project root" got back a "summarize the conversation"
 * template because OpenClaude swapped its prompt for the compact one.
 *
 * Note on OPENAI_MODEL: lookupByModel pre-pends process.env.OPENAI_MODEL
 * as a qualifier, e.g. `govai-llm-gemini:govai-llm-cerebras`. The
 * longest-prefix-wins rule then matches `govai-llm-gemini` (16 chars) and
 * silently returns the gemini value for any other GovAI alias. In the
 * runtime this is harmless because OpenClaude only ever queries with the
 * OPENAI_MODEL value itself, so there is no cross-alias lookup. But for
 * the tests we MUST clear OPENAI_MODEL — otherwise every assertion would
 * collapse to the gemini 1M value.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
  getOpenAIContextWindow,
  getOpenAIMaxOutputTokens,
} from './openaiContextWindows.js'

const SAVED_OPENAI_MODEL = process.env.OPENAI_MODEL

beforeAll(() => {
  delete process.env.OPENAI_MODEL
})

afterAll(() => {
  if (SAVED_OPENAI_MODEL !== undefined) {
    process.env.OPENAI_MODEL = SAVED_OPENAI_MODEL
  }
})

test('govai-llm-gemini reports the full Gemini 1M context window', () => {
  // Without this entry, OpenClaude falls back to its 8k conservative
  // default and triggers auto-compact on every turn — see the comment
  // in openaiContextWindows.ts for the full explanation.
  expect(getOpenAIContextWindow('govai-llm-gemini')).toBe(1_048_576)
  expect(getOpenAIMaxOutputTokens('govai-llm-gemini')).toBe(65_536)
})

test('govai-llm-gemini-flash reports the full Gemini 1M context window', () => {
  // Backup alias used as a fallback when flash-lite is rate-limited.
  expect(getOpenAIContextWindow('govai-llm-gemini-flash')).toBe(1_048_576)
  expect(getOpenAIMaxOutputTokens('govai-llm-gemini-flash')).toBe(65_536)
})

test('gemini-2.5-flash-lite is registered (1M context, 64k max output)', () => {
  // The actual underlying model that govai-llm-gemini routes to via
  // LiteLLM. We register both the alias and the real name so direct
  // model references (e.g. via /provider) also resolve correctly.
  expect(getOpenAIContextWindow('gemini-2.5-flash-lite')).toBe(1_048_576)
  expect(getOpenAIMaxOutputTokens('gemini-2.5-flash-lite')).toBe(65_536)
})

test('govai-llm-cerebras reports the 64k Cerebras context (qwen-3-235b)', () => {
  // Cerebras's qwen-3-235b is the only Cerebras model on this account
  // that returns properly structured tool_calls (verified manually with
  // the get_weather function-calling test). 64k is the registered cap
  // — published Cerebras free tier limit and verified empirically with
  // a 17K-token probe before adoption.
  expect(getOpenAIContextWindow('govai-llm-cerebras')).toBe(64_000)
  expect(getOpenAIMaxOutputTokens('govai-llm-cerebras')).toBe(8_192)
})

test('govai-llm-cerebras-fast reports the llama3.1-8b 128k context', () => {
  // Cerebras's llama3.1-8b alias. NOT used as an OpenClaude target
  // because it returns tool calls as plain text content blocks instead
  // of the OpenAI structured tool_calls format — but it's exposed in
  // the model selector for plain chat traffic, so we still need to
  // register it correctly to avoid the 8k auto-compact false positive.
  expect(getOpenAIContextWindow('govai-llm-cerebras-fast')).toBe(128_000)
  expect(getOpenAIMaxOutputTokens('govai-llm-cerebras-fast')).toBe(8_192)
})

test('govai-llm-ollama reports the qwen2.5:3b 32k context', () => {
  // The absolute floor of the failover chain — runs locally on the
  // developer's host (no quota, no internet). Qwen 2.5 ships with a
  // 32k context window, so registering at 32_768 lets OpenClaude
  // route through it without auto-compacting.
  expect(getOpenAIContextWindow('govai-llm-ollama')).toBe(32_768)
  expect(getOpenAIMaxOutputTokens('govai-llm-ollama')).toBe(4_096)
})

// Note on what this file does NOT cover: the "miss" path. Inside
// openclaude-runner, OPENAI_MODEL=govai-llm-gemini is always set, and
// lookupByModel pre-pends it as a qualifier — so any miss-path test
// would resolve via the longest-prefix-wins rule and silently match the
// govai-llm-gemini entry. That's the existing behavior of lookupByKey
// (designed for dated variants like gpt-4o-2024-11-20 → gpt-4o) and is
// not something this regression file is trying to assert. The three
// positive tests above are what the runtime actually depends on.
