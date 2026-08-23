-- ADR-043 C7 (D4) — record which egress path each managed-model request took.
--
-- 'server' = the gateway dialed the upstream itself (the default); 'client-tunnel'
-- = the request egressed through the user's own enrolled device. NULL-tolerant:
-- pre-migration rows, and any request where egress selection did not run, keep a
-- null mode. Metadata only — no endpoint URLs or credentials (same stance as the
-- rest of model_usage_events).
ALTER TABLE model_usage_events ADD COLUMN IF NOT EXISTS egress_mode text;
