// api/magic-link.js
// Step 1 of passwordless login: user submits their email, we generate a
// short-lived one-time token, email them a link containing it.
//
// SETUP NEEDED (both free):
// 1. Create a free account at https://resend.com (100 emails/day free, no card).
// 2. Get your API key from their dashboard.
// 3. Vercel -> Settings -> Environment Variables -> add RESEND_API_KEY.
// 4. Also add SITE_URL = https://<your-vercel-domain> (used to build the link).
// 5. Optional: verify your own domain in Resend later to send from
//    "you@verisyn.app" instead of the shared "onboarding@resend.dev" sender —
//    not required to get started.

import { kv, generateToken } from './_lib.js';
import { sendMagicLinkEmail } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { email } = req.body || {};
  if (!email || !email.includes('@')) { res.status(400).json({ error: 'A valid email is required.' }); return; }
  const normalizedEmail = email.trim().toLowerCase();

  const token = generateToken();
  await kv.set(`magic:${token}`, normalizedEmail, { ex: 60 * 15 }); // 15 minute expiry

  const siteUrl = process.env.SITE_URL || `https://${req.headers.host}`;
  const link = `${siteUrl}/api/magic-verify?token=${token}`;

  const sent = await sendMagicLinkEmail(normalizedEmail, link);
  if (!sent) {
    res.status(500).json({ error: 'Could not send the email right now. Try again shortly, or use Google / password sign-in.' });
    return;
  }

  res.status(200).json({ sent: true });
}
