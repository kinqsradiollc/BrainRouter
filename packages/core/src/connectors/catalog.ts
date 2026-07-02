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
    flows: ['checkpoint', 'slim'],
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
    description: 'Index Drive folders, shared docs, and sheets for workspace knowledge.',
    flows: ['load', 'checkpoint', 'slim'],
    credentialModes: ['static', 'oauth'],
    configFields: [
      listField('folderIds', 'Folder ids', 'Optional Drive folder ids. Empty means all accessible Drive files.'),
      boolField('includeSharedDrives', 'Include shared drives', true),
      boolField('includeSheets', 'Include spreadsheets', true),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [secretField('token', 'Access token', 'Google OAuth access token or account reference.')],
  },
  {
    source: 'confluence',
    title: 'Confluence',
    description: 'Index Confluence spaces, pages, comments, and page hierarchy.',
    flows: ['load', 'checkpoint', 'slim'],
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
    flows: ['checkpoint', 'slim'],
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
    flows: ['checkpoint', 'slim'],
    credentialModes: ['none'],
    configFields: [
      textField('serverId', 'MCP server id', 'Configured MCP server profile to read resources from.'),
      listField('resourceUris', 'Resource URIs', 'Optional URI allow-list. Empty means list resources first.'),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [],
  },
  // ── Catalog-stage connectors (config schemas defined; ingest runtime staged,
  //    same as the existing non-GitHub sources). Brings the picker to parity
  //    with common knowledge/work sources. ──
  {
    source: 'notion',
    title: 'Notion',
    description: 'Index Notion pages, databases, and wikis for search and recall.',
    flows: ['load', 'checkpoint', 'slim'],
    credentialModes: ['static', 'oauth'],
    configFields: [
      listField('databaseIds', 'Database ids', 'Optional database ids. Empty means all accessible pages and databases.'),
      boolField('includeComments', 'Include comments', false),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [secretField('token', 'Integration token', 'Notion internal integration token (or OAuth account reference).')],
  },
  {
    source: 'linear',
    title: 'Linear',
    description: 'Index Linear issues, projects, and comments.',
    flows: ['load', 'checkpoint', 'slim'],
    credentialModes: ['static', 'oauth'],
    configFields: [
      listField('teamKeys', 'Teams', 'Optional team keys. Empty means all accessible teams.'),
      boolField('includeComments', 'Include comments', true),
      boolField('includeArchived', 'Include archived', false),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [secretField('apiKey', 'API key', 'Linear personal API key (or OAuth account reference).')],
  },
  {
    source: 'asana',
    title: 'Asana',
    description: 'Index Asana projects, tasks, and comments.',
    flows: ['load', 'checkpoint', 'slim'],
    credentialModes: ['static', 'oauth'],
    configFields: [
      listField('projectIds', 'Projects', 'Optional project ids. Empty means all accessible projects in the workspace.'),
      boolField('includeComments', 'Include comments', true),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [secretField('token', 'Personal access token', 'Asana personal access token (or OAuth account reference).')],
  },
  {
    source: 'clickup',
    title: 'ClickUp',
    description: 'Index ClickUp spaces, lists, and tasks.',
    flows: ['load', 'checkpoint', 'slim'],
    credentialModes: ['static'],
    configFields: [
      listField('spaceIds', 'Spaces', 'Optional space ids. Empty means all accessible spaces in the workspace.'),
      boolField('includeComments', 'Include comments', true),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [secretField('token', 'API token', 'ClickUp personal API token.')],
  },
  {
    source: 'discord',
    title: 'Discord',
    description: 'Index Discord channels and threads for team recall.',
    flows: ['checkpoint', 'slim', 'event'],
    credentialModes: ['static'],
    configFields: [
      listField('channels', 'Channels', 'Optional channel ids. Empty means all accessible channels in the server.'),
      boolField('includeThreads', 'Include threads', true),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [secretField('botToken', 'Bot token', 'Discord bot token with read access to the server.')],
  },
  {
    source: 'teams',
    title: 'Microsoft Teams',
    description: 'Index Microsoft Teams channels and chats.',
    flows: ['checkpoint', 'slim', 'permission-sync'],
    credentialModes: ['oauth', 'static'],
    configFields: [
      listField('teamIds', 'Teams', 'Optional team ids. Empty means all accessible teams.'),
      boolField('includeChats', 'Include 1:1 / group chats', false),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [secretField('token', 'Graph token', 'Microsoft Graph token or OAuth account reference.')],
  },
  {
    source: 'dropbox',
    title: 'Dropbox',
    description: 'Index Dropbox files and folders.',
    flows: ['load', 'checkpoint', 'slim'],
    credentialModes: ['oauth', 'static'],
    configFields: [
      listField('paths', 'Paths', 'Optional folder paths. Empty means the full accessible Dropbox.'),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [secretField('token', 'Access token', 'Dropbox access token or OAuth account reference.')],
  },
  {
    source: 'sharepoint',
    title: 'SharePoint',
    description: 'Index SharePoint sites, libraries, and documents.',
    flows: ['load', 'checkpoint', 'slim', 'permission-sync'],
    credentialModes: ['oauth', 'static'],
    configFields: [
      listField('siteUrls', 'Sites', 'Optional site URLs. Empty means all accessible sites.'),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [secretField('token', 'Graph token', 'Microsoft Graph token or OAuth account reference.')],
  },
  {
    source: 'hubspot',
    title: 'HubSpot',
    description: 'Index HubSpot contacts, companies, deals, and tickets.',
    flows: ['load', 'checkpoint', 'slim'],
    credentialModes: ['static', 'oauth'],
    configFields: [
      listField('objectTypes', 'Object types', 'Optional CRM object types (contacts, companies, deals, tickets). Empty means all.'),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [secretField('token', 'Private app token', 'HubSpot private-app access token (or OAuth account reference).')],
  },
  {
    source: 'salesforce',
    title: 'Salesforce',
    description: 'Index Salesforce objects, knowledge articles, and cases.',
    flows: ['load', 'checkpoint', 'slim', 'permission-sync'],
    credentialModes: ['oauth', 'static'],
    configFields: [
      textField('instanceUrl', 'Instance URL', 'Your Salesforce instance URL, e.g. https://your-org.my.salesforce.com.'),
      listField('objects', 'Objects', 'Optional SObject names (Account, Case, Knowledge__kav, …). Empty means a sensible default set.'),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [secretField('token', 'Access token', 'Salesforce OAuth access token or account reference.')],
  },
  {
    source: 'zendesk',
    title: 'Zendesk',
    description: 'Index Zendesk help-center articles and tickets.',
    flows: ['load', 'checkpoint', 'slim'],
    credentialModes: ['static'],
    configFields: [
      textField('subdomain', 'Subdomain', 'Your Zendesk subdomain, e.g. acme (for acme.zendesk.com).'),
      boolField('includeTickets', 'Include tickets', true),
      boolField('includeArticles', 'Include help-center articles', true),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [secretField('apiToken', 'API token', 'Zendesk API token (used with your agent email).')],
  },
  {
    source: 'airtable',
    title: 'Airtable',
    description: 'Index Airtable bases, tables, and records.',
    flows: ['load', 'checkpoint', 'slim'],
    credentialModes: ['static'],
    configFields: [
      listField('baseIds', 'Bases', 'Optional base ids. Empty means all accessible bases.'),
      listField('tables', 'Tables', 'Optional table names to limit to.'),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [secretField('token', 'Personal access token', 'Airtable personal access token with data.read scope.')],
  },
  {
    source: 'bitbucket',
    title: 'Bitbucket',
    description: 'Index Bitbucket repositories, pull requests, and issues.',
    flows: ['load', 'checkpoint', 'slim'],
    credentialModes: ['static'],
    configFields: [
      textField('workspace', 'Workspace', 'Bitbucket workspace id.'),
      listField('repositories', 'Repositories', 'Optional repo slugs. Empty means all accessible repos in the workspace.'),
      boolField('includePullRequests', 'Include pull requests', true),
      boolField('includeFiles', 'Include files', false),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [secretField('token', 'App password / token', 'Bitbucket app password or access token with repo read.')],
  },
  {
    source: 'gitbook',
    title: 'GitBook',
    description: 'Index GitBook spaces and pages.',
    flows: ['load', 'checkpoint', 'slim'],
    credentialModes: ['static'],
    configFields: [
      listField('spaceIds', 'Spaces', 'Optional space ids. Empty means all accessible spaces.'),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [secretField('token', 'API token', 'GitBook API token.')],
  },
  {
    source: 'discourse',
    title: 'Discourse',
    description: 'Index Discourse forum topics and posts.',
    flows: ['load', 'checkpoint', 'slim'],
    credentialModes: ['static', 'none'],
    configFields: [
      textField('baseUrl', 'Forum URL', 'Discourse forum base URL, e.g. https://forum.example.com.'),
      listField('categories', 'Categories', 'Optional category slugs. Empty means all public categories.'),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [secretField('apiKey', 'API key', 'Optional Discourse API key for private categories.')],
  },
  {
    source: 'gmail',
    title: 'Gmail',
    description: 'Index Gmail threads and messages.',
    flows: ['load', 'checkpoint', 'slim'],
    credentialModes: ['static', 'oauth'],
    configFields: [
      textField('query', 'Search query', 'Optional Gmail search query (e.g. label:work). Empty means the inbox.'),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [secretField('token', 'Access token', 'Google OAuth access token with Gmail read scope.')],
  },
  {
    source: 's3',
    title: 'Amazon S3',
    description: 'Index documents stored in an S3 bucket (also R2 / GCS-compatible).',
    flows: ['load', 'checkpoint', 'slim'],
    credentialModes: ['static'],
    configFields: [
      textField('bucket', 'Bucket', 'S3 bucket name.'),
      textField('prefix', 'Prefix', 'Optional key prefix to limit ingestion.'),
      textField('endpoint', 'Endpoint', 'Optional custom endpoint for R2 / MinIO / GCS-compatible storage.'),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [secretField('credentials', 'Access keys', 'accessKeyId/secretAccessKey JSON or a credential reference.')],
  },
  {
    source: 'gong',
    title: 'Gong',
    description: 'Index Gong call transcripts and highlights.',
    flows: ['load', 'checkpoint', 'slim'],
    credentialModes: ['static'],
    configFields: [
      numberField('lookbackDays', 'Lookback days', 'How many days of calls to ingest.'),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [secretField('token', 'Access key', 'Gong access key / secret reference.')],
  },
  {
    source: 'fireflies',
    title: 'Fireflies',
    description: 'Index Fireflies meeting transcripts and summaries.',
    flows: ['load', 'checkpoint', 'slim'],
    credentialModes: ['static'],
    configFields: [
      numberField('lookbackDays', 'Lookback days', 'How many days of meetings to ingest.'),
      numberField('pollMinutes', 'Auto run minutes', 'Optional background polling cadence in minutes.'),
    ],
    credentialFields: [secretField('apiKey', 'API key', 'Fireflies API key.')],
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
