/**
 * Native Storage implementation: MMKV for synchronous UI prefs + expo-secure-store
 * for encrypted credentials. RN-only — not part of the pure typecheck; verified
 * by the full `tsconfig.json` build once native deps are installed.
 */
import { MMKV } from 'react-native-mmkv';
import * as SecureStore from 'expo-secure-store';
import type { Storage } from './Storage';

const mmkv = new MMKV({ id: 'brainrouter-prefs' });

export class NativeStorage implements Storage {
  getString(key: string): string | undefined {
    return mmkv.getString(key);
  }

  set(key: string, value: string): void {
    mmkv.set(key, value);
  }

  getBoolean(key: string): boolean | undefined {
    return mmkv.getBoolean(key);
  }

  setBoolean(key: string, value: boolean): void {
    mmkv.set(key, value);
  }

  delete(key: string): void {
    mmkv.delete(key);
  }

  getJSON<T>(key: string): T | undefined {
    const v = mmkv.getString(key);
    if (v === undefined) return undefined;
    try {
      return JSON.parse(v) as T;
    } catch {
      return undefined;
    }
  }

  setJSON<T>(key: string, value: T): void {
    mmkv.set(key, JSON.stringify(value));
  }

  getSecure(key: string): Promise<string | null> {
    return SecureStore.getItemAsync(key);
  }

  async setSecure(key: string, value: string): Promise<void> {
    await SecureStore.setItemAsync(key, value);
  }

  async deleteSecure(key: string): Promise<void> {
    await SecureStore.deleteItemAsync(key);
  }
}

/** The app-wide singleton storage instance. */
export const storage: Storage = new NativeStorage();
