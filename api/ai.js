// api/ai.js
// Merged: previously api/ai-verdict.js + api/ai-chat.js.
// Combined into one file to stay under Vercel's Hobby plan function limit.
//
// POST { mode: 'verdict', prompt } -> plain-English scan verdict (all tiers)
// POST { mode: 'chat', question, context } -> AI Q&A (Pro+ only)

import { getSessionUser } from './_lib.js';

async function callGemini(prompt, apiKey) {
  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 300, temperature: 0.4 }
      })
    }
  );
  const data = await geminiRes.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const apiKey = process.env.GEMINI_API_KEY;
  const { mode, prompt, question, context } = req.body || {};

  if (mode === 'support') {
    if (!question) { res.status(400).json({ error: 'Missing question.' }); return; }
    if (!apiKey) { res.status(500).json({ error: 'AI not configured yet.' }); return; }

    const knowledgeBase = `
VERISYN PRODUCT FACTS (only answer using these — if something isn't covered, say you're not sure and suggest Live Support):
- Verisyn scans token contracts for honeypot risk, tax %, mint/ownership risk, and liquidity lock status. Paste a contract address or search by name on the homepage.
- Wallet Scanner checks a wallet address for phishing/scam/mixer history — click the "Wallet" tab on the scanner, Pro feature.
- Whale Analysis (whales.html) shows top holders, deployer reputation (their track record across other tokens they've made), rug timeline, and early buyer detection. Deployer/timeline/snipers are Pro+.
- Risk score (0-100): higher = safer. Based on honeypot status, tax, mint/ownership flags, liquidity lock %, and holder concentration. A low score means real red flags were found — read the flag list for specifics.
- Honeypot = a contract that lets you buy but blocks selling, a common total-loss scam.
- Free plan: 5 scans/day (registered) or 3/day (not logged in), 1 saved watchlist item, no wallet scanning.
- Pro ($9.99/mo): unlimited scans, wallet scanning, AI explanations, unlimited watchlist with real email alerts, PDF export button (CSV/PDF export specifically require Pro+).
- Founding Member ($5.99/mo): same as Pro, price locked for life, limited to first 200 signups.
- Pro+ ($19.99/mo): everything in Pro, plus AI Q&A on scan results, CSV/PDF export, deployer reputation, rug timeline, early buyer detection, wallet exposure checker, priority support.
- Subscriptions are real recurring Paystack subscriptions, billed in NGN. Cancel anytime from the Account page (account.html) — access continues until the end of the current billing period, no immediate cutoff.
- Chrome extension: auto-detects contract addresses on X, Telegram Web, Discord, DexScreener, and more, shows a colored risk badge inline. Install by loading it unpacked in Chrome developer mode (not yet on the Chrome Web Store).
- Telegram bot: @Verisyn_bot — use /scan 0x... in any chat, or admins can enable auto-scan in groups.
- Sign-in options: Google, magic email link, or email+password. No wallet connection is ever required to use Verisyn.
- "Verify your account" = just sign in; there's no separate KYC/identity verification step.
`;

    const supportPrompt = `You are Verisyn's AI support assistant. Answer the user's question using ONLY the facts below. Be concise (2-4 sentences), friendly, and precise. If the question is about something not covered by these facts, honestly say you're not certain and suggest they use Live Support for a direct answer — never guess or invent product details.

${knowledgeBase}

User's question: "${question}"`;

    try {
      const text = await callGemini(supportPrompt, apiKey);
      res.status(200).json({ answer: text || "I'm not sure about that one — try Live Support for a direct answer." });
    } catch (err) {
      console.error(err);
      res.status(200).json({ answer: "I'm having trouble answering right now — try Live Support instead." });
    }
    return;
  }

  if (mode === 'chat') {
    const user = await getSessionUser(req);
    if (!user || !user.isProPlus) { res.status(403).json({ error: 'AI Q&A is a Pro+ feature.' }); return; }
    if (!question) { res.status(400).json({ error: 'Missing question.' }); return; }
    if (!apiKey) { res.status(500).json({ error: 'AI not configured yet.' }); return; }

    const chatPrompt = `You are a crypto security analyst. A user has already scanned a token and is now asking a follow-up question.
Scan context:
${context || 'No additional context provided.'}

User's question: "${question}"

Answer in 2-4 plain-English sentences. Be direct and specific to the data given. If the question can't be answered from the scan data, say so honestly rather than guessing. Never give financial advice ("you should buy/sell") — only risk analysis.`;

    try {
      const text = await callGemini(chatPrompt, apiKey);
      res.status(200).json({ answer: text || "Couldn't generate an answer — try rephrasing your question." });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'AI request failed. Try again shortly.' });
    }
    return;
  }

  // default: verdict mode, open to all tiers
  if (!prompt || typeof prompt !== 'string') { res.status(400).json({ error: 'Missing prompt' }); return; }
  if (!apiKey) { res.status(200).json({ text: null }); return; } // frontend falls back to rule-based oneliner

  try {
    const text = await callGemini(prompt, apiKey);
    res.status(200).json({ text: text || null });
  } catch (err) {
    console.error(err);
    res.status(200).json({ text: null });
  }
}
