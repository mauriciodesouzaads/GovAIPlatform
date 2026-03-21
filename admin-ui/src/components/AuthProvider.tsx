'use client';

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import api, { ENDPOINTS } from '@/lib/api';
import { getAuthToken, clearAuthToken } from '@/lib/auth-storage';

interface AuthContextType {
    token: string | null;
    role: string;
    email: string;
    isLoading: boolean;
    logout: () => Promise<void>;
    refreshFromServer: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType>({
    token: null,
    role: 'operator',
    email: '',
    isLoading: true,
    logout: async () => {},
    refreshFromServer: async () => false,
});

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [token, setToken] = useState<string | null>(null);
    const [role, setRole] = useState<string>('operator');
    const [email, setEmail] = useState<string>('');
    const [isLoading, setIsLoading] = useState(true);
    const router = useRouter();
    const pathname = usePathname();

    const refreshFromServer = useCallback(async (): Promise<boolean> => {
        try {
            const res = await api.get(ENDPOINTS.ME);
            const { email: serverEmail, role: serverRole } = res.data;
            setRole(serverRole || 'operator');
            setEmail(serverEmail || '');
            const storedToken = getAuthToken();
            setToken(storedToken);
            return true;
        } catch {
            return false;
        }
    }, []);

    useEffect(() => {
        const initAuth = async () => {
            const storedToken = getAuthToken();

            if (!storedToken) {
                setToken(null);
                setRole('operator');
                setEmail('');
                setIsLoading(false);
                if (pathname !== '/login') router.push('/login');
                return;
            }

            api.defaults.headers.common['Authorization'] = `Bearer ${storedToken}`;
            const ok = await refreshFromServer();
            if (!ok) {
                clearAuthToken();
                delete api.defaults.headers.common['Authorization'];
                setToken(null);
                setRole('operator');
                setEmail('');
                if (pathname !== '/login') router.push('/login');
            }
            setIsLoading(false);
        };

        initAuth();
    }, [pathname, refreshFromServer, router]);

    const logout = useCallback(async () => {
        clearAuthToken();
        delete api.defaults.headers.common['Authorization'];
        setToken(null);
        setRole('operator');
        setEmail('');

        try {
            await api.post(ENDPOINTS.LOGOUT);
        } catch {
            // noop — sessão bearer-only já foi invalidada no cliente
        }

        router.push('/login');
    }, [router]);

    if (isLoading) return <div className="min-h-screen bg-black" />;

    return (
        <AuthContext.Provider value={{ token, role, email, isLoading, logout, refreshFromServer }}>
            {children}
        </AuthContext.Provider>
    );
}
