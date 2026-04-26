'use client';

import { useEffect, useState } from 'react';
import type { AssistantSummary, RuntimeAdminClient } from '@/lib/runtime-admin-client';

/**
 * One-shot fetch of the assistants catalog. The list is small and
 * doesn't change during a Modo Agente form session, so no polling.
 *
 * Filters down to status='published' (only published assistants are
 * runnable) and orders fixtures first so the demo agents are easy to
 * find on a fresh tenant.
 */
export function useAssistants(client: RuntimeAdminClient | null): {
    assistants: AssistantSummary[];
    loading: boolean;
    error: Error | null;
    reload: () => Promise<void>;
} {
    const [assistants, setAssistants] = useState<AssistantSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);

    const tick = async () => {
        if (!client) return;
        try {
            const data = await client.listAssistants();
            const runnable = data.assistants.filter(a => a.status === 'published');
            runnable.sort((a, b) => {
                if (a.is_fixture !== b.is_fixture) return a.is_fixture ? -1 : 1;
                return a.name.localeCompare(b.name);
            });
            setAssistants(runnable);
            setError(null);
        } catch (e) {
            setError(e as Error);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        if (!client) return;
        setLoading(true);
        tick();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [client]);

    return { assistants, loading, error, reload: tick };
}
