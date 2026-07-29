/**
 * Purpose: Classify provider failures and own route selection/cooldown policy.
 */
import type { ModelRegistryEntry, RouterFailure, RouterFailureKind, RouterStrategy } from './types.js';

export interface RouterPolicyOptions {
  now?: () => number;
  cooldownBaseMs?: number;
  cooldownMaxMs?: number;
  sessionAffinity?: boolean;
  strategy?: RouterStrategy;
}

interface CooldownState {
  until: number;
  step: number;
  reason: RouterFailureKind;
}

export interface RouterRecentEvent {
  at: number;
  message: string;
  from: string;
  to: string;
  reason: RouterFailureKind;
  status?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cooldownKey(route: Pick<ModelRegistryEntry, 'provider' | 'model'>): string {
  return `${route.provider}/${route.model}`;
}

export function classifyRouterFailure(error: unknown): RouterFailure {
  const anyErr = error as any;
  const status = typeof anyErr?.status === 'number' ? anyErr.status : undefined;
  const message = String(anyErr?.message ?? error ?? '');
  const lower = message.toLowerCase();
  const retryAfterMs = typeof anyErr?.retryAfterMs === 'number' ? anyErr.retryAfterMs : undefined;

  if (anyErr?.brainrouterStreamStarted === true) {
    return { kind: 'non_retryable', retryable: false, status, retryAfterMs, message };
  }
  if (status === 401 || status === 403) {
    return { kind: 'auth_rejected', retryable: true, status, retryAfterMs, message };
  }
  if (status === 404 || (status === 400 && /unsupported|unknown|not found|does not exist|invalid model/.test(lower))) {
    return { kind: 'model_lockout', retryable: true, status, retryAfterMs, message };
  }
  if (/context length|context window|maximum context|too many tokens|prompt is too long|tokens? exceed|413/.test(lower)) {
    return { kind: 'context_overflow', retryable: true, status, retryAfterMs, message };
  }
  if (status === 429 || (typeof status === 'number' && status >= 500) || /timeout|timed out|econnreset|network|fetch failed/i.test(message)) {
    return { kind: 'provider_retryable', retryable: true, status, retryAfterMs, message };
  }
  return { kind: 'non_retryable', retryable: false, status, retryAfterMs, message };
}

export class RouterPolicy {
  private readonly now: () => number;
  private readonly baseMs: number;
  private readonly maxMs: number;
  private readonly sessionAffinity: boolean;
  private readonly strategy: RouterStrategy;
  private providerCooldowns = new Map<string, CooldownState>();
  private modelCooldowns = new Map<string, CooldownState>();
  private sessionProviders = new Map<string, string>();
  private recentEvents: RouterRecentEvent[] = [];
  private roundRobinIndex = 0;

  constructor(opts: RouterPolicyOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.baseMs = clamp(opts.cooldownBaseMs ?? 3_000, 500, 60_000);
    this.maxMs = clamp(opts.cooldownMaxMs ?? 300_000, this.baseMs, 1_800_000);
    this.sessionAffinity = opts.sessionAffinity !== false;
    this.strategy = opts.strategy ?? 'priority';
  }

  status() {
    return {
      providers: [...this.providerCooldowns.entries()].map(([provider, state]) => ({ provider, ...state })),
      models: [...this.modelCooldowns.entries()].map(([route, state]) => ({ route, ...state })),
      recentEvents: [...this.recentEvents],
    };
  }

  noteSuccess(route: Pick<ModelRegistryEntry, 'provider' | 'model'>, sessionKey?: string): void {
    this.providerCooldowns.delete(route.provider);
    this.modelCooldowns.delete(cooldownKey(route));
    if (this.sessionAffinity && sessionKey) this.sessionProviders.set(sessionKey, route.provider);
  }

  markFailure(route: Pick<ModelRegistryEntry, 'provider' | 'model'>, failure: RouterFailure): void {
    if (!failure.retryable || failure.kind === 'non_retryable') return;
    if (failure.kind === 'context_overflow') return;
    const map = failure.kind === 'model_lockout' ? this.modelCooldowns : this.providerCooldowns;
    const key = failure.kind === 'model_lockout' ? cooldownKey(route) : route.provider;
    const prev = map.get(key);
    const step = failure.kind === 'auth_rejected'
      ? Math.max(prev?.step ?? 0, 5)
      : (prev?.step ?? 0) + 1;
    const computed = Math.min(this.maxMs, this.baseMs * 2 ** Math.max(0, step - 1));
    const delay = failure.retryAfterMs !== undefined ? Math.max(failure.retryAfterMs, computed) : computed;
    map.set(key, { until: this.now() + delay, step, reason: failure.kind });
  }

  noteFallback(
    from: string,
    to: string,
    failure: Pick<RouterFailure, 'kind' | 'status'>,
  ): void {
    const status = failure.status ? ` ${failure.status}` : '';
    const message = `${from} unavailable (${failure.kind}${status}), routed to ${to}`;
    this.recentEvents = [
      { at: this.now(), message, from, to, reason: failure.kind, status: failure.status },
      ...this.recentEvents,
    ].slice(0, 5);
  }

  orderRoutes(routes: ModelRegistryEntry[], sessionKey?: string): ModelRegistryEntry[] {
    if (routes.length <= 1) return routes;
    let ordered = [...routes];
    if (this.strategy === 'round-robin') {
      const offset = this.roundRobinIndex % ordered.length;
      this.roundRobinIndex += 1;
      ordered = [...ordered.slice(offset), ...ordered.slice(0, offset)];
    } else if (this.strategy === 'free-first') {
      ordered.sort((a, b) => {
        const af = a.llm.free === true || a.providerDef?.local === true ? 0 : 1;
        const bf = b.llm.free === true || b.providerDef?.local === true ? 0 : 1;
        return af - bf;
      });
    }
    const preferred = sessionKey && this.sessionAffinity ? this.sessionProviders.get(sessionKey) : undefined;
    if (preferred) {
      ordered.sort((a, b) => (a.provider === preferred ? -1 : 0) - (b.provider === preferred ? -1 : 0));
    }
    return ordered;
  }

  pickRoute(routes: ModelRegistryEntry[], sessionKey?: string): ModelRegistryEntry | null {
    const ordered = this.orderRoutes(routes, sessionKey);
    if (ordered.length === 0) return null;
    const now = this.now();
    const healthy = ordered.find((route) => this.cooldownUntil(route) <= now);
    if (healthy) return healthy;
    return ordered.reduce((best, route) => (
      this.cooldownUntil(route) < this.cooldownUntil(best) ? route : best
    ), ordered[0]);
  }

  private cooldownUntil(route: Pick<ModelRegistryEntry, 'provider' | 'model'>): number {
    return Math.max(
      this.providerCooldowns.get(route.provider)?.until ?? 0,
      this.modelCooldowns.get(cooldownKey(route))?.until ?? 0,
    );
  }
}

let singleton: RouterPolicy | undefined;

export function getRouterPolicy(opts: RouterPolicyOptions = {}): RouterPolicy {
  if (!singleton) singleton = new RouterPolicy(opts);
  return singleton;
}

export function resetRouterPolicyForTests(): void {
  singleton = undefined;
}
