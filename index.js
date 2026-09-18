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

const MAX_NEWS = 8;
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
    })
    .sort((a, b) => {
      const scoreDifference =
        calculateNewsScore(b) - calculateNewsScore(a);

  // لو الـScore متساوي، الأحدث أولًا
  if (scoreDifference !== 0) {
    return scoreDifference;
  }

  return b.date - a.date;
})
.slice(0, MAX_NEWS);

  console.log(
    `✅ Found ${freshNews.length} new unique news`
  );

  console.log('📊 SNR Scores:');

for (const item of freshNews) {
  console.log(
    `   ${calculateNewsScore(item)} → ${item.title}`
  );
}

  /*
    No new news
  */

  if (freshNews.length === 0) {
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

  const newsText = freshNews
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

مهمتك اختيار الأخبار التي تستحق فعلًا أن يعرفها مشجع كرة القدم.

أولوية الأخبار:

1. انتقالات اللاعبين والمدربين، خصوصًا الصفقات الكبيرة أو الأخبار الرسمية.
2. إصابات وغيابات اللاعبين المؤثرين.
3. نتائج المباريات المهمة والأحداث الحاسمة فيها.
4. قرارات رسمية مهمة من الأندية أو الاتحادات أو البطولات.
5. أخبار دوري أبطال أوروبا والبطولات الكبرى.
6. أخبار الدوري الإنجليزي والإسباني والإيطالي والألماني.
7. أخبار الأهلي والزمالك ومنتخب مصر.
8. تصريحات قوية أو جدلية من لاعبين أو مدربين إذا كان لها تأثير حقيقي على كرة القدم.
9. أزمات أو أحداث كبيرة داخل الأندية أو المنتخبات.
10. أخبار محمد صلاح، مبابي، هالاند، يامال، فينيسيوس وغيرهم عندما يكون الخبر مهمًا فعلًا.

تجاهل تمامًا:

- الأخبار التجارية والإعلانية البحتة.
- توقيع لاعب مع شركة ملابس أو راعٍ، إلا إذا كان الخبر له أهمية استثنائية في عالم كرة القدم.
- أخبار التشكيلات العادية قبل المباريات إذا لم يكن فيها شيء مهم.
- أخبار فرق الشباب أو كرة الصالات أو كرة القدم النسائية إلا إذا كان هناك حدث استثنائي أو بطولة مهمة.
- الأخبار الضعيفة أو المكررة.
- المقالات التي تضع عنوانًا مثيرًا بدون معلومة مهمة.
- الأخبار التي لا تحتوي على معلومات واضحة.
- أي خبر لا يتعلق بكرة القدم.

قواعد مهمة جدًا:

- لا تخترع أي معلومة.
- اعتمد فقط على المعلومات الموجودة في الأخبار المعطاة.
- لا تجعل عدد الأخبار هدفًا بحد ذاته.
- إذا كان هناك خبر واحد قوي فقط، اختره وحده.
- إذا كان هناك خبران قويان، اختر الاثنين.
- إذا كان هناك 3 أو 4 أخبار قوية، اخترهم.
- لا تحاول الوصول إلى عدد معين من الأخبار.
- إذا لم يوجد أي خبر يستحق النشر، أعد كلمة واحدة فقط:
NO_NEWS

لكل خبر يتم اختياره:

**⚽ عنوان مختصر وجذاب**

ملخص واضح من سطر أو سطرين يشرح أهم ما حدث.

🔗 الرابط

لا تضف مقدمة أو خاتمة.
لا تضف تحليلاً أو توقعات.
لا تكرر نفس الخبر بصياغات مختلفة.
لا تضع أي أخبار لم تكن موجودة في البيانات.

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
    NO NEWS
    =========================================================
  */

  if (
    result.trim().toUpperCase() === 'NO_NEWS'
  ) {
    console.log(
      'ℹ️ Gemini found no important news. Nothing to send.'
    );

    return;
  }

  /*
    =========================================================
    FORMAT FOR TELEGRAM
    =========================================================
  */

  result = result.replace(
    /\*\*(.*?)\*\*/g,
    '<b>$1</b>'
  );

  result = result.replace(
    /(?:🔗\s*)?(https?:\/\/[^\s<]+)/g,
    '<a href="$1">🔗 اقرأ الخبر</a>'
  );

  result = result.replace(
    /[ \t]+\n/g,
    '\n'
  );

  result = result.replace(
    /\n{3,}/g,
    '\n\n'
  );

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

  const selectedLinks = new Set();

  for (const match of result.matchAll(/https?:\\/\\/[^\\s<)]+/g)) {
    selectedLinks.add(
      match[0].replace(/[),.]+$/, '')
    );
  }

  for (const item of freshNews) {
    if (selectedLinks.has(item.link)) {
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
