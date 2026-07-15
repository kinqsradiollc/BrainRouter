import * as SecureStore from 'expo-secure-store';
import type { HostCredential } from '../protocol/types';

export interface CredentialStore {
  list(): Promise<HostCredential[]>;
  get(id: string): Promise<HostCredential | null>;
  put(value: HostCredential): Promise<void>;
  remove(id: string): Promise<void>;
}

const INDEX_KEY = 'brainrouter.mobile.hosts';
const key = (id: string): string => `brainrouter.mobile.host.${id}`;

export class SecureCredentialStore implements CredentialStore {
  async list(): Promise<HostCredential[]> {
    const ids = await this.ids();
    return (await Promise.all(ids.map((id) => this.get(id)))).filter((value): value is HostCredential => !!value);
  }
  async get(id: string): Promise<HostCredential | null> {
    const raw = await SecureStore.getItemAsync(key(id));
    if (!raw) return null;
    try { return JSON.parse(raw) as HostCredential; } catch { return null; }
  }
  async put(value: HostCredential): Promise<void> {
    await SecureStore.setItemAsync(key(value.id), JSON.stringify(value), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    const ids = await this.ids();
    if (!ids.includes(value.id)) await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify([...ids, value.id]));
  }
  async remove(id: string): Promise<void> {
    await SecureStore.deleteItemAsync(key(id));
    await SecureStore.setItemAsync(INDEX_KEY, JSON.stringify((await this.ids()).filter((item) => item !== id)));
  }
  private async ids(): Promise<string[]> {
    try { const parsed = JSON.parse(await SecureStore.getItemAsync(INDEX_KEY) || '[]'); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
  }
}

export class MemoryCredentialStore implements CredentialStore {
  private values = new Map<string, HostCredential>();
  async list() { return [...this.values.values()].map((value) => structuredClone(value)); }
  async get(id: string) { const value = this.values.get(id); return value ? structuredClone(value) : null; }
  async put(value: HostCredential) { this.values.set(value.id, structuredClone(value)); }
  async remove(id: string) { this.values.delete(id); }
}

/** SecureStore-backed rotating device credentials (spec §9, Task 24) — holds only
 * the phone's remote-access identity + rotating refresh token, never the account
 * bearer. Satisfies the RemoteSecretsPort of client/RemoteAccessClient. */
export class SecureRemoteSecrets {
  private key(name: string): string { return `brainrouter.mobile.remote.${name.replace(/[^A-Za-z0-9._-]/g, '_')}`; }
  async get(name: string): Promise<string | null> { return (await SecureStore.getItemAsync(this.key(name))) ?? null; }
  async set(name: string, value: string): Promise<void> {
    await SecureStore.setItemAsync(this.key(name), value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
  }
  async delete(name: string): Promise<void> { await SecureStore.deleteItemAsync(this.key(name)); }
}
