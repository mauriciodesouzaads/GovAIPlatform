'use client';

import { useEffect, useState } from 'react';
import type { McpServerSummary, RuntimeAdminClient } from '@/lib/runtime-admin-client';

/**
 * MCP server registry list, used by Modo Livre to render the
 * "MCPs to mount" toggle group. Disabled servers are filtered out
 * so the user can't accidentally pick a broken integration.
 */
export function useMcpServers(client: RuntimeAdminClient | null): {
    servers: McpServerSummary[];
    loading: boolean;
    error: Error | null;
} {
    const [servers, setServers] = useState<McpServerSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<Error | null>(null);

    useEffect(() => {
        if (!client) return;
        let cancelled = false;
        (async () => {
            try {
                const data = await client.listMcpServers();
                if (cancelled) return;
                setServers(data.servers.filter(s => s.enabled));
                setError(null);
            } catch (e) {
                if (!cancelled) setError(e as Error);
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [client]);

    return { servers, loading, error };
}
