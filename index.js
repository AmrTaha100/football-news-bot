const Parser = require('rss-parser');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');

const parser = new Parser();

const RSS_URL =
  'https://news.google.com/rss/search?q=%D9%83%D8%B1%D8%A9+%D8%A7%D9%84%D9%82%D8%AF%D9%85&hl=ar&gl=EG&ceid=EG:ar';

const GEMINI_MODEL = 'gemini-3.1-flash-lite';

const MAX_NEWS = 10;
const HOURS_BACK = 1;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const SEEN_FILE = './seen.json';

if (!GEMINI_API_KEY) {
  throw new Error('❌ GEMINI_API_KEY غير موجود');
}

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error('❌ TELEGRAM_BOT_TOKEN غير موجود');
}

if (!TELEGRAM_CHAT_ID) {
  throw new Error('❌ TELEGRAM_CHAT_ID غير موجود');
}

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY
});

function cleanText(text = '') {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function loadSeen() {
  try {
    if (!fs.existsSync(SEEN_FILE)) {
      return new Set();
    }

    const data = JSON.parse(
      fs.readFileSync(SEEN_FILE, 'utf8')
    );

    return new Set(data);
  } catch {
    return new Set();
  }
}

function saveSeen(seen) {
  fs.writeFileSync(
    SEEN_FILE,
    JSON.stringify([...seen], null, 2),
    'utf8'
  );
}

function splitMessage(text, maxLength = 4000) {
  const messages = [];
  let remaining = text.trim();

  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf('\n\n', maxLength);

    if (cut < 1000) {
      cut = remaining.lastIndexOf('\n', maxLength);
    }

    if (cut < 1000) {
      cut = maxLength;
    }

    messages.push(
      remaining.slice(0, cut).trim()
    );

    remaining = remaining.slice(cut).trim();
  }

  if (remaining) {
    messages.push(remaining);
  }

  return messages;
}

async function sendTelegram(text) {
  const url =
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(
      `Telegram error: ${JSON.stringify(data)}`
    );
  }
}

async function main() {
  console.log('⚽ Football News Bot started');

  // قراءة الأخبار
  console.log('📡 Reading Google News RSS...');

  const feed = await parser.parseURL(RSS_URL);

  console.log(
    `📰 RSS returned ${feed.items.length} items`
  );

  const now = Date.now();
  const oneHourAgo =
    now - HOURS_BACK * 60 * 60 * 1000;

  const seen = loadSeen();

  // فلترة الأخبار
  const freshNews = feed.items
    .map(item => {
      const date = new Date(
        item.pubDate || item.isoDate
      );

      return {
        title: cleanText(item.title),
        description: cleanText(
          item.contentSnippet ||
          item.content ||
          item.description ||
          ''
        ).slice(0, 500),
        link: item.link,
        date
      };
    })
    .filter(item => {
      const time = item.date.getTime();

      return (
        item.link &&
        !seen.has(item.link) &&
        time >= oneHourAgo &&
        time <= now
      );
    })
    .sort((a, b) => b.date - a.date)
    .slice(0, MAX_NEWS);

  console.log(
    `✅ Found ${freshNews.length} new news`
  );

  if (freshNews.length === 0) {
    console.log('ℹ️ No new news. Nothing to send.');
    return;
  }

  // تجهيز الأخبار لـ Gemini
  const newsText = freshNews
    .map((item, index) => {
      return `
${index + 1}. ${item.title}

الوصف:
${item.description}

الرابط:
${item.link}
`;
    })
    .join('\n----------------\n');

  // Gemini
  console.log('🤖 Sending ONE request to Gemini...');

  const prompt = `
أنت مساعد متخصص في أخبار كرة القدم.

لديك الأخبار التالية:

${newsText}

المطلوب:

- اختر الأخبار المهمة فقط.
- اكتب بالعربية المصرية بشكل مختصر وواضح.
- لا تخترع أي معلومة غير موجودة في البيانات.
- لكل خبر اكتب:
  عنوان مختصر
  ملخص من سطر أو سطرين
  الرابط الأصلي كما هو

- تجاهل الأخبار المكررة أو غير المهمة.
- لا تذكر أي شيء خارج كرة القدم.

استخدم هذا الشكل:

**⚽ عنوان الخبر**

ملخص الخبر.

🔗 الرابط

لا تضف مقدمة أو خاتمة.
`;

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt
  });

  let result = response.text || '';

  if (!result.trim()) {
    throw new Error('❌ Gemini returned an empty response');
  }

  console.log('✅ Gemini response received');

  // Markdown → Telegram HTML
  result = result.replace(
    /\*\*(.*?)\*\*/g,
    '<b>$1</b>'
  );

  // تحويل الرابط إلى "اقرأ الخبر"
  result = result.replace(
  /(?:🔗\s*)?(https?:\/\/[^\s<]+)/g,
  '<a href="$1">🔗 اقرأ الخبر</a>'
);

result = result.replace(
  /(<a href="[^"]+">🔗 اقرأ الخبر<\/a>)(?=\s*$)/gm,
  '$1'
);

  // تقسيم الرسالة
  const messages = splitMessage(result);

  console.log(
    `📨 Sending ${messages.length} Telegram message(s)...`
  );

  // Telegram
  for (const message of messages) {
    await sendTelegram(message);

    if (messages.length > 1) {
      await new Promise(resolve =>
        setTimeout(resolve, 500)
      );
    }
  }

  // تسجيل الأخبار كمُرسلة
  for (const item of freshNews) {
    seen.add(item.link);
  }

  saveSeen(seen);

  console.log('💾 Seen news saved');
  console.log('🎉 DONE!');
}

main().catch(error => {
  console.error('❌ ERROR:');
  console.error(error.message);
  process.exit(1);
});