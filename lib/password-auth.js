// Native email/password auth for Cloudflare Workers. Passwords use PBKDF2-SHA-256;
// only SHA-256 hashes of opaque session tokens are stored in D1.
const ITERATIONS = 310_000;
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const encoder = new TextEncoder();
const toHex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => Uint8Array.from(hex.match(/.{2}/g) || [], (b) => parseInt(b, 16));
const randomHex = (n = 32) => toHex(crypto.getRandomValues(new Uint8Array(n)));
async function digest(value) {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}
async function derive(password, salt) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  return toHex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(salt), iterations: ITERATIONS }, material, 256));
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
function cookieName(request) {
  return new URL(request.url).protocol === 'https:' ? '__Host-claims_session' : 'claims_session';
}
function cookie(request, value, maxAge) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${cookieName(request)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
export async function registerPasswordUser(db, email, password, name) {
  const normalized = email.trim().toLowerCase();
  const salt = randomHex(16);
  const passwordHash = await derive(password, salt);
  const stamp = new Date().toISOString();
  try {
    await db.prepare('INSERT INTO auth_users (email, name, salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(normalized, name.trim().slice(0, 120), salt, passwordHash, stamp).run();
  } catch {
    return { error: 'An account with that email may already exist.' };
  }
  await db.prepare(`INSERT INTO reviewers (sub, name, email, department, role, status, created_at, last_seen_at)
    VALUES (?, ?, ?, NULL, 'head', 'pending', ?, ?)`).bind(normalized, name.trim().slice(0, 120), normalized, stamp, stamp).run();
  return { email: normalized, name: name.trim().slice(0, 120) };
}
export async function loginPasswordUser(db, request, email, password) {
  const normalized = email.trim().toLowerCase();
  const row = await db.prepare('SELECT email, name, salt, password_hash FROM auth_users WHERE email = ?').bind(normalized).first();
  // Perform a derivation even for unknown users to reduce account-enumeration timing differences.
  const salt = row?.salt || '00112233445566778899aabbccddeeff';
  const candidate = await derive(password, salt);
  if (!row || !safeEqual(candidate, row.password_hash)) return null;
  const token = randomHex(32);
  const tokenHash = await digest(token);
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  await db.prepare('INSERT INTO auth_sessions (token_hash, email, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .bind(tokenHash, normalized, expires, new Date().toISOString()).run();
  return { email: normalized, name: row.name, setCookie: cookie(request, token, SESSION_TTL_SECONDS) };
}
export async function getPasswordUser(db, request) {
  const token = readCookie(request, cookieName(request));
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = await digest(token);
  const row = await db.prepare(`SELECT u.email, u.name FROM auth_sessions s JOIN auth_users u ON u.email = s.email
    WHERE s.token_hash = ? AND s.expires_at > ?`).bind(tokenHash, Math.floor(Date.now() / 1000)).first();
  return row ? { sub: row.email, email: row.email, name: row.name, picture: null } : null;
}
export async function logoutPasswordUser(db, request) {
  const token = readCookie(request, cookieName(request));
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    await db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(await digest(token)).run();
  }
  return cookie(request, '', 0);
}
export const authCookieName = cookieName;
