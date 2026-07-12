// api/auth.js
// Handles account creation, login, logout, "am I logged in" checks, and
// subscription cancellation (folded in here rather than a new file, to stay
// well under Vercel's Hobby plan limit of 12 serverless functions).
// GET  -> returns current session state: {loggedIn, email, isPro, plan, subscriptionCode}
// POST -> body.action = 'signup' | 'login' | 'logout' | 'cancel_subscription'

import { kv, hashPassword, verifyPassword, generateToken, setSessionCookie,
         clearSessionCookie, getSessionUser, getUserRecord, saveUserRecord,
         checkRateLimit, getClientIp, sendEmail, isPasswordBreached, parseCookies,
         todayKey, GUEST_LIMIT, REGISTERED_LIMIT } from './_lib.js';

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const user = await getSessionUser(req);
    if (!user) {
      // Not logged in — return real guest quota remaining if a guestId was passed.
      const guestId = req.query?.guestId;
      let remaining = null;
      if (guestId) {
        const used = Number(await kv.get(`quota:guest:${guestId}:${todayKey()}`) || 0);
        remaining = Math.max(0, GUEST_LIMIT - used);
      }
      res.status(200).json({ loggedIn: false, remaining });
      return;
    }
    const record = await getUserRecord(user.email);
    let remaining = null;
    if (!user.isPro) {
      const used = Number(await kv.get(`quota:user:${user.email}:${todayKey()}`) || 0);
      remaining = Math.max(0, REGISTERED_LIMIT - used);
    }
    res.status(200).json({
      loggedIn: true, email: user.email, isPro: user.isPro, isProPlus: user.isProPlus,
      plan: record?.plan || null, subscriptionCode: record?.subscriptionCode || null,
      remaining
    });
    return;
  }

  if (req.method !== 'POST') { res.status(405).end(); return; }

  const { action, email, password, remember } = req.body || {};
  const ip = getClientIp(req);

  if (action === 'logout') {
    clearSessionCookie(res);
    res.status(200).json({ ok: true });
    return;
  }

  if (action === 'logout_other_sessions') {
    const user = await getSessionUser(req);
    if (!user) { res.status(401).json({ error: 'Log in first.' }); return; }
    const currentToken = parseCookies(req)['verisyn_session'];
    const allTokens = await kv.smembers(`user_sessions:${user.email}`);
    let revoked = 0;
    for (const t of allTokens) {
      if (t !== currentToken) {
        await kv.del(`session:${t}`);
        await kv.srem(`user_sessions:${user.email}`, t);
        revoked++;
      }
    }
    res.status(200).json({ ok: true, revoked });
    return;
  }

  if (action === 'priority_support') {
    const user = await getSessionUser(req);
    if (!user || !user.isProPlus) { res.status(403).json({ error: 'Priority support is a Pro+ feature.' }); return; }

    const okRate = await checkRateLimit(`ratelimit:support:${user.email}`, 5, 60 * 60);
    if (!okRate) { res.status(429).json({ error: 'Too many messages sent recently. Try again later.' }); return; }

    const { message } = req.body || {};
    if (!message || message.trim().length < 5) { res.status(400).json({ error: 'Please write a message first.' }); return; }

    const supportEmail = process.env.SUPPORT_EMAIL;
    if (!supportEmail) { res.status(500).json({ error: 'Support inbox not configured yet.' }); return; }

    const sent = await sendEmail(supportEmail, `[Pro+ Priority] Support message from ${user.email}`,
      `<p><b>From:</b> ${user.email} (Pro+ subscriber)</p><p>${message.replace(/</g,'&lt;')}</p>`);
    if (!sent) { res.status(500).json({ error: 'Could not send your message right now. Try again shortly.' }); return; }

    res.status(200).json({ ok: true });
    return;
  }

  if (action === 'cancel_subscription') {
    const user = await getSessionUser(req);
    if (!user) { res.status(401).json({ error: 'Log in first.' }); return; }
    const record = await getUserRecord(user.email);
    if (!record?.subscriptionCode) {
      res.status(400).json({ error: 'No active Paystack subscription found on this account.' });
      return;
    }

    try {
      const fetchRes = await fetch(`https://api.paystack.co/subscription/${record.subscriptionCode}`, {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
      });
      const fetchData = await fetchRes.json();
      const emailToken = fetchData.data?.email_token;
      if (!emailToken) { res.status(500).json({ error: 'Could not verify subscription with Paystack.' }); return; }

      const disableRes = await fetch('https://api.paystack.co/subscription/disable', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: record.subscriptionCode, token: emailToken })
      });
      const disableData = await disableRes.json();
      if (!disableData.status) { res.status(500).json({ error: disableData.message || 'Cancellation failed.' }); return; }

      res.status(200).json({ ok: true, message: 'Subscription cancelled. This can take a few minutes to fully reflect on your account.' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Cancellation failed. Try again shortly.' });
    }
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

    if (await isPasswordBreached(password)) {
      res.status(400).json({ error: 'That password has appeared in known data breaches. Please choose a different one.' });
      return;
    }

    await saveUserRecord(normalizedEmail, { passwordHash: hashPassword(password), isPro: false, createdAt: Date.now() });
    const token = generateToken();
    await kv.set(`session:${token}`, normalizedEmail, { ex: 60 * 60 * 24 * 30 });
    await kv.sadd(`user_sessions:${normalizedEmail}`, token);
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
    const sessionSeconds = remember === false ? (60 * 60 * 12) : (60 * 60 * 24 * 30); // 12h if not remembered, else 30 days
    await kv.set(`session:${token}`, normalizedEmail, { ex: sessionSeconds });
    await kv.sadd(`user_sessions:${normalizedEmail}`, token);
    setSessionCookie(res, token, sessionSeconds);
    res.status(200).json({ email: normalizedEmail, isPro: !!user.isPro });
    return;
  }

  res.status(400).json({ error: 'Unknown action.' });
}
