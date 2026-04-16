# ADR-013: Observability Strategy

## Status: Accepted

## Context

The platform has Prometheus metrics (`sre-metrics.ts` with histograms,
counters, gauges) and a multi-probe `/health` endpoint. To reach enterprise
operations maturity (the standard expected by bank/government customers),
we need the rest of the observability tripod:

- **Distributed tracing** across HTTP → BullMQ → gRPC → DB
- **Structured logs** correlatable with traces
- **Actionable alerts** (both in-app and Prometheus-level)
- **Pre-built dashboards** for immediate operational visibility

## Decision

### Three-pillar observability

#### Metrics (existing) — prom-client
- Exposed at `/metrics` (auth-gated via `METRICS_API_KEY`)
- Scraped by Prometheus (standard pull model)
- Used by AlertManager for infrastructure alerts
- Metric names: `govai_*` prefix (defined in `sre-metrics.ts`)

#### Traces (new) — OpenTelemetry
- Feature flag: `OTEL_ENABLED` (default `false` — zero overhead in dev)
- OTLP HTTP exporter to `otel-collector` (configurable endpoint)
- Auto-instrumentation for HTTP, pg, ioredis, gRPC, fastify
- Custom spans per gateway stage (planned) with `govai.*` attributes
- Context propagation through BullMQ via carrier in `job.data._otelContext`
- Correlation: `x-govai-trace-id` (UUID, existing) coexists with OTel
  `trace_id` (W3C format); both appear in structured logs

#### Logs (existing, evolved) — pino
- JSON format in production (via pino `formatters` config)
- Redact: `authorization`, `cookie`, `password`, `api_key`, `secret`
- `structured-log.ts` helper adds `otel_trace_id` + `otel_span_id`
- Critical events logged with canonical fields: `component`, `outcome`,
  `org_id`, `trace_id`

### Alerts

#### In-app alerting (new)
- `alerting.worker.ts`: evaluates `alert_thresholds` table every 60s
- Breaches enqueued to `notification.worker` (existing Slack/Teams/Email)
- Supported metrics: `gateway_latency_p95`, `violation_rate`, `execution_count`

#### Prometheus AlertManager (new)
- `deploy/prometheus/alerts.yaml`: p95 latency, error rate, DLP spike,
  queue depth, DEK rotation, runtime up/down
- Deployed alongside customer's Prometheus stack

### Dashboards (new)
- `deploy/grafana-dashboards/govai-gateway.json`: request rate, latency
  percentiles, DLP detections, policy violations, DB connections, memory
- `deploy/grafana-dashboards/govai-runtime.json`: work items by status/
  runtime/claim, approval wait duration, compliance consent gauge

## Trade-offs

- **OTel SDK adds ~30MB** to the Docker image and some CPU overhead.
  `OTEL_ENABLED=false` (default) means zero runtime cost in dev/local.

- **Structured logs in prod** disable pino-pretty — `docker logs` shows
  raw JSON. Correct trade-off for queryability in Loki/Elastic; use
  `jq` for local inspection.

- **Trace_id NOT added to Prometheus labels** — cardinality would explode.
  Correlation is via log search by `trace_id`, and Grafana datasource-
  to-datasource linking.

## Alternatives considered

- **Datadog/New Relic SaaS agents**: vendor lock-in, cost. Rejected for
  core. Customers can configure the OTel collector to export there.
- **Jaeger native client**: older API, less maintained. Rejected in favor
  of OTel SDK which supports Jaeger as an exporter anyway.
- **Logstash/Fluentd**: overkill — pino JSON is already structured. Any
  log shipper (Promtail, Filebeat, Vector) works directly.

## Consequences

- `OTEL_ENABLED=true` + the `observability` Docker Compose profile gives
  full tracing out of the box for any deployment
- Metrics, traces, and logs all share `govai_trace_id` for correlation
- Grafana dashboards are importable in < 5 minutes
- In-app alerts require zero external infrastructure (just notification
  channels configured in the admin UI)
