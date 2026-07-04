// api/cron-watchlist-check.js
// Runs automatically once a day (see vercel.json) — this is what makes "New
// Token Alerts" a real, working feature instead of a promise. For every Pro
// user's watchlist, it re-checks each token and emails them if something
// meaningful changed: ownership status, mint permission, liquidity lock, or tax.
//
// SECURITY: protected by CRON_SECRET so random internet requests can't trigger
// it and burn through your Resend/GoPlus quota. Vercel automatically sends
// this secret when it calls scheduled cron jobs — you just need to set the
// env var once.
//
// SETUP:
// 1. Vercel -> Settings -> Environment Variables -> add CRON_SECRET (any random string you make up).
// 2. Vercel Cron reads vercel.json automatically on deploy — no dashboard setup needed.
// 3. Free tier note: Vercel's Hobby plan allows cron jobs but limits how often
//    they can run (roughly once/day) — that's exactly what vercel.json uses here.

import { kv, sendEmail } from './_lib.js';

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const keys = await kv.keys('watchlist:*');
  let checked = 0, alerted = 0;

  for (const key of keys) {
    const email = key.replace('watchlist:', '');
    const list = await kv.get(key);
    if (!list || list.length === 0) continue;

    let changed = false;
    for (const item of list) {
      checked++;
      try {
        const secRes = await fetch(`https://api.gopluslabs.io/api/v1/token_security/${item.chain}?contract_addresses=${item.address}`);
        const secData = await secRes.json();
        const s = secData.result?.[Object.keys(secData.result || {})[0]];
        if (!s) continue;

        const lp = s.lp_holders || [];
        const lockedPct = Math.round(lp.filter(h => h.is_locked === 1).reduce((a, h) => a + parseFloat(h.percent || 0), 0) * 100);
        const snapshot = {
          mintable: s.is_mintable === '1',
          hiddenOwner: s.hidden_owner === '1',
          canReclaim: s.can_take_back_ownership === '1',
          buyTax: Math.round(parseFloat(s.buy_tax || 0) * 100),
          sellTax: Math.round(parseFloat(s.sell_tax || 0) * 100),
          lockedPct
        };

        const prev = item.lastSnapshot;
        const diffs = [];
        if (prev) {
          if (prev.mintable !== snapshot.mintable) diffs.push(`Mint permission changed to ${snapshot.mintable ? 'MINTABLE' : 'not mintable'}`);
          if (prev.hiddenOwner !== snapshot.hiddenOwner) diffs.push(`Owner visibility changed`);
          if (prev.canReclaim !== snapshot.canReclaim) diffs.push(`Ownership reclaim permission changed`);
          if (Math.abs(prev.buyTax - snapshot.buyTax) >= 3 || Math.abs(prev.sellTax - snapshot.sellTax) >= 3) diffs.push(`Tax changed to ${snapshot.buyTax}% buy / ${snapshot.sellTax}% sell`);
          if (prev.lockedPct >= 50 && snapshot.lockedPct < 30) diffs.push(`Liquidity lock dropped to ${snapshot.lockedPct}% — possible unlock`);
        }

        item.lastSnapshot = snapshot;
        if (diffs.length > 0) {
          changed = true;
          alerted++;
          await sendEmail(email, `⚠️ Verisyn alert: ${item.label} changed`,
            `<p>Something changed on a token you're watching:</p>
             <p><b>${item.label}</b> (${item.address})</p>
             <ul>${diffs.map(d => `<li>${d}</li>`).join('')}</ul>
             <p><a href="https://verisyn-five.vercel.app/?a=${item.address}&c=${item.chain}">View full report</a></p>`);
        }
      } catch (err) {
        console.error(`Watchlist check failed for ${item.address}:`, err);
      }
    }

    if (changed) await kv.set(key, list);
  }

  res.status(200).json({ checked, alerted });
}
