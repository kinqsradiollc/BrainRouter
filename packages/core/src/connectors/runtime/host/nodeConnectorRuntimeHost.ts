import type { ConnectorRuntimeHost } from './contracts.js';

export const nodeConnectorRuntimeHost: ConnectorRuntimeHost = {
  environmentValue: (name) => process.env[name],
  currentWorkingDirectory: () => process.cwd(),
};
