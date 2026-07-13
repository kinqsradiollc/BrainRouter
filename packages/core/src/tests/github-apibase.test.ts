import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGithubApiBase } from '../track/githubSync/githubApp.js';

test('validateGithubApiBase: empty → trusted default', () => {
  assert.equal(validateGithubApiBase(''), 'https://api.github.com');
  assert.equal(validateGithubApiBase(undefined), 'https://api.github.com');
  assert.equal(validateGithubApiBase('   '), 'https://api.github.com');
});

test('validateGithubApiBase: allows https GitHub + Enterprise domains, strips trailing slash', () => {
  assert.equal(validateGithubApiBase('https://api.github.com'), 'https://api.github.com');
  assert.equal(validateGithubApiBase('https://api.github.com/'), 'https://api.github.com');
  assert.equal(validateGithubApiBase('https://ghe.example.com/api/v3'), 'https://ghe.example.com/api/v3');
});

test('validateGithubApiBase: rejects SSRF vectors (CWE-918)', () => {
  assert.equal(validateGithubApiBase('http://api.github.com'), null, 'non-https');
  assert.equal(validateGithubApiBase('https://localhost'), null, 'localhost');
  assert.equal(validateGithubApiBase('https://evil.localhost'), null, '.localhost');
  assert.equal(validateGithubApiBase('https://127.0.0.1'), null, 'loopback ip');
  assert.equal(validateGithubApiBase('https://169.254.169.254/latest/meta-data'), null, 'link-local metadata');
  assert.equal(validateGithubApiBase('https://10.0.0.5/api'), null, 'private ip');
  assert.equal(validateGithubApiBase('https://[::1]'), null, 'ipv6 loopback');
  assert.equal(validateGithubApiBase('https://internal'), null, 'bare internal host');
  assert.equal(validateGithubApiBase('not a url'), null, 'garbage');
  assert.equal(validateGithubApiBase('ftp://api.github.com'), null, 'non-http scheme');
});
