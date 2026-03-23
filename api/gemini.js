// api/gemini.js
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { contents, generationConfig, model = "gemini-1.5-pro", purpose } = req.body;

  // Choose API key based on purpose (optional)
  let apiKey;
  if (purpose === 'careers') {
    apiKey = process.env.GEMINI_KEY_CAREERS;
  } else if (purpose === 'report') {
    apiKey = process.env.GEMINI_KEY_REPORT;
  } else {
    apiKey = process.env.GEMINI_KEY; // fallback single key
  }

  if (!apiKey) {
    return res.status(500).json({ error: 'Gemini API key not configured for this purpose' });
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig }),
    });

    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    console.error('Gemini API error:', error);
    res.status(500).json({ error: error.message });
  }
}