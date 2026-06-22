/**
 * The network contract. We reuse `@kinqs/brainrouter-agent-protocol` VERBATIM
 * as the wire vocabulary between the mobile client and `brainrouter-host`
 * (technical-doc.md §1, §6): it is transport-agnostic, has zero runtime deps
 * (RN-safe), and its `EventEnvelope.seq` exists for gap detection over lossy
 * transports. This module is the single place the app imports protocol types,
 * so a future protocol bump touches one file.
 */
export * from '@kinqs/brainrouter-agent-protocol';
