// api/ai-chat.js
// Pro+ feature: ask a free-form question about a token you've already scanned
// (e.g. "should I be worried about the tax?", "is this safe for a long hold?").
// Gated to isProPlus since it's a heavier, more valuable feature than the
// standard verdict paragraph every tier gets.

import { getSessionUser } from './_lib.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const user = await getSessionUser(req);
  if (!user || !user.isProPlus) {
    res.status(403).json({ error: 'AI Q&A is a Pro+ feature.' });
    return;
  }

  const { question, context } = req.body || {};
  if (!question || typeof question !== 'string') { res.status(400).json({ error: 'Missing question.' }); return; }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'AI not configured yet.' }); return; }

  const prompt = `You are a crypto security analyst. A user has already scanned a token and is now asking a follow-up question.
Scan context:
${context || 'No additional context provided.'}

User's question: "${question}"

Answer in 2-4 plain-English sentences. Be direct and specific to the data given. If the question can't be answered from the scan data, say so honestly rather than guessing. Never give financial advice ("you should buy/sell") — only risk analysis.`;

  try {
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
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    res.status(200).json({ answer: text.trim() || "Couldn't generate an answer — try rephrasing your question." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'AI request failed. Try again shortly.' });
  }
}
