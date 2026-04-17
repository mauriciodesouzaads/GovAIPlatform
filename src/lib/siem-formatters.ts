/**
 * SIEM Output Formatters — FASE 12
 * ---------------------------------------------------------------------------
 * Maps GovAI canonical events to SIEM-standard formats consumable by
 * Splunk, Elastic, Datadog, Microsoft Sentinel, QRadar, etc.
 *
 * Two formats supported:
 *   - CEF v0 (Common Event Format): single-line pipe-delimited, widely
 *     accepted as-is. Best for Splunk, Sentinel, QRadar.
 *   - JSON: native to Elastic/Datadog. Richer structure; larger payload.
 *
 * Field mapping follows CEF conventions:
 *   act     — action name (POLICY_VIOLATION, DLP_BLOCK, LOGIN_FAILURE, ...)
 *   suser   — source user (email of authenticated user)
 *   duser   — destination user (target, e.g., assistant name)
 *   outcome — success | failure | blocked
 *   cs1..6  — custom strings (org_id, trace_id, assistant_id, ...)
 */

export interface SiemEvent {
    timestamp: Date;
    action: string;
    outcome: 'success' | 'failure' | 'blocked';
    severity: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
    orgId: string;
    userId?: string;
    userEmail?: string;
    assistantId?: string;
    traceId?: string;
    reason?: string;
    metadata?: Record<string, unknown>;
}

/** CEF v0 format — single line, pipe-delimited.
 *  Spec: https://docs.centrify.com/Content/IntegrationContent/SIEM/arcsight-cef/arcsight-cef-format.htm
 */
export function toCEF(event: SiemEvent): string {
    const version = '0';
    const deviceVendor = 'GovAI';
    const deviceProduct = 'GRC-Platform';
    const deviceVersion = process.env.npm_package_version || '1.0.0';
    const signatureId = event.action;
    const name = event.action.replace(/_/g, ' ');

    // CEF header field separator is '|' and key=value separator is '='.
    // Any literal '|' in a header field or '=' in an extension value
    // must be escaped with '\'.
    const escapeHeader = (s: string) => String(s || '').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
    const escapeExt = (s: string) => String(s || '').replace(/\\/g, '\\\\').replace(/=/g, '\\=').replace(/\n/g, '\\n');

    const header = [
        `CEF:${version}`,
        escapeHeader(deviceVendor),
        escapeHeader(deviceProduct),
        escapeHeader(deviceVersion),
        escapeHeader(signatureId),
        escapeHeader(name),
        String(event.severity),
    ].join('|');

    const ext: string[] = [];
    ext.push(`rt=${event.timestamp.getTime()}`);
    ext.push(`act=${escapeExt(event.action)}`);
    ext.push(`outcome=${event.outcome}`);
    if (event.userEmail) ext.push(`suser=${escapeExt(event.userEmail)}`);
    if (event.assistantId) ext.push(`duser=${escapeExt(event.assistantId)}`);
    ext.push(`cs1Label=orgId cs1=${escapeExt(event.orgId)}`);
    if (event.traceId) ext.push(`cs2Label=traceId cs2=${escapeExt(event.traceId)}`);
    if (event.reason) ext.push(`cs3Label=reason cs3=${escapeExt(event.reason.substring(0, 500))}`);

    return `${header}|${ext.join(' ')}`;
}

/** JSON format — Elastic/Datadog native, Elastic Common Schema (ECS) fields. */
export function toSiemJSON(event: SiemEvent): string {
    return JSON.stringify({
        '@timestamp': event.timestamp.toISOString(),
        'event.action': event.action,
        'event.outcome': event.outcome,
        'event.severity': event.severity,
        'user.email': event.userEmail,
        'user.id': event.userId,
        'organization.id': event.orgId,
        'assistant.id': event.assistantId,
        'trace.id': event.traceId,
        'event.reason': event.reason,
        'source.product': 'GovAI',
        'source.version': process.env.npm_package_version || '1.0.0',
        ...event.metadata,
    });
}

/** Infer SIEM outcome from a canonical event name. */
export function inferOutcome(event: string): 'success' | 'failure' | 'blocked' {
    if (/violation|block|reject|deny|forbid/i.test(event)) return 'blocked';
    if (/success|grant|complet|approv(?:ed|ing)/i.test(event)) return 'success';
    if (/fail|error|timeout/i.test(event)) return 'failure';
    return 'success';
}

/** Infer severity 1-10 from a canonical event name. */
export function inferSeverity(event: string): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 {
    if (/critical|breach|leak|exfiltrat/i.test(event)) return 10;
    if (/violation|block/i.test(event)) return 9;
    if (/alert\.high|approval\.rejected/i.test(event)) return 7;
    if (/alert|reject|deny/i.test(event)) return 5;
    if (/execution\.error|runtime\.unavailable/i.test(event)) return 4;
    return 3;
}
