'use client';

import { useMemo } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { getAuthToken } from '@/lib/auth-storage';
import { RuntimeAdminClient } from '@/lib/runtime-admin-client';

/**
 * Returns a runtime-admin client bound to the current auth context.
 *
 * The client is memoised on token+orgId so React effect deps that
 * depend on it stay stable across renders.
 */
export function useRuntimeClient(): RuntimeAdminClient | null {
    const { orgId } = useAuth();
    // getAuthToken reads localStorage on every call — cheap, but we
    // capture once on render so the memoised client doesn't read
    // mid-stream.
    const token = typeof window !== 'undefined' ? getAuthToken() : null;

    return useMemo(() => {
        if (!token || !orgId) return null;
        return new RuntimeAdminClient({ token, orgId });
    }, [token, orgId]);
}
