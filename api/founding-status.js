// api/founding-status.js
// Tracks how many Founding Member spots (limited to 200) have been claimed,
// so the site can show "X spots left" and hide the offer once it's sold out.

import { Redis } from '@upstash/redis';
const kv = Redis.fromEnv();

const FOUNDING_LIMIT = 200;

export default async function handler(req, res) {
  try {
    const claimed = Number(await kv.get('verisyn:founding_claimed') || 0);
    res.status(200).json({ remaining: Math.max(0, FOUNDING_LIMIT - claimed), limit: FOUNDING_LIMIT });
  } catch (err) {
    console.error(err);
    res.status(200).json({ remaining: 0, limit: FOUNDING_LIMIT }); // fail safe: hide the offer rather than error
  }
}
