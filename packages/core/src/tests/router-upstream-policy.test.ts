import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPinnedLookup,
  validateUpstreamTarget,
  type UpstreamDnsResolver,
} from '../router/transport.js';
import {
  applyModelEffortWireMap,
  type ModelEffortWireMap,
} from '../router/providerAdapters.js';

const publicDns: UpstreamDnsResolver = async () => [
  { address: '93.184.216.34', family: 4 },
  { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
];

test('validateUpstreamTarget normalizes hosted HTTPS URLs and pins every public DNS answer', async () => {
  const target = await validateUpstreamTarget(' HTTPS://API.EXAMPLE.COM.:443/v1/chat#fragment ', {
    mode: 'hosted',
    resolve: publicDns,
  });

  assert.equal(target.url.href, 'https://api.example.com/v1/chat');
  assert.equal(target.hostname, 'api.example.com');
  assert.equal(target.allowlisted, false);
  assert.deepEqual(target.addresses, [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
  ]);
});

test('validateUpstreamTarget hosted mode rejects credentials, HTTP, metadata, and non-public IP classes', async () => {
  const cases = [
    'https://user:secret@api.example.com/v1',
    'http://api.example.com/v1',
    'https://localhost/v1',
    'https://metadata.google.internal/computeMetadata/v1',
    'https://127.0.0.1/v1',
    'https://10.0.0.4/v1',
    'https://100.64.0.1/v1',
    'https://169.254.169.254/latest/meta-data',
    'https://192.0.2.1/v1',
    'https://224.0.0.1/v1',
    'https://240.0.0.1/v1',
    'https://[::1]/v1',
    'https://[fc00::1]/v1',
    'https://[fe80::1]/v1',
    'https://[ff02::1]/v1',
    'https://[2001:db8::1]/v1',
  ];

  for (const url of cases) {
    await assert.rejects(
      validateUpstreamTarget(url, { mode: 'hosted', resolve: publicDns }),
      { name: 'UpstreamPolicyError' },
      url,
    );
  }
});

test('validateUpstreamTarget rejects a hostname when any DNS answer is unsafe', async () => {
  await assert.rejects(
    validateUpstreamTarget('https://rebind.example/v1', {
      mode: 'hosted',
      resolve: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    }),
    /loopback/i,
  );
});

test('self-hosted HTTP and private targets require an exact normalized origin allowlist', async () => {
  const resolve: UpstreamDnsResolver = async () => [{ address: '10.20.30.40', family: 4 }];

  const allowed = await validateUpstreamTarget('http://LLM.INTERNAL.:11434/v1', {
    mode: 'self-hosted',
    allowlist: ['http://llm.internal:11434'],
    resolve,
  });
  assert.equal(allowed.allowlisted, true);
  assert.equal(allowed.url.href, 'http://llm.internal:11434/v1');

  await assert.rejects(validateUpstreamTarget('http://llm.internal:11435/v1', {
    mode: 'self-hosted',
    allowlist: ['http://llm.internal:11434'],
    resolve,
  }), /allowlist/i);

  await assert.rejects(validateUpstreamTarget('http://llm.internal.evil:11434/v1', {
    mode: 'self-hosted',
    allowlist: ['http://llm.internal:11434'],
    resolve,
  }), /allowlist/i);

  await assert.rejects(validateUpstreamTarget('http://llm.internal:11434/v1', {
    mode: 'self-hosted',
    allowlist: ['http://*.internal:11434'],
    resolve,
  }), /exact origin/i);
});

test('cloud metadata and multicast stay denied even in a self-hosted allowlist', async () => {
  await assert.rejects(validateUpstreamTarget('http://169.254.169.254/latest/meta-data', {
    mode: 'self-hosted',
    allowlist: ['http://169.254.169.254'],
    resolve: publicDns,
  }), /cloud metadata/i);

  await assert.rejects(validateUpstreamTarget('http://224.0.0.1/v1', {
    mode: 'self-hosted',
    allowlist: ['http://224.0.0.1'],
    resolve: publicDns,
  }), /multicast/i);
});

test('createPinnedLookup returns only validated addresses and never falls back to DNS', async () => {
  const target = await validateUpstreamTarget('https://api.example.com/v1', {
    resolve: publicDns,
  });
  const lookup = createPinnedLookup(target);

  const all = await new Promise<readonly { address: string; family: 4 | 6 }[]>((resolve, reject) => {
    lookup('api.example.com', { all: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses as readonly { address: string; family: 4 | 6 }[]);
    });
  });
  assert.deepEqual(all, target.addresses);

  await assert.rejects(new Promise((resolve, reject) => {
    lookup('attacker.example', {}, (error, address) => error ? reject(error) : resolve(address));
  }), /hostname mismatch/i);
});

test('applyModelEffortWireMap preserves none, max, and exact provider-native values immutably', () => {
  const payload = Object.freeze({
    model: 'hosted-model',
    metadata: Object.freeze({ request: 'req-1' }),
  });
  const map: ModelEffortWireMap = {
    none: {
      'reasoning.effort': 'none',
      'vendor.thinking': 'disabled',
    },
    max: {
      'output_config.effort': 'xhigh',
      'vendor.budget': 'provider-native-max',
    },
  };

  const none = applyModelEffortWireMap(payload, 'none', map);
  const max = applyModelEffortWireMap(payload, 'max', map);

  assert.deepEqual(none, {
    model: 'hosted-model',
    metadata: { request: 'req-1' },
    reasoning: { effort: 'none' },
    vendor: { thinking: 'disabled' },
  });
  assert.deepEqual(max, {
    model: 'hosted-model',
    metadata: { request: 'req-1' },
    output_config: { effort: 'xhigh' },
    vendor: { budget: 'provider-native-max' },
  });
  assert.deepEqual(payload, { model: 'hosted-model', metadata: { request: 'req-1' } });
  assert.notEqual(max, payload);
});

test('applyModelEffortWireMap fails closed for a missing mapping or unsafe/conflicting paths', () => {
  const payload = { reasoning: { enabled: true } };

  assert.throws(() => applyModelEffortWireMap(payload, 'high', {}), /missing.*high/i);
  for (const path of [
    '',
    'reasoning..effort',
    '__proto__.polluted',
    'constructor.prototype.polluted',
    'reasoning[effort]',
  ]) {
    assert.throws(
      () => applyModelEffortWireMap(payload, 'high', { high: { [path]: 'high' } }),
      /path/i,
      path,
    );
  }

  assert.throws(
    () => applyModelEffortWireMap({ reasoning: 'scalar' }, 'high', {
      high: { 'reasoning.effort': 'high' },
    }),
    /non-object/i,
  );
  assert.deepEqual(payload, { reasoning: { enabled: true } });
});

