'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { RuntimeAdminClient } from '@/lib/runtime-admin-client';
import type {
    RuntimeWorkItemDetailResponse,
    RuntimeWorkItemEvent,
} from '@/types/runtime-admin';

/**
 * Loads detail for a single work_item AND, when the run is still
 * active, opens an SSE stream to receive subsequent events.
 *
 * The hook merges the initial event list (from GET /work-items/:id)
 * with streamed events (from /events/stream). Duplicate seqs are
 * de-duped on the way in so a quick GET-then-stream race doesn't
 * produce double rows.
 */
export interface UseWorkItemDetailResult {
    detail: RuntimeWorkItemDetailResponse | null;
    events: RuntimeWorkItemEvent[];
    streaming: boolean;
    loading: boolean;
    error: Error | null;
    /** Re-fetch the detail (e.g. after cancel). */
    refresh: () => Promise<void>;
}

const ACTIVE_STATUSES = new Set(['pending', 'in_progress', 'awaiting_approval']);

export function useWorkItemDetail(
    client: RuntimeAdminClient | null,
    id: string | null,
): UseWorkItemDetailResult {
    const [detail, setDetail] = useState<RuntimeWorkItemDetailResponse | null>(null);
    const [events, setEvents] = useState<RuntimeWorkItemEvent[]>([]);
    const [streaming, setStreaming] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);

    const streamCtrlRef = useRef<AbortController | null>(null);

    const refresh = useCallback(async () => {
        if (!client || !id) return;
        try {
            const data = await client.getWorkItem(id);
            setDetail(data);
            setEvents(prev => mergeBySeq(data.events, prev));
            setError(null);
        } catch (e) {
            setError(e as Error);
        } finally {
            setLoading(false);
        }
    }, [client, id]);

    // Initial fetch
    useEffect(() => {
        if (!client || !id) return;
        setLoading(true);
        refresh();
    }, [client, id, refresh]);

    // SSE: only when the work_item is still active
    useEffect(() => {
        if (!client || !id || !detail) return;
        if (!ACTIVE_STATUSES.has(detail.work_item.status)) return;

        const ctrl = new AbortController();
        streamCtrlRef.current?.abort();
        streamCtrlRef.current = ctrl;
        setStreaming(true);

        (async () => {
            try {
                for await (const ev of client.streamEvents(id, ctrl.signal)) {
                    if (ev.event === 'stream_end') {
                        // Re-fetch so terminal status / final tokens are visible
                        await refresh();
                        break;
                    }
                    // Each non-stream_end event is a RuntimeWorkItemEvent
                    const incoming = ev.data as RuntimeWorkItemEvent;
                    if (incoming && typeof incoming === 'object' && 'seq' in incoming) {
                        setEvents(prev => mergeBySeq([incoming], prev));
                    }
                }
            } catch (e) {
                // Aborted = unmount or new id; not an error.
                if ((e as Error).name !== 'AbortError') {
                    setError(e as Error);
                }
            } finally {
                setStreaming(false);
            }
        })();

        return () => {
            ctrl.abort();
            streamCtrlRef.current = null;
        };
        // detail.work_item.status guards entry; we don't need it in deps
        // because every status transition lands via refresh() which
        // updates detail.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [client, id, detail?.work_item.id]);

    return { detail, events, streaming, loading, error, refresh };
}

/** Merge two event arrays by seq, returning sorted ascending. */
function mergeBySeq(
    incoming: RuntimeWorkItemEvent[],
    existing: RuntimeWorkItemEvent[],
): RuntimeWorkItemEvent[] {
    const bySeq = new Map<number, RuntimeWorkItemEvent>();
    for (const e of existing) bySeq.set(e.seq, e);
    for (const e of incoming) bySeq.set(e.seq, e);
    return Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
}
