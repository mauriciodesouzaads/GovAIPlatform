'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import axios from 'axios';
import { ShieldAlert, Loader2 } from 'lucide-react';

import { API_BASE } from '@/lib/api';

export default function LoginPage() {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const router = useRouter();

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            const res = await axios.post(`${API_BASE}/v1/admin/login`, { email, password });

            // Store token
            localStorage.setItem('govai_admin_token', res.data.token);

            // Redirect to dashboard
            router.push('/');
        } catch (err: any) {
            setError(err.response?.data?.error || 'Erro ao realizar login');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen flex items-center justify-center bg-black/95 text-foreground relative overflow-hidden">
            {/* Decorative background effects */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-blue-500/10 rounded-full blur-[120px] pointer-events-none" />

            <div className="w-full max-w-md p-8 relative z-10">
                <div className="text-center mb-10">
                    <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-white text-black font-black text-2xl mb-6 shadow-xl shadow-white/5 border border-white/10">
                        G
                    </div>
                    <h1 className="text-3xl font-bold tracking-tight">GovAI <span className="text-muted-foreground font-medium">Platform</span></h1>
                    <p className="text-muted-foreground mt-3 text-sm">Acesso Restrito · Portal Administrativo</p>
                </div>

                <div className="bg-card border border-border/80 rounded-2xl p-8 shadow-2xl backdrop-blur-sm">
                    {error && (
                        <div className="mb-6 p-4 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm flex items-start gap-3">
                            <ShieldAlert className="w-5 h-5 shrink-0" />
                            <p>{error}</p>
                        </div>
                    )}

                    <form onSubmit={handleLogin} className="space-y-4 mb-8">
                        <div>
                            <label className="block text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">E-mail Corporativo</label>
                            <input
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                className="w-full bg-black/50 border border-border/80 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/50 transition-all"
                                placeholder="E-mail admin@govai.com"
                                required
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">Senha</label>
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="w-full bg-black/50 border border-border/80 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/50 transition-all"
                                placeholder="••••••••"
                                required
                            />
                        </div>
                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full bg-amber-500 hover:bg-amber-400 text-black font-bold py-3.5 px-4 rounded-xl transition-all disabled:opacity-50 flex items-center justify-center gap-2 mt-4 shadow-lg shadow-amber-500/20"
                        >
                            {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Entrar (Demo Local)'}
                        </button>
                    </form>

                    <div className="relative mb-8">
                        <div className="absolute inset-0 flex items-center">
                            <div className="w-full border-t border-border/80"></div>
                        </div>
                        <div className="relative flex justify-center text-xs uppercase">
                            <span className="bg-card px-2 text-muted-foreground font-semibold">Login Enterprise Integrado</span>
                        </div>
                    </div>

                    <div className="space-y-4">
                        <button
                            onClick={() => window.location.href = `${API_BASE}/v1/auth/sso/login?provider=entra_id`}
                            type="button"
                            className="w-full bg-[#2F2F2F] border border-border/80 text-white font-medium text-sm px-4 py-3.5 rounded-xl hover:bg-[#3f3f3f] hover:border-border transition-all flex items-center justify-center gap-3 group"
                        >
                            <svg className="w-5 h-5 group-hover:scale-110 transition-transform" viewBox="0 0 21 21"><path fill="#f25022" d="M1 1h9v9H1z" /><path fill="#7fba00" d="M11 1h9v9h-9z" /><path fill="#00a4ef" d="M1 11h9v9H1z" /><path fill="#ffb900" d="M11 11h9v9h-9z" /></svg>
                            Entrar com Microsoft Entra
                        </button>

                        <button
                            onClick={() => window.location.href = `${API_BASE}/v1/auth/sso/login?provider=okta`}
                            type="button"
                            className="w-full bg-[#2F2F2F] border border-border/80 text-white font-medium text-sm px-4 py-3.5 rounded-xl hover:bg-[#3f3f3f] hover:border-border transition-all flex items-center justify-center gap-3 group"
                        >
                            <svg className="w-5 h-5 group-hover:scale-110 transition-transform" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z" /></svg>
                            Entrar com Okta
                        </button>
                    </div>
                </div>

                <p className="text-center text-xs text-muted-foreground mt-8">
                    Demonstração: admin@govai.com / admin
                </p>
            </div>
        </div>
    );
}
