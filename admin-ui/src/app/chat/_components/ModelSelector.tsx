'use client';

import { useEffect, useMemo, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, Lock } from 'lucide-react';
import type { LlmProvider } from '@/lib/chat-client';
import { useChatClient } from './use-chat-client';

const PROVIDER_LABELS: Record<string, string> = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    google: 'Google',
};

/**
 * Dropdown que mostra modelos disponíveis agrupados por provider.
 * Capabilities aparecem como mini-pills informativos (não interativos)
 * — ver migration 097 para a justificativa do "informativo, não toggle".
 *
 * 6c.B.1 — quando mode='code', filtra para apenas Anthropic. Modo Code
 * é arquiteturalmente Claude Code SDK, então só faz sentido oferecer
 * Sonnet/Haiku/Opus. Outros providers ficam disponíveis em mode='chat'
 * (LiteLLM passthrough cobre OpenAI, Google, Cerebras, etc).
 */
export function ModelSelector({
    value,
    onChange,
    compact = false,
    mode = 'chat',
}: {
    value: string;
    onChange: (modelId: string) => void;
    compact?: boolean;
    mode?: 'chat' | 'code';
}) {
    const client = useChatClient();
    const [providers, setProviders] = useState<LlmProvider[]>([]);

    useEffect(() => {
        if (!client) return;
        let cancelled = false;
        client
            .listProviders()
            .then(list => { if (!cancelled) setProviders(list); })
            .catch(err => console.error('[chat] listProviders', err));
        return () => { cancelled = true; };
    }, [client]);

    // 6c.B.1: filtragem por mode + auto-correção quando o modelo
    // selecionado não é compatível (ex: usuário no chat com gpt-4o
    // alterna para Code → trocamos para sonnet-4-6 e disparamos onChange).
    const filtered = useMemo(() => (
        mode === 'code'
            ? providers.filter(p => p.provider === 'anthropic')
            : providers
    ), [providers, mode]);

    useEffect(() => {
        if (mode !== 'code' || providers.length === 0) return;
        const isAnthropic = providers.some(
            p => p.model_id === value && p.provider === 'anthropic',
        );
        if (!isAnthropic) {
            const fallback = providers.find(p => p.model_id === 'claude-sonnet-4-6')
                ?? providers.find(p => p.provider === 'anthropic' && p.is_default)
                ?? providers.find(p => p.provider === 'anthropic');
            if (fallback) onChange(fallback.model_id);
        }
        // onChange é estável o suficiente; intencionalmente fora do deps
        // para evitar loop quando o pai re-cria a função a cada render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, providers, value]);

    const current = filtered.find(p => p.model_id === value)
        ?? providers.find(p => p.model_id === value);
    const grouped = groupByProvider(filtered);

    return (
        <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
                <button
                    className={[
                        'inline-flex items-center gap-1.5 rounded-md transition-colors',
                        compact
                            ? 'px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200 hover:bg-white/5'
                            : 'px-3 py-1.5 text-sm text-zinc-200 bg-white/5 hover:bg-white/10 border border-white/10',
                    ].join(' ')}
                    title={`Modelo atual: ${current?.display_name ?? value}`}
                >
                    {current?.icon_emoji && <span>{current.icon_emoji}</span>}
                    <span className="font-medium">{current?.display_name ?? value}</span>
                    <ChevronDown className="w-3 h-3 opacity-60" />
                </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
                <DropdownMenu.Content
                    align="start"
                    sideOffset={4}
                    className="w-80 rounded-lg border border-white/10 bg-[#141820] shadow-2xl py-1 z-50"
                >
                    {/* 6c.B.1: explica restrição p/ usuários que tentam mudar modelo em Modo Code */}
                    {mode === 'code' && (
                        <div className="px-3 py-2 mx-1 mb-1 rounded bg-amber-500/10 border border-amber-500/20 text-[11px] text-amber-200/90 flex items-start gap-2">
                            <Lock className="w-3 h-3 mt-0.5 flex-shrink-0 text-amber-300" />
                            <span>
                                Modo Code roda exclusivamente com Claude Code SDK + modelos Anthropic.
                                Para usar GPT-4, Gemini, etc., alterne para Modo Chat.
                            </span>
                        </div>
                    )}
                    {Object.entries(grouped).map(([provider, models]) => (
                        <div key={provider} className="py-1">
                            <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-zinc-500 font-medium">
                                {PROVIDER_LABELS[provider] ?? provider}
                            </div>
                            {models.map(m => (
                                <DropdownMenu.Item
                                    key={m.model_id}
                                    onSelect={() => onChange(m.model_id)}
                                    className={[
                                        'px-3 py-2 cursor-pointer text-sm outline-none rounded-md mx-1',
                                        m.model_id === value
                                            ? 'bg-emerald-500/10 text-emerald-100'
                                            : 'text-zinc-200 data-[highlighted]:bg-white/5',
                                    ].join(' ')}
                                >
                                    <div className="flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-2 min-w-0">
                                            {m.icon_emoji && <span>{m.icon_emoji}</span>}
                                            <span className="font-medium truncate">{m.display_name}</span>
                                        </div>
                                        {m.is_default && (
                                            <span className="text-[10px] text-emerald-400/80 flex-shrink-0">
                                                recomendado
                                            </span>
                                        )}
                                    </div>
                                    {m.description && (
                                        <p className="text-[11px] text-zinc-500 mt-0.5 truncate">
                                            {m.description}
                                        </p>
                                    )}
                                    {m.capabilities.length > 0 && (
                                        <div className="flex flex-wrap gap-1 mt-1.5">
                                            {m.capabilities.slice(0, 4).map(cap => (
                                                <span
                                                    key={cap}
                                                    className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-zinc-400"
                                                >
                                                    {cap.replace(/_/g, ' ')}
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                </DropdownMenu.Item>
                            ))}
                        </div>
                    ))}
                </DropdownMenu.Content>
            </DropdownMenu.Portal>
        </DropdownMenu.Root>
    );
}

function groupByProvider(items: LlmProvider[]): Record<string, LlmProvider[]> {
    const out: Record<string, LlmProvider[]> = {};
    for (const m of items) {
        out[m.provider] ??= [];
        out[m.provider].push(m);
    }
    return out;
}
