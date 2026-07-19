# Team spaces and explicit sharing

**Status:** Approved for implementation (2026-07-16)

## Problem

BrainRouter currently treats every team as a subgroup inside the active organization. That leaves no safe way to model a personal collaboration group whose members belong to different organizations. It also creates two authorization defects:

1. an organization team can currently receive an arbitrary user ID even when that user is not an organization member; and
2. meeting reads treat every `team`-scoped meeting in an organization as visible to every organization member, without checking membership in the selected team.

## Model

BrainRouter has two explicit team kinds:

| Kind | Container | Eligible members | Administrative override | Sharing boundary |
|---|---|---|---|---|
| Organization team | Exactly one organization | Active members of that organization | Organization owner/admin and deployment admin | Resources from that same organization only |
| Personal team | One owning user; no organization container | Any active registered BrainRouter user | Team owner/admin only; organization admins have no override | Explicitly granted resources from any organization the grantor owns |

Personal organizations remain the default private workspace created for each user. They are not used as a shortcut for personal-team membership: joining a personal team must never add a user to an organization or expose organization-wide resources.

## Authorization invariants

- Every team has one kind and at least one owner member.
- Organization-team members must remain active members of the containing organization.
- Personal-team members only need an active BrainRouter account.
- A caller may see a personal team only when they are a member of it.
- Organization admins may see and manage organization teams in their active organization even when they are not team members.
- Organization admins have no special access to personal teams.
- Team admins cannot grant or remove the owner role. The last owner cannot be demoted, removed, or leave.
- Members may leave a team themselves unless they are its last owner.
- Removing a member revokes team-derived resource access immediately.
- Deleting a team atomically makes meetings shared only to that team private again.
- An organization meeting may be shared to an organization team only when both have the same `org_id`.
- A meeting may be shared to a personal team the meeting owner belongs to. Recipients receive only that meeting, not its organization.
- Team-scoped meeting list/detail/overview/transcript access always requires membership in the selected team.
- Organization-scoped and public-in-organization meeting reads remain constrained to the active organization. Anonymous access remains possible only through an active public share token.

## API contract

- `GET /api/teams` returns personal teams for the caller plus organization teams in the active organization. Organization admins receive all organization teams; other callers receive teams they belong to.
- `GET /api/orgs` exposes `isPersonal` so clients can distinguish a user's private workspace from a shared organization.
- `POST /api/teams { name, kind }` creates an `organization` (default, backward compatible) or `personal` team. Organization-team creation is rejected while the active workspace is personal.
- Team objects expose `kind`, nullable `orgId`, optional `orgName`, `ownerUserId`, `currentUserId`, the caller's `myRole`, and `canManage`.
- `POST /api/teams/:id/members` accepts `userId` or registered-account `email`. Organization-team targets must already belong to the organization.
- Existing detail, remove-member, and delete routes remain compatible. A member may remove themself unless they are the last owner. If the primary owner of a personal team leaves or is demoted after another owner exists, primary ownership transfers to another actual owner.

## UX contract

- Dashboard and desktop show separate Personal teams and Organization teams sections.
- Team creation makes the kind an explicit choice and explains its access consequences before creation.
- A personal workspace disables Organization-team creation and directs the user to select or create a shared organization first.
- Each selected team shows its kind, organization (when relevant), caller role, membership rule, and management boundary.
- Member entry accepts user ID or email and provides an organization-specific error when the account is not an organization member.
- Membership lists identify the current account and provide a capability-aware Leave action while protecting the last owner.
- Meeting share pickers label personal and organization destinations so cross-organization sharing is never ambiguous.
- A meeting shared through a personal team appears in a member's meeting list regardless of their active organization, labeled as team-shared; it never appears as organization-wide content.

## Compatibility and migration

- Existing teams in shared organizations backfill as `organization` teams.
- Legacy teams whose container is a personal workspace normalize to `personal` teams owned by their creator. The creator is guaranteed an owner membership during normalization.
- Existing API clients that omit `kind` continue creating organization teams only in shared organizations; personal workspaces return a conflict instead of creating an invalid organization team.
- Existing meeting `team_id` values remain valid. Team access becomes narrower and correct: only team members retain access.
- Migration is additive except for making `teams.org_id` nullable for personal teams. Constraints enforce valid kind/container combinations.

## Definition of done

- Query and route tests cover both team kinds, cross-org eligibility, admin boundaries, owner lifecycle, deletion cleanup, and meeting member/nonmember reads.
- Dashboard and desktop types, create/manage surfaces, and share pickers handle both kinds.
- Desktop account-backed requests carry an explicit resolved organization header.
- Backend, dashboard, desktop, root typechecks, targeted tests, and live signed-in UI smoke tests are green.
