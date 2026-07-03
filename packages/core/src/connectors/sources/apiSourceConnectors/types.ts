import type { ConnectorCheckpoint, ConnectorDocument } from '@kinqs/brainrouter-types';

export interface SlackConnectorChannel {
  id: string;
  name: string;
}

export interface SlackConnectorMessage {
  channelId: string;
  channelName?: string;
  ts: string;
  text?: string;
  user?: string;
  permalink?: string;
  threadTs?: string;
  replies?: SlackConnectorMessage[];
}

export interface SlackConnectorClient {
  listChannels(opts?: { include?: string[]; exclude?: string[]; limit?: number }): Promise<SlackConnectorChannel[]>;
  listMessages(channel: SlackConnectorChannel, opts?: { since?: string; includeThreads?: boolean; includeBotMessages?: boolean }): Promise<SlackConnectorMessage[]>;
}

export interface JiraConnectorIssue {
  key: string;
  summary: string;
  description?: string;
  status?: string;
  url?: string;
  updatedAt?: string;
  labels?: string[];
  assignee?: string;
  comments?: Array<{ author?: string; body: string; updatedAt?: string }>;
}

export interface JiraConnectorClient {
  listIssues(opts: { projects: string[]; jql?: string; since?: string; includeComments?: boolean }): Promise<JiraConnectorIssue[]>;
}

export interface ConfluenceConnectorPage {
  id: string;
  title: string;
  space?: string;
  url?: string;
  updatedAt?: string;
  body?: string;
  comments?: Array<{ author?: string; body: string; updatedAt?: string }>;
}

export interface ConfluenceConnectorClient {
  listPages(opts: { spaces: string[]; since?: string; includeComments?: boolean }): Promise<ConfluenceConnectorPage[]>;
}

export interface NotionConnectorPage {
  id: string;
  title: string;
  url?: string;
  updatedAt?: string;
  parent?: string;
  body?: string;
  comments?: Array<{ author?: string; body: string; updatedAt?: string }>;
}

export interface NotionConnectorClient {
  listPages(opts: { databaseIds: string[]; since?: string; includeComments?: boolean }): Promise<NotionConnectorPage[]>;
}

export interface LinearConnectorIssue {
  id: string;
  identifier?: string;
  title: string;
  description?: string;
  state?: string;
  url?: string;
  updatedAt?: string;
  teamKey?: string;
  assignee?: string;
  comments?: Array<{ author?: string; body: string; updatedAt?: string }>;
}

export interface LinearConnectorClient {
  listIssues(opts: { teamKeys: string[]; since?: string; includeArchived?: boolean; includeComments?: boolean }): Promise<LinearConnectorIssue[]>;
}

export interface ApiConnectorRunResult {
  documents: ConnectorDocument[];
  checkpoint: ConnectorCheckpoint;
  failures: string[];
}

export interface ApiConnectorRunOptions {
  now?: string;
  maxItems?: number;
}

export interface TokenClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}
