'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import type { RuntimeAdminClient, ListWorkItemsFilters } from '@/lib/runtime-admin-client';
import type { RuntimeWorkItemSummary } from '@/types/runtime-admin';

/**
 * Polled list of runtime work items.
 *
 * Behavior
 *   - Fires once on mount + whenever filters change (deep-compared
 *     via JSON.stringify since filter objects are recreated each
 *     render).
 *   - Polls every `pollMs` (default 5000) while the document is
 *     visible. Pauses immediately on `visibilitychange` to "hidden"
 *     and resumes on "visible" with one extra fetch so the user
 *     sees fresh state when they tab back.
 *   - Aborts in-flight requests on unmount + when filters change so
 *     the latest reply always wins.
 */
export interface UseWorkItemsResult {
    items: RuntimeWorkItemSummary[];
    loading: boolean;
    error: Error | null;
    total: number | null;
    /** 6c.B.2 — counts por source p/ as 3 sub-abas em /evidencias.
     * Vem agregado pelo backend numa query única (sem filtro corrente). */
    countsBySource: Record<'chat'|'admin'|'api'|'test', number>;
    /** Manual re-fetch — bypasses the visibility gate. */
    refresh: () => Promise<void>;
}

export function useWorkItems(
    client: RuntimeAdminClient | null,
    filters: ListWorkItemsFilters,
    pollMs = 5000,
): UseWorkItemsResult {
    const [items, setItems] = useState<RuntimeWorkItemSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);
    const [total, setTotal] = useState<number | null>(null);
    const [countsBySource, setCountsBySource] = useState<Record<'chat'|'admin'|'api'|'test', number>>({
        chat: 0, admin: 0, api: 0, test: 0,
    });

    // JSON-stringify the filters into a stable dep — the user passes
    // a new object each render in practice, and we only care about
    // value equality.
    const filtersKey = JSON.stringify(filters);

    const abortRef = useRef<AbortController | null>(null);

    const fetchOnce = useCallback(async () => {
        if (!client) return;
        abortRef.current?.abort();
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        try {
            const data = await client.listWorkItems(filters, ctrl.signal);
            if (ctrl.signal.aborted) return;
            setItems(data.items);
            setTotal(data.total_estimate);
            if (data.counts_by_source) {
                setCountsBySource(data.counts_by_source);
            }
            setError(null);
        } catch (e) {
            if ((e as Error).name === 'AbortError') return;
            setError(e as Error);
        } finally {
            if (!ctrl.signal.aborted) setLoading(false);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [client, filtersKey]);

    useEffect(() => {
        setLoading(true);
        fetchOnce();
        let intervalId: ReturnType<typeof setInterval> | null = null;

        const startPolling = () => {
            if (intervalId) return;
            intervalId = setInterval(fetchOnce, pollMs);
        };
        const stopPolling = () => {
            if (intervalId) { clearInterval(intervalId); intervalId = null; }
        };
        const onVisibility = () => {
            if (document.hidden) {
                stopPolling();
            } else {
                fetchOnce();
                startPolling();
            }
        };

        document.addEventListener('visibilitychange', onVisibility);
        if (!document.hidden) startPolling();

        return () => {
            document.removeEventListener('visibilitychange', onVisibility);
            stopPolling();
            abortRef.current?.abort();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fetchOnce, pollMs]);

    return { items, loading, error, total, countsBySource, refresh: fetchOnce };
}
