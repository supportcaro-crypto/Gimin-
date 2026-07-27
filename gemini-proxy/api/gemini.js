// api/gemini.js
// Endpoint وسيط: يستقبل طلب من Termux، وينادي Gemini API نيابة عنه.
// بيدعم Key Rotation عبر عدة مفاتيح (كل مفتاح من مشروع/حساب مختلف)
// عشان نتجاوز حد الـ 20 طلب/يوم لكل حساب لحاله.

// المفاتيح بتتقرأ من Environment Variables بأسماء:
// GEMINI_API_KEY_1, GEMINI_API_KEY_2, ... GEMINI_API_KEY_15
// (لسا فيه دعم لـ GEMINI_API_KEY القديم كـ fallback لو حابب تستخدمه لحاله)

function getApiKeys() {
  const keys = [];

  // المفتاح القديم (لو موجود) - يضل يشتغل لو حابب تستخدمه
  if (process.env.GEMINI_API_KEY) {
    keys.push(process.env.GEMINI_API_KEY);
  }

  // نقرأ حتى 30 مفتاح (GEMINI_API_KEY_1 ... GEMINI_API_KEY_30) عشان نعطي مجال للتوسع
  for (let i = 1; i <= 30; i++) {
    const key = process.env['GEMINI_API_KEY_' + i];
    if (key) {
      keys.push(key);
    }
  }

  return keys;
}

// خلط عشوائي للمصفوفة (Fisher-Yates) عشان نوزع الحمل بين المفاتيح
function shuffle(array) {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function callGemini(apiKey, selectedModel, parts, generationConfig) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + selectedModel + ':generateContent';

  const body = { contents: [{ parts }] };
  if (generationConfig) {
    body.generationConfig = generationConfig;
  }

  const geminiRes = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  const data = await geminiRes.json();
  return { ok: geminiRes.ok, status: geminiRes.status, data };
}

export default async function handler(req, res) {
  // نسمح فقط بطلبات POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'استخدم POST فقط' });
  }

  const allKeys = getApiKeys();
  if (allKeys.length === 0) {
    return res.status(500).json({ error: 'ما في ولا مفتاح Gemini مضاف بإعدادات Vercel (GEMINI_API_KEY_1 ... الخ)' });
  }

  try {
    const { text, images, model, generationConfig } = req.body || {};

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

    // نرتب المفاتيح عشوائياً عشان نوزع الحمل، ونجرب واحد ورا التاني
    const keysToTry = shuffle(allKeys);

    let lastError = null;
    const attemptedCount = keysToTry.length;

    for (let i = 0; i < keysToTry.length; i++) {
      const currentKey = keysToTry[i];
      let result;
      try {
        result = await callGemini(currentKey, selectedModel, parts, generationConfig);
      } catch (err) {
        // خطأ شبكة أو اتصال بمفتاح معين - نكمل على اللي بعده
        lastError = { error: 'خطأ اتصال', details: String(err) };
        continue;
      }

      if (result.ok) {
        // نجح! نستخرج النص ونرجعه
        let replyText = '';
        const data = result.data;
        if (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) {
          replyText = data.candidates[0].content.parts.map(function (p) { return p.text; }).filter(Boolean).join('\n');
        }

        return res.status(200).json({
          reply: replyText,
          raw: data,
          attemptNumber: i + 1, // للتشخيص: أي محاولة نجحت
          totalKeysAvailable: allKeys.length,
        });
      }

      // فشل هالمفتاح - إذا كان بسبب quota (429) أو صلاحيات (403) نجرب التالي
      if (result.status === 429 || result.status === 403) {
        lastError = { error: 'خطأ من Gemini API', details: result.data, status: result.status };
        continue;
      }

      // أي خطأ تاني (400 مثلاً - طلب غلط) ما في داعي نجرب مفاتيح تانية، نرجعه فوراً
      return res.status(result.status).json({ error: 'خطأ من Gemini API', details: result.data });
    }

    // خلصت كل المفاتيح وكلها فشلت
    return res.status(429).json({
      error: 'كل المفاتيح (' + attemptedCount + ') وصلت لحدها أو فشلت اليوم',
      lastError,
    });
  } catch (err) {
    return res.status(500).json({ error: 'خطأ داخلي في الوسيط', details: String(err) });
  }
}
