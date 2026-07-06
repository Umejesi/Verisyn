// api/google-callback.js
// Step 2 of Google Sign-In: Google redirects here with a one-time code.
// We exchange it for the user's email, then log them in the same way as
// any other passwordless flow.

import { kv, generateToken, setSessionCookie, getOrCreateUser, parseCookies, requireSiteUrl } from './_lib.js';

export default async function handler(req, res) {
  let siteUrl;
  try { siteUrl = requireSiteUrl(); }
  catch { res.status(500).json({ error: 'Server misconfigured — SITE_URL not set.' }); return; }
  const { code, state } = req.query || {};

  const cookieState = parseCookies(req)['verisyn_oauth_state'];
  if (!code || !state || state !== cookieState) {
    res.redirect(302, `${siteUrl}/?auth_error=google_state_mismatch`);
    return;
  }

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = `${siteUrl}/api/google-callback`;

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      console.error('Google token exchange failed:', tokenData);
      res.redirect(302, `${siteUrl}/?auth_error=google_token_failed`);
      return;
    }

    const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const userInfo = await userRes.json();
    if (!userInfo.email) {
      res.redirect(302, `${siteUrl}/?auth_error=google_no_email`);
      return;
    }

    const email = userInfo.email.toLowerCase();
    await getOrCreateUser(email);
    const sessionToken = generateToken();
    await kv.set(`session:${sessionToken}`, email, { ex: 60 * 60 * 24 * 30 });
    setSessionCookie(res, sessionToken);

    res.redirect(302, `${siteUrl}/?authed=1`);
  } catch (err) {
    console.error(err);
    res.redirect(302, `${siteUrl}/?auth_error=google_unexpected`);
  }
}
