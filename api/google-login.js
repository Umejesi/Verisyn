// api/google-login.js
// Step 1 of Google Sign-In: redirects the user to Google's consent screen.
//
// SETUP NEEDED (free, no per-user cost):
// 1. Go to https://console.cloud.google.com -> create a project (any name, e.g. "Verisyn").
// 2. Left menu -> APIs & Services -> OAuth consent screen -> set it up:
//      - User type: External
//      - App name: Verisyn (this is what users see on Google's consent screen)
//      - Add your email as a test user if it's still in "Testing" mode.
// 3. Left menu -> APIs & Services -> Credentials -> Create Credentials -> OAuth client ID:
//      - Application type: Web application
//      - Authorized redirect URI: https://<your-vercel-domain>/api/google-callback
// 4. Copy the Client ID and Client Secret it gives you.
// 5. Vercel -> Settings -> Environment Variables -> add:
//      GOOGLE_CLIENT_ID = ...
//      GOOGLE_CLIENT_SECRET = ...
//      SITE_URL = https://<your-vercel-domain>  (if not already set from Paystack/magic-link setup)

import crypto from 'crypto';
import { setShortCookie, requireSiteUrl } from './_lib.js';

export default async function handler(req, res) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  let siteUrl;
  try { siteUrl = requireSiteUrl(); }
  catch { res.status(500).json({ error: 'Server misconfigured — SITE_URL not set.' }); return; }

  if (!clientId) {
    res.redirect(302, `${siteUrl}/?auth_error=google_not_configured`);
    return;
  }

  const state = crypto.randomBytes(16).toString('hex');
  setShortCookie(res, 'verisyn_oauth_state', state, 60 * 10); // 10 minutes to complete the flow

  const redirectUri = `${siteUrl}/api/google-callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    prompt: 'select_account'
  });

  res.redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}
