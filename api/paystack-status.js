// api/paystack-status.js
// Lets the site check, right after a Paystack payment, whether the webhook has
// generated a Pro code yet for a given transaction reference. The frontend
// polls this a few times (webhooks usually arrive within a second or two).

import { Redis } from '@upstash/redis';

const kv = Redis.fromEnv();

export default async function handler(req, res) {
  const reference = req.query?.reference;
  if (!reference) { res.status(400).json({ ready: false, error: 'Missing reference' }); return; }

  try {
    const code = await kv.get(`paystack:ref:${reference}`);
    if (code) res.status(200).json({ ready: true, code });
    else res.status(200).json({ ready: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ready: false, error: 'Server error' });
  }
}
