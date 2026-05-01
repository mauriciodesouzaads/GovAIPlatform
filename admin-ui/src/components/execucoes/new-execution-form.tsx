'use client';

import { useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Sparkles, Shield, AlertCircle, ArrowRight } from 'lucide-react';
import type { AssistantSummary, RuntimeAdminClient } from '@/lib/runtime-admin-client';

/**
 * Modo Agente form — pick a pre-configured agent + prompt.
 *
 * Philosophy: the consultant ships an agent (system prompt + RAG +
 * engine + skills + MCPs + governance) bundled as one assistant row.
 * The end user only sees a name, a one-line description, and a
 * textarea for their prompt. All runtime knobs are derived from the
 * assistant's default_runtime_options + default_mcp_server_ids. No
 * MCP picker, no engine picker — that's Modo Livre.
 *
 * Submission posts to /v1/admin/runtime/work-items with mode='agent'
 * and on 202 Accepted navigates to /execucoes/:id where the live
 * timeline takes over.
 */
export function NewExecutionForm({
    client,
    assistants,
    loading,
    error,
}: {
    client: RuntimeAdminClient | null;
    assistants: AssistantSummary[];
    loading: boolean;
    error: Error | null;
}) {
    const router = useRouter();
    const [selectedId, setSelectedId] = useState<string>('');
    const [message, setMessage] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);

    const selected = useMemo(
        () => assistants.find(a => a.id === selectedId) ?? null,
        [assistants, selectedId]
    );

    // Auto-pick the first fixture once the list lands so the user can
    // submit without an extra click on the demo path.
    useMemo(() => {
        if (!selectedId && assistants.length > 0) {
            setSelectedId(assistants[0].id);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [assistants.length]);

    const submit = async () => {
        if (!client || !selected || !message.trim()) return;
        setSubmitting(true);
        setSubmitError(null);
        try {
            const res = await client.createWorkItem({
                mode: 'agent',
                assistant_id: selected.id,
                message: message.trim(),
            });
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
                    Nova execução — Modo Agente
                </h2>
                <p className="text-sm text-muted-foreground">
                    Escolha um agente pré-configurado e descreva a tarefa. O agente carrega
                    o seu próprio system prompt, RAG, MCPs e governança — você só dá o briefing.
                </p>
            </header>

            {/* Agent picker */}
            <section className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Agente
                </label>
                {loading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Carregando catálogo…
                    </div>
                ) : error ? (
                    <div className="rounded-md border border-danger-border bg-rose-500/5 px-3 py-2 text-xs text-rose-200">
                        Falha ao carregar agentes: {error.message}
                    </div>
                ) : assistants.length === 0 ? (
                    <div className="rounded-md border border-warning-border bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
                        Nenhum agente publicado. Crie um em <code className="text-[11px] bg-black/30 px-1 rounded">/assistants</code> ou
                        use o <strong>Modo Livre</strong> ao lado.
                    </div>
                ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {assistants.map(a => (
                            <button
                                key={a.id}
                                type="button"
                                onClick={() => setSelectedId(a.id)}
                                className={[
                                    'text-left rounded-md border px-3 py-2.5 transition-colors',
                                    a.id === selectedId
                                        ? 'border-violet-500/60 bg-violet-500/10'
                                        : 'border-border/40 bg-card/30 hover:bg-card/50',
                                ].join(' ')}
                            >
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-1.5 flex-wrap">
                                            <span className="text-sm font-medium text-foreground/95 truncate">
                                                {a.name}
                                            </span>
                                            {a.is_fixture && (
                                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-500/20 text-violet-200">
                                                    <Sparkles className="h-2.5 w-2.5" />
                                                    fixture
                                                </span>
                                            )}
                                            {a.shield_level && a.shield_level >= 2 && (
                                                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-warning-bg text-amber-200">
                                                    <Shield className="h-2.5 w-2.5" />
                                                    nível {a.shield_level}
                                                </span>
                                            )}
                                        </div>
                                        {a.description && (
                                            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                                                {a.description}
                                            </p>
                                        )}
                                        <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground/80">
                                            {a.runtime_profile_slug && (
                                                <span className="font-mono">{a.runtime_profile_slug}</span>
                                            )}
                                            {a.default_mcp_server_ids.length > 0 && (
                                                <span>· {a.default_mcp_server_ids.length} MCP</span>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </button>
                        ))}
                    </div>
                )}
            </section>

            {/* Message */}
            <section className="space-y-2">
                <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Briefing
                </label>
                <textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    placeholder="O que você precisa que o agente faça? Seja específico — o agente já conhece o contexto da tarefa para a qual foi configurado."
                    rows={6}
                    className="w-full rounded-md border border-border/40 bg-card/30 px-3 py-2 text-sm text-foreground/95 placeholder:text-muted-foreground/60 focus:outline-none focus:border-violet-500/60 resize-y min-h-[120px]"
                />
                <div className="text-[11px] text-muted-foreground">
                    {message.length} / 50 000 caracteres
                </div>
            </section>

            {/* Submit */}
            <section className="flex items-center justify-between gap-3 pt-2 border-t border-border/30">
                <div className="text-xs text-muted-foreground">
                    {selected ? (
                        <>
                            Esta execução vai rodar como{' '}
                            <span className="font-medium text-foreground/80">{selected.name}</span>
                            {selected.runtime_profile_slug && (
                                <> em <span className="font-mono">{selected.runtime_profile_slug}</span></>
                            )}.
                        </>
                    ) : (
                        'Selecione um agente para continuar.'
                    )}
                </div>
                <button
                    type="button"
                    onClick={submit}
                    disabled={!selected || !message.trim() || submitting}
                    className="inline-flex items-center gap-1.5 rounded-md bg-violet-500 hover:bg-violet-600 disabled:bg-violet-500/30 disabled:cursor-not-allowed text-white text-sm font-medium px-4 py-2 transition-colors"
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
                <div className="flex items-start gap-2 rounded-md border border-danger-border bg-rose-500/5 px-3 py-2 text-xs text-rose-200">
                    <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                    <span>{submitError}</span>
                </div>
            )}
        </div>
    );
}
