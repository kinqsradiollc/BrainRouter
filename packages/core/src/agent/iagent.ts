// ADR-041 D4 — IAgent interface.
//
// Hosts (CLI, desktop, MCP server) depend on `IAgent`, not the concrete `Agent`
// class, so the runtime loop can be replaced from a profile (D11) without hosts
// importing the implementation. `Agent` implements `IAgent`; there is no
// behaviour change — this is a typing seam.
//
// This is the minimal host-facing surface (D4a.1): the members the federation
// peer-message adapter depends on. The interface grows as more hosts migrate off
// the concrete class (D4a.2 adds `runTurn` / `getLastBriefing` once their
// callback/option types are relocated out of `agent.ts` to avoid a back-cycle).

import type { InteractionPort } from "@kinqs/brainrouter-agent-protocol";
import type { AccessMode } from "../orchestration/roles/roles.js";
import type {
  SteeringInput,
  PeerSessionSender,
} from "../session/input/inputDelivery.js";

export interface IAgent {
  /** The agent's workspace root (may be entered/attached worktrees under it). */
  readonly workspaceRoot: string;
  /** Interactive prompt capability; absent in headless runtimes. */
  interactionPort?: InteractionPort;
  /** Drain and return the steering inputs queued for the next safe boundary. */
  consumePendingSteering(): SteeringInput[];
  /** Queue a steering input to be applied at the next safe turn boundary. */
  requestSteer(
    text: string,
    options?: {
      id?: string;
      source?: SteeringInput["source"];
      sender?: PeerSessionSender;
      createdAt?: number;
      expiresAt?: number;
    },
  ): SteeringInput;
  /** The agent's current access mode (read / write / …). */
  getAccessMode(): AccessMode;
}
