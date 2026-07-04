// api/magic-verify.js
// Step 2 of passwordless login: this is what the link in the email points to.
// Verifies the one-time token, logs the user in (creating their account on
// first sign-in), and redirects back to the site.

import { kv, generateToken, setSessionCookie, getOrCreateUser } from './_lib.js';

export default async function handler(req, res) {
  const token = req.query?.token;
  const siteUrl = process.env.SITE_URL || `https://${req.headers.host}`;

  if (!token) { res.redirect(302, `${siteUrl}/?auth_error=missing_token`); return; }

  const email = await kv.get(`magic:${token}`);
  if (!email) { res.redirect(302, `${siteUrl}/?auth_error=expired_link`); return; }

  await kv.del(`magic:${token}`); // single-use

  await getOrCreateUser(email);
  const sessionToken = generateToken();
  await kv.set(`session:${sessionToken}`, email, { ex: 60 * 60 * 24 * 30 });
  setSessionCookie(res, sessionToken);

  res.redirect(302, `${siteUrl}/?authed=1`);
}
