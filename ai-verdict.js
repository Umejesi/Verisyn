// api/ai-verdict.js
// Generates the plain-English verdict paragraph using Google Gemini instead
// of the old (non-functional outside Claude's artifact sandbox) Anthropic call.
// This is what makes "AI explanations" genuinely real instead of just the
// rule-based fallback text.
//
// SETUP:
// Vercel -> Settings -> Environment Variables -> add GEMINI_API_KEY
// (get one free at https://aistudio.google.com/apikey — Gemini's free tier
// is generous enough to cover this use case at your current scale).

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    res.status(200).json({ text: null }); // frontend falls back to rule-based oneliner
    return;
  }

  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string') { res.status(400).json({ error: 'Missing prompt' }); return; }

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
    res.status(200).json({ text: text.trim() || null });
  } catch (err) {
    console.error(err);
    res.status(200).json({ text: null }); // fail soft — frontend falls back gracefully
  }
}
