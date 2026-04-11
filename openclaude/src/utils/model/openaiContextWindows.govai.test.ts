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
 */
import { expect, test } from 'bun:test'
import {
  getOpenAIContextWindow,
  getOpenAIMaxOutputTokens,
} from './openaiContextWindows.js'

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

// Note on what this file does NOT cover: the "miss" path. Inside
// openclaude-runner, OPENAI_MODEL=govai-llm-gemini is always set, and
// lookupByModel pre-pends it as a qualifier — so any miss-path test
// would resolve via the longest-prefix-wins rule and silently match the
// govai-llm-gemini entry. That's the existing behavior of lookupByKey
// (designed for dated variants like gpt-4o-2024-11-20 → gpt-4o) and is
// not something this regression file is trying to assert. The three
// positive tests above are what the runtime actually depends on.
