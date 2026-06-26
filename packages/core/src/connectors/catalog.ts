import type { ConnectorCatalogEntry, ConnectorFlow, ConnectorSource } from '@kinqs/brainrouter-types';

export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = [
  {
    source: 'github',
    title: 'GitHub',
    description: 'Ingest issues, pull requests, repository files, and permission metadata from one repository, many repositories, or an owner/org.',
    flows: ['load', 'checkpoint', 'slim', 'permission-sync'],
    credentialModes: ['static', 'dynamic', 'oauth'],
    configFields: [
      {
        key: 'owner',
        label: 'Owner or organization',
        type: 'string',
        required: true,
        description: 'GitHub owner, user, or organization name.',
      },
      {
        key: 'repositories',
        label: 'Repositories',
        type: 'string-list',
        description: 'Optional list of repositories under the owner. Empty means all accessible repositories.',
      },
      {
        key: 'includeIssues',
        label: 'Include issues',
        type: 'boolean',
        defaultValue: true,
      },
      {
        key: 'includePullRequests',
        label: 'Include pull requests',
        type: 'boolean',
        defaultValue: true,
      },
      {
        key: 'includeFiles',
        label: 'Include files',
        type: 'boolean',
        defaultValue: false,
      },
      {
        key: 'baseUrl',
        label: 'GitHub base URL',
        type: 'string',
        description: 'Optional GitHub Enterprise API base URL.',
      },
      {
        key: 'pollMinutes',
        label: 'Auto run minutes',
        type: 'number',
        description: 'Optional background polling cadence in minutes. Empty disables scheduled runs.',
      },
    ],
    credentialFields: [
      {
        key: 'token',
        label: 'Access token',
        type: 'secret',
        required: true,
        description: 'GitHub token or GitHub CLI credential with repository read access.',
      },
    ],
  },
  {
    source: 'gitlab',
    title: 'GitLab',
    description: 'Index issues, merge requests, and repository files from GitLab projects or groups.',
    flows: ['load', 'checkpoint', 'slim'],
    credentialModes: ['static', 'oauth'],
    configFields: [
      textField('hostUrl', 'GitLab host URL', 'Optional. Defaults to https://gitlab.com.'),
      textField('owner', 'Group or namespace', 'GitLab group, user, or namespace.'),
      listField('projects', 'Projects', 'Optional project list. Empty means all accessible projects under the namespace.'),
      boolField('includeMergeRequests', 'Include merge requests', true),
      boolField('includeIssues', 'Include issues', true),
      boolField('includeFiles', 'Include files', false),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [secretField('token', 'GitLab token', 'GitLab token with project read access.')],
  },
  {
    source: 'slack',
    title: 'Slack',
    description: 'Index selected channels, threads, and shared files for team/project recall.',
    flows: ['checkpoint', 'slim', 'permission-sync', 'event'],
    credentialModes: ['static', 'oauth'],
    configFields: [
      listField('channels', 'Channels', 'Optional channel names or ids. Empty means all accessible channels.'),
      listField('excludeChannels', 'Excluded channels', 'Channels to skip.'),
      boolField('includeThreads', 'Include threads', true),
      boolField('includeBotMessages', 'Include bot messages', false),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [secretField('botToken', 'Bot token', 'Slack bot token with channel read scopes.')],
  },
  {
    source: 'google-drive',
    title: 'Google Drive',
    description: 'Index Drive folders, shared docs, sheets, and permissions for workspace knowledge.',
    flows: ['load', 'checkpoint', 'slim', 'permission-sync'],
    credentialModes: ['oauth', 'static'],
    configFields: [
      listField('folderIds', 'Folder ids', 'Optional Drive folder ids. Empty means all accessible Drive files.'),
      boolField('includeSharedDrives', 'Include shared drives', true),
      boolField('includeSheets', 'Include spreadsheets', true),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [secretField('serviceAccountJson', 'Service account JSON', 'Service-account JSON or OAuth account reference.')],
  },
  {
    source: 'confluence',
    title: 'Confluence',
    description: 'Index Confluence spaces, pages, comments, and page hierarchy.',
    flows: ['load', 'checkpoint', 'slim', 'permission-sync'],
    credentialModes: ['static', 'oauth'],
    configFields: [
      textField('baseUrl', 'Confluence base URL', 'Cloud or Data Center base URL.'),
      listField('spaces', 'Spaces', 'Optional space keys. Empty means all accessible spaces.'),
      boolField('includeComments', 'Include comments', true),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [secretField('apiToken', 'API token', 'Confluence API token or OAuth account reference.')],
  },
  {
    source: 'jira',
    title: 'Jira',
    description: 'Index Jira projects, issues, comments, labels, and status metadata.',
    flows: ['checkpoint', 'slim', 'permission-sync'],
    credentialModes: ['static', 'oauth'],
    configFields: [
      textField('baseUrl', 'Jira base URL', 'Cloud or Data Center base URL.'),
      listField('projects', 'Projects', 'Optional project keys. Empty means all accessible projects.'),
      textField('jql', 'JQL filter', 'Optional JQL to limit indexed issues.'),
      boolField('includeComments', 'Include comments', true),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [secretField('apiToken', 'API token', 'Jira API token or OAuth account reference.')],
  },
  {
    source: 'filesystem',
    title: 'Filesystem',
    description: 'Index local folders, docs, notes, and generated artifacts from the workspace.',
    flows: ['load', 'checkpoint', 'slim'],
    credentialModes: ['none'],
    configFields: [
      listField('roots', 'Folders', 'Workspace-relative or absolute folders to index.'),
      listField('includeGlobs', 'Include globs', 'Optional glob patterns to include.'),
      listField('excludeGlobs', 'Exclude globs', 'Optional glob patterns to skip.'),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [],
  },
  {
    source: 'web',
    title: 'Web',
    description: 'Index product docs, public sites, sitemap pages, and release notes.',
    flows: ['load', 'checkpoint', 'slim'],
    credentialModes: ['none', 'static'],
    configFields: [
      textField('baseUrl', 'Base URL', 'Website root, docs URL, or sitemap URL.'),
      textField('mode', 'Scrape mode', 'single, recursive, or sitemap.'),
      numberField('depth', 'Max depth', 'Optional recursive crawl depth.'),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [secretField('headerToken', 'Header token', 'Optional token for private documentation sites.')],
  },
  {
    source: 'mcp',
    title: 'MCP Resources',
    description: 'Index resources exposed by a configured MCP tool server.',
    flows: ['checkpoint', 'slim', 'event'],
    credentialModes: ['none'],
    configFields: [
      textField('serverId', 'MCP server id', 'Configured MCP server profile to read resources from.'),
      listField('resourceUris', 'Resource URIs', 'Optional URI allow-list. Empty means list resources first.'),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [],
  },
];

const CATALOG_BY_SOURCE = new Map<ConnectorSource, ConnectorCatalogEntry>(
  CONNECTOR_CATALOG.map((entry) => [entry.source, entry]),
);

export function listConnectorCatalog(): ConnectorCatalogEntry[] {
  return CONNECTOR_CATALOG.map(cloneCatalogEntry);
}

export function getConnectorCatalogEntry(source: ConnectorSource): ConnectorCatalogEntry | undefined {
  const entry = CATALOG_BY_SOURCE.get(source);
  return entry ? cloneCatalogEntry(entry) : undefined;
}

export function connectorSupportsFlow(source: ConnectorSource, flow: ConnectorFlow): boolean {
  return CATALOG_BY_SOURCE.get(source)?.flows.includes(flow) ?? false;
}

function cloneCatalogEntry(entry: ConnectorCatalogEntry): ConnectorCatalogEntry {
  return {
    ...entry,
    flows: [...entry.flows],
    credentialModes: [...entry.credentialModes],
    configFields: entry.configFields.map((field) => ({ ...field })),
    credentialFields: entry.credentialFields.map((field) => ({ ...field })),
  };
}

function textField(key: string, label: string, description?: string): ConnectorCatalogEntry['configFields'][number] {
  return { key, label, type: 'string', description };
}

function listField(key: string, label: string, description?: string): ConnectorCatalogEntry['configFields'][number] {
  return { key, label, type: 'string-list', description };
}

function boolField(key: string, label: string, defaultValue: boolean): ConnectorCatalogEntry['configFields'][number] {
  return { key, label, type: 'boolean', defaultValue };
}

function numberField(key: string, label: string, description?: string): ConnectorCatalogEntry['configFields'][number] {
  return { key, label, type: 'number', description };
}

function secretField(key: string, label: string, description?: string): ConnectorCatalogEntry['credentialFields'][number] {
  return { key, label, type: 'secret', required: true, description };
}
