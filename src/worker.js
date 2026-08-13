import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const SESSION_COOKIE = '__Host-weather_session';
const encoder = new TextEncoder();

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    }
  });
}

function isAllowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = String(env.APP_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean);
  return Boolean(origin && allowed.includes(origin));
}

function getCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  const item = cookie.split(';').map((value) => value.trim()).find((value) => value.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : null;
}

function sessionKey(env) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters.');
  }
  return encoder.encode(env.SESSION_SECRET);
}

async function createSession(user, env) {
  return new SignJWT({
    name: user.name,
    email: user.email,
    picture: user.picture
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(user.id)
    .setIssuer('weather-search')
    .setAudience('weather-search-web')
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(sessionKey(env));
}

async function readSession(request, env) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const { payload } = await jwtVerify(token, sessionKey(env), {
    algorithms: ['HS256'],
    issuer: 'weather-search',
    audience: 'weather-search-web'
  });
  return {
    id: payload.sub,
    name: payload.name,
    email: payload.email,
    picture: payload.picture
  };
}

async function googleLogin(request, env) {
  if (!isAllowedOrigin(request, env)) return json({ error: 'Invalid origin' }, 403);
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > 10000) return json({ error: 'Request too large' }, 413);

  let body;
  try {
    const rawBody = await request.text();
    if (rawBody.length > 10000) return json({ error: 'Request too large' }, 413);
    body = JSON.parse(rawBody);
  } catch { return json({ error: 'Invalid JSON' }, 400); }
  if (typeof body.credential !== 'string' || body.credential.length > 8000) {
    return json({ error: 'Invalid credential' }, 400);
  }

  try {
    const { payload } = await jwtVerify(body.credential, GOOGLE_JWKS, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: env.GOOGLE_CLIENT_ID,
      algorithms: ['RS256']
    });
    if (!payload.sub || !payload.email || payload.email_verified !== true) {
      return json({ error: 'Unverified Google account' }, 401);
    }
    const user = {
      id: payload.sub,
      email: payload.email,
      name: payload.name || payload.email,
      picture: payload.picture || ''
    };
    const session = await createSession(user, env);
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(session)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
    return json(user, 200, { 'Set-Cookie': cookie });
  } catch {
    return json({ error: 'Invalid Google token' }, 401);
  }
}

async function sessionInfo(request, env) {
  try {
    const user = await readSession(request, env);
    return user ? json(user) : json({ error: 'Not authenticated' }, 401);
  } catch {
    return json({ error: 'Invalid session' }, 401, {
      'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
    });
  }
}

function logout(request, env) {
  if (!isAllowedOrigin(request, env)) return json({ error: 'Invalid origin' }, 403);
  return json({ ok: true }, 200, {
    'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/auth/google' && request.method === 'POST') return googleLogin(request, env);
    if (url.pathname === '/api/auth/session' && request.method === 'GET') return sessionInfo(request, env);
    if (url.pathname === '/api/auth/logout' && request.method === 'POST') return logout(request, env);
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    return env.ASSETS.fetch(request);
  }
};
