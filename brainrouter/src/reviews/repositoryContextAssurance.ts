/**
 * Compatibility entrypoint for exact-revision repository-context assurance.
 *
 * The implementation is split by contract, coverage, prompt, and lifecycle
 * concern under `repository-context/`; maintained callers keep this stable
 * import while the backend ownership migration proceeds.
 */

export * from "./repository-context/contracts.js";
export * from "./repository-context/session.js";
