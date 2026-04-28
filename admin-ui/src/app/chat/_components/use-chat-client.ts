'use client';

import { useMemo } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { getAuthToken } from '@/lib/auth-storage';
import { ChatClient } from '@/lib/chat-client';

/**
 * Memoised chat client bound to the current auth context.
 * Mirrors useRuntimeClient in 5b.1 — returns null while we don't have
 * both token and orgId so callers can no-op safely on first render.
 */
export function useChatClient(): ChatClient | null {
    const { orgId } = useAuth();
    const token = typeof window !== 'undefined' ? getAuthToken() : null;
    return useMemo(() => {
        if (!token || !orgId) return null;
        return new ChatClient({ token, orgId });
    }, [token, orgId]);
}
