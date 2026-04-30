'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, MessageSquare } from 'lucide-react';
import { useChatClient } from './_components/use-chat-client';

/**
 * /chat — entry point.
 *
 * Three behaviors:
 *   1. ?assistant_id=<uuid> in querystring (deep-link from /catalog
 *      "Usar" or external share): create new conversation linked to
 *      the agent + redirect. This is the canonical entry for users
 *      who clicked an agent card.
 *   2. No querystring + has existing conversations: redirect to the
 *      most recent.
 *   3. No querystring + no conversations: welcome with "Iniciar" CTA
 *      that creates a free (unlinked) conversation.
 *
 * Avoids landing the user on a blank page or auto-creating a throwaway
 * conv on every visit.
 */
export default function ChatEntryPage() {
    const client = useChatClient();
    const router = useRouter();
    const searchParams = useSearchParams();
    const assistantIdParam = searchParams?.get('assistant_id') ?? null;
    const [phase, setPhase] = useState<'loading' | 'empty' | 'creating'>('loading');

    useEffect(() => {
        if (!client) return;
        let cancelled = false;
        (async () => {
            try {
                // 1. Deep-link with assistant_id — always create a fresh
                // conversation pinned to the agent and redirect. No
                // attempt to "find existing conversation with same agent"
                // because each click on "Usar" should start a clean
                // session, not resume a stale one.
                if (assistantIdParam) {
                    const conv = await client.createConversation({
                        assistant_id: assistantIdParam,
                    });
                    if (!cancelled) router.replace(`/chat/${conv.id}`);
                    return;
                }

                // 2. No deep-link — fall back to most recent conv or empty.
                const list = await client.listConversations({ archived: false, limit: 1 });
                if (cancelled) return;
                if (list.length > 0) {
                    router.replace(`/chat/${list[0].id}`);
                } else {
                    setPhase('empty');
                }
            } catch (err) {
                if (!cancelled) {
                    console.error('[chat entry]', err);
                    setPhase('empty');
                }
            }
        })();
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [client, assistantIdParam]);

    async function startConversation() {
        if (!client) return;
        setPhase('creating');
        try {
            const conv = await client.createConversation();
            router.replace(`/chat/${conv.id}`);
        } catch (err) {
            console.error('[chat entry] create failed', err);
            setPhase('empty');
        }
    }

    return (
        <div className="flex-1 flex items-center justify-center text-text-100">
            {phase === 'loading' || phase === 'creating' ? (
                <Loader2 className="w-5 h-5 animate-spin text-text-500" />
            ) : (
                <div className="max-w-md text-center space-y-4">
                    <div className="mx-auto w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
                        <MessageSquare className="w-6 h-6 text-emerald-400" />
                    </div>
                    <div>
                        <h1 className="text-lg font-semibold text-text-100">Bem-vindo ao Chat GovAI</h1>
                        <p className="text-sm text-text-500 mt-1">
                            Conversa governada com Claude, GPT e Gemini. Auditada,
                            com DLP e RAG, sob seu controle.
                        </p>
                    </div>
                    <button
                        onClick={startConversation}
                        className="px-4 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white text-sm font-medium transition-colors"
                    >
                        Iniciar conversa
                    </button>
                </div>
            )}
        </div>
    );
}
