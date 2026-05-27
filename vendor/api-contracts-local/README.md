# PORTA API Contracts

Shared contracts package for PORTA services.

This repository is the single source of truth for DTOs and OpenAPI specs used by the control-plane and operations console.

## What This Repository Owns

- TypeScript DTO definitions under `src/dtos/`
- Contract validation utilities under `src/utils/`
- OpenAPI specs:
  - `src/openapi/control-plane.yaml`
  - `src/openapi/rollout.yaml`
- Package exports consumed as `@porta/api-contracts`

## Why It Exists

- Prevent schema drift between repos
- Keep wire format deterministic and versioned
- Make CI contract checks enforceable (types/build/client generation/compatibility)

## Versioning Rules

- SemVer is mandatory
- `MAJOR`: breaking schema/contract change
- `MINOR`: additive backward-compatible change
- `PATCH`: non-breaking fixes

For rollout/config flows, `config_seq` remains authoritative for ordering and anti-replay.

## Quick Start

### Prerequisites

- Node.js 20+
- npm

### Install

```bash
npm install
```

### Build

```bash
npm run build
```

### Type-check

```bash
npm run check
```

### Tests

```bash
npm test
```

## Package Output

- Runtime JS: `dist/index.js`
- Type declarations: `dist/index.d.ts`
- Exported package files: `dist/`, `src/openapi/`

## Consumers

- `porta-control-plane` (runtime and API validation)
- `porta-operations-console` (typed API generation and DTO alignment)

## Contract Change Checklist

1. Update DTO/OpenAPI files in this repo.
2. Apply SemVer bump consistent with change type.
3. Rebuild package (`npm run build`).
4. Regenerate downstream clients/types where applicable.
5. Run CI gates (build/types/tests/contracts/compat/client-generation/schema-drift).

## Behavior Glossary

These product meanings are canonical even where current transport or DTO fields still use older compatibility names:

- `focus episode`
  - The durable unit of user-facing focus time.
  - It is not the same thing as current foreground-app age.
- `distraction episode`
  - A tracked, non-idle segment where the user is no longer continuing the same focus episode because they are off-context or in sustained fragmentation.
- `away segment`
  - Idle or away time.
  - It is not the same thing as distraction.
- `pressure`
  - The expressive user-facing overload score.
- `overload active`
  - The conservative stabilized state used for interventions and system actions.
- `short break`
  - The lighter break intervention with shorter recovery.
- `long break`
  - The stronger break intervention with longer recovery.
- `limited`
  - Ari still has usable truth, but certainty is reduced by missing channels, trust limits, or runtime constraints.
- `updating`
  - Ari is showing the last known usable value while fresh analyzed state catches up.

## Legacy Migration Map

These compatibility mappings must stay explicit until downstream repos finish the product migration:

- `taskContinuitySeconds`
  - Legacy machine-summary field currently used as the durable focus timer.
  - Canonical target: `focus episode` duration.
- `taskContinuityScore`
  - Legacy continuity strength field.
  - Canonical target: compatibility input for focus-episode quality until episode-native fields land.
- `overloadLikelihood`
  - Legacy visible overload field.
  - Canonical target: `pressure`.
- `overloadActive`
  - Already close to the final meaning.
  - Canonical target: `overload active`.
- `breakPendingAction`
  - Legacy compatibility field that still carries action IDs such as `stretch_break_suggestion` and `break_suggestion`.
  - Canonical target: short-break or long-break readiness / overlay routing.
- `breakPendingKind`
  - Canonical pending-break kind.
  - Product-facing surfaces should prefer this instead of parsing `breakPendingAction`.
- `stretch_break_suggestion`
  - Legacy action ID for the product-facing `short break`.
- `break_suggestion`
  - Legacy action ID for the product-facing `long break`.

This repo should treat those names as compatibility transport, not final product language.

## Boundaries

This repo does not own:

- Runtime policy execution: `porta-control-plane`
- UI rendering and operator workflows: `porta-operations-console`
- Endpoint signal capture/tray/service runtime: `porta-agent-windows-x64`
