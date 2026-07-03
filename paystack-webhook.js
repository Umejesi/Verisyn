// api/paystack-webhook.js
// Verisyn Paystack webhook — Vercel serverless function.
//
// WHAT THIS DOES:
// Paystack calls this URL automatically every time a payment event happens.
// On a successful charge, it generates a Pro code, stores it two ways:
//   1. Added to the same `verisyn:valid_codes` set your manual /api/redeem already checks
//      (so it works exactly like a manually-issued code — no separate logic to maintain).
//   2. Mapped to the payment's unique `reference` for 24 hours, so the site can look it up
//      right after payment and unlock Pro automatically without the user typing anything.
//
// SETUP (once your Paystack account is verified):
// 1. Vercel -> Settings -> Environment Variables -> add:
//      PAYSTACK_SECRET_KEY = sk_live_xxxxx  (or sk_test_xxxxx while testing)
// 2. Paystack Dashboard -> Settings -> API Keys & Webhooks -> Webhook URL:
//      https://<your-vercel-domain>/api/paystack-webhook
// 3. Redeploy so the env var takes effect.
// 4. Test with a real (or Paystack test-mode) payment and check Vercel's runtime logs
//    to confirm you see "Generated Pro code ..." in the output.
//
// IMPORTANT IF YOU REUSE THIS PAYSTACK ACCOUNT FOR OTHER SITES:
// Paystack webhooks are set per-account, not per-website — so this same URL would
// receive events from any other product using the same account. This file only acts
// on charges whose metadata.product === 'verisyn' (set automatically by the site's
// checkout button), so other sites' payments are safely ignored here. If you build
// a webhook for another product on the same account, give it a different metadata
// tag and point it at a different endpoint file.

import crypto from 'crypto';
import { Redis } from '@upstash/redis';

const kv = Redis.fromEnv();

// We need the exact raw request bytes to verify Paystack's signature, so we
// disable Vercel's automatic JSON body parsing and read the stream ourselves.
export const config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function generateCode() {
  const rand = crypto.randomBytes(5).toString('hex').toUpperCase();
  return `VERISYN-${rand}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).end('Method not allowed'); return; }

  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    console.error('PAYSTACK_SECRET_KEY is not set.');
    res.status(500).end('Server not configured');
    return;
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers['x-paystack-signature'];
  const expectedHash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');

  if (signature !== expectedHash) {
    console.warn('Paystack webhook signature mismatch — rejecting.');
    res.status(401).end('Invalid signature');
    return;
  }

  let event;
  try { event = JSON.parse(rawBody); } catch { res.status(400).end('Bad payload'); return; }

  if (event.event === 'charge.success') {
    const reference = event.data?.reference;
    const email = event.data?.customer?.email || 'unknown';
    const product = event.data?.metadata?.product;

    // If this Paystack account is shared across multiple sites/products, the same
    // account-level webhook fires for ALL of them. Only act on payments tagged
    // for Verisyn specifically — everything else is silently ignored here.
    if (product !== 'verisyn') {
      console.log(`Ignoring charge ${reference} — not tagged for Verisyn (product: ${product || 'none'}).`);
      res.status(200).json({ received: true, ignored: true });
      return;
    }

    if (reference) {
      const already = await kv.get(`paystack:ref:${reference}`);
      if (!already) {
        const code = generateCode();
        await kv.sadd('verisyn:valid_codes', code);
        await kv.set(`paystack:ref:${reference}`, code, { ex: 60 * 60 * 24 }); // 24h pickup window
        console.log(`Generated Pro code ${code} for ${email} (ref: ${reference})`);
      }
    }
  }

  // Always 200 quickly so Paystack doesn't retry unnecessarily.
  res.status(200).json({ received: true });
}
