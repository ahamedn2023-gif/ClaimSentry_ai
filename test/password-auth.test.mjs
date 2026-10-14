import test from 'node:test';
import assert from 'node:assert/strict';
import { registerPasswordUser, loginPasswordUser, getPasswordUser, logoutPasswordUser } from '../lib/password-auth.js';

class FakeD1 {
  users = new Map(); sessions = new Map(); reviewers = new Map();
  prepare(sql) {
    const db = this; let args = [];
    return {
      bind(...values) { args = values; return this; },
      async run() {
        if (sql.startsWith('INSERT INTO auth_users')) {
          if (db.users.has(args[0])) throw new Error('UNIQUE constraint failed');
          db.users.set(args[0], { email: args[0], name: args[1], salt: args[2], password_hash: args[3], created_at: args[4] });
        } else if (sql.startsWith('INSERT INTO reviewers')) {
          db.reviewers.set(args[0], { sub: args[0], name: args[1], email: args[2], department: null, role: 'head', status: 'pending' });
        } else if (sql.startsWith('INSERT INTO auth_sessions')) {
          db.sessions.set(args[0], { token_hash: args[0], email: args[1], expires_at: args[2], created_at: args[3] });
        } else if (sql.startsWith('DELETE FROM auth_sessions')) db.sessions.delete(args[0]);
        return { success: true };
      },
      async first() {
        if (sql.startsWith('SELECT email, name, salt, password_hash FROM auth_users')) return db.users.get(args[0]) || null;
        if (sql.includes('JOIN auth_users')) {
          const session = db.sessions.get(args[0]);
          if (!session || session.expires_at <= args[1]) return null;
          const user = db.users.get(session.email);
          return user ? { email: user.email, name: user.name } : null;
        }
        return null;
      },
    };
  }
}

test('native auth hashes passwords and issues revocable HttpOnly sessions', async () => {
  const db = new FakeD1();
  const registered = await registerPasswordUser(db, 'Reviewer@example.com', 'correct horse battery staple', 'Reviewer');
  assert.equal(registered.email, 'reviewer@example.com');
  const stored = db.users.get('reviewer@example.com');
  assert.ok(stored.password_hash && stored.salt);
  assert.notEqual(stored.password_hash, 'correct horse battery staple');
  assert.equal(db.reviewers.get('reviewer@example.com').status, 'pending');

  assert.equal(await loginPasswordUser(db, new Request('https://claims.example/api/auth/login'), 'reviewer@example.com', 'wrong password'), null);
  const login = await loginPasswordUser(db, new Request('https://claims.example/api/auth/login'), 'reviewer@example.com', 'correct horse battery staple');
  assert.match(login.setCookie, /HttpOnly/);
  assert.match(login.setCookie, /SameSite=Strict/);
  assert.match(login.setCookie, /Secure/);
  const cookiePair = login.setCookie.split(';')[0];
  const request = new Request('https://claims.example/api/reviewer/session', { headers: { cookie: cookiePair } });
  const user = await getPasswordUser(db, request);
  assert.equal(user.email, 'reviewer@example.com');
  await logoutPasswordUser(db, request);
  assert.equal(await getPasswordUser(db, request), null);
});
