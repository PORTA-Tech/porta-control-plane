# Step 15: Observability + Alerts (Control-Plane)

## Implemented
- Correlation propagation in policy evaluation:
  - `correlation_id` accepted on `POST /v1/policy/evaluate`
  - persisted on every decision trace (`DecisionTrace.correlation_id`)
- New observability metrics:
  - `correlation_trace_complete_total`
  - `correlation_trace_incomplete_total`
  - `alerts_triggered_total`
- Alert persistence and lifecycle:
  - store: `.data/audit-alerts.ndjson`
  - endpoints:
    - `GET /v1/audit/alerts`
    - `GET /v1/audit/alerts?include_history=true`
    - `POST /v1/audit/alerts/:alertId/resolve`
- Deterministic alert rules over recent decision traces:
  - stress likelihood > 0.90 sustained > 30s
  - overload likelihood > 0.85 sustained > 60s
  - intervention failures > 3 in 5m
  - policy version mismatch
  - signature verification failure
  - event->console latency > 2s

## RBAC
- Added route policies:
  - `GET /v1/audit/alerts` -> `auditor|admin|operator`
  - `POST /v1/audit/alerts/:alertId/resolve` -> `admin|operator`

## Validation
- `npm run check` passed
- `npm run test` passed
- `npm run build` passed
