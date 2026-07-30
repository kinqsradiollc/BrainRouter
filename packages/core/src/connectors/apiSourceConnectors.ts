// Barrel: per-provider API source connectors split into cohesive modules.
// Public surface is preserved verbatim via these re-exports.
export type {
  SlackConnectorChannel,
  SlackConnectorMessage,
  SlackConnectorClient,
  JiraConnectorIssue,
  JiraConnectorClient,
  ConfluenceConnectorPage,
  ConfluenceConnectorClient,
  NotionConnectorPage,
  NotionConnectorClient,
  LinearConnectorIssue,
  LinearConnectorClient,
  ApiConnectorRunResult,
  ApiConnectorRunOptions,
  TokenClientOptions,
} from './apiSourceConnectors/types.js';

export { runSlackConnectorCheckpoint, slackTokenClient } from './apiSourceConnectors/slack.js';
export { runJiraConnectorCheckpoint, jiraTokenClient } from './apiSourceConnectors/jira.js';
export { runConfluenceConnectorCheckpoint, confluenceTokenClient } from './apiSourceConnectors/confluence.js';
export { runNotionConnectorCheckpoint, notionTokenClient } from './apiSourceConnectors/notion.js';
export { runLinearConnectorCheckpoint, linearTokenClient } from './apiSourceConnectors/linear.js';
