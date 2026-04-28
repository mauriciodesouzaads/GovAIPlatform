'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, MessageSquare } from 'lucide-react';
import { useChatClient } from './_components/use-chat-client';

/**
 * /chat — entry point. If the user already has conversations, redirect
 * to the most recent. If empty, show a clean welcome with a "Iniciar"
 * CTA that creates a new conversation. Avoids landing the user on a
 * blank page or auto-creating a throwaway conv on every visit.
 */
export default function ChatEntryPage() {
    const client = useChatClient();
    const router = useRouter();
    const [phase, setPhase] = useState<'loading' | 'empty' | 'creating'>('loading');

    useEffect(() => {
        if (!client) return;
        let cancelled = false;
        (async () => {
            try {
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
    }, [client]);

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
        <div className="flex-1 flex items-center justify-center text-zinc-300">
            {phase === 'loading' || phase === 'creating' ? (
                <Loader2 className="w-5 h-5 animate-spin text-zinc-500" />
            ) : (
                <div className="max-w-md text-center space-y-4">
                    <div className="mx-auto w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center">
                        <MessageSquare className="w-6 h-6 text-emerald-400" />
                    </div>
                    <div>
                        <h1 className="text-lg font-semibold text-zinc-100">Bem-vindo ao Chat GovAI</h1>
                        <p className="text-sm text-zinc-500 mt-1">
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
