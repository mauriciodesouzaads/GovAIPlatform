'use client';

import { createContext, useContext, useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import axios from 'axios';

interface AuthContextType {
    token: string | null;
    logout: () => void;
    isLoading: boolean;
}

const AuthContext = createContext<AuthContextType>({ token: null, logout: () => { }, isLoading: true });

export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: React.ReactNode }) {
    const [token, setToken] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const router = useRouter();
    const pathname = usePathname();

    useEffect(() => {
        const storedToken = localStorage.getItem('govai_admin_token');

        if (storedToken) {
            setToken(storedToken);
            // Setup global axios defaults
            axios.defaults.headers.common['Authorization'] = `Bearer ${storedToken}`;
            // Fallback x-org-id for smooth transition (until we remove it fully from backend)
            axios.defaults.headers.common['x-org-id'] = '00000000-0000-0000-0000-000000000001';
        } else if (pathname !== '/login') {
            router.push('/login');
        }

        setIsLoading(false);
    }, [pathname, router]);

    const logout = () => {
        localStorage.removeItem('govai_admin_token');
        setToken(null);
        delete axios.defaults.headers.common['Authorization'];
        router.push('/login');
    };

    // If loading, show nothing or a spinner to prevent flashing unauthorized content
    if (isLoading) return <div className="min-h-screen bg-black" />;

    return (
        <AuthContext.Provider value={{ token, logout, isLoading }}>
            {children}
        </AuthContext.Provider>
    );
}
