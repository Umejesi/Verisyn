// api/magic.js
// Merged: previously api/magic-link.js + api/magic-verify.js.
// Combined into one file to stay under Vercel's Hobby plan function limit.
//
// POST { email } -> sends the sign-in link (was api/magic-link.js)
// GET ?token=...  -> verifies it and logs the user in (was api/magic-verify.js)
//
// Security: rate limited per email AND per IP so this can't be used to spam
// a stranger's inbox with sign-in links or burn through your Resend quota.
// SITE_URL must be a real env var (never trusts the request's Host header).

import { kv, generateToken, setSessionCookie, getOrCreateUser, sendMagicLinkEmail,
         checkRateLimit, getClientIp, requireSiteUrl } from './_lib.js';

export default async function handler(req, res) {
  let siteUrl;
  try { siteUrl = requireSiteUrl(); }
  catch { res.status(500).json({ error: 'Server misconfigured — SITE_URL not set.' }); return; }

  if (req.method === 'GET') {
    const token = req.query?.token;
    if (!token) { res.redirect(302, `${siteUrl}/?auth_error=missing_token`); return; }

    const email = await kv.get(`magic:${token}`);
    if (!email) { res.redirect(302, `${siteUrl}/?auth_error=expired_link`); return; }

    await kv.del(`magic:${token}`); // single-use

    await getOrCreateUser(email);
    const sessionToken = generateToken();
    await kv.set(`session:${sessionToken}`, email, { ex: 60 * 60 * 24 * 30 });
    setSessionCookie(res, sessionToken);

    res.redirect(302, `${siteUrl}/?authed=1`);
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { email } = req.body || {};
  if (!email || !email.includes('@')) { res.status(400).json({ error: 'A valid email is required.' }); return; }
  const normalizedEmail = email.trim().toLowerCase();
  const ip = getClientIp(req);

  // Cap per-email requests (stops someone spamming a stranger's inbox) and
  // per-IP requests (stops one person mass-requesting links for many emails).
  const okEmail = await checkRateLimit(`ratelimit:magic:email:${normalizedEmail}`, 3, 15 * 60);
  const okIp = await checkRateLimit(`ratelimit:magic:ip:${ip}`, 10, 60 * 60);
  if (!okEmail || !okIp) {
    res.status(429).json({ error: 'Too many sign-in link requests. Try again in a few minutes.' });
    return;
  }

  const token = generateToken();
  await kv.set(`magic:${token}`, normalizedEmail, { ex: 60 * 15 }); // 15 minute expiry

  const link = `${siteUrl}/api/magic?token=${token}`;
  const sent = await sendMagicLinkEmail(normalizedEmail, link);
  if (!sent) {
    res.status(500).json({ error: 'Could not send the email right now. Try again shortly, or use Google / password sign-in.' });
    return;
  }

  res.status(200).json({ sent: true });
}
