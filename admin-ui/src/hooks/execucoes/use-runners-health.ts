'use client';

import { useEffect, useState } from 'react';
import type { RuntimeAdminClient } from '@/lib/runtime-admin-client';
import type { RuntimeRunnerHealth } from '@/types/runtime-admin';

/**
 * Polls /runners/health every `pollMs` (default 15s — runners don't
 * change state often, and the backend already has a 30s Redis cache
 * on the underlying probe).
 */
export function useRunnersHealth(
    client: RuntimeAdminClient | null,
    pollMs = 15_000,
): {
    runners: RuntimeRunnerHealth[];
    loading: boolean;
    error: Error | null;
} {
    const [runners, setRunners] = useState<RuntimeRunnerHealth[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);

    useEffect(() => {
        if (!client) return;
        let cancelled = false;
        const ctrl = new AbortController();

        const tick = async () => {
            try {
                const data = await client.runnersHealth(ctrl.signal);
                if (cancelled) return;
                setRunners(data.runners);
                setError(null);
            } catch (e) {
                if ((e as Error).name === 'AbortError') return;
                if (!cancelled) setError(e as Error);
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        tick();

        let intervalId: ReturnType<typeof setInterval> | null = null;
        const startPolling = () => {
            if (intervalId) return;
            intervalId = setInterval(tick, pollMs);
        };
        const stopPolling = () => {
            if (intervalId) { clearInterval(intervalId); intervalId = null; }
        };
        const onVisibility = () => {
            if (document.hidden) stopPolling();
            else { tick(); startPolling(); }
        };

        document.addEventListener('visibilitychange', onVisibility);
        if (!document.hidden) startPolling();

        return () => {
            cancelled = true;
            ctrl.abort();
            document.removeEventListener('visibilitychange', onVisibility);
            stopPolling();
        };
    }, [client, pollMs]);

    return { runners, loading, error };
}
