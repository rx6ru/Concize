// Supabase authentication for an MV3 extension WITHOUT the SDK: it doesn't work cleanly in MV3 service workers (no localStorage, remote-code ban), so this calls the Supabase Auth REST API directly.
// Session is stored in chrome.storage.local so it's reachable from the popup, offscreen document, and service worker.

(function () {
    const SB_URL = CONCIZE_CONFIG.SUPABASE_URL;
    // New Supabase API keys (2025+): the publishable key (sb_publishable_...) replaces the legacy anon key.
    // It goes in the `apikey` header ONLY: never in Authorization (it's not a JWT).
    // Fall back to a legacy anon key if that's what the project still uses.
    const SB_KEY = CONCIZE_CONFIG.SUPABASE_PUBLISHABLE_KEY || CONCIZE_CONFIG.SUPABASE_ANON_KEY;
    const SESSION_KEY = 'sb_session';

    async function getSession() {
        const out = await chrome.storage.local.get(SESSION_KEY);
        return out[SESSION_KEY] || null;
    }
    async function setSession(data) {
        await chrome.storage.local.set({
            [SESSION_KEY]: {
                access_token: data.access_token,
                refresh_token: data.refresh_token,
                expires_at: data.expires_at,
            },
        });
    }
    async function clearSession() {
        await chrome.storage.local.remove(SESSION_KEY);
    }

    function authHeaders() {
        return { apikey: SB_KEY, 'Content-Type': 'application/json' };
    }

    async function signUp(email, password) {
        const res = await fetch(`${SB_URL}/auth/v1/signup`, {
            method: 'POST', headers: authHeaders(), body: JSON.stringify({ email, password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.msg || data.error_description || data.error || 'Sign-up failed');
        // If email confirmation is disabled, signup returns a session immediately.
        if (data.access_token) await setSession(data);
        return data;
    }

    async function signIn(email, password) {
        const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=password`, {
            method: 'POST', headers: authHeaders(), body: JSON.stringify({ email, password }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error_description || data.msg || 'Sign-in failed');
        await setSession(data);
        return data;
    }

    async function signOut() {
        await clearSession();
    }

    async function isAuthenticated() {
        return !!(await getSession());
    }

    // Refresh tokens. Supabase ROTATES the refresh token: we always persist the new one.
    async function refresh(refreshToken) {
        const res = await fetch(`${SB_URL}/auth/v1/token?grant_type=refresh_token`, {
            method: 'POST', headers: authHeaders(), body: JSON.stringify({ refresh_token: refreshToken }),
        });
        if (!res.ok) {
            await clearSession(); // force re-login
            throw new Error('Session expired — please sign in again');
        }
        const data = await res.json();
        await setSession(data);
        return data.access_token;
    }

    /**
     * fetch() against the Concize backend with a Bearer token attached.
     * - `path` may be a backend-relative path ("/api/v1/...") or an absolute URL.
     * - Proactively refreshes if the token expires within 60s; reactively refreshes once on 401.
     */
    // The manifest only grants localhost outright. Any other BACKEND_URL has to be granted by the
    // user at runtime, so ask before the fetch rather than letting it fail as a bare network error.
    function backendOrigin() {
        try { return new URL(CONCIZE_CONFIG.BACKEND_URL).origin + '/*'; } catch (_) { return null; }
    }

    async function hasBackendAccess() {
        const origin = backendOrigin();
        if (!origin) return false;
        return chrome.permissions.contains({ origins: [origin] });
    }

    /** Prompts for access to the configured backend. Chrome requires a user gesture, so call this from a click. */
    async function requestBackendAccess() {
        const origin = backendOrigin();
        if (!origin) throw new Error(`BACKEND_URL is not a valid URL: ${CONCIZE_CONFIG.BACKEND_URL}`);
        return chrome.permissions.request({ origins: [origin] });
    }

    async function authedFetch(path, options = {}) {
        let session = await getSession();
        if (!session) throw new Error('Not signed in');

        if (!await hasBackendAccess()) {
            throw new Error(`No permission to reach ${CONCIZE_CONFIG.BACKEND_URL}. Open the extension and sign in again to grant it.`);
        }

        const nowSec = Math.floor(Date.now() / 1000);
        if (session.expires_at && session.expires_at - nowSec < 60) {
            await refresh(session.refresh_token);
            session = await getSession();
        }

        const url = /^https?:\/\//.test(path) ? path : `${CONCIZE_CONFIG.BACKEND_URL}${path}`;
        const doFetch = (token) => fetch(url, {
            ...options,
            headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
        });

        let res = await doFetch(session.access_token);
        if (res.status === 401) {
            const token = await refresh(session.refresh_token);
            res = await doFetch(token);
        }
        return res;
    }

    // Proactively refresh if the token is near expiry. Called by the service-worker alarm so the session stays alive even while the popup is closed.
    async function maybeRefresh(thresholdSec = 300) {
        const session = await getSession();
        if (!session || !session.refresh_token) return;
        const nowSec = Math.floor(Date.now() / 1000);
        if (!session.expires_at || session.expires_at - nowSec < thresholdSec) {
            try { await refresh(session.refresh_token); } catch (_) { /* user must re-login */ }
        }
    }

    const ConcizeAuth = { signUp, signIn, signOut, isAuthenticated, getSession, authedFetch, maybeRefresh, hasBackendAccess, requestBackendAccess };
    if (typeof self !== 'undefined') self.ConcizeAuth = ConcizeAuth;
})();
