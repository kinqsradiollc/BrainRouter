/** Privileged process context required by the connector checkpoint composer. */
export interface ConnectorRuntimeHost {
  environmentValue(name: string): string | undefined;
  currentWorkingDirectory(): string;
}
