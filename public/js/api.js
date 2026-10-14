// Thin fetch layer. Same-origin only; the server does the authorizing.

async function asJson(response) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { error: text || 'Unexpected response' }; }
  if (!response.ok) {
    const err = new Error(body?.error || `Request failed (${response.status})`);
    err.status = response.status;
    err.body = body;
    throw err;
  }
  return body;
}

export const api = {
  async get(path) {
    return asJson(await fetch(path, { headers: { accept: 'application/json' }, credentials: 'same-origin' }));
  },
  async post(path, body) {
    return asJson(
      await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body ?? {}),
      }),
    );
  },
  async postForm(path, formData) {
    return asJson(await fetch(path, { method: 'POST', credentials: 'same-origin', body: formData }));
  },
};

export const signInUrl = () => '/reviewer.html';
