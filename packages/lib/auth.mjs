import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

// Supabase anon key is a public client key (like Stripe's publishable key).
// Security is enforced by Row Level Security policies, not key secrecy.
// Override via env vars for alternative Supabase instances.
const SUPABASE_URL =
  process.env.SUPABASE_URL || 'https://tbnliojrqmcagojtvqpe.supabase.co';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRibmxpb2pycW1jYWdvanR2cXBlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyNjIxNzAsImV4cCI6MjA4ODgzODE3MH0.GKlpbVFgBbcV0OwxFZuOb-LfqtOu95ZiR33KNOONPI0';

const PREFERRED_PORT = 54321;

/**
 * Generate PKCE code verifier + challenge
 */
function generatePKCE() {
  const verifier = randomBytes(32)
    .toString('base64url')
    .slice(0, 64);
  const challenge = createHash('sha256')
    .update(verifier)
    .digest('base64url');
  return { verifier, challenge };
}

/**
 * Build the Supabase OAuth URL for GitHub login
 */
export function buildAuthUrl(codeChallenge, callbackUrl) {
  const params = new URLSearchParams({
    provider: 'github',
    redirect_to: callbackUrl,
    flow_type: 'pkce',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${SUPABASE_URL}/auth/v1/authorize?${params}`;
}

const MAX_BODY = 8192;

/**
 * Create callback server. Returns { server, resultPromise, nonce }.
 * resultPromise resolves with { type: 'code', code } or { type: 'token', access_token }.
 * The nonce protects /receive-token from cross-origin requests.
 */
function createCallbackServer() {
  let resolveResult, rejectResult;
  const resultPromise = new Promise((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const nonce = randomBytes(16).toString('hex');
  const tokenPath = `/receive-token/${nonce}`;

  const timeout = setTimeout(() => {
    server.close();
    rejectResult(new Error('Login timed out after 120 seconds'));
  }, 120_000);

  const server = createServer((req, res) => {
    const port = server.address()?.port ?? PREFERRED_PORT;
    const url = new URL(req.url, `http://localhost:${port}`);

    // Handle token/debug info posted from browser (nonce-protected)
    if (url.pathname === tokenPath && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY) {
          req.destroy();
          clearTimeout(timeout);
          server.close();
          rejectResult(new Error('Request body too large'));
        }
      });
      req.on('end', () => {
        res.writeHead(200);
        res.end('ok');
        clearTimeout(timeout);
        server.close();

        if (body.startsWith('NO_FRAGMENT:')) {
          rejectResult(new Error('No tokens received from browser redirect'));
        } else {
          const params = new URLSearchParams(body);
          const accessToken = params.get('access_token');
          if (accessToken) {
            resolveResult({ type: 'token', access_token: accessToken });
          } else {
            rejectResult(new Error('Unexpected callback data'));
          }
        }
      });
      return;
    }

    if (url.pathname === '/callback') {
      const code = url.searchParams.get('code');

      if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body style="background:#0a0a0a;color:#ff6600;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
              <div style="text-align:center">
                <h1>&#9632; Robot Resources</h1>
                <p style="color:#00ff41">Login successful. You can close this tab.</p>
              </div>
            </body>
          </html>
        `);
        clearTimeout(timeout);
        server.close();
        resolveResult({ type: 'code', code });
      } else {
        // No code in query params — serve page that captures the full URL
        // (fragment tokens, errors, etc.) and sends it back via nonce-protected endpoint
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body style="background:#0a0a0a;color:#ff6600;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
              <div style="text-align:center">
                <h1>&#9632; Robot Resources</h1>
                <p id="msg">Completing login...</p>
              </div>
            </body>
            <script>
              const fullUrl = window.location.href;
              const hash = window.location.hash.substring(1);
              const payload = hash || 'NO_FRAGMENT:' + fullUrl;
              fetch('${tokenPath}', { method: 'POST', body: payload })
                .then(() => {
                  if (hash && hash.includes('access_token')) {
                    document.getElementById('msg').style.color = '#00ff41';
                    document.getElementById('msg').textContent = 'Login successful. You can close this tab.';
                  } else {
                    document.getElementById('msg').style.color = '#ffaa00';
                    document.getElementById('msg').textContent = 'Something went wrong. Check terminal.';
                  }
                });
            </script>
          </html>
        `);
      }
      return;
    }

    // Reject all other paths
    res.writeHead(404);
    res.end();
  });

  server.on('error', (err) => {
    clearTimeout(timeout);
    rejectResult(new Error(`Could not start callback server: ${err.message}`));
  });

  return { server, resultPromise, nonce };
}

/**
 * Exchange the auth code + PKCE verifier for a Supabase session.
 */
async function exchangeCodeForSession(code, codeVerifier) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({
      auth_code: code,
      code_verifier: codeVerifier,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${body}`);
  }

  return res.json();
}

/**
 * Try to listen on the preferred port, fall back to OS-assigned port.
 */
function listenWithFallback(server) {
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        // Preferred port busy — let OS assign one
        server.listen(0, '127.0.0.1', () => resolve(server.address().port));
      } else {
        reject(err);
      }
    });
    server.listen(PREFERRED_PORT, '127.0.0.1', () => resolve(server.address().port));
  });
}

/**
 * Full OAuth flow with PKCE + implicit fallback.
 * Returns { access_token, refresh_token, user }.
 */
export async function authenticate() {
  const { verifier, challenge } = generatePKCE();

  // Create server and wait for it to be listening
  const { server, resultPromise } = createCallbackServer();

  const port = await listenWithFallback(server);
  const callbackUrl = `http://localhost:${port}/callback`;
  const authUrl = buildAuthUrl(challenge, callbackUrl);

  console.log(`\n  Auth URL: ${authUrl}\n`);

  // Open browser (use execFile to avoid shell injection)
  const { execFile } = await import('node:child_process');
  if (process.platform === 'win32') {
    // 'start' is a cmd.exe builtin, not an executable — must invoke via cmd.exe
    execFile('cmd.exe', ['/c', 'start', '""', authUrl]);
  } else {
    const openCmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    execFile(openCmd, [authUrl]);
  }

  console.log('  Waiting for GitHub authorization...\n');

  // Wait for the callback
  const result = await resultPromise;

  if (result.type === 'code') {
    // PKCE flow — exchange code for session
    const session = await exchangeCodeForSession(result.code, verifier);
    return {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      user: session.user,
    };
  } else {
    // Implicit flow fallback — we have the access_token directly
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${result.access_token}`,
      },
    });
    if (!res.ok) throw new Error('Failed to fetch user info');
    const user = await res.json();
    return {
      access_token: result.access_token,
      refresh_token: null,
      user,
    };
  }
}
