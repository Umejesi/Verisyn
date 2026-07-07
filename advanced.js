// api/advanced.js
// Pro+ features requiring blockchain transaction history, powered by
// Etherscan's V2 unified API (one free key covers ETH/BSC/Base/Arbitrum).
// Folded into a single endpoint (dispatched by `type`) to stay within
// Vercel's 12-function limit — this is now the 12th and last function slot
// available on the free plan; any future feature will need another merge.
//
// POST { type: 'timeline', address, chain }      -> contract creation + ownership transfer history
// POST { type: 'snipers', address, chain }        -> earliest wallets to receive the token
// POST { type: 'exposure', walletAddress, chain } -> tokens a wallet holds, risk-checked
//
// All three require Pro+. SETUP: Vercel -> Environment Variables -> add
// ETHERSCAN_API_KEY (free from etherscan.io/apis).

import { getSessionUser } from './_lib.js';

const OWNERSHIP_TRANSFERRED_TOPIC = '0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e';

async function etherscan(chainId, params) {
  const apiKey = process.env.ETHERSCAN_API_KEY;
  const query = new URLSearchParams({ chainid: chainId, apikey: apiKey, ...params });
  const res = await fetch(`https://api.etherscan.io/v2/api?${query.toString()}`);
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const user = await getSessionUser(req);
  if (!user || !user.isProPlus) { res.status(403).json({ error: 'This is a Pro+ feature.' }); return; }

  if (!process.env.ETHERSCAN_API_KEY) { res.status(500).json({ error: 'Blockchain history is not configured yet.' }); return; }

  const { type, address, chain, walletAddress } = req.body || {};

  try {
    if (type === 'timeline') {
      if (!address) { res.status(400).json({ error: 'Missing address.' }); return; }
      const events = [];

      // Contract creation: first transaction in the contract's own history.
      const txData = await etherscan(chain, {
        module: 'account', action: 'txlist', address, startblock: 0, endblock: 99999999, page: 1, offset: 1, sort: 'asc'
      });
      const creationTx = txData.result?.[0];
      if (creationTx) {
        events.push({ type: 'created', label: 'Contract Created', timestamp: Number(creationTx.timeStamp) * 1000, detail: `Tx: ${creationTx.hash.slice(0, 10)}...` });
      }

      // Ownership transfer events (standard OpenZeppelin event signature).
      const logsData = await etherscan(chain, {
        module: 'logs', action: 'getLogs', address, topic0: OWNERSHIP_TRANSFERRED_TOPIC, fromBlock: 0, toBlock: 'latest'
      });
      (logsData.result || []).slice(0, 10).forEach(log => {
        events.push({
          type: 'ownership',
          label: 'Ownership Transferred',
          timestamp: parseInt(log.timeStamp, 16) * 1000,
          detail: `To: ${('0x' + log.topics?.[2]?.slice(-40)) || 'unknown'}`
        });
      });

      events.sort((a, b) => a.timestamp - b.timestamp);
      res.status(200).json({ events });
      return;
    }

    if (type === 'snipers') {
      if (!address) { res.status(400).json({ error: 'Missing address.' }); return; }
      const data = await etherscan(chain, {
        module: 'account', action: 'tokentx', contractaddress: address, page: 1, offset: 200, sort: 'asc'
      });
      const transfers = data.result || [];
      const seen = new Set();
      const earlyBuyers = [];
      for (const tx of transfers) {
        const buyer = tx.to?.toLowerCase();
        if (!buyer || buyer === '0x0000000000000000000000000000000000000000' || seen.has(buyer)) continue;
        seen.add(buyer);
        earlyBuyers.push({ address: tx.to, timestamp: Number(tx.timeStamp) * 1000 });
        if (earlyBuyers.length >= 15) break;
      }
      res.status(200).json({ earlyBuyers });
      return;
    }

    if (type === 'exposure') {
      if (!walletAddress || !/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) { res.status(400).json({ error: 'Invalid wallet address.' }); return; }
      const data = await etherscan(chain, {
        module: 'account', action: 'tokentx', address: walletAddress, page: 1, offset: 100, sort: 'desc'
      });
      const transfers = data.result || [];
      const seenTokens = new Map();
      for (const tx of transfers) {
        if (!seenTokens.has(tx.contractAddress) && seenTokens.size < 10) {
          seenTokens.set(tx.contractAddress, tx.tokenSymbol || tx.contractAddress.slice(0, 8));
        }
      }

      const results = [];
      for (const [tokenAddress, symbol] of seenTokens) {
        try {
          const secRes = await fetch(`https://api.gopluslabs.io/api/v1/token_security/${chain}?contract_addresses=${tokenAddress}`);
          const secData = await secRes.json();
          const s = secData.result?.[Object.keys(secData.result || {})[0]];
          if (!s) continue;
          const risky = s.is_honeypot === '1' || parseFloat(s.sell_tax || 0) >= 0.2 || s.hidden_owner === '1';
          results.push({ address: tokenAddress, symbol, risky });
        } catch { /* skip tokens that fail to check */ }
      }

      const riskyCount = results.filter(r => r.risky).length;
      res.status(200).json({ tokens: results, riskyCount, total: results.length });
      return;
    }

    res.status(400).json({ error: 'Unknown type.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Request failed. Try again shortly.' });
  }
}
