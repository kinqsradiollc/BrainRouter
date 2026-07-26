---
name: authorization-boundary-skill
description: Implement or review backend authentication, authorization, tenancy, secret, and untrusted-input boundaries without trusting caller-supplied identity or scope.
allowed-tools: [read_file, list_dir, grep_search, glob_files, edit_file, apply_patch, run_command]
---

# Authorization and trust boundaries

## Overview

Derive identity and scope from a trusted server context, then authorize the
specific action against the specific resource. Authentication proves a caller;
authorization decides whether that caller may perform this operation here.

## When to Use

Use for login, sessions, tokens, API keys, RBAC, permissions, organization or
tenant scope, ownership checks, secret handling, webhooks, uploads, and any
boundary that accepts untrusted data.

## Workflow

1. Map trust boundaries from ingress to side effect. Mark which identity,
   tenant, role, resource, and policy values are server-derived versus
   caller-controlled.
2. Authenticate once at the boundary using the established mechanism. Reject
   ambiguous, expired, malformed, replayed, or wrong-audience credentials
   without exposing secret material.
3. Authorize the exact action and resource after loading server-trusted scope.
   Apply deny-first behavior and prevent confused-deputy or cross-tenant paths.
4. Validate and cap untrusted text, paths, URLs, filenames, identifiers, and
   structured payloads before parsing, lookup, logging, or persistence.
5. Keep secrets write-only and redact them from errors, logs, traces, caches,
   prompts, analytics, and returned configuration.
6. Test allowed, denied, missing, malformed, stale, replayed, and cross-scope
   cases at the real boundary.

## Verification

- [ ] Identity, tenant, and privileged scope are server-derived.
- [ ] Authorization checks action plus resource, not role name alone.
- [ ] Denies and explicit revocations win over grants and defaults.
- [ ] Untrusted inputs are bounded before expensive or sensitive work.
- [ ] Secrets cannot appear in output, logs, traces, or persisted diagnostics.

## Red Flags

- Trusting `userId`, `orgId`, role, or ownership supplied in a request body.
- Checking authentication but not resource authorization.
- Logging full headers, tokens, connection strings, or raw untrusted payloads.
- A fallback path that bypasses the normal policy chokepoint.
