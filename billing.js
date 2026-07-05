// api/billing.js
// Merged: previously api/redeem.js + api/founding-status.js.
// Combined into one file purely to stay under Vercel's Hobby plan limit of
// 12 serverless functions per deployment — no behavior changed.
//
// GET  -> founding member spots remaining (was api/founding-status.js)
// POST -> redeem a Pro code (was api/redeem.js)

import { kv, getSessionUser, getUserRecord, saveUserRecord } from './_lib.js';

const FOUNDING_LIMIT = 200;

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const claimed = Number(await kv.get('verisyn:founding_claimed') || 0);
      res.status(200).json({ remaining: Math.max(0, FOUNDING_LIMIT - claimed), limit: FOUNDING_LIMIT });
    } catch (err) {
      console.error(err);
      res.status(200).json({ remaining: 0, limit: FOUNDING_LIMIT });
    }
    return;
  }

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
