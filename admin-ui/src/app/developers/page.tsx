'use client';

/**
 * Developer Portal — FASE 13.4
 * ---------------------------------------------------------------------------
 * One-stop page for external integrators: versioned OpenAPI spec,
 * SDK install recipes, rate-limit summary, canonical code snippets.
 *
 * Deliberately static and English/Portuguese-aware via next-intl keys
 * (nav.* and common.*). Nothing on this page requires a live API call.
 */

import Link from 'next/link';
import { useState } from 'react';
import { BookOpen, Package, Terminal, Copy, CheckCircle2, ExternalLink, Clock } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { PageHeader } from '@/components/PageHeader';
import { API_BASE } from '@/lib/api';

// ── Reusable code block with copy button ──────────────────────────────────

function CodeBlock({ code, lang = 'bash' }: { code: string; lang?: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <div className="relative group border border-border rounded-lg bg-secondary/30 overflow-hidden">
            <div className="px-3 py-1.5 border-b border-border/50 text-[10px] uppercase tracking-wider text-muted-foreground flex items-center justify-between">
                <span>{lang}</span>
                <button
                    onClick={() => {
                        navigator.clipboard.writeText(code);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 1500);
                    }}
                    className="inline-flex items-center gap-1 text-xs hover:text-foreground"
                >
                    {copied ? <CheckCircle2 className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    {copied ? 'Copied' : 'Copy'}
                </button>
            </div>
            <pre className="p-3 text-xs font-mono whitespace-pre-wrap overflow-x-auto">{code}</pre>
        </div>
    );
}

function SectionCard({
    title, icon, children,
}: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
    return (
        <div className="border border-border rounded-xl bg-card/40 p-5">
            <div className="flex items-center gap-2 mb-3">
                {icon}
                <h2 className="text-sm font-semibold text-foreground">{title}</h2>
            </div>
            {children}
        </div>
    );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function DevelopersPage() {
    const t = useTranslations('common');

    const tsSnippet = `import { createGovAIClient } from '@govai/sdk';

const client = createGovAIClient({
    baseUrl: '${API_BASE}',
    apiKey: process.env.GOVAI_API_KEY!,
    orgId: process.env.GOVAI_ORG_ID!,
});

const { data, error } = await client.GET('/v1/admin/assistants');
if (error) throw error;
console.log(data);`;

    const pySnippet = `from govai_sdk import AuthenticatedClient
from govai_sdk.api.assistants import list_assistants

client = AuthenticatedClient(
    base_url="${API_BASE}",
    token="sk-govai-…",
    headers={"x-org-id": "00000000-0000-0000-0000-000000000001"},
)

for a in list_assistants.sync(client=client):
    print(a.id, a.name)`;

    const curlSnippet = `curl -X GET "${API_BASE}/v1/admin/assistants" \\
  -H "Authorization: Bearer $GOVAI_API_KEY" \\
  -H "x-org-id: $GOVAI_ORG_ID"`;

    return (
        <div className="p-6 max-w-6xl mx-auto space-y-5">
            <PageHeader
                title="Developer Portal"
                subtitle="Integre a plataforma com suas aplicações via API pública + SDKs oficiais"
                icon={<Terminal className="w-5 h-5" />}
                actions={
                    <div className="flex gap-2">
                        <Link
                            href="/v1/docs"
                            target="_blank"
                            className="inline-flex items-center gap-2 text-sm px-3 py-2 rounded-lg border border-border bg-secondary/50 hover:bg-secondary"
                        >
                            <BookOpen className="w-4 h-4" />
                            Swagger UI
                            <ExternalLink className="w-3 h-3" />
                        </Link>
                    </div>
                }
            />

            {/* ── Quick reference bar ─────────────────────────────────────── */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="border border-border rounded-lg bg-card/30 p-3">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Base URL</div>
                    <div className="font-mono text-sm text-foreground mt-1 break-all">{API_BASE}</div>
                </div>
                <div className="border border-border rounded-lg bg-card/30 p-3">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Auth</div>
                    <div className="font-mono text-sm text-foreground mt-1">Bearer sk-govai-…</div>
                </div>
                <div className="border border-border rounded-lg bg-card/30 p-3">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Spec</div>
                    <div className="font-mono text-sm text-foreground mt-1">
                        <a href="https://github.com/mauriciodesouzaads/GovAIPlatform/blob/main/docs/api/openapi.yaml" className="underline hover:text-primary" target="_blank" rel="noreferrer">
                            docs/api/openapi.yaml
                        </a>
                    </div>
                </div>
            </div>

            {/* ── SDK cards ────────────────────────────────────────────────── */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <SectionCard title="TypeScript / JavaScript" icon={<Package className="w-4 h-4 text-primary" />}>
                    <CodeBlock code="npm install @govai/sdk" lang="bash" />
                    <div className="h-2" />
                    <CodeBlock code={tsSnippet} lang="typescript" />
                    <p className="text-xs text-muted-foreground mt-3">
                        Full types generated from <code className="text-foreground">openapi.yaml</code>;
                        your editor autocompletes every route.
                    </p>
                </SectionCard>

                <SectionCard title="Python" icon={<Package className="w-4 h-4 text-primary" />}>
                    <CodeBlock code="pip install govai-sdk" lang="bash" />
                    <div className="h-2" />
                    <CodeBlock code={pySnippet} lang="python" />
                    <p className="text-xs text-muted-foreground mt-3">
                        Generated with <code className="text-foreground">openapi-python-client</code>;
                        sync + async APIs; typed models with attrs.
                    </p>
                </SectionCard>
            </div>

            <SectionCard title="cURL" icon={<Terminal className="w-4 h-4 text-primary" />}>
                <CodeBlock code={curlSnippet} lang="bash" />
            </SectionCard>

            {/* ── Rate limits ──────────────────────────────────────────────── */}
            <SectionCard title="Rate limits" icon={<Clock className="w-4 h-4 text-primary" />}>
                <table className="w-full text-sm">
                    <thead className="text-xs uppercase tracking-wider text-muted-foreground">
                        <tr className="border-b border-border/50">
                            <th className="text-left py-2 font-medium">Caller</th>
                            <th className="text-right py-2 font-medium">Requests / min</th>
                            <th className="text-left py-2 font-medium pl-4">Scope</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr className="border-b border-border/30">
                            <td className="py-2">Authenticated (API key / JWT)</td>
                            <td className="py-2 text-right tabular-nums">1 000</td>
                            <td className="py-2 pl-4 text-muted-foreground">Per credential</td>
                        </tr>
                        <tr>
                            <td className="py-2">Unauthenticated</td>
                            <td className="py-2 text-right tabular-nums">50</td>
                            <td className="py-2 pl-4 text-muted-foreground">Per source IP</td>
                        </tr>
                    </tbody>
                </table>
                <p className="text-xs text-muted-foreground mt-3">
                    Every response carries <code className="text-foreground">X-RateLimit-Limit</code>,
                    {' '}<code className="text-foreground">X-RateLimit-Remaining</code>,
                    {' '}<code className="text-foreground">X-RateLimit-Reset</code>.
                    A 429 adds <code className="text-foreground">Retry-After</code> (seconds).
                    The official SDKs honor all four automatically — see
                    {' '}<code className="text-foreground">docs/api/RATE_LIMITS.md</code>.
                </p>
            </SectionCard>

            {/* ── Footer links ─────────────────────────────────────────────── */}
            <div className="text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                <span>&copy; GovAI Platform</span>
                <span>·</span>
                <Link href="/v1/docs" target="_blank" className="hover:text-foreground underline">Swagger UI</Link>
                <span>·</span>
                <a href="https://github.com/mauriciodesouzaads/GovAIPlatform/tree/main/sdk" className="hover:text-foreground underline" target="_blank" rel="noreferrer">SDK source</a>
                <span>·</span>
                <a href="https://github.com/mauriciodesouzaads/GovAIPlatform/blob/main/docs/api/RATE_LIMITS.md" className="hover:text-foreground underline" target="_blank" rel="noreferrer">Rate limits</a>
                <span className="ml-auto">{t('loading').replace('...', '')} • API v1</span>
            </div>
        </div>
    );
}
