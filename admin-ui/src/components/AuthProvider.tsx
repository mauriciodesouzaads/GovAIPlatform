'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import axios from 'axios';

interface AuthContextType {
    token: string | null;
    role: string;
    email: string;
    logout: () => void;
    isLoading: boolean;
}

const AuthContext = createContext<AuthContextType>({ token: null, role: 'operator', email: '', logout: () => { }, isLoading: true });

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [token, setToken] = useState<string | null>(null);
    const [role, setRole] = useState<string>('operator');
    const [email, setEmail] = useState<string>('');
    const [isLoading, setIsLoading] = useState(true);
    const router = useRouter();
    const pathname = usePathname();

    useEffect(() => {
        const storedToken = localStorage.getItem('govai_admin_token');

        if (storedToken) {
            try {
                // Decode JWT without verification (trusting the server validation later)
                const base64Url = storedToken.split('.')[1];
                const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
                const jsonPayload = decodeURIComponent(window.atob(base64).split('').map(function (c) {
                    return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
                }).join(''));
                const decoded = JSON.parse(jsonPayload);

                setRole(decoded.role || 'operator');
                setEmail(decoded.email || 'user@govai.com');
            } catch (e) {
                console.error("Invalid token payload", e);
            }

            setToken(storedToken);
            // Setup global axios defaults — JWT carries orgId, no need for manual header
            axios.defaults.headers.common['Authorization'] = `Bearer ${storedToken}`;
        } else if (pathname !== '/login') {
            router.push('/login');
        }

        setIsLoading(false);
    }, [pathname, router]);

    const logout = () => {
        localStorage.removeItem('govai_admin_token');
        setToken(null);
        setRole('operator');
        setEmail('');
        delete axios.defaults.headers.common['Authorization'];
        router.push('/login');
    };

    // If loading, show nothing or a spinner to prevent flashing unauthorized content
    if (isLoading) return <div className="min-h-screen bg-black" />;

    return (
        <AuthContext.Provider value={{ token, role, email, logout, isLoading }}>
            {children}
        </AuthContext.Provider>
    );
}
