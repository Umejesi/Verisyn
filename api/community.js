// api/community.js
// Lets users flag a token as Scam / Safe / Suspicious and see aggregate counts.
// Shared by both the website and the extension — one backend, one source of truth.
//
// GET  ?address=0x... -> current counts for that address
// POST { address, report } -> submit a report ('scam' | 'safe' | 'suspicious')
//
// Basic abuse prevention: each reporter (by session email if logged in, else
// guestId) can only submit one report per address, and reporting is rate
// limited so a script can't mass-flag tokens.

import { kv, getSessionUser, checkRateLimit, getClientIp } from './_lib.js';

const VALID_REPORTS = ['scam', 'safe', 'suspicious'];

export default async function handler(req, res) {
  const address = (req.query?.address || req.body?.address || '').toLowerCase();
  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    res.status(400).json({ error: 'Invalid address.' });
    return;
  }

  if (req.method === 'GET') {
    const [scam, safe, suspicious] = await Promise.all([
      kv.get(`community:${address}:scam`),
      kv.get(`community:${address}:safe`),
      kv.get(`community:${address}:suspicious`)
    ]);
    res.status(200).json({
      scam: Number(scam || 0),
      safe: Number(safe || 0),
      suspicious: Number(suspicious || 0)
    });
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { report, guestId } = req.body || {};
  if (!VALID_REPORTS.includes(report)) { res.status(400).json({ error: 'Invalid report type.' }); return; }

  const user = await getSessionUser(req);
  const reporterId = user?.email || guestId;
  if (!reporterId) { res.status(400).json({ error: 'Missing reporter identity.' }); return; }

  const ip = getClientIp(req);
  const okIp = await checkRateLimit(`ratelimit:community:ip:${ip}`, 20, 60 * 60);
  if (!okIp) { res.status(429).json({ error: 'Too many reports from this network. Try again later.' }); return; }

  const alreadyReported = await kv.sismember(`community:${address}:reporters`, reporterId);
  if (alreadyReported) { res.status(200).json({ ok: true, alreadyReported: true }); return; }

  await kv.sadd(`community:${address}:reporters`, reporterId);
  await kv.incr(`community:${address}:${report}`);

  res.status(200).json({ ok: true });
}
