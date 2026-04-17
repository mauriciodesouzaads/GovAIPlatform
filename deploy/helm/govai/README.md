# GovAI GRC Platform — Helm Chart

Production Helm chart for the GovAI platform on Kubernetes 1.24+.

## Requirements

- Kubernetes 1.24+
- Helm 3.10+
- **PostgreSQL 15+** with `pgvector` extension (managed service recommended:
  RDS, Cloud SQL, Neon)
- **Redis 7+** (ElastiCache, MemoryStore, Upstash)
- **Ingress controller** (nginx-ingress recommended)
- **cert-manager** (optional, for TLS cert provisioning)
- **NetworkPolicy-aware CNI** (Calico, Cilium, Weave) if `networkPolicy.enabled=true`

## Pre-install: create secrets

The chart NEVER generates secrets. All credentials are consumed via
`existingSecret` references. Create them before `helm install`:

### Postgres credentials
```bash
kubectl create namespace govai
kubectl -n govai create secret generic govai-postgres-creds \
    --from-literal=POSTGRES_PASSWORD=<strong-superuser-pw> \
    --from-literal=DB_APP_PASSWORD=<strong-app-pw>
```

### Redis credentials
```bash
kubectl -n govai create secret generic govai-redis-creds \
    --from-literal=REDIS_URL=redis://:password@redis-host:6379
```

### LLM provider keys
```bash
kubectl -n govai create secret generic govai-llm-keys \
    --from-literal=GROQ_API_KEY=gsk_... \
    --from-literal=GEMINI_API_KEY=AIz... \
    --from-literal=CEREBRAS_API_KEY=csk_... \
    --from-literal=ANTHROPIC_API_KEY=sk-ant-... \
    --from-literal=OPENAI_API_KEY=sk-...
```

### LiteLLM master key
```bash
kubectl -n govai create secret generic govai-litellm-key \
    --from-literal=LITELLM_KEY=$(openssl rand -hex 32)
```

### JWT signing secret
```bash
kubectl -n govai create secret generic govai-jwt \
    --from-literal=JWT_SECRET=$(openssl rand -base64 64) \
    --from-literal=SIGNING_SECRET=$(openssl rand -base64 64)
```

## Install

```bash
helm install govai ./deploy/helm/govai \
    --namespace govai \
    --set postgres.host=my-rds.us-east.rds.amazonaws.com \
    --set redis.host=my-elasticache.use1.cache.amazonaws.com \
    --set global.domain=govai.mycompany.com \
    --set ingress.hosts.api=api.govai.mycompany.com \
    --set ingress.hosts.adminUi=app.govai.mycompany.com \
    --values values-prod.example.yaml
```

The pre-install hook runs migrations automatically. Check progress:
```bash
kubectl -n govai logs job/$(kubectl -n govai get jobs -o name | grep migrations)
```

## Multi-replica requirements

For `replicaCount.api > 1`, the chart validates at render time that:
- `features.streamRegistryMode=distributed` is set (enables Redis pub/sub
  for approval routing across replicas — see ADR-012)

## Upgrade

```bash
helm upgrade govai ./deploy/helm/govai --namespace govai \
    --values values-prod.example.yaml
```

Pre-upgrade hook runs migrations.

## Uninstall

```bash
helm uninstall govai --namespace govai
```

**Note:** external databases are NOT deleted. Drop them manually if desired.

## Feature flags

Set via `--set` or `values.yaml`:

| Flag | Default | Effect |
|------|---------|--------|
| `features.streamRegistryMode` | `distributed` | Required when `replicaCount.api > 1` |
| `features.otelEnabled` | `true` | Emit OpenTelemetry traces to collector |
| `features.claudeCodeRunnerEnabled` | `false` | Deploy the Official Claude Code sidecar (requires ANTHROPIC_API_KEY with credits) |
| `features.openRouterEnabled` | `false` | Expose OpenRouter alias in LiteLLM (requires OPENROUTER_API_KEY) |
| `features.tenantMaxConcurrent` | `2` | Per-tenant concurrency limit in architect worker |

## Observability

- Prometheus metrics at `<api-pod>:3000/metrics` (auth-gated via
  `METRICS_API_KEY` secret)
- OpenTelemetry spans exported to `observability.otel.collectorEndpoint`
- Structured JSON logs to stdout (consumed by any log shipper)
- Prometheus alert rules: `deploy/prometheus/alerts.yaml`
- Grafana dashboards: `deploy/grafana-dashboards/`

## Validation

```bash
# Lint
helm lint deploy/helm/govai

# Dry-run render
helm template govai deploy/helm/govai \
    --namespace govai \
    --set postgres.host=dummy \
    --set redis.host=dummy \
    --set global.domain=test.com
```
