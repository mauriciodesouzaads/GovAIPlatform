'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import axios from 'axios';
import { ShieldCheck, Loader2, AlertCircle, CheckCircle2, Eye, EyeOff } from 'lucide-react';

import api, { API_BASE } from '@/lib/api';
import { setAuthToken } from '@/lib/auth-storage';
import { useAuth } from '@/components/AuthProvider';

function LoginForm() {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [error, setError] = useState('');
    const [successMsg, setSuccessMsg] = useState('');
    const [loading, setLoading] = useState(false);
    const [ssoLoading, setSsoLoading] = useState<'microsoft' | 'okta' | null>(null);

    // Reset flow
    const [isResetting, setIsResetting] = useState(false);
    const [resetToken, setResetToken] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [showNewPassword, setShowNewPassword] = useState(false);

    const router = useRouter();
    const searchParams = useSearchParams();
    const { refreshFromServer } = useAuth();

    // Handle OIDC auth code exchange
    useEffect(() => {
        const authCode = searchParams.get('auth_code');
        if (!authCode) return;
        let cancelled = false;
        const exchangeCode = async () => {
            try {
                const res = await axios.post(`${API_BASE}/v1/auth/oidc/session`, { code: authCode });
                if (cancelled) return;
                setAuthToken(res.data.token);

                // Same role-based redirect as the standard login path
                const GOVERNANCE_ROLES = ['dpo', 'auditor', 'compliance'];
                try {
                    const payload = JSON.parse(atob(res.data.token.split('.')[1]));
                    const userRole: string = payload?.role || 'operator';
                    router.replace(GOVERNANCE_ROLES.includes(userRole) ? '/shield' : '/');
                } catch {
                    router.replace('/');
                }
            } catch (err: unknown) {
                if (cancelled) return;
                const e = err as { response?: { data?: { error?: string } } };
                setError(e.response?.data?.error || 'Falha ao concluir a sessão SSO. Reinicie o login.');
            }
        };
        exchangeCode();
        return () => { cancelled = true; };
    }, [searchParams, router]);

    // Handle OIDC error codes
    useEffect(() => {
        const oidcError = searchParams.get('error');
        if (oidcError) {
            const messages: Record<string, string> = {
                microsoft_auth_failed: 'Falha na autenticação Microsoft Entra. Tente novamente.',
                okta_auth_failed: 'Falha na autenticação Okta. Tente novamente.',
                tenant_not_authorized: 'Nenhuma organização autorizada foi encontrada para este tenant.',
                identity_claims_incomplete: 'O provedor de identidade não retornou claims suficientes.',
            };
            setError(messages[oidcError] || `Erro de autenticação SSO: ${oidcError}`);
        }
    }, [searchParams]);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);
        try {
            const res = await axios.post(`${API_BASE}/v1/admin/login`, { email, password });
            setAuthToken(res.data.token);
            api.defaults.headers.common['Authorization'] = `Bearer ${res.data.token}`;
            await refreshFromServer();

            // Governance roles land on Shield after login; admins/operators go to Dashboard.
            // We decode the JWT payload (no crypto — just reading the claims) to decide the
            // redirect destination at login time only. Manual navigation to / is still allowed
            // and will show the role-filtered dashboard without triggering this redirect.
            const GOVERNANCE_ROLES = ['dpo', 'auditor', 'compliance'];
            try {
                const payload = JSON.parse(atob(res.data.token.split('.')[1]));
                const userRole: string = payload?.role || 'operator';
                router.push(GOVERNANCE_ROLES.includes(userRole) ? '/shield' : '/');
            } catch {
                router.push('/');
            }
        } catch (err: unknown) {
            const e = err as { response?: { status: number; data?: { requires_password_change?: boolean; resetToken?: string; error?: string } } };
            if (e.response?.status === 403 && e.response?.data?.requires_password_change) {
                setIsResetting(true);
                setResetToken(e.response.data.resetToken || '');
                setError('Troca de senha inicial obrigatória por conformidade de segurança.');
            } else if (e.response?.status === 401 || e.response?.status === 403) {
                setError('E-mail ou senha incorretos.');
            } else if (!e.response) {
                setError('Servidor temporariamente indisponível. Verifique a conexão.');
            } else {
                setError(e.response?.data?.error || 'Erro ao realizar login.');
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
            await axios.post(`${API_BASE}/v1/admin/reset-password`, { resetToken, newPassword });
            setSuccessMsg('Senha atualizada com sucesso! Faça login com a nova senha.');
            setIsResetting(false);
            setResetToken('');
            setNewPassword('');
            setPassword('');
        } catch (err: unknown) {
            const e = err as { response?: { data?: { error?: string } } };
            setError(e.response?.data?.error || 'Erro ao redefinir a senha.');
        } finally {
            setLoading(false);
        }
    };

    const inputClass = "w-full bg-secondary border border-border rounded-lg px-4 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:ring-offset-2 focus:ring-offset-background focus:border-primary/50 transition-all placeholder:text-muted-foreground";

    return (
        <div className="min-h-screen bg-background flex items-center justify-center p-4">
            <div className="w-full max-w-sm">

                {/* Card */}
                <div className="bg-card border border-border rounded-2xl p-8 shadow-lg">

                    {/* Brand */}
                    <div className="text-center mb-8">
                        <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 mb-5">
                            <ShieldCheck className="w-7 h-7 text-primary" />
                        </div>
                        <h1 className="text-2xl font-bold text-foreground tracking-tight">GovAI Platform</h1>
                        <p className="text-sm text-muted-foreground mt-1">Enterprise AI Governance Platform</p>
                    </div>

                    {/* Success message */}
                    {successMsg && (
                        <div className="mb-5 p-3.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-start gap-2.5">
                            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                            <p className="text-sm text-emerald-400">{successMsg}</p>
                        </div>
                    )}

                    {/* Error message */}
                    {error && (
                        <div className="mb-5 p-3.5 rounded-lg bg-rose-500/10 border border-rose-500/20 flex items-start gap-2.5 animate-in fade-in duration-200">
                            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                            <p className="text-sm text-rose-400">{error}</p>
                        </div>
                    )}

                    {!isResetting ? (
                        <>
                            {/* Login form */}
                            <form onSubmit={handleLogin} className="space-y-4">
                                <div className="space-y-1.5">
                                    <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                        E-mail Corporativo
                                    </label>
                                    <input
                                        type="email"
                                        value={email}
                                        onChange={e => setEmail(e.target.value)}
                                        className={inputClass}
                                        placeholder="admin@empresa.com"
                                        autoComplete="email"
                                        required
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <div className="flex items-center justify-between">
                                        <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                            Senha
                                        </label>
                                        <button
                                            type="button"
                                            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                                        >
                                            Esqueceu a senha?
                                        </button>
                                    </div>
                                    <div className="relative">
                                        <input
                                            type={showPassword ? 'text' : 'password'}
                                            value={password}
                                            onChange={e => setPassword(e.target.value)}
                                            className={`${inputClass} pr-10`}
                                            placeholder="••••••••••••"
                                            autoComplete="current-password"
                                            required
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setShowPassword(v => !v)}
                                            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                                            tabIndex={-1}
                                        >
                                            {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                        </button>
                                    </div>
                                </div>
                                <button
                                    type="submit"
                                    disabled={loading}
                                    className="w-full bg-primary text-primary-foreground font-semibold py-2.5 px-4 rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2 mt-2"
                                >
                                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                                    {loading ? 'Entrando…' : 'Entrar'}
                                </button>
                            </form>

                            {/* Divider */}
                            <div className="relative my-6">
                                <div className="absolute inset-0 flex items-center">
                                    <div className="w-full border-t border-border" />
                                </div>
                                <div className="relative flex justify-center">
                                    <span className="bg-card px-3 text-xs text-muted-foreground">Login Enterprise</span>
                                </div>
                            </div>

                            {/* SSO buttons */}
                            <div className="space-y-3">
                                <button
                                    onClick={() => { setSsoLoading('microsoft'); window.location.href = `${API_BASE}/v1/auth/oidc/microsoft`; }}
                                    disabled={ssoLoading !== null}
                                    type="button"
                                    className="w-full bg-secondary border border-border text-foreground font-medium text-sm px-4 py-2.5 rounded-lg hover:bg-secondary/80 transition-colors flex items-center justify-center gap-3 disabled:opacity-60"
                                >
                                    {ssoLoading === 'microsoft'
                                        ? <Loader2 className="w-4 h-4 animate-spin" />
                                        : <svg className="w-5 h-5" viewBox="0 0 21 21"><path fill="#f25022" d="M1 1h9v9H1z"/><path fill="#7fba00" d="M11 1h9v9h-9z"/><path fill="#00a4ef" d="M1 11h9v9H1z"/><path fill="#ffb900" d="M11 11h9v9h-9z"/></svg>
                                    }
                                    {ssoLoading === 'microsoft' ? 'Redirecionando…' : 'Entrar com Microsoft Entra'}
                                </button>

                                <button
                                    onClick={() => { setSsoLoading('okta'); window.location.href = `${API_BASE}/v1/auth/oidc/okta`; }}
                                    disabled={ssoLoading !== null}
                                    type="button"
                                    className="w-full bg-secondary border border-border text-foreground font-medium text-sm px-4 py-2.5 rounded-lg hover:bg-secondary/80 transition-colors flex items-center justify-center gap-3 disabled:opacity-60"
                                >
                                    {ssoLoading === 'okta'
                                        ? <Loader2 className="w-4 h-4 animate-spin" />
                                        : <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z"/></svg>
                                    }
                                    {ssoLoading === 'okta' ? 'Redirecionando…' : 'Entrar com Okta'}
                                </button>
                            </div>
                        </>
                    ) : (
                        /* Password reset form */
                        <form onSubmit={handleResetPassword} className="space-y-4">
                            <p className="text-sm text-muted-foreground text-center">
                                Defina uma nova senha corporativa (mínimo 12 caracteres)
                            </p>
                            <div className="space-y-1.5">
                                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                    Nova Senha
                                </label>
                                <div className="relative">
                                    <input
                                        type={showNewPassword ? 'text' : 'password'}
                                        value={newPassword}
                                        onChange={e => setNewPassword(e.target.value)}
                                        className={`${inputClass} pr-10`}
                                        placeholder="Mínimo 12 caracteres"
                                        required
                                        minLength={12}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowNewPassword(v => !v)}
                                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                                        tabIndex={-1}
                                    >
                                        {showNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                    </button>
                                </div>
                            </div>
                            <button
                                type="submit"
                                disabled={loading}
                                className="w-full bg-primary text-primary-foreground font-semibold py-2.5 px-4 rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                            >
                                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                                {loading ? 'Atualizando…' : 'Confirmar Nova Senha'}
                            </button>
                            <button
                                type="button"
                                onClick={() => { setIsResetting(false); setError(''); }}
                                className="w-full bg-transparent border border-border text-muted-foreground hover:text-foreground font-medium text-sm py-2.5 px-4 rounded-lg transition-colors"
                            >
                                Voltar ao Login
                            </button>
                        </form>
                    )}
                </div>

                {/* Footer */}
                <p className="text-center text-xs text-muted-foreground mt-6">
                    Powered by GovAI Platform &copy; {new Date().getFullYear()}
                </p>
            </div>
        </div>
    );
}

export default function LoginPage() {
    return (
        <Suspense fallback={
            <div className="min-h-screen bg-background flex items-center justify-center">
                <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
        }>
            <LoginForm />
        </Suspense>
    );
}
