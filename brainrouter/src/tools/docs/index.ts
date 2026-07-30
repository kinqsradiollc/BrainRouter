// Barrel for the `docs` tool domain — re-exports every tool module's
// public surface (schemas + handlers) so callers import one path per domain.
export * from './get_persona.js';
export * from './get_reference.js';
export * from './get_template_doc.js';
export * from './list_template_docs.js';
