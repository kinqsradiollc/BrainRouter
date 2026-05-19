# Frontend Pagination & Infinite Scroll Implementation

The backend API was recently updated to support cursor-based pagination. The frontend `dashboard` now needs to be wired up to use this functionality to allow users to load more records without refreshing the page.

## Proposed Changes

### 1. Update Custom Hooks (`packages/hooks/src`)
Currently, hooks like `useMemories`, `useUsers`, `useScenes`, and `useContradictions` fetch the first page and replace the state.
We need to update them to:
- Store a `nextCursor` string and `hasMore` boolean in state.
- Expose a `loadMore` function that calls the SDK `client.get*` methods with `{ cursor: nextCursor }`.
- When the API returns, *append* the new records to the existing array rather than overwriting it.

### 2. Update UI Pages (`dashboard/app`)
In the following pages:
- `users/page.tsx`
- `memories/page.tsx`
- `scenes/page.tsx`
- `contradictions/page.tsx`

We need to:
- Render a **"Load More"** `<PremiumButton>` at the bottom of the table if `hasMore` is true.
- Add a loading state (e.g., `isFetchingMore`) to disable the button and show a spinner while data is being fetched.
- Ensure the Framer Motion `AnimatePresence` layout continues to cleanly animate newly appended rows into the table.

## Verification Plan

### Automated Tests
- Ensure `dashboard` passes `npm run build` with no type errors after refactoring the hooks.

### Manual Verification
- Go to `/memories` in the dashboard, scroll to the bottom of the table, and click "Load More".
- Verify that new memories appear smoothly and the old ones remain visible.
- Verify that the "Load More" button disappears when there are no more records to load (`hasMore === false`).
