/**
 * Shield Core — Detection & Risk Intelligence Plane
 *
 * Facade: re-exports everything from the 5 service modules so that
 * existing imports from '../lib/shield' continue working unchanged.
 *
 * Regra de set_config:
 *   Usar false (session-level). Limpar no finally.
 *   Nunca usar true (transaction-local).
 */

// ── Ingestion ──────────────────────────────────────────────────────────────────
export {
    ShieldObservationPayload,
    normalizeToolName,
    hashUserIdentifier,
    recordShieldObservation,
    processShieldObservations,
} from './shield-ingestion.service';

// ── Findings ───────────────────────────────────────────────────────────────────
export {
    ShieldFindingFilters,
    ShieldPromoteResult,
    generateShieldFindings,
    listShieldFindings,
    mergeOrUpdateFinding,
    dedupeFindings,
    syncShieldToolsWithCatalog,
    computeOwnerCandidate,
} from './shield-findings.service';

// ── Workflow ───────────────────────────────────────────────────────────────────
export {
    acknowledgeShieldFinding,
    promoteShieldFindingToCatalog,
    acceptRisk,
    dismissFinding,
    resolveFinding,
    reopenFinding,
    assignShieldFindingOwner,
    appendShieldFindingComment,
    listShieldFindingActions,
} from './shield-workflow.service';

// ── Reporting ──────────────────────────────────────────────────────────────────
export {
    generateExecutivePosture,
} from './shield-reporting.service';

// ── Consultant ─────────────────────────────────────────────────────────────────
export {
    listShieldPostureForConsultant,
} from './shield-consultant.service';
