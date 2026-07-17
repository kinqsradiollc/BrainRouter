/**
 * Minimal panel-id surface. On the desktop, `panels/index.ts` was a barrel of
 * React panel components; the mobile app routes those surfaces as screens/sheets
 * instead. The ported command core (`domain/commands/commands.ts`) only needs
 * the `PanelId` union (a command can target a panel), so we keep just that here
 * — copied verbatim from the desktop `panels/Panel.tsx` definition.
 */
export type PanelId =
  | 'context'
  | 'files'
  | 'file'
  | 'editor'
  | 'diff'
  | 'terminal'
  | 'tools'
  | 'tasks'
  | 'dashboard'
  | 'plan'
  | 'search'
  | 'schedule'
  | 'worktrees'
  | 'review'
  | 'requirements'
  | 'annotations'
  | 'artifacts'
  | 'ci';
