import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveCliKnobs } from '../config/config.js';
import type { Config } from '../config/configTypes.js';
import {
  clearOrgConventionRepoRoots,
  discoverOrgConventionRepos,
  loadPluginsWithKnobs,
  setOrgConventionRepoRoots,
  type OrgConventionOwner,
  type OrgConventionProvider,
} from './index.js';

function mkTmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeConventionRepo(parent: string, owner: string): string {
  const root = path.join(parent, owner, '.brainrouter');
  fs.mkdirSync(path.join(root, 'skills', 'deploy'), { recursive: true });
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'deploy', 'SKILL.md'), `---\nname: ${owner}-deploy\ndescription: deploy\n---\n# deploy\n`);
  fs.writeFileSync(path.join(root, 'agents', 'reviewer.md'), '# reviewer\n');
  return root;
}

const cfg = (cli: Record<string, unknown> = {}): Config => ({ activeServer: '', servers: {}, cli } as Config);

test('MC-E1 discoverOrgConventionRepos discovers viewer and org repos and skips missing repos silently', async (t) => {
  const tmp = mkTmp('br-org-conv-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const viewerRoot = writeConventionRepo(tmp, 'viewer');
  const orgRoot = writeConventionRepo(tmp, 'team');
  const roots = new Map<string, string>([
    ['viewer', viewerRoot],
    ['team', orgRoot],
  ]);
  const provider: OrgConventionProvider = {
    provider: 'github',
    async listOwners(): Promise<OrgConventionOwner[]> {
      return [
        { provider: 'github', login: 'viewer', kind: 'user' },
        { provider: 'github', login: 'team', kind: 'org' },
        { provider: 'github', login: 'missing', kind: 'org' },
      ];
    },
    async conventionRepoRoot(owner): Promise<string | null> {
      return roots.get(owner.login) ?? null;
    },
  };

  const result = await discoverOrgConventionRepos({ enabled: true, providers: [provider] });

  assert.deepEqual(result.repos.map((repo) => repo.owner.login), ['viewer', 'team']);
  assert.deepEqual(result.repos.map((repo) => repo.root), [viewerRoot, orgRoot]);
  assert.deepEqual(result.warnings, []);
});

test('MC-E1 loader includes read-only convention skills and agents only when orgRepoDiscovery is on', (t) => {
  const tmp = mkTmp('br-org-load-');
  const ws = mkTmp('br-org-ws-');
  t.after(() => {
    clearOrgConventionRepoRoots();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(ws, { recursive: true, force: true });
  });

  const root = writeConventionRepo(tmp, 'team');
  setOrgConventionRepoRoots([root]);

  const off = loadPluginsWithKnobs(ws, resolveCliKnobs(cfg()));
  assert.equal(off.contributions.skillRoots.some((entry) => entry.endsWith(path.join('.brainrouter', 'skills'))), false);
  assert.equal(off.contributions.agentFiles.length, 0);

  const on = loadPluginsWithKnobs(ws, resolveCliKnobs(cfg({ skills: { orgRepoDiscovery: true } })));
  assert.ok(on.contributions.skillRoots.some((entry) => entry === path.join(root, 'skills')));
  assert.deepEqual(on.contributions.agentFiles.map((entry) => path.basename(entry.path)), ['reviewer.md']);
});
