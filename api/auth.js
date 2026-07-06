// api/auth.js
// Handles account creation, login, logout, and "am I logged in" checks.
// GET  -> returns current session state: {loggedIn, email, isPro}
// POST -> body.action = 'signup' | 'login' | 'logout'

import { kv, hashPassword, verifyPassword, generateToken, setSessionCookie,
         clearSessionCookie, getSessionUser, getUserRecord, saveUserRecord,
         checkRateLimit, getClientIp } from './_lib.js';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const user = await getSessionUser(req);
    res.status(200).json(user ? { loggedIn: true, email: user.email, isPro: user.isPro, isProPlus: user.isProPlus } : { loggedIn: false });
    return;
  }

  if (req.method !== 'POST') { res.status(405).end(); return; }

  const { action, email, password } = req.body || {};
  const ip = getClientIp(req);

  if (action === 'logout') {
    clearSessionCookie(res);
    res.status(200).json({ ok: true });
    return;
  }

  if (!email || !email.includes('@')) { res.status(400).json({ error: 'A valid email is required.' }); return; }
  if (!password || password.length < 6) { res.status(400).json({ error: 'Password must be at least 6 characters.' }); return; }
  const normalizedEmail = email.trim().toLowerCase();

  if (action === 'signup') {
    // Cap new account creation per IP — slows down mass fake-account creation.
    const okIp = await checkRateLimit(`ratelimit:signup:ip:${ip}`, 8, 60 * 60);
    if (!okIp) { res.status(429).json({ error: 'Too many accounts created from this network recently. Try again later.' }); return; }

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
    // Cap login attempts by IP and by the specific email being targeted —
    // this is what stops password brute-forcing.
    const okIp = await checkRateLimit(`ratelimit:login:ip:${ip}`, 20, 15 * 60);
    const okEmail = await checkRateLimit(`ratelimit:login:email:${normalizedEmail}`, 8, 15 * 60);
    if (!okIp || !okEmail) { res.status(429).json({ error: 'Too many login attempts. Try again in a few minutes.' }); return; }

    const user = await getUserRecord(normalizedEmail);
    if (!user) { res.status(401).json({ error: 'No account found with this email.' }); return; }
    if (!user.passwordHash) {
      res.status(401).json({ error: 'This account was created with Google or a magic link — use that instead of a password.' });
      return;
    }
    if (!verifyPassword(password, user.passwordHash)) { res.status(401).json({ error: 'Incorrect password.' }); return; }

    const token = generateToken();
    await kv.set(`session:${token}`, normalizedEmail, { ex: 60 * 60 * 24 * 30 });
    setSessionCookie(res, token);
    res.status(200).json({ email: normalizedEmail, isPro: !!user.isPro });
    return;
  }

  res.status(400).json({ error: 'Unknown action.' });
}
