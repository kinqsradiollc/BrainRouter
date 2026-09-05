<!-- GENERATED FILE — do not edit by hand.
     Source: packages/core/src/diagram/schema.ts (zod) via diagramJsonSchemas().
     Regenerate: REGEN_CATALOG=1 npm --workspace packages/core test -- diagram-schema-drift
     Drift-checked by packages/core/src/tests/diagram-schema-drift.test.ts (ADR-056 D-A1). -->

# BrainRouter diagram IR

Schema version 1. 5 kinds; every object level rejects unknown fields (`additionalProperties: false`).

## `architecture`

| Field | Type | Required |
|-------|------|----------|
| `boundaries` | array<object> | no |
| `components` | array<object> | yes |
| `connections` | array<object> | yes |
| `kind` | `"architecture"` | yes |
| `mainPath` | array<string (pattern)> | no |
| `meta` | object | yes |
| `schemaVersion` | `1` | yes |

### `architecture.boundaries` (array items)

| Field | Type | Required |
|-------|------|----------|
| `id` | string (pattern) | yes |
| `kind` | `"trust"` \| `"network"` \| `"region"` \| `"group"` | no |
| `label` | string | yes |
| `wraps` | array<string (pattern)> | yes |

### `architecture.components` (array items)

| Field | Type | Required |
|-------|------|----------|
| `column` | integer | no |
| `description` | string | no |
| `evidence` | `"authored"` \| `"verified"` \| `"unverified"` | no |
| `id` | string (pattern) | yes |
| `label` | string | yes |
| `row` | integer | no |
| `sources` | array<object> | no |
| `type` | `"frontend"` \| `"backend"` \| `"database"` \| `"cloud"` \| `"security"` \| `"messagebus"` \| `"external"` | yes |
| `variant` | `"default"` \| `"emphasis"` \| `"security"` \| `"dashed"` | no |

### `architecture.connections` (array items)

| Field | Type | Required |
|-------|------|----------|
| `description` | string | no |
| `direction` | `"forward"` \| `"both"` | no |
| `evidence` | `"authored"` \| `"verified"` \| `"unverified"` | no |
| `from` | string (pattern) | yes |
| `id` | string (pattern) | yes |
| `label` | string | yes |
| `sources` | array<object> | no |
| `style` | `"sync"` \| `"async"` \| `"data"` | no |
| `to` | string (pattern) | yes |

### `architecture.meta`

| Field | Type | Required |
|-------|------|----------|
| `qualityProfile` | `"standard"` \| `"showcase"` | no |
| `repository` | object | no |
| `subtitle` | string | no |
| `theme` | `"auto"` \| `"dark"` \| `"light"` | no |
| `title` | string | yes |
| `views` | array<object> | no |

## `workflow`

| Field | Type | Required |
|-------|------|----------|
| `edges` | array<object> | yes |
| `kind` | `"workflow"` | yes |
| `lanes` | array<object> | no |
| `mainPath` | array<string (pattern)> | no |
| `meta` | object | yes |
| `nodes` | array<object> | yes |
| `schemaVersion` | `1` | yes |

### `workflow.edges` (array items)

| Field | Type | Required |
|-------|------|----------|
| `description` | string | no |
| `evidence` | `"authored"` \| `"verified"` \| `"unverified"` | no |
| `from` | string (pattern) | yes |
| `id` | string (pattern) | yes |
| `label` | string | yes |
| `sources` | array<object> | no |
| `to` | string (pattern) | yes |

### `workflow.lanes` (array items)

| Field | Type | Required |
|-------|------|----------|
| `id` | string (pattern) | yes |
| `label` | string | yes |

### `workflow.meta`

| Field | Type | Required |
|-------|------|----------|
| `qualityProfile` | `"standard"` \| `"showcase"` | no |
| `repository` | object | no |
| `subtitle` | string | no |
| `theme` | `"auto"` \| `"dark"` \| `"light"` | no |
| `title` | string | yes |
| `views` | array<object> | no |

### `workflow.nodes` (array items)

| Field | Type | Required |
|-------|------|----------|
| `description` | string | no |
| `evidence` | `"authored"` \| `"verified"` \| `"unverified"` | no |
| `id` | string (pattern) | yes |
| `label` | string | yes |
| `lane` | string (pattern) | no |
| `shape` | `"step"` \| `"decision"` \| `"start"` \| `"end"` \| `"tool"` | no |
| `sources` | array<object> | no |

## `sequence`

| Field | Type | Required |
|-------|------|----------|
| `activations` | array<object> | no |
| `kind` | `"sequence"` | yes |
| `messages` | array<object> | yes |
| `meta` | object | yes |
| `participants` | array<object> | yes |
| `schemaVersion` | `1` | yes |

### `sequence.activations` (array items)

| Field | Type | Required |
|-------|------|----------|
| `fromMessage` | string (pattern) | yes |
| `participant` | string (pattern) | yes |
| `toMessage` | string (pattern) | yes |

### `sequence.messages` (array items)

| Field | Type | Required |
|-------|------|----------|
| `description` | string | no |
| `evidence` | `"authored"` \| `"verified"` \| `"unverified"` | no |
| `from` | string (pattern) | yes |
| `id` | string (pattern) | yes |
| `kind` | `"sync"` \| `"async"` \| `"return"` | no |
| `label` | string | yes |
| `sources` | array<object> | no |
| `to` | string (pattern) | yes |

### `sequence.meta`

| Field | Type | Required |
|-------|------|----------|
| `qualityProfile` | `"standard"` \| `"showcase"` | no |
| `repository` | object | no |
| `subtitle` | string | no |
| `theme` | `"auto"` \| `"dark"` \| `"light"` | no |
| `title` | string | yes |
| `views` | array<object> | no |

### `sequence.participants` (array items)

| Field | Type | Required |
|-------|------|----------|
| `description` | string | no |
| `evidence` | `"authored"` \| `"verified"` \| `"unverified"` | no |
| `id` | string (pattern) | yes |
| `label` | string | yes |
| `sources` | array<object> | no |
| `type` | `"frontend"` \| `"backend"` \| `"database"` \| `"cloud"` \| `"security"` \| `"messagebus"` \| `"external"` | no |

## `dataflow`

| Field | Type | Required |
|-------|------|----------|
| `flows` | array<object> | yes |
| `kind` | `"dataflow"` | yes |
| `meta` | object | yes |
| `nodes` | array<object> | yes |
| `schemaVersion` | `1` | yes |
| `stages` | array<object> | no |

### `dataflow.flows` (array items)

| Field | Type | Required |
|-------|------|----------|
| `description` | string | no |
| `evidence` | `"authored"` \| `"verified"` \| `"unverified"` | no |
| `from` | string (pattern) | yes |
| `id` | string (pattern) | yes |
| `label` | string | yes |
| `sources` | array<object> | no |
| `to` | string (pattern) | yes |

### `dataflow.meta`

| Field | Type | Required |
|-------|------|----------|
| `qualityProfile` | `"standard"` \| `"showcase"` | no |
| `repository` | object | no |
| `subtitle` | string | no |
| `theme` | `"auto"` \| `"dark"` \| `"light"` | no |
| `title` | string | yes |
| `views` | array<object> | no |

### `dataflow.nodes` (array items)

| Field | Type | Required |
|-------|------|----------|
| `description` | string | no |
| `evidence` | `"authored"` \| `"verified"` \| `"unverified"` | no |
| `id` | string (pattern) | yes |
| `label` | string | yes |
| `sources` | array<object> | no |
| `stage` | string (pattern) | no |
| `type` | `"frontend"` \| `"backend"` \| `"database"` \| `"cloud"` \| `"security"` \| `"messagebus"` \| `"external"` | no |

### `dataflow.stages` (array items)

| Field | Type | Required |
|-------|------|----------|
| `id` | string (pattern) | yes |
| `label` | string | yes |

## `lifecycle`

| Field | Type | Required |
|-------|------|----------|
| `kind` | `"lifecycle"` | yes |
| `meta` | object | yes |
| `schemaVersion` | `1` | yes |
| `states` | array<object> | yes |
| `transitions` | array<object> | yes |

### `lifecycle.meta`

| Field | Type | Required |
|-------|------|----------|
| `qualityProfile` | `"standard"` \| `"showcase"` | no |
| `repository` | object | no |
| `subtitle` | string | no |
| `theme` | `"auto"` \| `"dark"` \| `"light"` | no |
| `title` | string | yes |
| `views` | array<object> | no |

### `lifecycle.states` (array items)

| Field | Type | Required |
|-------|------|----------|
| `description` | string | no |
| `evidence` | `"authored"` \| `"verified"` \| `"unverified"` | no |
| `id` | string (pattern) | yes |
| `label` | string | yes |
| `sources` | array<object> | no |
| `type` | `"initial"` \| `"active"` \| `"waiting"` \| `"terminal"` \| `"failure"` | no |

### `lifecycle.transitions` (array items)

| Field | Type | Required |
|-------|------|----------|
| `description` | string | no |
| `evidence` | `"authored"` \| `"verified"` \| `"unverified"` | no |
| `from` | string (pattern) | yes |
| `id` | string (pattern) | yes |
| `label` | string | yes |
| `sources` | array<object> | no |
| `to` | string (pattern) | yes |
