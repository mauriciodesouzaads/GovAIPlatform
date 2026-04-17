/**
 * @govai/sdk — TypeScript client for the GovAI Platform API.
 *
 * Public surface:
 *   - `createGovAIClient(options)` — build a typed client
 *   - `paths` — the TypeScript union of every endpoint's shape
 *               (generated from docs/api/openapi.yaml)
 */

export { createGovAIClient, type GovAIClientOptions } from './client';
export type { paths } from './schema';
