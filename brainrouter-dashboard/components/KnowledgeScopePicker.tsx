'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { adminApi, type OrgSummary, type Project } from '../lib/adminApi';
import { brainApi, type KnowledgeScope, type ScopedSourceDocument } from '../lib/brainApi';

const EMPTY_SCOPE: KnowledgeScope = { orgId: '', projectId: '', workspaceTag: '' };

function workspaceName(source: ScopedSourceDocument): string {
  if (source.workspaceLabel?.trim()) return source.workspaceLabel.trim();
  const metadata = source.metadata ?? {};
  for (const key of ['workspaceName', 'workspaceRoot', 'workspace'] as const) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) {
      const parts = value.replace(/\\/g, '/').split('/').filter(Boolean);
      return parts.at(-1) ?? value;
    }
  }
  return source.workspaceTag ? `Workspace ${source.workspaceTag.slice(0, 8)}` : 'Unscoped';
}

function initialScope(): KnowledgeScope {
  if (typeof window === 'undefined') return EMPTY_SCOPE;
  const query = new URLSearchParams(window.location.search);
  return {
    orgId: query.get('orgId') ?? '',
    projectId: query.get('projectId') ?? '',
    workspaceTag: query.get('workspaceTag') ?? '',
  };
}

export function useKnowledgeScope() {
  const [scope, setScope] = useState<KnowledgeScope>(initialScope);
  const [orgs, setOrgs] = useState<OrgSummary[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [sources, setSources] = useState<ScopedSourceDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const scopeRef = useRef(scope);
  const orgRequestIdRef = useRef(0);
  const projectRequestIdRef = useRef(0);
  const sourceRequestIdRef = useRef(0);
  const projectAbortRef = useRef<AbortController | null>(null);
  const sourceAbortRef = useRef<AbortController | null>(null);
  scopeRef.current = scope;

  const replaceScope = useCallback((next: KnowledgeScope) => {
    scopeRef.current = next;
    setScope(next);
  }, []);

  const invalidateProjectRequest = useCallback(() => {
    projectRequestIdRef.current += 1;
    projectAbortRef.current?.abort();
    projectAbortRef.current = null;
  }, []);

  const invalidateSourceRequest = useCallback(() => {
    sourceRequestIdRef.current += 1;
    sourceAbortRef.current?.abort();
    sourceAbortRef.current = null;
  }, []);

  useEffect(() => {
    const requestId = ++orgRequestIdRef.current;
    const controller = new AbortController();
    void adminApi
      .listOrgs(controller.signal)
      .then(({ orgs: nextOrgs = [] }) => {
        if (requestId !== orgRequestIdRef.current) return;
        setOrgs(nextOrgs);
        const current = scopeRef.current;
        const requested = nextOrgs.some((org) => org.orgId === current.orgId) ? current.orgId : '';
        const fallback = nextOrgs.find((org) => org.isDefault)?.orgId ?? nextOrgs[0]?.orgId ?? '';
        const orgId = requested || fallback;
        if (orgId !== current.orgId) {
          invalidateProjectRequest();
          invalidateSourceRequest();
          setProjects([]);
          setSources([]);
          setLoading(Boolean(orgId));
          replaceScope({ orgId, projectId: '', workspaceTag: '' });
        }
      })
      .catch((caught) => {
        if (requestId === orgRequestIdRef.current && !(caught instanceof Error && caught.name === 'AbortError')) {
          setError(caught instanceof Error ? caught.message : 'Could not load organizations');
        }
      });
    return () => {
      orgRequestIdRef.current += 1;
      controller.abort();
    };
  }, [invalidateProjectRequest, invalidateSourceRequest, replaceScope]);

  useEffect(() => {
    invalidateProjectRequest();
    setProjects([]);
    if (!scope.orgId) {
      return;
    }
    const requestedOrgId = scope.orgId;
    const requestId = ++projectRequestIdRef.current;
    const controller = new AbortController();
    projectAbortRef.current = controller;
    void adminApi
      .listProjects(requestedOrgId, controller.signal)
      .then(({ projects: nextProjects = [] }) => {
        if (requestId !== projectRequestIdRef.current || scopeRef.current.orgId !== requestedOrgId) return;
        setProjects(nextProjects);
        const current = scopeRef.current;
        if (current.projectId && !nextProjects.some((project) => project.projectId === current.projectId)) {
          invalidateSourceRequest();
          setSources([]);
          setLoading(true);
          replaceScope({ ...current, projectId: '', workspaceTag: '' });
        }
      })
      .catch((caught) => {
        if (requestId === projectRequestIdRef.current && !(caught instanceof Error && caught.name === 'AbortError')) {
          setError(caught instanceof Error ? caught.message : 'Could not load projects');
        }
      });
    return () => {
      if (projectAbortRef.current === controller) projectAbortRef.current = null;
      projectRequestIdRef.current += 1;
      controller.abort();
    };
  }, [invalidateProjectRequest, invalidateSourceRequest, replaceScope, scope.orgId]);

  const reloadSources = useCallback(async () => {
    invalidateSourceRequest();
    setSources([]);
    const expectedOrgId = scope.orgId;
    const expectedProjectId = scope.projectId;
    if (!expectedOrgId) {
      setSources([]);
      setLoading(false);
      return;
    }
    const requestId = ++sourceRequestIdRef.current;
    const controller = new AbortController();
    sourceAbortRef.current = controller;
    setLoading(true);
    try {
      const result = await brainApi.listSources(
        { orgId: expectedOrgId, projectId: expectedProjectId, workspaceTag: '' },
        100,
        controller.signal,
      );
      if (
        requestId !== sourceRequestIdRef.current ||
        scopeRef.current.orgId !== expectedOrgId ||
        scopeRef.current.projectId !== expectedProjectId
      )
        return;
      setSources(result.documents ?? []);
      setError('');
    } catch (caught) {
      if (
        requestId !== sourceRequestIdRef.current ||
        scopeRef.current.orgId !== expectedOrgId ||
        scopeRef.current.projectId !== expectedProjectId ||
        (caught instanceof Error && caught.name === 'AbortError')
      )
        return;
      setSources([]);
      setError(caught instanceof Error ? caught.message : 'Could not load sources');
    } finally {
      if (
        requestId === sourceRequestIdRef.current &&
        scopeRef.current.orgId === expectedOrgId &&
        scopeRef.current.projectId === expectedProjectId
      ) {
        sourceAbortRef.current = null;
        setLoading(false);
      }
    }
  }, [invalidateSourceRequest, scope.orgId, scope.projectId]);

  useEffect(() => {
    void reloadSources();
    return invalidateSourceRequest;
  }, [invalidateSourceRequest, reloadSources]);

  useEffect(() => {
    if (typeof window === 'undefined' || !scope.orgId) return;
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries(scope)) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  }, [scope]);

  const workspaces = useMemo(() => {
    const labels = new Map<string, string>();
    for (const source of sources) {
      const tag = source.workspaceTag ?? '';
      if (tag && !labels.has(tag)) labels.set(tag, workspaceName(source));
    }
    return [...labels].map(([tag, label]) => ({ tag, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [sources]);

  useEffect(() => {
    if (!loading && scope.workspaceTag && !workspaces.some((workspace) => workspace.tag === scope.workspaceTag)) {
      replaceScope({ ...scopeRef.current, workspaceTag: '' });
    }
  }, [loading, replaceScope, scope.workspaceTag, workspaces]);

  const setOrgId = useCallback(
    (orgId: string) => {
      invalidateProjectRequest();
      invalidateSourceRequest();
      setProjects([]);
      setSources([]);
      setLoading(Boolean(orgId));
      setError('');
      replaceScope({ orgId, projectId: '', workspaceTag: '' });
    },
    [invalidateProjectRequest, invalidateSourceRequest, replaceScope],
  );

  const setProjectId = useCallback(
    (projectId: string) => {
      invalidateSourceRequest();
      setSources([]);
      setLoading(Boolean(scopeRef.current.orgId));
      setError('');
      replaceScope({ ...scopeRef.current, projectId, workspaceTag: '' });
    },
    [invalidateSourceRequest, replaceScope],
  );

  const setWorkspaceTag = useCallback(
    (workspaceTag: string) => {
      setError('');
      replaceScope({ ...scopeRef.current, workspaceTag });
    },
    [replaceScope],
  );

  return {
    scope,
    setOrgId,
    setProjectId,
    setWorkspaceTag,
    orgs,
    projects,
    workspaces,
    sources,
    loading,
    error,
    reloadSources,
  };
}

type ScopeState = ReturnType<typeof useKnowledgeScope>;

export function KnowledgeScopePicker({ state, compact = false }: { state: ScopeState; compact?: boolean }) {
  return (
    <div className={`knowledge-scope${compact ? ' knowledge-scope--compact' : ''}`} aria-label="Knowledge scope">
      <label>
        <span>Organization</span>
        <select
          className="settings-select"
          value={state.scope.orgId}
          onChange={(event) => state.setOrgId(event.target.value)}
        >
          {state.orgs.length === 0 && <option value="">Personal workspace</option>}
          {state.orgs.map((org) => (
            <option key={org.orgId} value={org.orgId}>
              {org.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Project</span>
        <select
          className="settings-select"
          value={state.scope.projectId}
          onChange={(event) => state.setProjectId(event.target.value)}
          disabled={!state.scope.orgId}
        >
          <option value="">All projects</option>
          {state.projects.map((project) => (
            <option key={project.projectId} value={project.projectId}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Workspace</span>
        <select
          className="settings-select"
          value={state.scope.workspaceTag}
          onChange={(event) => state.setWorkspaceTag(event.target.value)}
          disabled={state.loading || state.workspaces.length === 0}
        >
          <option value="">All workspaces</option>
          {state.workspaces.map((workspace) => (
            <option key={workspace.tag} value={workspace.tag}>
              {workspace.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
