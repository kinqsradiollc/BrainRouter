# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-05-21

### Added
- **Admin Users Console**: Fully interactive user dashboard at `/users` featuring paginated listings, user creation (via modal), status toggling (enable/disable), API key resets, and deletion with confirmation. Built-in self-protection prevents admins from deleting or disabling their own accounts.
- **Enhanced Memories Hub**: Completely redesigned memories page with a debounced text search, filter chips for classification types (instruction, codebase fact, etc.), status filter toggles (active/archived), inline editing modal, infinite scroll pagination, and checkbox-based bulk actions for administrator pruning/archiving.
- **Expanded Profile Settings**: Added profile display-name editing, masked API key display with quick-copy, rotate API key confirmation flow, and dynamically generated JSON config snippets for copy-pasting to MCP clients (STDIO and HTTP/SSE options).
- **Contradiction Resolution & Badge Count**: Wired up contradiction status filtering ("Open", "Resolved", "All"), visual arbitration controls (resolve/dismiss), and added a real-time pending contradiction badge in the Sidebar navigation.
- **Evidence Management Controls**: Restyled evidence page action triggers to match the theme design system with full kind-based filtering.
- **Theme & Layout Enhancements**: Added an animated golden loading spinner for page-load states, styling rules for premium markdown content, and improved visual styles for UI cards.
- **MCP Onboarding Banner**: Created a dismissible "Connect your MCP client" dashboard banner that displays localized SSE connection variables.
- **Secure Authentication & Guard**: Implemented "Remember Me" session persistence (saving JWT to local storage on select) and added client-side signup password strength validation.
- **Backend Infrastructure Hardening**:
  - Added built-in auth route rate limiting (20 attempts / 15 minutes per IP).
  - Dynamic CORS configuration with `BRAINROUTER_CORS_ORIGIN` env support.
  - Length constraint validation on signup inputs and memory updates.
  - SDK-level `BrainRouterApiError` class for returning descriptive error payloads.

### Fixed
- Fixed Recall Inspector crash on null or undefined potential score rendering.
- Fixed `AuthGuard` loading flash when validating session persistence on initial mount.
- Fixed stale JWT persistence by clearing invalid auth tokens after protected API call failures.
