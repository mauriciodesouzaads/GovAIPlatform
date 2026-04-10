BEGIN;

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS
  alert_thresholds JSONB DEFAULT '{"latency_p95_ms": 5000, "violation_rate_pct": 10, "daily_cost_usd": 50}'::jsonb;

COMMIT;
