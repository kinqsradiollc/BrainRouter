/**
 * Storage — the port seam #2 (technical-doc.md §4). The desktop reached
 * `localStorage` directly (~30 `br-*` UI-pref keys). On mobile we hide MMKV
 * (fast, synchronous UI prefs — a drop-in for localStorage) and SecureStore
 * (encrypted credentials: host URL + device token) behind this small API.
 *
 * This module defines the interfaces plus an `InMemoryStorage` used by tests
 * and the MockTransport-backed dev app; the native MMKV/SecureStore-backed
 * implementation lives in `nativeStorage.ts` (RN-only).
 */

/** Synchronous key/value prefs store (localStorage-shaped). Backed by MMKV. */
export interface PrefsStorage {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  getBoolean(key: string): boolean | undefined;
  setBoolean(key: string, value: boolean): void;
  delete(key: string): void;
  /** Convenience JSON helpers (return undefined on missing/parse error). */
  getJSON<T>(key: string): T | undefined;
  setJSON<T>(key: string, value: T): void;
}

/** Asynchronous encrypted store for credentials. Backed by expo-secure-store. */
export interface SecureStorage {
  getSecure(key: string): Promise<string | null>;
  setSecure(key: string, value: string): Promise<void>;
  deleteSecure(key: string): Promise<void>;
}

export interface Storage extends PrefsStorage, SecureStorage {}

/** Canonical storage keys (mirrors the desktop's `br-*` convention). */
export const StorageKeys = {
  theme: 'br-theme',
  accent: 'br-accent',
  textSize: 'br-text-size',
  lastWorkspace: 'br-last-workspace',
  // secure
  hostUrl: 'br-host-url',
  deviceToken: 'br-device-token',
} as const;

/** In-memory Storage for tests and the dev/Mock-backed app. */
export class InMemoryStorage implements Storage {
  private readonly prefs = new Map<string, string>();
  private readonly secure = new Map<string, string>();

  getString(key: string): string | undefined {
    return this.prefs.get(key);
  }

  set(key: string, value: string): void {
    this.prefs.set(key, value);
  }

  getBoolean(key: string): boolean | undefined {
    const v = this.prefs.get(key);
    return v === undefined ? undefined : v === 'true';
  }

  setBoolean(key: string, value: boolean): void {
    this.prefs.set(key, value ? 'true' : 'false');
  }

  delete(key: string): void {
    this.prefs.delete(key);
  }

  getJSON<T>(key: string): T | undefined {
    const v = this.prefs.get(key);
    if (v === undefined) return undefined;
    try {
      return JSON.parse(v) as T;
    } catch {
      return undefined;
    }
  }

  setJSON<T>(key: string, value: T): void {
    this.prefs.set(key, JSON.stringify(value));
  }

  getSecure(key: string): Promise<string | null> {
    return Promise.resolve(this.secure.has(key) ? (this.secure.get(key) as string) : null);
  }

  setSecure(key: string, value: string): Promise<void> {
    this.secure.set(key, value);
    return Promise.resolve();
  }

  deleteSecure(key: string): Promise<void> {
    this.secure.delete(key);
    return Promise.resolve();
  }
}
