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
