'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import axios from 'axios';
import { ShieldAlert, Loader2 } from 'lucide-react';

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
            const res = await axios.post('http://localhost:3000/v1/admin/login', { email, password });

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

                    <form onSubmit={handleLogin} className="space-y-5">
                        <div>
                            <label className="text-xs uppercase font-medium text-muted-foreground tracking-wide block mb-2">E-mail Corporativo</label>
                            <input
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder="admin@govai.com"
                                required
                                className="w-full bg-secondary border border-border rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all placeholder:text-muted-foreground/50"
                            />
                        </div>

                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <label className="text-xs uppercase font-medium text-muted-foreground tracking-wide">Senha</label>
                            </div>
                            <input
                                type="password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="••••••••"
                                required
                                className="w-full bg-secondary border border-border rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/50 transition-all placeholder:text-muted-foreground/50"
                            />
                        </div>

                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full bg-white text-black font-semibold text-sm px-4 py-3 rounded-lg hover:bg-neutral-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 mt-4"
                        >
                            {loading ? <Loader2 className="w-4 h-4 text-black animate-spin" /> : null}
                            {loading ? 'Autenticando...' : 'Acessar Painel'}
                        </button>
                    </form>
                </div>

                <p className="text-center text-xs text-muted-foreground mt-8">
                    Demonstração: admin@govai.com / admin
                </p>
            </div>
        </div>
    );
}
