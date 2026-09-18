const Parser = require('rss-parser');
const { GoogleGenAI } = require('@google/genai');
const fs = require('fs');

const parser = new Parser();

/*
  =========================================================
  RSS SEARCHES
  =========================================================
*/

const RSS_QUERIES = [
  'كرة القدم أخبار مهمة',
  'انتقالات كرة القدم',
  'دوري أبطال أوروبا',
  'الدوري الإنجليزي الممتاز',
  'الدوري الإسباني',
  'الأهلي الزمالك منتخب مصر محمد صلاح مبابي يامال هالاند'
];

const RSS_URLS = RSS_QUERIES.map(query =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(
    query
  )}&hl=ar&gl=EG&ceid=EG:ar`
);

/*
  =========================================================
  SETTINGS
  =========================================================
*/

const GEMINI_MODEL = 'gemini-3.1-flash-lite';

const MAX_NEWS = 15;
const HOURS_BACK = 1.25;

/*
  =========================================================
  ENVIRONMENT VARIABLES
  =========================================================
*/

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

/*
  =========================================================
  PERSISTENT STORAGE
  Railway Volume is mounted at /app/data
  =========================================================
*/

const DATA_DIR = '/app/data';
const SEEN_FILE = `${DATA_DIR}/seen.json`;

if (!GEMINI_API_KEY) {
  throw new Error('❌ GEMINI_API_KEY غير موجود');
}

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error('❌ TELEGRAM_BOT_TOKEN غير موجود');
}

if (!TELEGRAM_CHAT_ID) {
  throw new Error('❌ TELEGRAM_CHAT_ID غير موجود');
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY
});

/*
  =========================================================
  HELPERS
  =========================================================
*/

function cleanText(text = '') {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeArabic(text = '') {
  return text
    .toLowerCase()
    .replace(/[إأآا]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[ًٌٍَُِّْـ]/g, '')
    .replace(/[^\u0600-\u06FF\u0030-\u0039a-z\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getNewsTokens(item) {
  const stopWords = new Set([
    'في', 'من', 'عن', 'على', 'الى', 'إلى', 'مع', 'بعد', 'قبل',
    'هذا', 'هذه', 'ذلك', 'تلك', 'الذي', 'التي', 'هو', 'هي',
    'ما', 'ماذا', 'هل', 'كيف', 'لماذا', 'تم', 'قد', 'كان',
    'كانت', 'يكون', 'يتم', 'أمام', 'خلال', 'ضمن', 'حول',
    'اليوم', 'غدا', 'أمس', 'اخبار', 'أخبار', 'كرة', 'قدم'
  ]);

  return new Set(
    normalizeArabic(`${item.title} ${item.description}`)
      .split(' ')
      .filter(token => token.length >= 3 && !stopWords.has(token))
  );
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }

  let intersection = 0;

  for (const token of setA) {
    if (setB.has(token)) {
      intersection++;
    }
  }

  const union = new Set([...setA, ...setB]).size;

  return union === 0 ? 0 : intersection / union;
}

function titleSimilarity(titleA, titleB) {
  const tokensA = new Set(
    normalizeArabic(titleA)
      .split(' ')
      .filter(token => token.length >= 3)
  );

  const tokensB = new Set(
    normalizeArabic(titleB)
      .split(' ')
      .filter(token => token.length >= 3)
  );

  return jaccardSimilarity(tokensA, tokensB);
}

function areSemanticallyDuplicate(itemA, itemB) {
  const titleScore = titleSimilarity(itemA.title, itemB.title);
  const contentScore = jaccardSimilarity(
    getNewsTokens(itemA),
    getNewsTokens(itemB)
  );

  if (titleScore >= 0.65) {
    return true;
  }

  if (contentScore >= 0.72) {
    return true;
  }

  return false;
}

function semanticDeduplicate(items) {
  const groups = [];

  for (const item of items) {
    let matchedGroup = null;

    for (const group of groups) {
      if (areSemanticallyDuplicate(item, group[0])) {
        matchedGroup = group;
        break;
      }
    }

    if (matchedGroup) {
      matchedGroup.push(item);
    } else {
      groups.push([item]);
    }
  }

  return groups.map(group =>
    group.sort((a, b) => {
      const scoreDifference =
        calculateNewsScore(b) - calculateNewsScore(a);

      if (scoreDifference !== 0) {
        return scoreDifference;
      }

      return b.date - a.date;
    })[0]
  );
}

function calculateNewsScore(item) {
  const text = `${item.title} ${item.description}`.toLowerCase();

  const hasAny = words =>
    words.some(word => text.includes(word.toLowerCase()));

  const countMatches = words =>
    words.filter(word => text.includes(word.toLowerCase())).length;

  /*
    =========================================================
    SNR 2.1
    Event importance is the main score.
    Context (player/club/competition) is a limited bonus so
    a famous name cannot make an otherwise weak story important.
    =========================================================
  */

  let eventScore = 0;

  // 🚨 أخبار رسمية / قرارات قوية
  if (hasAny([
    'رسميًا',
    'رسميا',
    'بشكل رسمي',
    'أعلن النادي',
    'أعلنت إدارة',
    'أعلن الاتحاد',
    'تم الإعلان'
  ])) {
    eventScore += 24;
  }

  if (hasAny([
    'قرار رسمي',
    'قرار الاتحاد',
    'قرار النادي',
    'تمت إقالته',
    'تمت إقالتها',
    'استقال من',
    'استقالت من',
    'تعيين مدرب',
    'تعيين المدير'
  ])) {
    eventScore += 20;
  }

  // 🔄 انتقالات مؤكدة أو تطورات قوية
  if (hasAny([
    'انتقال',
    'صفقة',
    'يوقع',
    'وقع عقد',
    'ينضم إلى',
    'ينضم لـ',
    'يقترب من ضم',
    'يقترب من التوقيع',
    'يتفاوض مع',
    'مفاوضات مع',
    'توصل لاتفاق',
    'توصل إلى اتفاق',
    'اتفق مع',
    'يرحل عن',
    'يرحل من',
    'يودع ناديه',
    'يجدد عقده',
    'تجديد عقد',
    'تمديد عقد'
  ])) {
    eventScore += 18;
  }

  // انتقالات محتملة / اهتمام: أقل من الخبر المؤكد
  if (hasAny([
    'اهتمام بـ',
    'اهتمام باللاعب',
    'يرغب في ضم',
    'يسعى لضم',
    'يدخل في مفاوضات',
    'مفاوضات أولية',
    'مرشح للانضمام',
    'قد ينتقل',
    'قد يرحل',
    'يقترب من الرحيل'
  ])) {
    eventScore += 9;
  }

  // 🏥 إصابات وغيابات
  if (hasAny([
    'إصابة',
    'أصيب',
    'تعرض للإصابة',
    'يغيب بسبب',
    'سيغيب',
    'لن يشارك',
    'غياب',
    'غيابه عن المباراة',
    'خضع لفحوصات'
  ])) {
    eventScore += 17;
  }

  // 🏟️ نتائج وأحداث حاسمة
  if (hasAny([
    'فاز على',
    'فوز على',
    'تغلب على',
    'هزم',
    'تعادل مع',
    'خسر أمام',
    'يودع البطولة',
    'يتأهل إلى',
    'تأهل إلى',
    'حسم التأهل',
    'يتوج بـ',
    'توج بـ',
    'الهدف القاتل',
    'ركلة ترجيح'
  ])) {
    eventScore += 14;
  }

  // ⚖️ عقوبات وقرارات انضباطية
  if (hasAny([
    'إيقاف',
    'عقوبة',
    'غرامة',
    'حرمان',
    'إيقاف المباراة',
    'تأجيل المباراة',
    'إلغاء المباراة'
  ])) {
    eventScore += 13;
  }

  // 🗣️ التصريحات: تأثير محدود
  if (hasAny([
    'يعلن',
    'أعلن',
    'تصريحاته',
    'تصريحات',
    'كشف عن',
    'أكد أن',
    'أكد',
    'ينتقد',
    'هاجم',
    'يرد على'
  ])) {
    eventScore += 5;
  }

  // 🏆 سياق البطولة: bonus محدود
  let contextScore = 0;

  if (hasAny([
    'دوري أبطال أوروبا',
    'دوري الأبطال',
    'champions league',
    'كأس العالم',
    'كأس أمم أفريقيا'
  ])) {
    contextScore += 7;
  } else if (hasAny([
    'الدوري الإنجليزي',
    'الدوري الإسباني',
    'الدوري الإيطالي',
    'الدوري الألماني'
  ])) {
    contextScore += 5;
  }

  // ⭐ نجوم كبار: بونص محدود
  const majorPlayers = [
    'محمد صلاح',
    'مبابي',
    'هالاند',
    'يامال',
    'فينيسيوس',
    'بيلينجهام',
    'رونالدو',
    'ميسي'
  ];

  contextScore += Math.min(countMatches(majorPlayers), 2) * 5;

  // 🏟️ أندية كبيرة: بونص محدود
  const majorClubs = [
    'الأهلي',
    'الزمالك',
    'ليفربول',
    'مانشستر سيتي',
    'مانشستر يونايتد',
    'ريال مدريد',
    'برشلونة',
    'أرسنال',
    'تشيلسي',
    'بايرن ميونخ',
    'باريس سان جيرمان'
  ];

  contextScore += Math.min(countMatches(majorClubs), 2) * 4;

  if (hasAny([
    'منتخب مصر',
    'المنتخب المصري',
    'الفراعنة'
  ])) {
    contextScore += 6;
  } else if (hasAny([
    'الدوري المصري',
    'كأس مصر',
    'السوبر المصري'
  ])) {
    contextScore += 4;
  }

  contextScore = Math.min(contextScore, 18);

  // ⏱️ حداثة بسيطة حتى لا تتغلب على أهمية الحدث
  let freshnessScore = 0;

  if (item.date instanceof Date && Number.isFinite(item.date.getTime())) {
    const ageMinutes = Math.max(
      0,
      (Date.now() - item.date.getTime()) / 60000
    );

    if (ageMinutes <= 15) {
      freshnessScore = 4;
    } else if (ageMinutes <= 30) {
      freshnessScore = 3;
    } else if (ageMinutes <= 60) {
      freshnessScore = 1;
    }
  }

  // 🗑️ خصومات للأخبار غير المناسبة
  let penalty = 0;

  if (hasAny([
    'شركة ملابس',
    'راعٍ',
    'رعاية',
    'إعلان تجاري',
    'سفير العلامة',
    'علامة تجارية',
    'حملة إعلانية',
    'إطلاق حذاء'
  ])) {
    penalty -= 25;
  }

  if (hasAny([
    'فريق الشباب',
    'كرة الصالات',
    'كرة القدم النسائية',
    'تشكيل متوقع',
    'التشكيل المتوقع',
    'تشكيل الفريق',
    'جلسة تصوير'
  ])) {
    penalty -= 12;
  }

  if (hasAny([
    'لن تصدق',
    'صدمة مدوية',
    'مفاجأة مدوية',
    'شاهد ماذا حدث',
    'الحقيقة الكاملة',
    'كواليس مثيرة',
    'تفاصيل لا تصدق'
  ])) {
    penalty -= 10;
  }

  if (hasAny([
    'تحليل',
    'رأي',
    'توقعات',
    'من الأفضل',
    'هل يستحق'
  ])) {
    penalty -= 5;
  }

  return eventScore + contextScore + freshnessScore + penalty;
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

    remaining = remaining
      .slice(cut)
      .trim();
  }

  if (remaining) {
    messages.push(remaining);
  }

  return messages;
}

/*
  =========================================================
  TELEGRAM
  =========================================================
*/

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

/*
  =========================================================
  MAIN
  =========================================================
*/

async function main() {
  console.log('⚽ Football News Bot started');

  console.log(
    `📡 Reading ${RSS_URLS.length} Google News RSS searches...`
  );

  /*
    Read all RSS searches in parallel.
    This does NOT create extra Gemini requests.
  */

  const feeds = await Promise.all(
    RSS_URLS.map(async (url, index) => {
      try {
        const feed = await parser.parseURL(url);

        console.log(
          `📰 RSS search ${index + 1}: ${feed.items.length} items`
        );

        return feed.items;
      } catch (error) {
        console.error(
          `⚠️ RSS search ${index + 1} failed: ${error.message}`
        );

        return [];
      }
    })
  );

  /*
    Combine all RSS results
  */

  const allItems = feeds.flat();

  console.log(
    `📰 Total RSS items: ${allItems.length}`
  );

  /*
    =========================================================
    FILTER + DEDUPLICATE
    =========================================================
  */

  const now = Date.now();

  const oneHourAgo =
    now - HOURS_BACK * 60 * 60 * 1000;

  const seen = loadSeen();

  const uniqueLinks = new Set();

  const freshNews = allItems
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

      if (!item.link) {
        return false;
      }

      if (seen.has(item.link)) {
        return false;
      }

      if (uniqueLinks.has(item.link)) {
        return false;
      }

      if (
        !Number.isFinite(time) ||
        time < oneHourAgo ||
        time > now
      ) {
        return false;
      }

      uniqueLinks.add(item.link);

      return true;
    });

  console.log(
    `🧹 Fresh unseen stories: ${freshNews.length}`
  );

  const beforeSemanticDedup = freshNews.length;

  const deduplicatedNews = semanticDeduplicate(freshNews);

  console.log(
    `🧠 Semantic dedup: ${beforeSemanticDedup} → ${deduplicatedNews.length} unique stories`
  );

  const selectedCandidates = deduplicatedNews
    .sort((a, b) => {
      const scoreDifference =
        calculateNewsScore(b) - calculateNewsScore(a);

      if (scoreDifference !== 0) {
        return scoreDifference;
      }

      return b.date - a.date;
    })
    .slice(0, MAX_NEWS);

  console.log(
    `✅ Found ${selectedCandidates.length} unique stories for Gemini (top ${MAX_NEWS})`
  );

  console.log('📊 SNR Scores:');

  for (const item of selectedCandidates) {
    console.log(
      `   ${calculateNewsScore(item)} → ${item.title}`
    );
  }
  /*
    No new news
  */

  if (selectedCandidates.length === 0) {
    console.log(
      'ℹ️ No new news. Nothing to send.'
    );

    return;
  }

  /*
    =========================================================
    PREPARE NEWS FOR GEMINI
    =========================================================
  */

  const newsText = selectedCandidates
    .map(
      (item, index) => `
${index + 1}. ${item.title}

الوصف:
${item.description}

الرابط:
${item.link}
`
    )
    .join('\n----------------\n');

  /*
    =========================================================
    ONE GEMINI REQUEST
    =========================================================
  */

  console.log(
    '🤖 Sending ONE request to Gemini...'
  );

  const prompt = `
أنت محرر أخبار كرة قدم لقناة Telegram مصرية.

لديك مجموعة من الأخبار المنشورة خلال الفترة الأخيرة.
اختر فقط الأخبار التي تستحق النشر فعلًا.

الأولوية:
- انتقالات اللاعبين والمدربين، خصوصًا الصفقات الرسمية أو التطورات القوية.
- الإصابات والغيابات المؤثرة.
- نتائج المباريات المهمة والأحداث الحاسمة.
- القرارات الرسمية المهمة.
- دوري أبطال أوروبا والبطولات الكبرى.
- الدوريات الأوروبية الكبرى.
- الأهلي والزمالك ومنتخب مصر.
- التصريحات القوية عندما يكون لها تأثير حقيقي.
- الأزمات والأحداث الكبيرة داخل الأندية أو المنتخبات.
- أخبار النجوم الكبار عندما تكون المعلومة مهمة فعلًا.

تجاهل:
- الإعلانات والرعاية والتسويق.
- التشكيلات العادية والمباريات المباشرة.
- أخبار الشباب والصالات والنسائية إلا في حدث استثنائي.
- الأخبار المكررة أو الضعيفة أو العناوين المضللة.
- التحليل والرأي والتوقعات.
- أي شيء ليس كرة قدم.

قواعد:
- لا تخترع أي معلومة.
- استخدم فقط البيانات المعطاة.
- لا يوجد عدد مطلوب للأخبار.
- اختر خبرًا واحدًا أو عدة أخبار فقط إذا كانت مهمة فعلًا.
- إذا لم يوجد خبر مهم، أعد JSON فارغًا.
- لا تكرر نفس الحدث حتى لو ظهر من أكثر من مصدر.

أعد النتيجة بصيغة JSON فقط، بدون Markdown أو \`\`\`json.

الصيغة الإلزامية:
{
  "news": [
    {
      "title": "عنوان عربي مختصر",
      "summary": "ملخص واضح من سطر أو سطرين",
      "link": "الرابط الأصلي كما ورد في البيانات"
    }
  ]
}

الأخبار:

${newsText}
`;

  const response =
    await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: prompt
    });

  let result = response.text || '';

  if (!result.trim()) {
    throw new Error(
      '❌ Gemini returned an empty response'
    );
  }

  console.log(
    '✅ Gemini response received'
  );
  /*
    =========================================================
    PARSE STRUCTURED GEMINI RESPONSE
    =========================================================
  */

  let parsed;

  try {
    let jsonText = result.trim();

    jsonText = jsonText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    parsed = JSON.parse(jsonText);
  } catch (error) {
    console.error('❌ Gemini returned invalid JSON');
    console.error(result);
    throw new Error('Gemini JSON parsing failed');
  }

  if (!parsed || !Array.isArray(parsed.news)) {
    throw new Error('❌ Gemini JSON missing news array');
  }

  const selectedNews = parsed.news.filter(item =>
    item &&
    typeof item.title === 'string' &&
    typeof item.summary === 'string' &&
    typeof item.link === 'string'
  );

  if (selectedNews.length === 0) {
    console.log('ℹ️ Gemini found no important news. Nothing to send.');
    return;
  }

  console.log(`🧠 Gemini selected ${selectedNews.length} important news`);

  /*
    =========================================================
    FORMAT FOR TELEGRAM
    =========================================================
  */

  result = selectedNews
    .map(item =>
      `<b>⚽ ${item.title.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</b>\n\n` +
      `${item.summary.replace(/</g, '&lt;').replace(/>/g, '&gt;')}\n\n` +
      `<a href="${item.link.replace(/"/g, '&quot;')}">🔗 اقرأ الخبر</a>`
    )
    .join('\n\n');

  result = result.trim();

  /*
    =========================================================
    SPLIT TELEGRAM MESSAGE
    =========================================================
  */

  const messages =
    splitMessage(result);

  console.log(
    `📨 Sending ${messages.length} Telegram message(s)...`
  );

  for (const message of messages) {
    await sendTelegram(message);

    if (messages.length > 1) {
      await new Promise(resolve =>
        setTimeout(resolve, 500)
      );
    }
  }

  /*
    =========================================================
    SAVE SEEN NEWS
    =========================================================
  */

  const selectedLinks = new Set(
    selectedNews.map(item => item.link.trim())
  );

  for (const item of selectedCandidates) {
    if (selectedLinks.has(item.link.trim())) {
      seen.add(item.link);
    }
  }

  saveSeen(seen);

  console.log(
    `💾 Seen news saved: ${seen.size} links`
  );

  console.log('🎉 DONE!');
}

/*
  =========================================================
  ERROR HANDLING
  =========================================================
*/

main().catch(error => {
  console.error('❌ ERROR:');
  console.error(error.message);

  process.exit(1);
});
