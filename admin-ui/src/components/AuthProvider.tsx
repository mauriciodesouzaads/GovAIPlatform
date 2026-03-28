'use client';

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import api, { ENDPOINTS } from '@/lib/api';
import { getAuthToken, clearAuthToken } from '@/lib/auth-storage';

interface AuthContextType {
    token: string | null;
    role: string;
    email: string;
    orgId: string;
    isLoading: boolean;
    logout: () => Promise<void>;
    refreshFromServer: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType>({
    token: null,
    role: 'operator',
    email: '',
    orgId: '',
    isLoading: true,
    logout: async () => {},
    refreshFromServer: async () => false,
});

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [token, setToken] = useState<string | null>(null);
    const [role, setRole] = useState<string>('operator');
    const [email, setEmail] = useState<string>('');
    const [orgId, setOrgId] = useState<string>('');
    const [isLoading, setIsLoading] = useState(true);
    const router = useRouter();
    const pathname = usePathname();

    // refreshFromServer: syncs role/email/orgId from server into context.
    // Called after login to populate context without re-running initAuth.
    // Does NOT clear the token on failure — caller decides.
    const refreshFromServer = useCallback(async (): Promise<boolean> => {
        try {
            const res = await api.get(ENDPOINTS.ME);
            const { email: serverEmail, role: serverRole, orgId: serverOrgId } = res.data;
            setRole(serverRole || 'operator');
            setEmail(serverEmail || '');
            setOrgId(serverOrgId || '');
            setToken(getAuthToken());
            return true;
        } catch {
            return false;
        }
    }, []);

    // Effect #1 — runs ONCE on mount to initialise auth state.
    // Must NOT have pathname in its dependency array to avoid re-running
    // on every client-side navigation (the root cause of the redirect loop).
    useEffect(() => {
        const initAuth = async () => {
            const storedToken = getAuthToken();

            if (!storedToken) {
                setIsLoading(false);
                return; // redirect to /login handled by effect #2
            }

            // Set the Authorization header immediately — before the async
            // /me call — so any concurrent request also carries the token.
            api.defaults.headers.common['Authorization'] = `Bearer ${storedToken}`;
            setToken(storedToken);

            try {
                const res = await api.get(ENDPOINTS.ME);
                const { email: serverEmail, role: serverRole, orgId: serverOrgId } = res.data;
                setRole(serverRole || 'operator');
                setEmail(serverEmail || '');
                setOrgId(serverOrgId || '');
            } catch (err: any) {
                // Invalidate session only on explicit 401/403 (bad/expired token).
                // Network errors (err.response undefined) are transient — keep the
                // session alive so a temporary backend outage does not log the user out.
                if (err.response?.status === 401 || err.response?.status === 403) {
                    clearAuthToken();
                    delete api.defaults.headers.common['Authorization'];
                    setToken(null);
                }
            } finally {
                setIsLoading(false);
            }
        };

        initAuth();
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Effect #2 — redirect guard.
    // Fires when loading completes or token/pathname changes.
    // This is the ONLY place that redirects to /login.
    useEffect(() => {
        if (!isLoading && !token && pathname !== '/login') {
            router.push('/login');
        }
    }, [isLoading, token, pathname, router]);

    const logout = useCallback(async () => {
        clearAuthToken();
        delete api.defaults.headers.common['Authorization'];
        setToken(null);
        setRole('operator');
        setEmail('');
        setOrgId('');

        try {
            await api.post(ENDPOINTS.LOGOUT);
        } catch {
            // noop — sessão bearer-only já foi invalidada no cliente
        }

        router.push('/login');
    }, [router]);

    if (isLoading) return <div className="min-h-screen bg-black" />;

    return (
        <AuthContext.Provider value={{ token, role, email, orgId, isLoading, logout, refreshFromServer }}>
            {children}
        </AuthContext.Provider>
    );
}
