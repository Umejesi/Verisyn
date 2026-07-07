// api/paystack-webhook.js
// Verisyn Paystack webhook — Vercel serverless function.
//
// WHAT THIS DOES NOW (real recurring subscriptions, not one-time codes):
// Paystack calls this URL on every payment event. When a charge succeeds —
// whether it's the first payment or an automatic monthly renewal — this
// looks up the paying customer's account by email and sets isPro = true
// directly on their account record. When Paystack reports a subscription was
// cancelled or stopped renewing, this sets isPro = false the same way.
// A backup one-time code is still generated on each successful charge purely
// as a receipt/fallback the frontend can display — the real activation no
// longer depends on that code being redeemed.
//
// SETUP (once your Paystack account is verified):
// 1. Vercel -> Settings -> Environment Variables -> add:
//      PAYSTACK_SECRET_KEY = sk_live_xxxxx  (or sk_test_xxxxx while testing)
// 2. Paystack Dashboard -> Settings -> API Keys & Webhooks -> Webhook URL:
//      https://<your-vercel-domain>/api/paystack-webhook
// 3. Redeploy so the env var takes effect.
// 4. Test with a real (or Paystack test-mode) subscription payment and check
//    Vercel's runtime logs to confirm "Activated Pro (...) for ..." appears.
//
// IMPORTANT IF YOU REUSE THIS PAYSTACK ACCOUNT FOR OTHER SITES:
// Paystack webhooks are set per-account, not per-website — so this same URL would
// receive events from any other product using the same account. This file only acts
// on charges whose metadata.product === 'verisyn' (set automatically by the site's
// checkout button), so other sites' payments are safely ignored here. If you build
// a webhook for another product on the same account, give it a different metadata
// tag and point it at a different endpoint file.

import crypto from 'crypto';
import { kv, getUserRecord, saveUserRecord } from './_lib.js';

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
  // --- merged in from api/paystack-status.js to stay under Vercel's 12-function limit ---
  // The frontend polls this via GET right after checkout to see if a Pro code is ready yet.
  if (req.method === 'GET') {
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
    return;
  }

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

  // --- Real subscription payment (first charge or a renewal) ---
  if (event.event === 'charge.success') {
    const reference = event.data?.reference;
    const email = event.data?.customer?.email?.toLowerCase();
    const product = event.data?.metadata?.product;
    const planTag = event.data?.metadata?.plan; // 'pro' | 'founding' | 'proplus'
    const isSubscriptionCharge = !!event.data?.plan?.plan_code;

    if (product !== 'verisyn') {
      console.log(`Ignoring charge ${reference} — not tagged for Verisyn (product: ${product || 'none'}).`);
      res.status(200).json({ received: true, ignored: true });
      return;
    }

    // Directly activate the account by email — reliable for both the first
    // payment and every future renewal, no code redemption required.
    if (email) {
      const record = await getUserRecord(email);
      if (record) {
        record.isPro = true;
        record.plan = planTag || record.plan || 'pro';
        record.subscriptionCode = event.data?.subscription_code || record.subscriptionCode || null;
        await saveUserRecord(email, record);
        console.log(`Activated Pro (${record.plan}) for ${email} via ${isSubscriptionCharge ? 'subscription' : 'one-time'} charge.`);
      }
    }

    // Still generate a backup code too — this is what the frontend's polling
    // flow displays as a receipt right after checkout. Harmless if unused.
    if (reference) {
      const already = await kv.get(`paystack:ref:${reference}`);
      if (!already) {
        const code = generateCode();
        await kv.sadd('verisyn:valid_codes', code);
        await kv.set(`paystack:ref:${reference}`, code, { ex: 60 * 60 * 24 });

        if (planTag === 'founding') {
          await kv.incr('verisyn:founding_claimed');
        }
      }
    }
  }

  // --- Subscription cancelled, expired, or payments stopped ---
  if (event.event === 'subscription.disable' || event.event === 'subscription.not_renew') {
    const email = event.data?.customer?.email?.toLowerCase();
    if (email) {
      const record = await getUserRecord(email);
      if (record && record.isPro) {
        record.isPro = false;
        await saveUserRecord(email, record);
        console.log(`Deactivated Pro for ${email} — subscription ${event.event}.`);
      }
    }
  }

  // Always 200 quickly so Paystack doesn't retry unnecessarily.
  res.status(200).json({ received: true });
}
