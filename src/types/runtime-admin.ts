/**
 * Runtime admin API — shared types
 * ---------------------------------------------------------------------------
 * Wire shapes for endpoints under /v1/admin/runtime/*. The admin-ui
 * (Etapa 5b) consumes these directly, so changes here are
 * cross-package — keep them additive when possible.
 */

export type RuntimeWorkItemStatus =
    | 'pending'
    | 'in_progress'
    | 'awaiting_approval'
    | 'done'
    | 'blocked'
    | 'cancelled';

export interface RuntimeWorkItemSummary {
    id: string;
    status: RuntimeWorkItemStatus;
    runtime_profile_slug: string | null;
    title: string;
    description: string | null;
    parent_work_item_id: string | null;
    subagent_depth: number;
    worker_session_id: string | null;
    session_id: string | null;
    created_at: string;
    completed_at: string | null;
    dispatch_error: string | null;
    tool_count: number;
    event_count: number;
    tokens: { prompt: number; completion: number } | null;
    has_error: boolean;
    // 6c.B.2 — origem do work_item p/ filtragem nas 3 sub-abas em /evidencias
    source: 'chat' | 'admin' | 'api' | 'test';
}

export interface RuntimeWorkItemListResponse {
    items: RuntimeWorkItemSummary[];
    next_cursor: string | null;
    /** Approximate count for the current filter set (NULL when expensive). */
    total_estimate: number | null;
    /** 6c.B.2 — counts by source para drive das pílulas das sub-abas */
    counts_by_source?: Record<'chat' | 'admin' | 'api' | 'test', number>;
}

export interface RuntimeWorkItemEvent {
    id: string;
    seq: number;
    type: string;
    tool_name: string | null;
    prompt_id: string | null;
    payload: Record<string, unknown>;
    timestamp: string;
}

export interface RuntimeWorkItemDetailResponse {
    work_item: RuntimeWorkItemSummary & {
        execution_context: Record<string, unknown>;
        execution_hint: string | null;
        worker_runtime: string;
        runtime_claim_level: string | null;
        dispatch_attempts: number;
        recovery_attempts: number;
        run_started_at: string | null;
        cancelled_at: string | null;
        cancellation_requested_at: string | null;
        last_event_at: string | null;
        mcp_server_ids: string[] | null;
    };
    events: RuntimeWorkItemEvent[];
    /** Direct children if this work_item has subagents; empty otherwise. */
    subagents: RuntimeWorkItemSummary[];
}

export interface RuntimeSession {
    session_id: string;
    last_used_unix_ms: number;
    message_count: number;
    runtime_slug: string;
    last_work_item_id: string | null;
}

export interface RuntimeSessionListResponse {
    sessions: RuntimeSession[];
}

export interface RuntimeRunnerHealth {
    slug: string;
    display_name: string;
    available: boolean;
    last_check_unix_ms: number;
    /** Resolved by resolveRuntimeTarget — the path the adapter would dial. */
    transport: 'unix' | 'tcp' | 'unknown';
    socket_path: string | null;
    grpc_host: string | null;
    /** Surfaced from runtime_profiles.config so the UI can render the lane. */
    runtime_class: string;
    claim_level: string | null;
}

export interface RuntimeRunnerHealthResponse {
    runners: RuntimeRunnerHealth[];
}

/** SSE line shape:  event: <type>\ndata: <RuntimeWorkItemEvent JSON>\n\n */
export interface RuntimeStreamEnd {
    final_status: RuntimeWorkItemStatus;
    closed_at_unix_ms: number;
}
