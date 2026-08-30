/**
 * ADR-052 P3 (D3) — the restricted session profile. `cli.restricted` clamps a
 * session to read-tier tools (no write/shell/exec), drops network/web tools, and
 * refuses posture escalation, for an untrusted repo or a CI seat.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { _resetCliKnobsCache, setCliKnobOverride, resolveCliKnobs, type Config } from '../config/config.js';
import { registryNetworkToolNames, registryAllowedTools } from '../tool/registry/registry.js';

test('registryNetworkToolNames lists the network/web tools (web_search, fetch_url)', () => {
  const net = registryNetworkToolNames();
  assert.ok(net.has('web_search'), 'web_search is a network tool');
  assert.ok(net.has('fetch_url'), 'fetch_url is a network tool');
  assert.ok(!net.has('read_file'), 'a plain read is not a network tool');
});

test('resolveCliKnobs reads cli.restricted (config-only, default false)', () => {
  assert.equal(resolveCliKnobs({ cli: { restricted: true } } as unknown as Config).restricted, true);
  assert.equal(resolveCliKnobs({ cli: {} } as unknown as Config).restricted, false);
  assert.equal(resolveCliKnobs({ cli: { restricted: 'yes' } } as unknown as Config).restricted, false); // non-true ⇒ false
});

test('a restricted agent is clamped to read tier, refuses escalation, and drops network tools', async () => {
  _resetCliKnobsCache();
  setCliKnobOverride({ restricted: true } as never);
  try {
    const { Agent } = await import('../agent/agent.js');
    const stubMcp: any = { callTool: async () => ({ content: [] }) };
    // Ask for the widest posture — a restricted session must ignore it.
    const agent: any = new Agent(stubMcp, { provider: 'openai', apiKey: '', model: 'gpt-4o-mini' }, {
      workspaceRoot: '/tmp', launchCwd: '/tmp', sessionKey: 's:restricted', accessMode: 'shell',
    });
    assert.equal(agent.restricted, true);
    assert.equal(agent.accessMode, 'read', 'a restricted session opens at read tier despite accessMode: shell');
    agent.accessMode = 'shell'; // attempt to escalate mid-session
    assert.equal(agent.accessMode, 'read', 'escalation is refused (clamped back to read)');

    const tools = agent.allowedToolsForAccess() as Set<string>;
    assert.ok(!tools.has('web_search') && !tools.has('fetch_url'), 'network tools are dropped');
    assert.ok(tools.has('read_file'), 'read tools remain');
    // Write/shell tools sit above read tier and are absent.
    const readTier = registryAllowedTools('read');
    for (const t of tools) assert.ok(readTier.has(t), `restricted tool ${t} is within read tier`);
  } finally {
    _resetCliKnobsCache();
  }
});

test('without restricted, a session keeps its requested posture', async () => {
  _resetCliKnobsCache();
  setCliKnobOverride({ restricted: false } as never);
  try {
    const { Agent } = await import('../agent/agent.js');
    const stubMcp: any = { callTool: async () => ({ content: [] }) };
    const agent: any = new Agent(stubMcp, { provider: 'openai', apiKey: '', model: 'gpt-4o-mini' }, {
      workspaceRoot: '/tmp', launchCwd: '/tmp', sessionKey: 's:open', accessMode: 'shell',
    });
    assert.equal(agent.restricted, false);
    assert.equal(agent.accessMode, 'shell');
    assert.ok((agent.allowedToolsForAccess() as Set<string>).has('web_search'), 'network tools available when not restricted');
  } finally {
    _resetCliKnobsCache();
  }
});
