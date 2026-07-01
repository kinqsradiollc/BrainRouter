import test from 'node:test';
import assert from 'node:assert/strict';
import { githubCliTlsHelp, isGithubCliTlsError, mergeGithubCliEnv, normalizeGithubCliError } from './ghCli.js';
test('isGithubCliTlsError detects GitHub CLI x509 failures', () => {
    assert.equal(isGithubCliTlsError('Post "https://api.github.com/graphql": tls: failed to verify certificate: x509: certificate signed by unknown authority'), true);
    assert.equal(isGithubCliTlsError('HTTP 401: Bad credentials'), false);
});
test('mergeGithubCliEnv passes trusted CA settings to gh without disabling TLS', () => {
    const env = mergeGithubCliEnv({}, { sslCAInfo: '/corp/ca.pem', sslCAPath: '/corp/certs' });
    assert.equal(env.GH_PROMPT_DISABLED, '1');
    assert.equal(env.SSL_CERT_FILE, '/corp/ca.pem');
    assert.equal(env.SSL_CERT_DIR, '/corp/certs');
    assert.equal(env.GIT_SSL_NO_VERIFY, undefined);
});
test('mergeGithubCliEnv preserves explicit SSL_CERT_FILE over git config', () => {
    const env = mergeGithubCliEnv({ SSL_CERT_FILE: '/explicit.pem' }, { sslCAInfo: '/git.pem' });
    assert.equal(env.SSL_CERT_FILE, '/explicit.pem');
});
test('normalizeGithubCliError returns actionable TLS help', () => {
    const msg = normalizeGithubCliError('x509: certificate signed by unknown authority');
    assert.ok(msg.includes(githubCliTlsHelp()));
    assert.ok(msg.includes('SSL_CERT_FILE'));
    assert.equal(msg.includes('x509:'), false);
});
