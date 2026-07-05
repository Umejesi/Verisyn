// api/magic.js
// Merged: previously api/magic-link.js + api/magic-verify.js.
// Combined into one file to stay under Vercel's Hobby plan function limit.
//
// POST { email } -> sends the sign-in link (was api/magic-link.js)
// GET ?token=...  -> verifies it and logs the user in (was api/magic-verify.js)

import { kv, generateToken, setSessionCookie, getOrCreateUser, sendMagicLinkEmail } from './_lib.js';

export default async function handler(req, res) {
  const siteUrl = process.env.SITE_URL || `https://${req.headers.host}`;

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
