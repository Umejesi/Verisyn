// api/watchlist.js
// Merged: previously api/watchlist.js + api/cron-watchlist-check.js.
// Combined into one file to stay under Vercel's Hobby plan function limit.
//
// Normal use (from the site, with a session cookie):
//   GET    -> list current watchlist for the logged-in Pro user
//   POST   -> add {address, chain, label}
//   DELETE -> remove ?address=...
//
// Cron use (triggered automatically once a day by vercel.json):
//   GET with header "Authorization: Bearer <CRON_SECRET>" -> runs the daily
//   alert check across ALL users' watchlists instead of returning one user's list.
//   Vercel adds this header automatically for scheduled cron invocations once
//   CRON_SECRET is set as an env var — no extra code needed to trigger it.

import { kv, getSessionUser, sendEmail } from './_lib.js';

export default async function handler(req, res) {
  // --- cron path: runs the daily check across every Pro user's watchlist ---
  if (req.method === 'GET' && req.headers.authorization === `Bearer ${process.env.CRON_SECRET}`) {
    const result = await runDailyWatchlistCheck();
    res.status(200).json(result);
    return;
  }

  // --- public path: the homepage's live alert feed, no login required.
  // Shows real detected changes with the address truncated, no user info. ---
  if (req.method === 'GET' && req.query?.public === '1') {
    const feed = (await kv.get('public:alerts')) || [];
    const totalScans = Number(await kv.get('verisyn:total_scans') || 0);
    res.status(200).json({ feed: feed.slice(0, 20), totalScans });
    return;
  }

  // --- normal user paths: require a logged-in session ---
  const user = await getSessionUser(req);
  if (!user) { res.status(401).json({ error: 'Log in first.' }); return; }

  // Scan history is available to any logged-in user (not Pro-gated) — it's
  // what powers the dashboard's "recent scans" widget for everyone with an account.
  if (req.method === 'GET' && req.query?.history === '1') {
    const history = (await kv.get(`scan_history:${user.email}`)) || [];
    res.status(200).json({ history });
    return;
  }

  if (!user.isPro) { res.status(403).json({ error: 'Server-side watchlists with alerts are a Pro feature.' }); return; }

  const key = `watchlist:${user.email}`;

  if (req.method === 'GET') {
    const list = await kv.get(key);
    res.status(200).json({ items: list || [] });
    return;
  }

  if (req.method === 'POST') {
    const { address, chain, label } = req.body || {};
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) { res.status(400).json({ error: 'Invalid address.' }); return; }
    const list = (await kv.get(key)) || [];
    if (list.some(i => i.address === address)) { res.status(200).json({ items: list }); return; }
    list.unshift({ address, chain: chain || '1', label: label || address.slice(0, 8), addedAt: Date.now(), lastSnapshot: null });
    await kv.set(key, list.slice(0, 100));
    res.status(200).json({ items: list });
    return;
  }

  if (req.method === 'DELETE') {
    const address = req.query?.address;
    let list = (await kv.get(key)) || [];
    list = list.filter(i => i.address !== address);
    await kv.set(key, list);
    res.status(200).json({ items: list });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
}

async function runDailyWatchlistCheck() {
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

          // Push an anonymized version to the public live feed — no user info,
          // just the fact that something real got caught.
          const publicFeed = (await kv.get('public:alerts')) || [];
          publicFeed.unshift({
            addressShort: `${item.address.slice(0,6)}…${item.address.slice(-4)}`,
            chain: item.chain,
            summary: diffs[0],
            timestamp: Date.now()
          });
          await kv.set('public:alerts', publicFeed.slice(0, 50));
        }
      } catch (err) {
        console.error(`Watchlist check failed for ${item.address}:`, err);
      }
    }

    if (changed) await kv.set(key, list);
  }

  return { checked, alerted };
}
