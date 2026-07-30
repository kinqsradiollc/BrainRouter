/** Built-in extension: deterministic meeting-summary formatting. */
import {
  formatMeetingSummary,
  MEETING_SUMMARY_FORMAT_TOOL,
} from '../../dist/extension/meetingSummary.js';

export function activate(host) {
  host.registerTool({
    name: MEETING_SUMMARY_FORMAT_TOOL.name,
    description: MEETING_SUMMARY_FORMAT_TOOL.description,
    inputSchema: MEETING_SUMMARY_FORMAT_TOOL.parameters,
    accessTier: 'read',
    actionKind: 'read_only',
    parallelSafe: true,
    handle: (args) => JSON.stringify(formatMeetingSummary(args)),
  });
  host.log('meeting-summary: registered format_meeting_summary');
}
