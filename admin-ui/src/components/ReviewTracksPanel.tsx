'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { CheckCircle2, XCircle, Clock, AlertCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { Badge } from './Badge';
import { ENDPOINTS } from '@/lib/api';

interface ReviewDecision {
  id: string;
  track_id: string;
  track_name: string;
  track_slug: string;
  is_required: boolean;
  sla_hours: number;
  decision: 'pending' | 'approved' | 'rejected' | 'escalated';
  reviewer_email: string | null;
  notes: string | null;
  decided_at: string | null;
  created_at: string;
}

interface ReviewStatus {
  assistant_id: string;
  decisions: ReviewDecision[];
  summary: {
    all_required_approved: boolean;
    any_rejected: boolean;
    pending_count: number;
  };
}

interface ReviewTracksPanelProps {
  assistantId: string;
  orgId: string;
  token: string;
  onDecisionMade?: () => void;
  canDecide?: boolean;
}

function decisionIcon(decision: string) {
  if (decision === 'approved') return <CheckCircle2 className="w-4 h-4 text-success-fg" />;
  if (decision === 'rejected') return <XCircle className="w-4 h-4 text-danger-fg" />;
  if (decision === 'escalated') return <AlertCircle className="w-4 h-4 text-warning-fg" />;
  return <Clock className="w-4 h-4 text-info-fg" />;
}

function decisionVariant(decision: string): 'success' | 'error' | 'warning' | 'info' {
  if (decision === 'approved') return 'success';
  if (decision === 'rejected') return 'error';
  if (decision === 'escalated') return 'warning';
  return 'info';
}

export function ReviewTracksPanel({ assistantId, orgId, token, onDecisionMade, canDecide = false }: ReviewTracksPanelProps) {
  const [status, setStatus] = useState<ReviewStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch(ENDPOINTS.REVIEW_STATUS(assistantId), {
        headers: { Authorization: `Bearer ${token}`, 'x-org-id': orgId },
      });
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      }
    } catch {
      // silently fail — panel stays empty
    } finally {
      setLoading(false);
    }
  }, [assistantId, orgId, token]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const decide = async (trackId: string, decision: 'approved' | 'rejected') => {
    setSubmitting(trackId);
    try {
      const res = await fetch(ENDPOINTS.REVIEW_TRACK_DECIDE(assistantId, trackId), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'x-org-id': orgId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ decision, notes: notes[trackId] ?? undefined }),
      });
      if (res.ok) {
        await fetchStatus();
        onDecisionMade?.();
      }
    } finally {
      setSubmitting(null);
      setExpanded(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-14 rounded-lg bg-secondary animate-pulse" />
        ))}
      </div>
    );
  }

  if (!status || status.decisions.length === 0) {
    return (
      <div className="text-center py-6 text-muted-foreground text-sm">
        Nenhuma track de revisão configurada.
      </div>
    );
  }

  const { summary } = status;

  return (
    <div className="space-y-3">
      {/* Summary banner */}
      <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium border
        ${summary.any_rejected
          ? 'bg-danger-bg border-danger-border text-danger-fg'
          : summary.all_required_approved
          ? 'bg-success-bg border-success-border text-success-fg'
          : 'bg-info-bg border-info-border text-info-fg'
        }`}>
        {summary.any_rejected
          ? <><XCircle className="w-3.5 h-3.5" /> Revisão rejeitada em uma ou mais tracks</>
          : summary.all_required_approved
          ? <><CheckCircle2 className="w-3.5 h-3.5" /> Todas as tracks obrigatórias aprovadas</>
          : <><Clock className="w-3.5 h-3.5" /> {summary.pending_count} track(s) aguardando decisão</>
        }
      </div>

      {/* Track rows */}
      {status.decisions.map(d => (
        <div key={d.track_id} className="border border-border rounded-lg overflow-hidden">
          <div className="flex items-center gap-3 px-3 py-2.5">
            {decisionIcon(d.decision)}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground truncate">{d.track_name}</span>
                {d.is_required && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground border border-border">
                    obrigatória
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                SLA: {d.sla_hours}h
                {d.decided_at && ` · Decidido ${new Date(d.decided_at).toLocaleDateString('pt-BR')}`}
                {d.reviewer_email && ` · ${d.reviewer_email}`}
              </div>
            </div>
            <Badge variant={decisionVariant(d.decision)}>
              {d.decision === 'pending' ? 'Pendente'
                : d.decision === 'approved' ? 'Aprovado'
                : d.decision === 'rejected' ? 'Rejeitado'
                : 'Escalado'}
            </Badge>
            {canDecide && d.decision === 'pending' && (
              <button
                onClick={() => setExpanded(expanded === d.track_id ? null : d.track_id)}
                className="ml-1 text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Expandir"
              >
                {expanded === d.track_id ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
            )}
          </div>

          {/* Notes field and action buttons */}
          {canDecide && d.decision === 'pending' && expanded === d.track_id && (
            <div className="border-t border-border px-3 py-3 bg-secondary/20 space-y-2">
              <textarea
                placeholder="Observações (opcional)"
                rows={2}
                value={notes[d.track_id] ?? ''}
                onChange={e => setNotes(prev => ({ ...prev, [d.track_id]: e.target.value }))}
                className="w-full text-xs bg-background border border-border rounded-md px-2.5 py-1.5 text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:border-border-400"
              />
              <div className="flex gap-2">
                <button
                  disabled={!!submitting}
                  onClick={() => decide(d.track_id, 'approved')}
                  className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md bg-success-bg text-success-fg border border-success-border text-xs font-medium hover:bg-emerald-500/25 transition-colors disabled:opacity-50"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  {submitting === d.track_id ? 'Salvando...' : 'Aprovar'}
                </button>
                <button
                  disabled={!!submitting}
                  onClick={() => decide(d.track_id, 'rejected')}
                  className="flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-md bg-danger-bg text-danger-fg border border-danger-border text-xs font-medium hover:bg-rose-500/25 transition-colors disabled:opacity-50"
                >
                  <XCircle className="w-3.5 h-3.5" />
                  {submitting === d.track_id ? 'Salvando...' : 'Rejeitar'}
                </button>
              </div>
            </div>
          )}

          {/* Notes display for finalized decisions */}
          {d.notes && d.decision !== 'pending' && (
            <div className="border-t border-border px-3 py-2 bg-secondary/10 text-xs text-muted-foreground">
              {d.notes}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
