// api/auth.js
// Handles account creation, login, logout, and "am I logged in" checks.
// GET  -> returns current session state: {loggedIn, email, isPro}
// POST -> body.action = 'signup' | 'login' | 'logout'

import { kv, hashPassword, verifyPassword, generateToken, setSessionCookie,
         clearSessionCookie, getSessionUser, getUserRecord, saveUserRecord } from './_lib.js';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const user = await getSessionUser(req);
    res.status(200).json(user ? { loggedIn: true, email: user.email, isPro: user.isPro } : { loggedIn: false });
    return;
  }

  if (req.method !== 'POST') { res.status(405).end(); return; }

  const { action, email, password } = req.body || {};

  if (action === 'logout') {
    clearSessionCookie(res);
    res.status(200).json({ ok: true });
    return;
  }

  if (!email || !email.includes('@')) { res.status(400).json({ error: 'A valid email is required.' }); return; }
  if (!password || password.length < 6) { res.status(400).json({ error: 'Password must be at least 6 characters.' }); return; }
  const normalizedEmail = email.trim().toLowerCase();

  if (action === 'signup') {
    const existing = await getUserRecord(normalizedEmail);
    if (existing) { res.status(409).json({ error: 'An account with this email already exists — try logging in.' }); return; }

    await saveUserRecord(normalizedEmail, { passwordHash: hashPassword(password), isPro: false, createdAt: Date.now() });
    const token = generateToken();
    await kv.set(`session:${token}`, normalizedEmail, { ex: 60 * 60 * 24 * 30 });
    setSessionCookie(res, token);
    res.status(200).json({ email: normalizedEmail, isPro: false });
    return;
  }

  if (action === 'login') {
    const user = await getUserRecord(normalizedEmail);
    if (!user) { res.status(401).json({ error: 'No account found with this email.' }); return; }
    if (!verifyPassword(password, user.passwordHash)) { res.status(401).json({ error: 'Incorrect password.' }); return; }

    const token = generateToken();
    await kv.set(`session:${token}`, normalizedEmail, { ex: 60 * 60 * 24 * 30 });
    setSessionCookie(res, token);
    res.status(200).json({ email: normalizedEmail, isPro: !!user.isPro });
    return;
  }

  res.status(400).json({ error: 'Unknown action.' });
}
