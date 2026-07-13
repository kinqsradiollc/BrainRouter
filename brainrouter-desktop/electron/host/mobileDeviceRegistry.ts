import fs from 'node:fs';
import path from 'node:path';
import { getBrainrouterHome } from '@kinqs/brainrouter-core/storage';

export type MobileScope = 'monitor' | 'control' | 'approve';

export interface MobileDeviceRecord {
  id: string;
  name: string;
  publicKey: string;
  tokenHash: string;
  scopes: MobileScope[];
  lastCounter: number;
  createdAt: string;
  lastSeenAt?: string;
  revokedAt?: string;
}

interface RegistryFile { version: 1; devices: MobileDeviceRecord[] }

export class MobileDeviceRegistry {
  readonly file: string;
  constructor(home = getBrainrouterHome()) {
    this.file = path.join(home, 'mobile', 'devices.json');
  }

  list(includeRevoked = false): MobileDeviceRecord[] {
    return this.read().devices.filter((device) => includeRevoked || !device.revokedAt).map((device) => ({ ...device, scopes: [...device.scopes] }));
  }

  get(id: string): MobileDeviceRecord | undefined { return this.list(true).find((device) => device.id === id); }

  put(device: MobileDeviceRecord): void {
    const file = this.read();
    const index = file.devices.findIndex((item) => item.id === device.id);
    if (index >= 0) file.devices[index] = device;
    else file.devices.push(device);
    this.write(file);
  }

  update(id: string, patch: Partial<MobileDeviceRecord>): MobileDeviceRecord | undefined {
    const file = this.read();
    const device = file.devices.find((item) => item.id === id);
    if (!device) return undefined;
    Object.assign(device, patch);
    this.write(file);
    return { ...device, scopes: [...device.scopes] };
  }

  revoke(id: string): boolean { return !!this.update(id, { revokedAt: new Date().toISOString() }); }

  private read(): RegistryFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as RegistryFile;
      return parsed?.version === 1 && Array.isArray(parsed.devices) ? parsed : { version: 1, devices: [] };
    } catch { return { version: 1, devices: [] }; }
  }

  private write(file: RegistryFile): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try { fs.chmodSync(this.file, 0o600); } catch { /* Windows */ }
  }
}
