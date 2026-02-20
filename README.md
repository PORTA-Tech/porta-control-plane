# porta-control-plane

Backend-first fleet control plane (Phase 8A).

## Scope
- Deterministic node identity
- Signed config envelope validation
- Monotonic `config_seq` anti-replay
- Immutable append-only audit ledger (hash chained)
- Rollout state machine + operator API

## Run
1. `npm install`
2. `npm run dev`

Default port: `8787`
