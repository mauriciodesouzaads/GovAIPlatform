'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, AlertCircle, ArrowRight, Cpu, Brain, Network, Layers } from 'lucide-react';
import type {
    McpServerSummary,
    RuntimeAdminClient,
    CreateWorkItemBody,
} from '@/lib/runtime-admin-client';
import type { RuntimeRunnerHealth } from '@/types/runtime-admin';

type Engine = 'openclaude' | 'claude_code_official' | 'aider';

const ENGINE_LABELS: Record<Engine, string> = {
    openclaude:           'OpenClaude (curado)',
    claude_code_official: 'Claude Code Oficial',
    aider:                'Aider',
};

/**
 * Modo Livre form — pick the engine + model + system prompt + MCPs
 * inline. No assistant binding, no published version. The native
 * harness runs under audit hooks; the row is marked execution_mode=
 * 'freeform' and assistant_id stays NULL (enforced by 093 CHECK).
 *
 * Used by:
 *   - Consultants evaluating a new agent recipe before publishing it
 *     as an assistant.
 *   - Power users who need raw access to the harness for one-off
 *     tasks where the governance overhead of a full assistant version
 *     is unwarranted.
 *
 * The audit trail is identical to Modo Agente — every tool call,
 * every approval prompt, every file change goes into
 * runtime_work_item_events. The only thing that's "free" is the
 * configuration choice; the runtime gates are the same.
 */
export function FreeformExecutionForm({
    client,
    runners,
    mcpServers,
    mcpLoading,
}: {
    client: RuntimeAdminClient | null;
    runners: RuntimeRunnerHealth[];
    mcpServers: McpServerSummary[];
    mcpLoading: boolean;
}) {
    const router = useRouter();

    // Default to first available engine, fallback openclaude.
    const firstAvailable = runners.find(r => r.available)?.slug as Engine | undefined;
    const [engine, setEngine] = useState<Engine>(firstAvailable ?? 'openclaude');
    const [systemPrompt, setSystemPrompt] = useState('');
    const [message, setMessage] = useState('');
    const [model, setModel] = useState('');
    const [enableThinking, setEnableThinking] = useState(false);
    const [thinkingBudget, setThinkingBudget] = useState(4000);
    const [enableSubagents, setEnableSubagents] = useState(false);
    const [selectedMcps, setSelectedMcps] = useState<string[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);

    const engineAvailable = (slug: Engine): boolean => {
        const r = runners.find(x => x.slug === slug);
        return r ? r.available : false;
    };

    const toggleMcp = (id: string) => {
        setSelectedMcps(prev =>
            prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
        );
    };

    const submit = async () => {
        if (!client || !message.trim()) return;
        setSubmitting(true);
        setSubmitError(null);
        try {
            const body: CreateWorkItemBody = {
                mode: 'freeform',
                runtime_profile_slug: engine,
                message: message.trim(),
                ...(systemPrompt.trim() ? { system_prompt: systemPrompt.trim() } : {}),
                ...(model.trim() ? { model: model.trim() } : {}),
                ...((enableThinking || enableSubagents) ? {
                    runtime_options: {
                        ...(enableThinking ? {
                            enable_thinking: true,
                            thinking_budget_tokens: thinkingBudget,
                        } : {}),
                        ...(enableSubagents ? { enable_subagents: true } : {}),
                    },
                } : {}),
                ...(selectedMcps.length > 0 ? { mcp_server_ids: selectedMcps } : {}),
            };
            const res = await client.createWorkItem(body);
            router.push(`/execucoes/${res.work_item_id}`);
        } catch (e) {
            setSubmitError((e as Error).message);
            setSubmitting(false);
        }
    };

    return (
        <div className="max-w-3xl space-y-6">
            <header className="space-y-1">
                <h2 className="text-base font-semibold text-foreground/95">
                    Nova execução — Modo Livre
                </h2>
                <p className="text-sm text-muted-foreground">
                    Configure o harness inline. Útil para avaliar uma receita de agente antes
                    de publicá-la, ou para tarefas avulsas onde uma assistant version formal
                    é overkill. Auditado igual ao Modo Agente — todas as ferramentas, prompts
                    de aprovação e mudanças de arquivo vão para o timeline.
                </p>
            </header>

            {/* Engine */}
            <section className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Engine
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {(['openclaude', 'claude_code_official', 'aider'] as const).map(slug => {
                        const available = engineAvailable(slug);
                        const active = engine === slug;
                        return (
                            <button
                                key={slug}
                                type="button"
                                onClick={() => available && setEngine(slug)}
                                disabled={!available}
                                className={[
                                    'flex items-center gap-2 rounded-md border px-3 py-2.5 text-left transition-colors',
                                    active
                                        ? 'border-emerald-500/60 bg-emerald-500/10'
                                        : 'border-border/40 bg-card/30 hover:bg-card/50',
                                    !available && 'opacity-40 cursor-not-allowed',
                                ].filter(Boolean).join(' ')}
                            >
                                <Cpu className={[
                                    'h-3.5 w-3.5 flex-shrink-0',
                                    active ? 'text-emerald-300' : 'text-muted-foreground',
                                ].join(' ')} />
                                <div className="min-w-0">
                                    <div className="text-sm font-medium text-foreground/95">
                                        {ENGINE_LABELS[slug]}
                                    </div>
                                    <div className="text-[10px] text-muted-foreground font-mono">
                                        {slug}
                                        {!available && ' · indisponível'}
                                    </div>
                                </div>
                            </button>
                        );
                    })}
                </div>
            </section>

            {/* System prompt */}
            <section className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    System prompt (opcional)
                </label>
                <textarea
                    value={systemPrompt}
                    onChange={(e) => setSystemPrompt(e.target.value)}
                    placeholder="Você é um assistente de pesquisa que… (deixe em branco para usar o default da harness)"
                    rows={3}
                    className="w-full rounded-md border border-border/40 bg-card/30 px-3 py-2 text-sm text-foreground/95 placeholder:text-muted-foreground/60 focus:outline-none focus:border-emerald-500/60 resize-y min-h-[80px] font-mono text-xs"
                />
            </section>

            {/* Message */}
            <section className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Mensagem inicial
                </label>
                <textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="O que você quer que essa harness execute?"
                    rows={5}
                    className="w-full rounded-md border border-border/40 bg-card/30 px-3 py-2 text-sm text-foreground/95 placeholder:text-muted-foreground/60 focus:outline-none focus:border-emerald-500/60 resize-y min-h-[100px]"
                />
                <div className="text-[11px] text-muted-foreground">
                    {message.length} / 50 000 caracteres
                </div>
            </section>

            {/* Advanced */}
            <details className="space-y-2 group">
                <summary className="text-xs font-semibold uppercase tracking-wide text-muted-foreground cursor-pointer hover:text-foreground/80 transition-colors">
                    Avançado · model, thinking, subagentes
                </summary>
                <div className="space-y-3 pt-2 pl-2 border-l border-border/30">
                    {/* Model override */}
                    <div className="space-y-1.5">
                        <label className="text-[11px] text-muted-foreground">
                            Model override (opcional, ex: <code>anthropic/claude-sonnet-4</code>)
                        </label>
                        <input
                            type="text"
                            value={model}
                            onChange={(e) => setModel(e.target.value)}
                            placeholder="(default da harness)"
                            className="w-full rounded-md border border-border/40 bg-card/30 px-3 py-1.5 text-xs text-foreground/95 placeholder:text-muted-foreground/60 focus:outline-none focus:border-emerald-500/60 font-mono"
                        />
                    </div>

                    {/* Thinking */}
                    <div className="space-y-2">
                        <label className="flex items-center gap-2 cursor-pointer">
                            <input
                                type="checkbox"
                                checked={enableThinking}
                                onChange={(e) => setEnableThinking(e.target.checked)}
                                className="rounded border-border/40 bg-card/30"
                            />
                            <Brain className="h-3.5 w-3.5 text-muted-foreground" />
                            <span className="text-xs">Extended thinking</span>
                        </label>
                        {enableThinking && (
                            <div className="pl-5 space-y-1">
                                <label className="text-[11px] text-muted-foreground">
                                    Budget (tokens): {thinkingBudget}
                                </label>
                                <input
                                    type="range"
                                    min={1000}
                                    max={32000}
                                    step={1000}
                                    value={thinkingBudget}
                                    onChange={(e) => setThinkingBudget(parseInt(e.target.value, 10))}
                                    className="w-full"
                                />
                            </div>
                        )}
                    </div>

                    {/* Subagents */}
                    <label className="flex items-center gap-2 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={enableSubagents}
                            onChange={(e) => setEnableSubagents(e.target.checked)}
                            className="rounded border-border/40 bg-card/30"
                        />
                        <Layers className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="text-xs">
                            Subagentes (Task tool) — só faz sentido em <code>claude_code_official</code>
                        </span>
                    </label>
                </div>
            </details>

            {/* MCPs */}
            <section className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
                    <Network className="h-3 w-3" />
                    MCPs
                </label>
                {mcpLoading ? (
                    <div className="text-xs text-muted-foreground">Carregando registry…</div>
                ) : mcpServers.length === 0 ? (
                    <div className="text-xs text-muted-foreground">
                        Nenhum MCP server registrado. Configure em{' '}
                        <code className="text-[11px] bg-black/30 px-1 rounded">/v1/admin/mcp-servers</code>.
                    </div>
                ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                        {mcpServers.map(s => (
                            <label
                                key={s.id}
                                className={[
                                    'flex items-center gap-2 rounded-md border px-2 py-1.5 cursor-pointer transition-colors',
                                    selectedMcps.includes(s.id)
                                        ? 'border-emerald-500/60 bg-emerald-500/10'
                                        : 'border-border/40 bg-card/30 hover:bg-card/50',
                                ].join(' ')}
                            >
                                <input
                                    type="checkbox"
                                    checked={selectedMcps.includes(s.id)}
                                    onChange={() => toggleMcp(s.id)}
                                    className="rounded border-border/40"
                                />
                                <div className="min-w-0 flex-1">
                                    <div className="text-xs font-medium truncate">{s.name}</div>
                                    <div className="text-[10px] text-muted-foreground font-mono">
                                        {s.transport}
                                    </div>
                                </div>
                            </label>
                        ))}
                    </div>
                )}
            </section>

            {/* Submit */}
            <section className="flex items-center justify-between gap-3 pt-2 border-t border-border/30">
                <div className="text-xs text-muted-foreground">
                    Modo Livre · {ENGINE_LABELS[engine]} · {selectedMcps.length} MCP
                    {enableThinking && ' · thinking'}
                    {enableSubagents && ' · subagentes'}
                </div>
                <button
                    type="button"
                    onClick={submit}
                    disabled={!message.trim() || submitting || !engineAvailable(engine)}
                    className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500 hover:bg-emerald-600 disabled:bg-emerald-500/30 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 transition-colors"
                >
                    {submitting ? (
                        <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            Enfileirando…
                        </>
                    ) : (
                        <>
                            Executar
                            <ArrowRight className="h-3.5 w-3.5" />
                        </>
                    )}
                </button>
            </section>

            {submitError && (
                <div className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-200">
                    <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                    <span>{submitError}</span>
                </div>
            )}
        </div>
    );
}
