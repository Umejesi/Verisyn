// api/redeem.js
// Verisyn Pro code redemption — Vercel serverless function.
//
// HOW YOU SELL PRO MANUALLY, BEFORE PAYSTACK IS READY:
// 1. Someone pays you however you can currently accept money (bank transfer, crypto, cash app, etc).
// 2. Generate a code for them — anything unique works, e.g. "VERISYN-JULY-A7F3K9".
// 3. Add that code to your Upstash database as an *unredeemed* code:
//      - Go to your Upstash console -> your database -> "Data Browser" (or CLI tab)
//      - Run this command (Upstash's console has a command box for exactly this):
//          SADD verisyn:valid_codes VERISYN-JULY-A7F3K9
// 4. Email/DM the code to the buyer. They paste it into the "Redeem code" box on the site.
// 5. This endpoint checks the code is in that set AND hasn't been used yet, marks it used,
//    and tells the frontend to unlock Pro. Each code works exactly once.
//
// LATER, WHEN PAYSTACK IS READY:
// Paystack's webhook (on successful payment) can call this same Upstash SADD command
// automatically to generate + store a code, and email it to the customer — no code changes
// needed here, just add a webhook handler that does that SADD step for you.

import { Redis } from '@upstash/redis';

const kv = Redis.fromEnv();

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ valid: false, reason: 'Method not allowed' }); return; }

  const { code } = req.body || {};
  if (!code || typeof code !== 'string') {
    res.status(400).json({ valid: false, reason: 'No code provided.' });
    return;
  }
  const normalized = code.trim().toUpperCase();

  try{
    const isValidUnused = await kv.sismember('verisyn:valid_codes', normalized);
    if (!isValidUnused) {
      const alreadyUsed = await kv.sismember('verisyn:used_codes', normalized);
      res.status(200).json({
        valid: false,
        reason: alreadyUsed ? 'This code has already been used.' : 'Code not recognized.'
      });
      return;
    }

    // consume the code: move it from valid to used, single-use enforced
    await kv.srem('verisyn:valid_codes', normalized);
    await kv.sadd('verisyn:used_codes', normalized);

    res.status(200).json({ valid: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ valid: false, reason: 'Server error, try again shortly.' });
  }
}
