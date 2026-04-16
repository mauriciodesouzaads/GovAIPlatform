# GovAI Grafana Dashboards

Pre-built dashboards for the GovAI GRC Platform observability stack.

## Requirements

- Grafana 10+
- Prometheus datasource scraping `govai-api:3000/metrics`
- PostgreSQL datasource with read-only access to `govai_platform` (optional, for runtime ops dashboard)

## Dashboards

| Dashboard | File | Datasources |
|-----------|------|-------------|
| Gateway Overview | `govai-gateway.json` | Prometheus |
| Runtime Operations | `govai-runtime.json` | Prometheus + PostgreSQL |

## Import

1. Navigate to **Grafana → Dashboards → Import**
2. Upload the JSON file or paste its contents
3. Select the appropriate Prometheus datasource
4. For runtime ops: also select the PostgreSQL datasource

## Prometheus Scrape Configuration

Add to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: govai-api
    static_configs:
      - targets: ['api:3000']
    metrics_path: /metrics
    authorization:
      credentials: <METRICS_API_KEY>
    scrape_interval: 15s
```

## Template Variables

Both dashboards use Grafana template variables:

- `$datasource` — select which Prometheus datasource to query
- `$org_id` — filter by tenant organization (from `assistant_id` metric label)

## Metric Names

All GovAI metrics use the `govai_` prefix. Key metrics:

| Metric | Type | Description |
|--------|------|-------------|
| `govai_http_requests_total` | Counter | Total HTTP requests (label: status) |
| `govai_gateway_latency_ms` | Histogram | Gateway latency per request |
| `govai_assistant_latency_ms` | Histogram | Per-assistant latency |
| `govai_dlp_detections_total` | Counter | DLP/PII detections |
| `govai_quota_exceeded_total` | Counter | Quota violations |
| `govai_active_pg_connections` | Gauge | Active DB connections |
| `govai_node_*` | Various | Node.js runtime metrics (GC, memory, event-loop) |
