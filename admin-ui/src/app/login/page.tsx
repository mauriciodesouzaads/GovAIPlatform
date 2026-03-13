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
    const [successMsg, setSuccessMsg] = useState('');
    const [loading, setLoading] = useState(false);

    // Reset Flow State
    const [isResetting, setIsResetting] = useState(false);
    const [resetToken, setResetToken] = useState('');
    const [newPassword, setNewPassword] = useState('');

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
        } catch (err: unknown) {
            const axiosError = err as { response?: { status: number; data?: { requires_password_change?: boolean; resetToken?: string; error?: string } } };
            if (axiosError.response?.status === 403 && axiosError.response?.data?.requires_password_change) {
                // Force Password Reset Flow
                setIsResetting(true);
                setResetToken(axiosError.response.data.resetToken || '');
                setError('Troca de senha inicial obrigatória por conformidade de segurança.');
            } else {
                setError(axiosError.response?.data?.error || 'Erro ao realizar login');
            }
        } finally {
            setLoading(false);
        }
    };

    const handleResetPassword = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            // Placeholder for actual API call. Assuming 'api' and 'ENDPOINTS' are defined.
            // If not, this line will cause an error.
            // For the original logic, it would be:
            // const res = await axios.post(
            //     `${API_BASE}/v1/admin/change-password`,
            //     { newPassword },
            //     { headers: { Authorization: `Bearer ${resetToken}` } }
            // );
            // setSuccessMsg(res.data.message || 'Senha atualizada com sucesso!');
            // For the provided snippet, we'll use the placeholder:
            await axios.post(`${API_BASE}/v1/admin/change-password`, { resetToken, newPassword }, { headers: { Authorization: `Bearer ${resetToken}` } }); // Using original endpoint for consistency
            setSuccessMsg('Senha atualizada com sucesso!'); // Assuming success message from original logic
            setIsResetting(false);
            setResetToken('');
            setNewPassword('');
            setPassword(''); // Clear old password
        } catch (err: unknown) {
            const axiosError = err as { response?: { data?: { error?: string } } };
            setError(axiosError.response?.data?.error || 'Erro ao redefinir a senha.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-[#050505] text-foreground flex items-center justify-center p-4 selection:bg-emerald-500/30">
            {/* Background Effects */}
            <div className="fixed inset-0 overflow-hidden pointer-events-none">
                <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-emerald-500/10 blur-[120px] rounded-full" />
                <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-emerald-500/5 blur-[120px] rounded-full" />
            </div>

            <div className="w-full max-w-md relative">
                <div className="bg-zinc-900/50 backdrop-blur-2xl border border-zinc-800 rounded-3xl p-8 shadow-2xl overflow-hidden">
                    {/* Header */}
                    <div className="mb-8 text-center">
                        <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500/20 to-emerald-600/10 border border-emerald-500/20 mb-6 shadow-inner">
                            <ShieldAlert className="w-8 h-8 text-emerald-500" /> {/* Changed to ShieldAlert for consistency with original imports */}
                        </div>
                        <h1 className="text-3xl font-bold tracking-tight text-white mb-2">GovAI Platform</h1>
                        <p className="text-zinc-400 text-sm">Controle e Governança para IA Enterprise</p>
                    </div>

                    {successMsg && (
                        <div className="mb-6 p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm flex items-start gap-3">
                            <ShieldAlert className="w-5 h-5 shrink-0" />
                            <p>{successMsg}</p>
                        </div>
                    )}
                    {error && (
                        <div className="mb-6 p-4 bg-rose-500/10 border border-rose-500/20 rounded-2xl flex items-center gap-3 animate-in fade-in slide-in-from-top-2 duration-300">
                            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-rose-500/20 flex items-center justify-center">
                                <ShieldAlert className="w-4 h-4 text-rose-500" /> {/* Changed to ShieldAlert for consistency with original imports */}
                            </div>
                            <p className="text-sm font-medium text-rose-200">{error}</p>
                        </div>
                    )}

                    {!isResetting ? (
                        <>
                            <form onSubmit={handleLogin} className="space-y-6">
                                <div className="space-y-5">
                                    <div>
                                        <label className="block text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">E-mail Corporativo</label>
                                        <input
                                            type="email"
                                            value={email}
                                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)}
                                            className="w-full bg-black/50 border border-border/80 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/50 transition-all"
                                            placeholder="E-mail admin@govai.com"
                                            required
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">Senha</label>
                                        <input
                                            type="password"
                                            value={password}
                                            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
                                            className="w-full bg-black/50 border border-border/80 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/50 transition-all"
                                            placeholder="••••••••"
                                            required
                                        />
                                    </div>
                                    <button
                                        type="submit"
                                        disabled={loading}
                                        className="w-full bg-emerald-500 hover:bg-emerald-400 text-black font-bold py-3.5 px-4 rounded-xl transition-all disabled:opacity-50 flex items-center justify-center gap-2 mt-4 shadow-lg shadow-emerald-500/20"
                                    >
                                        {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Entrar (Demo Local)'}
                                    </button>
                                </div>
                            </form>

                            <div className="relative mb-8 mt-8">
                                <div className="absolute inset-0 flex items-center">
                                    <div className="w-full border-t border-border/80"></div>
                                </div>
                                <div className="relative flex justify-center text-xs uppercase">
                                    <span className="bg-zinc-900 px-2 text-muted-foreground font-semibold">Login Enterprise Integrado</span>
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
                        </>
                    ) : (
                        <form onSubmit={handleResetPassword} className="space-y-4">
                            <div>
                                <label className="block text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">Nova Senha Corporativa (Mín: 12 chars)</label>
                                <input
                                    type="password"
                                    value={newPassword}
                                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNewPassword(e.target.value)}
                                    className="w-full bg-black/50 border border-border/80 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/50 transition-all"
                                    placeholder="Defina uma senha forte..."
                                    required
                                    minLength={12}
                                />
                            </div>
                            <button
                                type="submit"
                                disabled={loading}
                                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-3.5 px-4 rounded-xl transition-all disabled:opacity-50 flex items-center justify-center gap-2 mt-4 shadow-lg shadow-emerald-500/20"
                            >
                                {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Confirmar e Atualizar Credencial'}
                            </button>
                            <button
                                type="button"
                                onClick={() => { setIsResetting(false); setError(''); }}
                                className="w-full bg-transparent border border-border/80 text-muted-foreground hover:text-white font-medium text-sm py-3.5 px-4 rounded-xl transition-all"
                            >
                                Voltar ao Login
                            </button>
                        </form>
                    )}
                </div>

                <p className="text-center text-xs text-muted-foreground mt-8">
                    GovAI Platform &copy; {new Date().getFullYear()}
                </p>
            </div>
        </div>
    );
}
