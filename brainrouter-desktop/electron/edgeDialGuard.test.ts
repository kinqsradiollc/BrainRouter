/**
 * ADR-043 C5b acceptance — the SSRF dial guard. Loopback / private / link-local /
 * metadata / ULA / multicast / reserved ranges are refused across IPv4, IPv6,
 * crafted non-canonical literals, and IPv4-mapped IPv6; hostnames are refused
 * when they resolve (even partly) into a blocked range; public targets pin to a
 * vetted address.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { vetDialTarget, DialNotAllowedError, __test } from './edgeDialGuard.js';
import type { LookupAddress } from 'node:dns';

const { isBlockedIpv4, isBlockedIpv6 } = __test;

void test('blocks the IPv4 SSRF ranges', () => {
  for (const ip of [
    '127.0.0.1',
    '127.9.9.9',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', // CGNAT
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1', // multicast
  ]) {
    assert.equal(isBlockedIpv4(ip), true, `${ip} must be blocked`);
  }
});

void test('allows public IPv4', () => {
  for (const ip of ['1.1.1.1', '8.8.8.8', '52.10.20.30', '104.18.1.1']) {
    assert.equal(isBlockedIpv4(ip), false, `${ip} must be allowed`);
  }
});

void test('blocks IPv6 SSRF ranges incl. crafted / non-canonical loopback', () => {
  for (const ip of [
    '::1',
    '0:0:0:0:0:0:0:1', // fully-expanded loopback must still be caught
    '::',
    'fe80::1', // link-local
    'FE80::abcd', // uppercase
    'fc00::1', // ULA
    'fd12:3456::1', // ULA
    'ff02::1', // multicast
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:169.254.169.254', // IPv4-mapped metadata
    '64:ff9b::7f00:1', // NAT64-embedded 127.0.0.1
    '2001:db8::1', // documentation
  ]) {
    assert.equal(isBlockedIpv6(ip), true, `${ip} must be blocked`);
  }
});

void test('allows public IPv6', () => {
  for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isBlockedIpv6(ip), false, `${ip} must be allowed`);
  }
});

void test('vetDialTarget refuses a blocked IP literal', async () => {
  await assert.rejects(vetDialTarget('169.254.169.254', 80), DialNotAllowedError);
  await assert.rejects(vetDialTarget('::1', 443), DialNotAllowedError);
});

void test('vetDialTarget refuses an invalid port', async () => {
  await assert.rejects(vetDialTarget('1.1.1.1', 0), DialNotAllowedError);
  await assert.rejects(vetDialTarget('1.1.1.1', 70_000), DialNotAllowedError);
});

void test('vetDialTarget pins a public IP literal without resolving', async () => {
  const vetted = await vetDialTarget('1.1.1.1', 443, {
    lookup: async () => {
      throw new Error('must not resolve an IP literal');
    },
  });
  assert.deepEqual(vetted, { address: '1.1.1.1', family: 4, port: 443, host: '1.1.1.1' });
});

void test('vetDialTarget refuses a hostname that resolves into a blocked range', async () => {
  const lookup = async (): Promise<LookupAddress[]> => [
    { address: '52.1.2.3', family: 4 },
    { address: '169.254.169.254', family: 4 }, // rebinding / mixed record
  ];
  await assert.rejects(vetDialTarget('sneaky.example.com', 443, { lookup }), DialNotAllowedError);
});

void test('vetDialTarget refuses a host that does not resolve', async () => {
  await assert.rejects(vetDialTarget('nx.example.com', 443, { lookup: async () => [] }), DialNotAllowedError);
});

void test('vetDialTarget pins the first resolved public address', async () => {
  const lookup = async (): Promise<LookupAddress[]> => [
    { address: '104.18.2.3', family: 4 },
    { address: '104.18.2.4', family: 4 },
  ];
  const vetted = await vetDialTarget('api.provider.test', 443, { lookup });
  assert.equal(vetted.address, '104.18.2.3');
  assert.equal(vetted.host, 'api.provider.test');
  assert.equal(vetted.port, 443);
});

void test('vetDialTarget enforces an optional host allowlist before resolving', async () => {
  await assert.rejects(
    vetDialTarget('evil.example.com', 443, {
      isHostAllowed: (h) => h === 'api.provider.test',
      lookup: async () => {
        throw new Error('must not resolve a disallowed host');
      },
    }),
    DialNotAllowedError,
  );
});
