// api/gemini.js
// Endpoint وسيط: يستقبل طلب من سيرفر الطلبات، وينادي Gemini API عبر Streaming.
// بيدعم Key Rotation عبر عدة مفاتيح (كل مفتاح من مشروع/حساب مختلف).
//
// ⚠️ مهم: هذا الـ endpoint يرجّع الرد كـ NDJSON مُتدفّق (سطر JSON واحد لكل قطعة)
// بدل انتظار الرد الكامل، لأن فيرسل بيقطع أي اتصال ساكت أطول من حد زمني معين.
// طالما البيانات "تتدفق" باستمرار (حتى لو بطيء)، الاتصال ما بينقطع.
//
// شكل كل سطر يوصل للعميل (المستهلك):
//   {"chunk": "...نص جزئي..."}   ← قطعة نص جديدة من جيميناي
//   {"done": true, "attemptNumber": 1, "totalKeysAvailable": 1}   ← نهاية ناجحة
//   {"error": "...", "details": ...}   ← خطأ (يوصل بدل done)

// المفاتيح بتتقرأ من Environment Variables بأسماء:
// GEMINI_API_KEY_1, GEMINI_API_KEY_2, ... GEMINI_API_KEY_15
// (لسا فيه دعم لـ GEMINI_API_KEY القديم كـ fallback لو حابب تستخدمه لحاله)

export const config = {
  // نلغي أي buffering افتراضي، ونضمن إن الرد يقدر يبقى مفتوح للـ streaming
  maxDuration: 60,
};

function getApiKeys() {
  const keys = [];

  if (process.env.GEMINI_API_KEY) {
    keys.push(process.env.GEMINI_API_KEY);
  }

  for (let i = 1; i <= 30; i++) {
    const key = process.env['GEMINI_API_KEY_' + i];
    if (key) keys.push(key);
  }

  return keys;
}

function shuffle(array) {
  const arr = array.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ─── نداء Gemini عبر streamGenerateContent (SSE)، مع تمرير كل قطعة فور وصولها ───
// onChunk: دالة تُستدعى بكل قطعة نص جديدة (لإرسالها فوراً للعميل عبر res.write)
// ترجع: { ok, status, fullText, rawLastError } — fullText فارغ لو فشل قبل أي قطعة
async function streamGeminiOnce(apiKey, selectedModel, parts, generationConfig, onChunk) {
  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/' +
    selectedModel +
    ':streamGenerateContent?alt=sse';

  const body = { contents: [{ parts }] };
  if (generationConfig) body.generationConfig = generationConfig;

  const geminiRes = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-goog-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  // فشل فوري (429/403/400...) — نقرأ الجسم كـ JSON عادي (مش SSE بحالة الخطأ عادةً)
  if (!geminiRes.ok) {
    let errData = null;
    try {
      errData = await geminiRes.json();
    } catch (e) {
      errData = { raw: await geminiRes.text().catch(() => '') };
    }
    return { ok: false, status: geminiRes.status, fullText: '', errData };
  }

  // نجاح — نقرأ الـ stream سطر SSE سطر ("data: {...}")
  let fullText = '';
  const reader = geminiRes.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // آخر سطر قد يكون غير مكتمل، نحتفظ فيه للدفعة الجاية

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const jsonStr = trimmed.slice(5).trim();
      if (!jsonStr) continue;

      let parsed;
      try {
        parsed = JSON.parse(jsonStr);
      } catch (e) {
        continue; // سطر غير صالح، نتجاهله
      }

      const candidateParts = parsed?.candidates?.[0]?.content?.parts;
      if (Array.isArray(candidateParts)) {
        const pieceText = candidateParts.map((p) => p.text || '').join('');
        if (pieceText) {
          fullText += pieceText;
          onChunk(pieceText);
        }
      }
    }
  }

  return { ok: true, status: 200, fullText, errData: null };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'استخدم POST فقط' });
  }

  const allKeys = getApiKeys();
  if (allKeys.length === 0) {
    return res.status(500).json({ error: 'ما في ولا مفتاح Gemini مضاف بإعدادات Vercel (GEMINI_API_KEY_1 ... الخ)' });
  }

  const { text, images, model, generationConfig } = req.body || {};

  if (!text && (!images || images.length === 0)) {
    return res.status(400).json({ error: 'لازم تبعت text أو images على الأقل' });
  }

  const parts = [];
  if (text) parts.push({ text });
  if (Array.isArray(images)) {
    for (const img of images) {
      if (img && img.data && img.mimeType) {
        parts.push({ inline_data: { mime_type: img.mimeType, data: img.data } });
      }
    }
  }

  const selectedModel = model || 'gemini-flash-latest';
  const keysToTry = shuffle(allKeys);

  // ── نبدأ الاستجابة كـ NDJSON متدفق فوراً، قبل ما نعرف حتى نتيجة أول مفتاح ──
  // هذا يضمن أن الاتصال "حي" من أول لحظة، ولا ينتظر Vercel اكتمال شيء ليبدأ الإرسال.
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no', // تعطيل أي buffering وسيط محتمل
  });

  let lastError = null;
  const attemptedCount = keysToTry.length;

  for (let i = 0; i < keysToTry.length; i++) {
    const currentKey = keysToTry[i];
    let result;
    try {
      result = await streamGeminiOnce(currentKey, selectedModel, parts, generationConfig, (piece) => {
        res.write(JSON.stringify({ chunk: piece }) + '\n');
      });
    } catch (err) {
      lastError = { error: 'خطأ اتصال', details: String(err) };
      continue;
    }

    if (result.ok) {
      res.write(
        JSON.stringify({
          done: true,
          attemptNumber: i + 1,
          totalKeysAvailable: allKeys.length,
        }) + '\n'
      );
      return res.end();
    }

    // فشل بسبب quota/صلاحيات — نجرب المفتاح التالي (لسا ما بعتنا أي chunk له عادةً)
    if (result.status === 429 || result.status === 403) {
      lastError = { error: 'خطأ من Gemini API', details: result.errData, status: result.status };
      continue;
    }

    // خطأ تاني (400 مثلاً) — ما في داعي نجرب مفاتيح إضافية
    res.write(JSON.stringify({ error: 'خطأ من Gemini API', details: result.errData }) + '\n');
    return res.end();
  }

  // خلصت كل المفاتيح وكلها فشلت
  res.write(
    JSON.stringify({
      error: 'كل المفاتيح (' + attemptedCount + ') وصلت لحدها أو فشلت اليوم',
      lastError,
    }) + '\n'
  );
  return res.end();
}
