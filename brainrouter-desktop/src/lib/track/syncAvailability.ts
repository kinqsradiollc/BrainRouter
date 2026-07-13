export interface TrackSyncConfigLike {
  repo: string | null;
  hasToken: boolean;
  tokenSource: string | null;
  detectedRepo?: string | null;
  account?: {
    signedIn: boolean;
    connected: boolean;
    login?: string;
  };
}

export interface TrackSyncAvailability {
  configured: boolean;
  repo: string | null;
  source: string | null;
  accountManaged: boolean;
}

function clean(value: string | null | undefined): string | null {
  const result = typeof value === 'string' ? value.trim() : '';
  return result || null;
}

export function resolveTrackSyncAvailability(config: TrackSyncConfigLike | null | undefined): TrackSyncAvailability {
  const explicitRepo = clean(config?.repo);
  const repo = explicitRepo ?? clean(config?.detectedRepo);
  const accountManaged = config?.account?.connected === true;
  const localReady = Boolean(explicitRepo && config?.hasToken);
  const login = clean(config?.account?.login);

  return {
    configured: Boolean(repo && (accountManaged || localReady)),
    repo,
    source: accountManaged
      ? `BrainRouter account${login ? ` · ${login}` : ''}`
      : localReady
        ? clean(config?.tokenSource) ?? 'Local GitHub credential'
        : null,
    accountManaged,
  };
}

export function isTrackSyncAuthFailure(errors: readonly string[] | null | undefined): boolean {
  return errors?.some((error) => /\b401\b|unauthori[sz]ed|bad credentials|not connected/i.test(error)) ?? false;
}
