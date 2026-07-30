import type { ChildConversationRecord } from '@kinqs/brainrouter-core/session';

export function childConversationJson(conversations: ChildConversationRecord[]): string {
  return JSON.stringify({ conversations }) + '\n';
}

export function formatChildConversationList(conversations: ChildConversationRecord[]): string {
  if (conversations.length === 0) return 'No child conversations yet.\n';
  const lines = [`Child Conversations (${conversations.length}):`];
  for (const c of conversations) {
    const target = [c.repo, c.branch].filter(Boolean).join('@') || 'workspace';
    lines.push(`  ${c.status.padEnd(6)}  ${c.id}  ${target}  runtime=${c.parentRuntimeId}  model=${c.model || '-'}`);
    if (c.title) lines.push(`    ${c.title}`);
  }
  return lines.join('\n') + '\n';
}
