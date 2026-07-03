// api/redeem.js
// Redeems a Pro code and — this is the important change — saves Pro status
// to the user's ACCOUNT (in Redis), not just their browser. That means Pro
// now survives clearing browser data, switching devices, or reinstalling
// the browser extension. Logging in is required specifically so there's an
// account to attach it to.
//
// HOW YOU SELL PRO MANUALLY (unchanged from before):
// 1. Take payment however you currently can.
// 2. Make up a unique code, e.g. "VERISYN-JULY-A7F3K9".
// 3. In Upstash's console Data Browser/CLI, run:
//      SADD verisyn:valid_codes VERISYN-JULY-A7F3K9
// 4. Send the code to the buyer. They log in (or sign up) on the site first,
//    then redeem the code — Pro attaches to their account permanently.

import { kv, getSessionUser, getUserRecord, saveUserRecord } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ valid: false, reason: 'Method not allowed' }); return; }

  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ valid: false, reason: 'Log in or create a free account first, then redeem your code so Pro saves to it.' });
    return;
  }

  const { code } = req.body || {};
  if (!code || typeof code !== 'string') { res.status(400).json({ valid: false, reason: 'No code provided.' }); return; }
  const normalized = code.trim().toUpperCase();

  try {
    const isValidUnused = await kv.sismember('verisyn:valid_codes', normalized);
    if (!isValidUnused) {
      const alreadyUsed = await kv.sismember('verisyn:used_codes', normalized);
      res.status(200).json({ valid: false, reason: alreadyUsed ? 'This code has already been used.' : 'Code not recognized.' });
      return;
    }

    await kv.srem('verisyn:valid_codes', normalized);
    await kv.sadd('verisyn:used_codes', normalized);

    const record = await getUserRecord(user.email);
    record.isPro = true;
    await saveUserRecord(user.email, record);

    res.status(200).json({ valid: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ valid: false, reason: 'Server error, try again shortly.' });
  }
}
