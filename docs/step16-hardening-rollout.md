# Step 16: Hardening + Rollout (Control-Plane)

## Security Hardening Applied
- Security headers enabled globally:
  - `Strict-Transport-Security`
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: no-referrer`
  - `Content-Security-Policy: default-src 'none'`
- Signed decision traces + intervention commands retained.
- RBAC extended to alerts endpoints.

## Performance Harness
- Script: `scripts/step16-policy-load.mjs`
- Purpose: high-volume policy evaluation and alert path validation.
- Usage:
  - `node ./scripts/step16-policy-load.mjs`
  - env overrides:
    - `CONTROL_PLANE_BASE_URL`
    - `STEP16_ROUNDS`
    - `STEP16_OPERATOR_ID`
    - `STEP16_OPERATOR_ROLE`

## Chaos Expectations
- Control-plane restart should preserve:
  - policy engine runtime state in `.data/policy-engine-state.json`
  - decision traces in `.data/audit-decision-traces.ndjson`
  - alert history in `.data/audit-alerts.ndjson`

## Canary Rollout Gates
- Stage 1: 5%
- Stage 2: 25%
- Stage 3: 50%
- Stage 4: 100%

Promote only when:
- `policy_evaluation_latency_ms < 50`
- `audit_log_write_latency_ms < 500`
- `correlation_trace_incomplete_total == 0`
- no unresolved critical alerts
