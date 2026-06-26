const TLS_ERROR_RE = /(?:x509: certificate signed by unknown authority|tls: failed to verify certificate|certificate verify failed|self[- ]signed certificate|unable to get local issuer certificate)/i;
export function isGithubCliTlsError(text) {
    return TLS_ERROR_RE.test(text);
}
export function mergeGithubCliEnv(base, certs = {}) {
    const env = { ...base, GH_PROMPT_DISABLED: '1' };
    const caFile = env.SSL_CERT_FILE || env.GIT_SSL_CAINFO || env.NODE_EXTRA_CA_CERTS || certs.sslCAInfo;
    const caPath = env.SSL_CERT_DIR || env.GIT_SSL_CAPATH || certs.sslCAPath;
    if (caFile && !env.SSL_CERT_FILE)
        env.SSL_CERT_FILE = caFile;
    if (caPath && !env.SSL_CERT_DIR)
        env.SSL_CERT_DIR = caPath;
    return env;
}
export function githubCliTlsHelp() {
    return [
        'GitHub CLI cannot verify GitHub TLS.',
        'Add a trusted CA bundle in Settings → Connectors → GitHub Track sync, or set SSL_CERT_FILE, GIT_SSL_CAINFO, or git config http.sslCAInfo, then retry.',
    ].join(' ');
}
export function normalizeGithubCliError(stderr, fallback = 'GitHub CLI command failed.') {
    const msg = stderr.trim();
    if (isGithubCliTlsError(msg))
        return githubCliTlsHelp();
    return msg || fallback;
}
