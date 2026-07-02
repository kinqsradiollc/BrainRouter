/**
 * GitHub OAuth **device flow** (RFC 8628) — connector Phase 2.
 *
 * The desktop is a public OAuth client (no client secret): we request a device
 * code, the user authorizes it at github.com/login/device, and we poll the
 * token endpoint honoring the server-driven cadence. Pure + dependency-injected
 * (fetch, clock) so the whole state machine is unit-testable offline:
 *
 *   - `authorization_pending` → keep polling at `interval`
 *   - `slow_down`             → interval += 5s (per spec), keep polling
 *   - `expired_token`         → the device code died (~15 min) — terminal
 *   - `access_denied`         → the user clicked cancel — terminal
 *   - token payload           → done
 *
 * Rather than blocking the host in a long loop, `pollOnce` exposes ONE poll
 * step; the caller (renderer via `github-oauth-poll`) drives the cadence with
 * the `nextIntervalSec` we return. That keeps the host responsive, makes abort
 * trivial (stop calling), and survives renderer reloads.
 */
const GITHUB_DEVICE_URL = 'https://github.com/login/device/code';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
/** Default scope: issue read/write + org repo listing (Track sync + the repo picker). */
export const GITHUB_OAUTH_SCOPE = 'repo read:org';
export async function requestDeviceCode(clientId, opts) {
    const fetchImpl = opts?.fetchImpl ?? fetch;
    const res = await fetchImpl(GITHUB_DEVICE_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, scope: opts?.scope ?? GITHUB_OAUTH_SCOPE }),
    });
    const body = (await res.json());
    if (!res.ok || !body.device_code || !body.user_code) {
        throw new Error(body.error_description || body.error || `Device-code request failed (HTTP ${res.status})`);
    }
    const now = opts?.nowMs ?? Date.now();
    return {
        deviceCode: body.device_code,
        userCode: body.user_code,
        verificationUri: body.verification_uri || 'https://github.com/login/device',
        intervalSec: Math.max(1, body.interval ?? 5),
        expiresAtMs: now + Math.max(30, body.expires_in ?? 900) * 1000,
    };
}
/** One RFC 8628 token poll. The caller waits `nextIntervalSec` between calls. */
export async function pollOnce(clientId, grant, opts) {
    const now = opts?.nowMs ?? Date.now();
    if (now >= grant.expiresAtMs)
        return { status: 'expired' };
    const fetchImpl = opts?.fetchImpl ?? fetch;
    let body;
    try {
        const res = await fetchImpl(GITHUB_TOKEN_URL, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({
                client_id: clientId,
                device_code: grant.deviceCode,
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            }),
        });
        body = (await res.json());
    }
    catch (e) {
        // Network blips are retryable — stay pending at the current cadence.
        return { status: 'pending', nextIntervalSec: grant.intervalSec };
    }
    if (body.access_token) {
        return { status: 'authorized', accessToken: body.access_token, scope: body.scope ?? '', tokenType: body.token_type ?? 'bearer' };
    }
    switch (body.error) {
        case 'authorization_pending':
            return { status: 'pending', nextIntervalSec: grant.intervalSec };
        case 'slow_down':
            // Spec: add 5 seconds (the response may carry an explicit new interval).
            return { status: 'pending', nextIntervalSec: Math.max(grant.intervalSec + 5, body.interval ?? 0) };
        case 'expired_token':
            return { status: 'expired' };
        case 'access_denied':
            return { status: 'denied' };
        default:
            return { status: 'error', message: body.error_description || body.error || 'Unexpected token-endpoint response' };
    }
}
