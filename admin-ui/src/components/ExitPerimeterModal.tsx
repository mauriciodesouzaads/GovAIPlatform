'use client';

import { useState, useEffect } from 'react';
import { AlertTriangle, ShieldOff, EyeOff, Scale, X } from 'lucide-react';
import { Button } from '@/components/Button';
import api, { ENDPOINTS } from '@/lib/api';
import { useToast } from '@/components/Toast';

export interface ExitPerimeterModalProps {
    open: boolean;
    onClose: () => void;
    assistant: { id: string; name: string };
    targetUrl: string;
}

export function ExitPerimeterModal({ open, onClose, assistant, targetUrl }: ExitPerimeterModalProps) {
    const [acknowledged, setAcknowledged] = useState(false);
    const [loading, setLoading] = useState(false);
    const { toast } = useToast();

    // Reset acknowledgment every time modal opens
    useEffect(() => {
        if (open) setAcknowledged(false);
    }, [open]);

    // Escape key
    useEffect(() => {
        if (!open) return;
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [open, onClose]);

    if (!open) return null;

    const handleExitPerimeter = async () => {
        setLoading(true);
        try {
            const res = await api.post(ENDPOINTS.CATALOG_EXIT_PERIMETER(assistant.id), {
                target_url: targetUrl,
                acknowledgment: true,
                confirmation_method: 'checkbox',
            });
            const traceId = (res.data as { trace_id?: string }).trace_id ?? '';
            window.open(targetUrl, '_blank', 'noopener,noreferrer');
            toast(`Saída registrada. Trace ID: ${traceId.substring(0, 8)}`, 'success');
            onClose();
        } catch (e: unknown) {
            const err = e as { response?: { data?: { error?: string } }; message?: string };
            toast(err.response?.data?.error ?? err.message ?? 'Erro ao registrar saída', 'error');
        } finally {
            setLoading(false);
        }
    };

    return (
        <>
            {/* Backdrop */}
            <div
                className="fixed inset-0 bg-background/70 backdrop-blur-sm z-[80]"
                onClick={onClose}
            />

            {/* Modal */}
            <div
                className="fixed inset-0 flex items-center justify-center z-[90] p-4"
                role="dialog"
                aria-modal="true"
                aria-labelledby="exit-modal-title"
                aria-describedby="exit-modal-description"
            >
                <div
                    className="w-full max-w-lg bg-card border border-border rounded-2xl shadow-2xl animate-in fade-in zoom-in-95 duration-200"
                    onClick={e => e.stopPropagation()}
                >
                    {/* Header bar with close button */}
                    <div className="flex items-center justify-end px-6 pt-5 pb-0">
                        <button
                            onClick={onClose}
                            aria-label="Fechar"
                            className="text-muted-foreground hover:text-foreground transition-colors p-1 -mr-1 rounded"
                        >
                            <X className="w-5 h-5" aria-hidden="true" />
                        </button>
                    </div>

                    <div className="px-6 pb-6 space-y-5">
                        {/* Warning header — amber theme */}
                        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-5">
                            <div className="flex items-start gap-3">
                                <AlertTriangle className="w-7 h-7 text-amber-400 shrink-0 mt-0.5" aria-hidden="true" />
                                <div>
                                    <h3 id="exit-modal-title" className="text-base font-bold text-amber-300">
                                        Saída do Ambiente Governado
                                    </h3>
                                    <p id="exit-modal-description" className="text-sm text-amber-200/80 mt-1">
                                        Você está prestes a acessar{' '}
                                        <strong className="text-amber-200">{assistant.name}</strong>{' '}
                                        fora do perímetro de governança da sua organização.
                                    </p>
                                </div>
                            </div>
                        </div>

                        {/* Consequences list */}
                        <div className="space-y-3">
                            <div className="flex items-start gap-2.5">
                                <ShieldOff className="w-4 h-4 text-destructive mt-0.5 shrink-0" aria-hidden="true" />
                                <p className="text-sm text-muted-foreground">
                                    Dados enviados{' '}
                                    <strong className="text-foreground">não serão mascarados</strong>{' '}
                                    pelo DLP. PII, dados confidenciais e informações proprietárias serão enviados sem proteção.
                                </p>
                            </div>
                            <div className="flex items-start gap-2.5">
                                <EyeOff className="w-4 h-4 text-destructive mt-0.5 shrink-0" aria-hidden="true" />
                                <p className="text-sm text-muted-foreground">
                                    Interações{' '}
                                    <strong className="text-foreground">não serão auditadas</strong>.
                                    Não haverá registro do conteúdo trocado com a IA externa.
                                </p>
                            </div>
                            <div className="flex items-start gap-2.5">
                                <Scale className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" aria-hidden="true" />
                                <p className="text-sm text-muted-foreground">
                                    A{' '}
                                    <strong className="text-foreground">responsabilidade por violações regulatórias</strong>{' '}
                                    decorrentes desta sessão será atribuída ao seu usuário, conforme política da organização.
                                </p>
                            </div>
                        </div>

                        {/* Legal acknowledgment — the clickwrap */}
                        <div className="border border-border rounded-xl p-4 bg-card/50">
                            <label className="flex items-start gap-3 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={acknowledged}
                                    onChange={e => setAcknowledged(e.target.checked)}
                                    className="mt-1 w-4 h-4 rounded border-border accent-amber-500 shrink-0"
                                />
                                <span className="text-sm text-foreground leading-relaxed">
                                    Declaro que li e compreendi os riscos acima. Estou ciente de que esta ação será
                                    registrada e que assumo responsabilidade pessoal pelas interações realizadas
                                    fora do ambiente governado.
                                </span>
                            </label>
                        </div>

                        {/* Action buttons */}
                        <div className="flex gap-3 pt-1">
                            <Button
                                variant="secondary"
                                className="flex-1"
                                onClick={onClose}
                                disabled={loading}
                            >
                                Voltar ao Ambiente Seguro
                            </Button>
                            <Button
                                variant="destructive"
                                className="flex-1"
                                disabled={!acknowledged || loading}
                                loading={loading}
                                onClick={handleExitPerimeter}
                            >
                                Aceito os Riscos — Prosseguir
                            </Button>
                        </div>
                    </div>
                </div>
            </div>
        </>
    );
}
