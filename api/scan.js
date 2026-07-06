// api/scan.js
// Every scan (token or wallet) now goes through here instead of hitting
// GoPlus/DexScreener directly from the browser. This is what makes the
// guest/registered/Pro tiers real instead of a client-side counter that
// resets on refresh.
//
// Guest (not logged in): 3 scans/day, tracked by a random ID the browser
//   generates once and stores locally. On its own this is bypassable by
//   clearing browser storage, so it's backed by a second, more generous
//   per-IP limit too — clearing storage alone no longer resets the count,
//   since the IP-based counter persists independently. A determined person
//   could still get a new IP (VPN, mobile network), but that's a much
//   higher bar than clearing localStorage.
// Registered (logged in, not Pro): 5 scans/day, tracked against their account.
// Pro: unlimited, and the only tier allowed to use wallet analysis.

import { kv, getSessionUser, todayKey, getClientIp } from './_lib.js';

const GUEST_LIMIT = 3;
const GUEST_IP_LIMIT = 12; // higher than GUEST_LIMIT to allow for shared/office IPs
const REGISTERED_LIMIT = 5;

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { address, chain, mode, guestId } = req.body || {};
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) { res.status(400).json({ error: 'Invalid address.' }); return; }
  if (!chain) { res.status(400).json({ error: 'Missing chain.' }); return; }

  const user = await getSessionUser(req);
  let tier, quotaKey, limit, ipQuotaKey;

  if (user && user.isPro) {
    tier = 'pro'; limit = Infinity;
  } else if (user) {
    tier = 'registered'; limit = REGISTERED_LIMIT;
    quotaKey = `quota:user:${user.email}:${todayKey()}`;
  } else {
    if (!guestId) { res.status(400).json({ error: 'Missing guest id.' }); return; }
    tier = 'guest'; limit = GUEST_LIMIT;
    quotaKey = `quota:guest:${guestId}:${todayKey()}`;
    ipQuotaKey = `quota:guestip:${getClientIp(req)}:${todayKey()}`;
  }

  if (mode === 'wallet' && tier !== 'pro') {
    res.status(403).json({ error: 'Wallet analysis is a Pro feature.', tier });
    return;
  }

  if (quotaKey) {
    const used = Number(await kv.get(quotaKey) || 0);
    const ipUsed = ipQuotaKey ? Number(await kv.get(ipQuotaKey) || 0) : 0;
    if (used >= limit || ipUsed >= GUEST_IP_LIMIT) {
      res.status(429).json({
        error: tier === 'guest'
          ? 'Guest scan limit reached for today. Log in for more free scans.'
          : 'Daily scan limit reached. Upgrade to Pro for unlimited scans.',
        tier, limit, used
      });
      return;
    }
  }

  try {
    let security, market = null;

    if (mode === 'wallet') {
      const wRes = await fetch(`https://api.gopluslabs.io/api/v1/address_security/${address}?chain_id=${chain}`);
      const wData = await wRes.json();
      if (!wData.result) { res.status(404).json({ error: 'No wallet data found.' }); return; }
      security = wData.result;
    } else {
      const sRes = await fetch(`https://api.gopluslabs.io/api/v1/token_security/${chain}?contract_addresses=${address}`);
      const sData = await sRes.json();
      const key = Object.keys(sData.result || {})[0];
      if (!key) { res.status(404).json({ error: 'No security data found for this address.' }); return; }
      security = sData.result[key];

      const mRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
      const mData = await mRes.json();
      if (mData.pairs && mData.pairs.length > 0) {
        market = mData.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
      }
    }

    let remaining = null;
    if (quotaKey) {
      const newCount = await kv.incr(quotaKey);
      if (newCount === 1) await kv.expire(quotaKey, 60 * 60 * 24);
      remaining = Math.max(0, limit - newCount);
    }
    if (ipQuotaKey) {
      const newIpCount = await kv.incr(ipQuotaKey);
      if (newIpCount === 1) await kv.expire(ipQuotaKey, 60 * 60 * 24);
    }

    res.status(200).json({ security, market, tier, remaining });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Scan failed. Try again shortly.' });
  }
}
