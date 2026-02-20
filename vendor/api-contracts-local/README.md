# porta-api-contracts

Shared DTOs and OpenAPI contracts for PORTA Fleet Control Plane.

## Scope
- Single source of truth for API/data shapes used by `porta-control-plane` and `porta-operations-console`
- DTOs for config envelopes, rollout state, SLO metrics, audit events, and node identity
- OpenAPI specs for control-plane and rollout endpoints

## Versioning
- `config_seq` is authoritative for ordering and anti-replay
- Breaking contract changes: major version
- Additive backward-compatible changes: minor version
- Non-schema/documentation fixes: patch version

## OpenAPI Files
- `src/openapi/control-plane.yaml`
- `src/openapi/rollout.yaml`
