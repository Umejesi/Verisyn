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

import { kv, getSessionUser, todayKey, getClientIp, GUEST_LIMIT, REGISTERED_LIMIT } from './_lib.js';

const GUEST_IP_LIMIT = 12; // higher than GUEST_LIMIT to allow for shared/office IPs

const CORE_CHAINS = ['1', '56', '8453', '42161'];       // free for everyone
const PRO_CHAINS = ['137', '43114', '10'];              // Polygon, Avalanche, Optimism — Pro only
const CHAIN_NAMES = { '1':'Ethereum', '56':'BSC', '8453':'Base', '42161':'Arbitrum', '137':'Polygon', '43114':'Avalanche', '10':'Optimism', 'solana':'Solana' };
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function fetchTokenSecurity(chain, address) {
  if (chain === 'solana') {
    // GoPlus's Solana Token Security API is still labeled "Beta" by GoPlus
    // themselves, and uses a different response schema than the EVM chains.
    const sRes = await fetch(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${address}`);
    const sData = await sRes.json();
    const key = Object.keys(sData.result || {})[0];
    return key ? { ...sData.result[key], _isSolana: true } : null;
  }
  const sRes = await fetch(`https://api.gopluslabs.io/api/v1/token_security/${chain}?contract_addresses=${address}`);
  const sData = await sRes.json();
  const key = Object.keys(sData.result || {})[0];
  return key ? sData.result[key] : null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { address, chain, mode, guestId } = req.body || {};
  const isValidAddress = chain === 'solana' ? SOLANA_ADDRESS_RE.test(address || '') : /^0x[a-fA-F0-9]{40}$/.test(address || '');
  if (!address || !isValidAddress) { res.status(400).json({ error: 'Invalid address.' }); return; }
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

  if (mode === 'wallet' && chain === 'solana') {
    res.status(400).json({ error: 'Wallet analysis is not yet available for Solana.' });
    return;
  }

  if (mode === 'wallet' && tier !== 'pro') {
    res.status(403).json({ error: 'Wallet analysis is a Pro feature.', tier });
    return;
  }

  if (PRO_CHAINS.includes(chain) && tier !== 'pro') {
    res.status(403).json({ error: 'This chain is a Pro feature. Upgrade to scan Polygon, Avalanche, or Optimism.', tier });
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
    let security, market = null, detectedChain = chain, chainMismatch = false, marketDataError = false;

    if (mode === 'wallet') {
      const wRes = await fetch(`https://api.gopluslabs.io/api/v1/address_security/${address}?chain_id=${chain}`);
      const wData = await wRes.json();
      if (!wData.result) { res.status(404).json({ error: 'No wallet data found.' }); return; }
      security = wData.result;
    } else {
      security = await fetchTokenSecurity(chain, address);

      // Not found on the requested chain — auto-check the other chains this
      // account is allowed to use, in case the address just exists on a
      // different one. Prevents confidently scoring the wrong token entirely.
      // Skipped for Solana since its address format never matches EVM chains anyway.
      if (!security && chain !== 'solana') {
        const chainsToTry = [
          ...CORE_CHAINS.filter(c => c !== chain),
          ...(tier === 'pro' ? PRO_CHAINS.filter(c => c !== chain) : [])
        ];
        for (const tryChain of chainsToTry) {
          const found = await fetchTokenSecurity(tryChain, address);
          if (found) { security = found; detectedChain = tryChain; chainMismatch = true; break; }
        }
      }

      if (!security) { res.status(404).json({ error: 'No security data found for this address on any supported chain.' }); return; }

      try {
        const mRes = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
        if (!mRes.ok) throw new Error('DexScreener returned an error status');
        const mData = await mRes.json();
        if (mData.pairs && mData.pairs.length > 0) {
          market = mData.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
        }
      } catch (err) {
        console.error('DexScreener fetch failed:', err);
        marketDataError = true;
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
    try { await kv.incr('verisyn:total_scans'); } catch {} // real counter for the trust indicator on the login page

    res.status(200).json({
      security, market, tier, remaining,
      detectedChain, chainMismatch,
      detectedChainName: chainMismatch ? CHAIN_NAMES[detectedChain] : null,
      marketDataError
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Scan failed. Try again shortly.' });
  }
}
