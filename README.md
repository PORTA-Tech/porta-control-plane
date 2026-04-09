# PORTA Control Plane

Central governance and decision service for PORTA.

This service ingests typed data, evaluates deterministic policies, emits signed intervention commands, keeps append-only audit traces, and exposes operator APIs for rollout/governance.

## What This Repository Owns

- Typed ingestion and schema-aware processing
- Deterministic policy evaluation runtime
- Signed intervention command generation
- Decision trace persistence and replay verification
- Audit/alert endpoints and observability metrics
- RBAC enforcement on all `/v1/*` APIs
- Rollout/config integrity surfaces used by the console

## Implemented Scope (Steps)

- Step 8: policy model + signing/verification path foundations
- Step 9: control-plane ingestion + version validation + structured storage
- Step 10: deterministic policy execution loop and state mutation model
- Step 11: audit/governance model (traceability, RBAC, retention controls)
- Step 15: observability + alerts and correlation coverage
- Step 16: hardening/load harness for rollout validation

## Runtime Stack

- Node.js + Express (TypeScript)
- Local persistence under `.data/` for runtime artifacts
- Ed25519 signing for policy/intervention trust checks
- SHA-256 canonical hashing for replay/integrity

## API Surface (High Level)

- `GET /health`
- `POST /v1/policy/evaluate`
- `GET /v1/policy/state/:environment/:service`
- `GET/POST /v1/config/*`
- `GET/POST /v1/rollout/*`
- `GET /v1/nodes/snapshot`
- `GET/POST /v1/adapter/*`
- `GET/POST /v1/audit/*`

All `/v1/*` routes require:

- `x-operator-id`
- `x-operator-role`

RBAC roles include `viewer`, `operator`, `admin`, `auditor`, `developer`, `agent`, with route-level policy checks.

## Quick Start

### Prerequisites

- Node.js 20+
- npm

### Install

```bash
npm install
```

### Run in dev mode

```bash
npm run dev
```

Default port: `8787` (`PORT` env overrides).

### Build and run

```bash
npm run build
npm run start
```

### Fleet Persistence

- Production deployments must set `PORTA_CONTROL_PLANE_DATABASE_URL` or `DATABASE_URL`.
- Fleet/account/device/consent state is not allowed to run in memory in production-like environments.
- Local or test-only in-memory mode can still be used outside production, or explicitly allowed with `PORTA_CONTROL_PLANE_ALLOW_IN_MEMORY_FLEET=true`.

### Windows Client Updates

Set these env vars on the control plane to publish a Windows in-app update prompt:

- `PORTA_WINDOWS_RELEASE_VERSION`
- `PORTA_WINDOWS_RELEASE_MSI_URL`

Optional:

- `PORTA_WINDOWS_RELEASE_PUBLISHED_AT_UTC`
- `PORTA_WINDOWS_RELEASE_MIN_SUPPORTED_VERSION`
- `PORTA_WINDOWS_RELEASE_REQUIRED`
- `PORTA_WINDOWS_RELEASE_TITLE`
- `PORTA_WINDOWS_RELEASE_SUMMARY`
- `PORTA_WINDOWS_RELEASE_SHA256`

When `PORTA_WINDOWS_RELEASE_VERSION` is newer than the installed Windows client version, Control Center can show an update prompt, download the MSI, and launch the installer from inside the app.

### Type-check and tests

```bash
npm run check
npm run test
```

### Step 16 policy load smoke

```bash
npm run step16:load
```

Optional env:

- `CONTROL_PLANE_BASE_URL`
- `STEP16_ROUNDS`
- `STEP16_OPERATOR_ID`
- `STEP16_OPERATOR_ROLE`

## Runtime Data Files

Artifacts are stored in `.data/`:

- `policy-engine-state.json`
- `audit-decision-traces.ndjson`
- `signed-intervention-commands.ndjson`
- `audit-alerts.ndjson`
- `audit-observability-metrics.json`

## Security Notes

- Use TLS termination in deployment
- Treat signing keys as secrets; dev keys in repo are for local controlled testing only
- Keep CORS restricted (`CORS_ALLOWED_ORIGINS`)
- Default headers include HSTS/CSP/nosniff/frame deny/referrer policy

## Docs

- `docs/step15-observability-alerts.md`
- `docs/step16-hardening-rollout.md`

## Behavior Glossary

The control plane must treat these product meanings as canonical even where the Windows client still sends older compatibility field names:

- `focus episode`
  - The durable unit of user-facing focus time.
  - It is not the same thing as current foreground-app age.
- `pressure`
  - The expressive user-facing overload score.
- `overload active`
  - The conservative stabilized state used for interventions and system actions.
- `short break`
  - The lighter break intervention with shorter recovery.
- `long break`
  - The stronger break intervention with longer recovery.
- `limited`
  - Usable truth is still available, but certainty is reduced by missing channels, trust limits, or runtime constraints.
- `updating`
  - Last known usable value is being shown while fresh analyzed state catches up.

## Legacy Migration Map

The control plane currently receives and stores compatibility transport from `porta-agent-windows-x64`. These mappings must remain explicit until the shared contract is upgraded end to end:

- `taskContinuitySeconds` -> focus-episode duration
- `taskContinuityScore` -> focus-episode quality compatibility signal
- `overloadLikelihood` -> pressure
- `overloadActive` -> overload active
- `stretch_break_suggestion` -> short break
- `break_suggestion` -> long break
- `breakPendingAction` -> break readiness / overlay routing compatibility field
- `breakPendingKind` -> canonical short-break / long-break readiness field

The control plane should preserve backward compatibility for transport and storage, but operator-facing copy and future views should use the canonical names above.

## Boundaries

This repo does not own:

- Windows endpoint capture/tray execution: `porta-agent-windows-x64`
- Operator frontend rendering: `porta-operations-console`
- Shared contracts package: `porta-api-contracts`
