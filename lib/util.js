// Shared primitives: ids, encoding, dates, small parsers, HTTP helpers.

export const json = (data, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(data), { ...init, headers });
};

export const errorJson = (message, status = 400, extra = {}) =>
  json({ error: message, ...extra }, { status });

/** Personalized / user-scoped responses must never be cached. */
export const privateJson = (data, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set('cache-control', 'private, no-store');
  return json(data, { ...init, headers });
};

export const nowIso = () => new Date().toISOString();

export const uuid = () => crypto.randomUUID();

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alike characters

/** Human-readable public reference the claimant uses to track their claim. */
export const claimId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return 'CLM-' + Array.from(bytes, (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
};

export const trackingSecret = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join('');
};

export const sha256Hex = async (bytes) => {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
};

export const toBase64 = (bytes) => {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
};

export const parseJson = (value, fallback) => {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

export const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** "12,500.50" / "$12,500" / 12500 -> cents (integer) */
export const toCents = (input) => {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 100) : null;
  const cleaned = String(input).replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? Math.round(value * 100) : null;
};

export const fromCents = (cents) =>
  typeof cents === 'number' ? (cents / 100).toFixed(2) : null;

export const daysBetween = (a, b) =>
  Math.round((Date.parse(a) - Date.parse(b)) / 86400000);

export const isIsoDate = (value) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

export const clean = (value, max = 2000) => {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
};

export const truthy = (value) => String(value).toLowerCase() === 'true';

/** Read a Request body as JSON with a size ceiling. */
export async function readJson(request, maxBytes = 64 * 1024) {
  const text = await request.text();
  if (text.length > maxBytes) throw new Error('Request body too large');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON body');
  }
}
