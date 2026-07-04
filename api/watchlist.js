// api/watchlist.js
// Server-side watchlist for Pro users. This is what makes "New Token Alerts"
// actually possible — a watchlist that only lives in the browser (localStorage)
// can't be checked by a background job while the user isn't online. Free/guest
// users keep the existing browser-only watchlist (1 item cap) unchanged; this
// endpoint is specifically for Pro accounts so the daily alert check has
// something real to read.
//
// GET    -> list current watchlist for the logged-in Pro user
// POST   -> add {address, chain, label}
// DELETE -> remove ?address=...

import { kv, getSessionUser } from './_lib.js';

export default async function handler(req, res) {
  const user = await getSessionUser(req);
  if (!user) { res.status(401).json({ error: 'Log in first.' }); return; }
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
    await kv.set(key, list.slice(0, 100)); // sane upper bound
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
