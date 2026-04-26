/**
 * Embedding provider abstraction — FASE 14.0/6a₁
 * ---------------------------------------------------------------------------
 * Pluggable interface so the RAG pipeline (uploads + retrieval hook) can
 * pick between providers without leaking SDK choice into call sites.
 *
 * Today's options:
 *   - 'gemini' — Google's gemini-embedding-001 via the v1beta REST API.
 *                768 dimensions; uses GEMINI_API_KEY (already wired
 *                across the platform). DEFAULT.
 *   - 'openai' — text-embedding-3-small (1536 dim) via @openai/openai
 *                lazy-loaded. Requires OPENAI_EMBEDDINGS_API_KEY.
 *   - 'mock'   — deterministic seeded vectors. CI/dev fallback when no
 *                external key is configured.
 *
 * Anthropic does NOT offer first-party embeddings as of this writing
 * (the @anthropic-ai/sdk has no `embeddings.create`). Customers who
 * want to use Claude for everything else can swap to Voyage AI later
 * by adding a fourth implementation here.
 *
 * The legacy pgvector RAG (src/lib/rag.ts → /v1/execute LLM-direct
 * path) keeps using Gemini directly via axios — unchanged. This module
 * is the entry-point for the NEW Qdrant pipeline only.
 */

import axios from 'axios';

export interface EmbeddingProvider {
    /** Human-readable provider name, persisted in knowledge_bases.embedding_provider. */
    readonly name: string;
    /** Model id, persisted in knowledge_bases.embedding_model. */
    readonly model: string;
    /** Output vector dimensionality, persisted in knowledge_bases.embedding_dim. */
    readonly dimensions: number;
    /** Embed N texts → N vectors. */
    embed(texts: string[]): Promise<number[][]>;
}

// ── Gemini provider ────────────────────────────────────────────────────────
//
// Uses the v1beta REST endpoint with output_dimensionality=768 to match
// the legacy pgvector schema. The API supports batching N inputs in
// parallel; we serialize because the free-tier quota is small and a
// large parallel burst exhausts it instantly.

class GeminiEmbeddingProvider implements EmbeddingProvider {
    readonly name = 'gemini';
    readonly model = 'gemini-embedding-001';
    readonly dimensions = 768;

    constructor(private readonly apiKey: string) {}

    async embed(texts: string[]): Promise<number[][]> {
        const out: number[][] = [];
        for (const text of texts) {
            // The model accepts up to ~30K tokens per call; chunks here
            // are ≤ 512 tokens by construction so no truncation needed.
            const res = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent`,
                {
                    content: { parts: [{ text }] },
                    output_dimensionality: this.dimensions,
                },
                {
                    headers: { 'x-goog-api-key': this.apiKey },
                    timeout: 30_000,
                },
            );
            const values = res.data?.embedding?.values;
            if (!Array.isArray(values) || values.length !== this.dimensions) {
                throw new Error(`Gemini embed returned malformed vector (got len=${values?.length ?? 'null'})`);
            }
            out.push(values);
        }
        return out;
    }
}

// ── OpenAI provider ────────────────────────────────────────────────────────
//
// Lazy-loaded so the api image doesn't need the openai package unless
// the operator opts in. The dimension is configurable via env so
// migrating between text-embedding-3-small (1536) and -large (3072) is
// a config change.

class OpenAIEmbeddingProvider implements EmbeddingProvider {
    readonly name = 'openai';
    constructor(
        readonly model: string,
        readonly dimensions: number,
        private readonly apiKey: string,
    ) {}
    async embed(texts: string[]): Promise<number[][]> {
        // axios fallback so we don't need the openai SDK installed.
        const res = await axios.post(
            'https://api.openai.com/v1/embeddings',
            { model: this.model, input: texts, dimensions: this.dimensions },
            {
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
                timeout: 30_000,
            },
        );
        const data = res.data?.data;
        if (!Array.isArray(data) || data.length !== texts.length) {
            throw new Error('OpenAI embed returned malformed payload');
        }
        return data.map((d: any) => d.embedding as number[]);
    }
}

// ── Mock provider ──────────────────────────────────────────────────────────
//
// Deterministic seeded vectors so reality-check tests pass without an
// external embeddings service. The seed is the sum of char codes — same
// text always produces the same vector. Two different texts get distinct
// vectors with non-trivial cosine similarity, so retrieval still
// surfaces "the right" chunk for keyword-rich queries.

class MockEmbeddingProvider implements EmbeddingProvider {
    readonly name = 'mock';
    readonly model = 'mock-deterministic-v1';
    readonly dimensions = 768;
    async embed(texts: string[]): Promise<number[][]> {
        return texts.map(text => {
            const seed = [...text].reduce((a, c) => a + c.charCodeAt(0), 0);
            // Mix in a per-token influence so substring matches still
            // cluster nearby in cosine space (helps retrieval tests
            // produce stable winners).
            const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
            const out = new Array<number>(this.dimensions);
            for (let i = 0; i < this.dimensions; i++) {
                let v = Math.sin(seed + i * 0.31415);
                for (let t = 0; t < Math.min(tokens.length, 16); t++) {
                    const tokenSeed = [...tokens[t]].reduce((a, c) => a + c.charCodeAt(0), 0);
                    v += Math.sin(tokenSeed + i) / 16;
                }
                out[i] = v;
            }
            // L2-normalize so cosine ≡ dot product downstream.
            const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0)) || 1;
            for (let i = 0; i < out.length; i++) out[i] /= norm;
            return out;
        });
    }
}

// ── Factory ────────────────────────────────────────────────────────────────
//
// Reads EMBEDDINGS_PROVIDER on first call and caches the instance per
// process. Falls back to mock if the configured provider has no key.

let _cached: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
    if (_cached) return _cached;
    const provider = (process.env.EMBEDDINGS_PROVIDER || 'gemini').toLowerCase();

    if (provider === 'mock') {
        _cached = new MockEmbeddingProvider();
        return _cached;
    }
    if (provider === 'gemini') {
        const key = process.env.GEMINI_API_KEY;
        if (!key) {
            console.warn('[embeddings] GEMINI_API_KEY missing — falling back to mock provider');
            _cached = new MockEmbeddingProvider();
            return _cached;
        }
        _cached = new GeminiEmbeddingProvider(key);
        return _cached;
    }
    if (provider === 'openai') {
        const key = process.env.OPENAI_EMBEDDINGS_API_KEY;
        if (!key) {
            console.warn('[embeddings] OPENAI_EMBEDDINGS_API_KEY missing — falling back to mock provider');
            _cached = new MockEmbeddingProvider();
            return _cached;
        }
        _cached = new OpenAIEmbeddingProvider(
            process.env.OPENAI_EMBEDDINGS_MODEL || 'text-embedding-3-small',
            parseInt(process.env.OPENAI_EMBEDDINGS_DIM || '1536', 10),
            key,
        );
        return _cached;
    }
    throw new Error(`unknown EMBEDDINGS_PROVIDER: ${provider}`);
}

/** Test helper — drop the cached singleton so a follow-up call rebuilds it. */
export function resetEmbeddingProviderForTests(): void {
    _cached = null;
}
