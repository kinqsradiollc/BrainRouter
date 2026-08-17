// ADR-041 A41-6 — the one memory-store type the engine talks to.
//
// `PostgresMemoryStore` is the only memory store in the product (SQLite is gone,
// ADR-007 Phase 2), and it already implements every capability-store interface —
// but the shared `IMemoryStore` type in `@kinqs/brainrouter-types` knows nothing
// about orgs, providers, connectors, projects, and the rest. Before this seam the
// engine bridged that gap with ~15 scattered `as unknown as XStore` casts, one per
// getter, each an unchecked assertion that the store happens to satisfy XStore.
//
// `IMemoryStoreComposite` is that assertion made once, structurally: the union of
// `IMemoryStore` and every capability interface the engine exposes. Typing the
// engine's `store` field as this composite lets each getter return `this.store`
// directly (tsc-verified), and `PostgresMemoryStore` declares `implements` on the
// same set so a signature drift is a compile error instead of a runtime surprise.
import type { IMemoryStore } from "@kinqs/brainrouter-types";
import type {
  TenancyStore,
  EmailAuthStore,
  OrgPersonaStore,
  MemorySharingStore,
  ProjectStore,
  AdminConsoleStore,
} from "../../tenancy/store.js";
import type { KnowledgeDocumentStore } from "../../knowledge/store.js";
import type { ProviderStore } from "../../providers/store.js";
import type { ModelPolicyStore } from "../../providers/modelPolicyStore.js";
import type { RemoteAccessStore } from "../../remote/store.js";
import type { IntegrationStore } from "../../integrations/store.js";
import type { ConnectorStore } from "../../connectors/store.js";
import type { RefreshSessionStore } from "../../api/routes/identity/refreshSessions.js";

/**
 * The complete capability surface of the backing memory store. Extended by every
 * store implementation ({@link PostgresMemoryStore}) and used as the type of
 * `MemoryEngine.store` so the per-capability getters need no casts.
 */
export interface IMemoryStoreComposite
  extends IMemoryStore,
    TenancyStore,
    EmailAuthStore,
    OrgPersonaStore,
    MemorySharingStore,
    ProjectStore,
    AdminConsoleStore,
    KnowledgeDocumentStore,
    ProviderStore,
    ModelPolicyStore,
    RemoteAccessStore,
    IntegrationStore,
    ConnectorStore {
  /** Liveness probe — a trivial round-trip to the backing store. */
  ping(): Promise<boolean>;
  /** The active embedding dimension (0 if the vector column is unbuilt). */
  getVecDimensions(): number;
  /** Factory for the revocable refresh-session store (ADR-037 B1). */
  refreshSessionStore(): RefreshSessionStore;
}
