'use client';

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import api, { ENDPOINTS } from '@/lib/api';

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

    // Tenta obter claims do servidor via /v1/admin/me.
    // Usado no fluxo SSO: o httpOnly cookie é enviado automaticamente (withCredentials: true),
    // o servidor extrai o JWT do cookie e retorna os claims.
    const refreshFromServer = useCallback(async (): Promise<boolean> => {
        try {
            const res = await api.get(ENDPOINTS.ME);
            const { email: serverEmail, role: serverRole } = res.data;
            setRole(serverRole || 'operator');
            setEmail(serverEmail || '');
            // Sentinel: indica sessão ativa por httpOnly cookie (sem token JS-acessível)
            setToken('__server_session__');
            api.defaults.headers.common['Authorization'] = undefined;
            return true;
        } catch {
            return false;
        }
    }, []);

    useEffect(() => {
        const initAuth = async () => {
            const storedToken = localStorage.getItem('govai_admin_token');

            if (storedToken) {
                // Fluxo de login local: token no localStorage.
                // Decodifica o payload (verificação real ocorre no servidor a cada request).
                try {
                    const base64Url = storedToken.split('.')[1];
                    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
                    const jsonPayload = decodeURIComponent(
                        window.atob(base64).split('').map(c =>
                            '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
                        ).join('')
                    );
                    const decoded = JSON.parse(jsonPayload);
                    setRole(decoded.role || 'operator');
                    setEmail(decoded.email || '');
                } catch {
                    // Token malformado — limpa e força re-auth
                    localStorage.removeItem('govai_admin_token');
                    router.push('/login');
                    setIsLoading(false);
                    return;
                }
                setToken(storedToken);
                api.defaults.headers.common['Authorization'] = `Bearer ${storedToken}`;
            } else if (pathname !== '/login') {
                // Sem localStorage token — tenta sessão SSO via httpOnly cookie.
                const hasServerSession = await refreshFromServer();
                if (!hasServerSession) {
                    router.push('/login');
                }
            }

            setIsLoading(false);
        };

        initAuth();
    // Apenas na montagem; pathname é deliberadamente excluído das deps
    // para evitar re-runs em navegação (o estado de auth não muda entre páginas).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const logout = useCallback(async () => {
        // Limpa localStorage
        localStorage.removeItem('govai_admin_token');
        delete api.defaults.headers.common['Authorization'];
        setToken(null);
        setRole('operator');
        setEmail('');

        // Limpa httpOnly cookie server-side (cobre sessões SSO)
        try {
            await api.post(ENDPOINTS.LOGOUT);
        } catch {
            // Falha silenciosa — o cookie vai expirar naturalmente
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
