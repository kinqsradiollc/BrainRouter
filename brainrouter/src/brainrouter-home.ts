import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function getBrainrouterHome(): string {
  const override = process.env.BRAINROUTER_HOME?.trim();
  const target = override || path.join(os.homedir(), '.brainrouter');
  fs.mkdirSync(target, { recursive: true });
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}
