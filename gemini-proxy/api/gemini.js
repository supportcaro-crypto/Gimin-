// api/gemini.js
// Endpoint وسيط: يستقبل طلب من Termux، وينادي Gemini API نيابة عنه.
// المفتاح بيتقرأ من Environment Variable اسمه GEMINI_API_KEY (مش مكتوب في الكود).

export default async function handler(req, res) {
  // نسمح فقط بطلبات POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'استخدم POST فقط' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY مش مضاف في إعدادات Vercel' });
  }

  try {
    const { text, images, model } = req.body || {};

    if (!text && (!images || images.length === 0)) {
      return res.status(400).json({ error: 'لازم تبعت text أو images على الأقل' });
    }

    // بناء أجزاء الطلب (parts): نص + صور (base64) لو موجودة
    const parts = [];
    if (text) {
      parts.push({ text });
    }
    if (Array.isArray(images)) {
      for (const img of images) {
        // كل صورة متوقع تيجي كـ { mimeType: "image/jpeg", data: "base64...." }
        if (img && img.data && img.mimeType) {
          parts.push({
            inline_data: {
              mime_type: img.mimeType,
              data: img.data,
            },
          });
        }
      }
    }

    const selectedModel = model || 'gemini-flash-latest';
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + selectedModel + ':generateContent';

    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts }],
      }),
    });

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      return res.status(geminiRes.status).json({ error: 'خطأ من Gemini API', details: data });
    }

    // نستخرج النص النهائي بشكل مبسط عشان Termux ياخده بسهولة
    let replyText = '';
    if (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) {
      replyText = data.candidates[0].content.parts.map(function (p) { return p.text; }).filter(Boolean).join('\n');
    }

    return res.status(200).json({
      reply: replyText,
      raw: data,
    });
  } catch (err) {
    return res.status(500).json({ error: 'خطأ داخلي في الوسيط', details: String(err) });
  }
}
