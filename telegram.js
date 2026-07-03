// api/telegram.js
// Verisyn Telegram bot — Vercel serverless function (webhook handler)
//
// SETUP STEPS (do these after deploying this file to your Vercel project):
// 1. Message @BotFather on Telegram -> /newbot -> follow prompts -> copy the bot token it gives you.
// 2. In Vercel dashboard: Project -> Settings -> Environment Variables
//      Add: TELEGRAM_BOT_TOKEN = <your token from BotFather>
// 3. In Vercel dashboard: Project -> Storage -> Create Database -> KV (free tier) -> Connect to this project.
//      This auto-adds the KV_* env vars this file needs. No extra config.
// 4. Redeploy so the env vars take effect.
// 5. Register the webhook (run this once, replace both placeholders):
//      https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://<YOUR_VERCEL_DOMAIN>/api/telegram
//    You should see {"ok":true,"result":true,...} in the response.
// 6. Add the bot to a group, make it admin (needed for it to read all messages, not just commands).
// 7. Try /scan 0x6982508145454ce325ddbe47a25d4ec3d2311933 in the group.

import { Redis } from '@upstash/redis';

const kv = Redis.fromEnv();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const SITE_URL = process.env.SITE_URL || 'https://verisyn.vercel.app'; // update once your domain is live

const CHAIN_NAMES = { 1: 'Ethereum', 56: 'BSC', 8453: 'Base', 42161: 'Arbitrum' };
const CHAIN_ALIASES = { eth: '1', ethereum: '1', bsc: '56', bnb: '56', base: '8453', arb: '42161', arbitrum: '42161' };
const ADDRESS_RE = /0x[a-fA-F0-9]{40}/;

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(200).send('Verisyn bot is running.'); return; }

  const update = req.body;
  const msg = update.message;
  if (!msg || !msg.text) { res.status(200).send('ok'); return; }

  const chatId = msg.chat.id;
  const chatType = msg.chat.type; // 'private' | 'group' | 'supergroup'
  const text = msg.text.trim();

  try {
    if (text.startsWith('/scan')) {
      await handleScanCommand(chatId, text);
    } else if (text.startsWith('/autoscan_on') && chatType !== 'private') {
      await handleAutoscanToggle(chatId, msg.from.id, true);
    } else if (text.startsWith('/autoscan_off') && chatType !== 'private') {
      await handleAutoscanToggle(chatId, msg.from.id, false);
    } else if (text.startsWith('/start') || text.startsWith('/help')) {
      await sendMessage(chatId, helpText());
    } else if (chatType !== 'private') {
      // auto-scan mode: only if this group opted in AND message contains a contract address
      const enabled = await kv.get(`autoscan:${chatId}`);
      if (enabled) {
        const match = text.match(ADDRESS_RE);
        if (match) await runAndReplyScan(chatId, match[0], '1', true);
      }
    }
  } catch (err) {
    console.error(err);
  }

  res.status(200).send('ok');
}

function helpText() {
  return `🛡️ *Verisyn* — token safety scanner\n\n` +
    `/scan <address> [chain] — check a contract (chain: eth, bsc, base, arb — default eth)\n` +
    `/autoscan_on — (admins only) auto-check any contract address posted in this group\n` +
    `/autoscan_off — (admins only) turn that off\n\n` +
    `Example: /scan 0x6982508145454ce325ddbe47a25d4ec3d2311933 eth`;
}

async function handleScanCommand(chatId, text) {
  const parts = text.split(/\s+/).slice(1);
  const addrPart = parts.find(p => ADDRESS_RE.test(p));
  if (!addrPart) {
    await sendMessage(chatId, "Send it like this: `/scan 0x1234...abcd eth`", true);
    return;
  }
  const address = addrPart.match(ADDRESS_RE)[0];
  const chainWord = parts.find(p => CHAIN_ALIASES[p.toLowerCase()]);
  const chain = chainWord ? CHAIN_ALIASES[chainWord.toLowerCase()] : '1';
  await runAndReplyScan(chatId, address, chain, false);
}

async function handleAutoscanToggle(chatId, userId, enable) {
  const member = await tgApi('getChatMember', { chat_id: chatId, user_id: userId });
  const status = member?.result?.status;
  if (status !== 'administrator' && status !== 'creator') {
    await sendMessage(chatId, "Only group admins can change this setting.");
    return;
  }
  await kv.set(`autoscan:${chatId}`, enable);
  await sendMessage(chatId, enable
    ? "✅ Auto-scan is ON — I'll check any contract address posted here automatically."
    : "Auto-scan is OFF — use /scan manually from now on.");
}

async function runAndReplyScan(chatId, address, chain, isAuto) {
  await tgApi('sendChatAction', { chat_id: chatId, action: 'typing' });
  try {
    const security = await fetchJson(`https://api.gopluslabs.io/api/v1/token_security/${chain}?contract_addresses=${address}`);
    const key = Object.keys(security.result || {})[0];
    if (!key) { await sendMessage(chatId, "Couldn't find security data for that contract."); return; }
    const s = security.result[key];
    const market = await fetchMarket(address);

    const { score, tier, emoji, topFlags } = computeRisk(s, market);
    const link = `${SITE_URL}/?a=${address}&c=${chain}`;

    let out = isAuto ? `👀 Detected a contract — here's the check:\n\n` : '';
    out += `${emoji} *${tier}* (${score}/100)\n_${CHAIN_NAMES[chain]} · ${address.slice(0,6)}...${address.slice(-4)}_\n\n`;
    if (topFlags.length) out += topFlags.map(f => `• ${f}`).join('\n') + '\n\n';
    out += `Full report: ${link}`;

    await sendMessage(chatId, out, true);
  } catch (err) {
    console.error(err);
    await sendMessage(chatId, "Scan failed — the contract may be too new or on an unsupported chain.");
  }
}

function computeRisk(s, market) {
  let score = 100;
  const flags = [];
  const bad = (t, p) => { flags.push(`🔴 ${t}`); score -= p; };
  const warn = (t, p) => { flags.push(`🟡 ${t}`); score -= p; };

  if (s.is_honeypot === '1') bad('Honeypot detected — you may not be able to sell', 50);
  const buyTax = parseFloat(s.buy_tax || 0) * 100, sellTax = parseFloat(s.sell_tax || 0) * 100;
  if (sellTax >= 20 || buyTax >= 20) bad(`Very high tax: ${buyTax.toFixed(1)}%/${sellTax.toFixed(1)}%`, 25);
  else if (sellTax >= 8 || buyTax >= 8) warn(`Elevated tax: ${buyTax.toFixed(1)}%/${sellTax.toFixed(1)}%`, 12);
  if (s.is_open_source === '0') bad('Contract source not verified', 15);
  if (s.is_mintable === '1') warn('Owner can mint new tokens', 10);
  if (s.hidden_owner === '1') bad('Hidden owner', 15);
  if (s.can_take_back_ownership === '1') bad('Ownership can be reclaimed', 15);
  if (s.owner_change_balance === '1') bad("Owner can alter wallet balances", 20);
  const lp = s.lp_holders || [];
  const lockedPct = lp.filter(h => h.is_locked === 1).reduce((a, h) => a + parseFloat(h.percent || 0), 0) * 100;
  if (lp.length > 0 && lockedPct < 30) bad(`Only ${lockedPct.toFixed(0)}% liquidity locked`, 20);
  const top10 = parseFloat(s.top10_holder_rate || 0) * 100;
  if (top10 > 70) bad(`Top 10 wallets hold ${top10.toFixed(0)}% of supply`, 15);
  if (!market) warn('No active trading pair found yet', 10);

  score = Math.max(0, Math.min(100, Math.round(score)));
  let tier, emoji;
  if (score >= 80) { tier = 'Low Risk'; emoji = '🟢'; }
  else if (score >= 50) { tier = 'Medium Risk'; emoji = '🟡'; }
  else if (score >= 25) { tier = 'High Risk'; emoji = '🟡'; }
  else { tier = 'Critical Risk'; emoji = '🔴'; }

  return { score, tier, emoji, topFlags: flags.slice(0, 4) };
}

async function fetchMarket(address) {
  try {
    const data = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    if (!data.pairs || data.pairs.length === 0) return null;
    return data.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  } catch { return null; }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('fetch failed: ' + url);
  return res.json();
}

async function tgApi(method, params) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  return res.json();
}

async function sendMessage(chatId, text, markdown) {
  return tgApi('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: markdown ? 'Markdown' : undefined,
    disable_web_page_preview: false
  });
}
