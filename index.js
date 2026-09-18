const Parser = require('rss-parser');
const { GoogleGenAI } = require('@google/genai');
const { GoogleDecoder } = require('google-news-url-decoder');
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

const googleDecoder = new GoogleDecoder();

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

async function fetchArticleContent(items) {
  console.log(`📄 Fetching article content for ${items.length} candidates...`);

  const results = await Promise.all(
    items.map(async item => {
      if (!item.link || !/^https?:\/\//i.test(item.link)) {
        return item;
      }

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        const response = await fetch(item.link, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; FootballNewsBot/1.0)'
          },
          signal: controller.signal
        });

        clearTimeout(timeout);

        if (!response.ok) {
          return item;
        }

        const html = await response.text();

        const metaDescription =
          html.match(/<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
          html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description)["']/i)?.[1] ||
          '';

        const articleMatch =
          html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1] ||
          '';

        const articleText = cleanText(
          articleMatch
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        );

        const descriptionText = cleanText(
          metaDescription
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&amp;/g, '&')
        );

        const extracted = [
          descriptionText,
          articleText
        ]
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 3000);

        if (!extracted) {
          return item;
        }

        console.log(`   📄 Content extracted: ${item.title}`);

        return {
          ...item,
          description: extracted
        };
      } catch (error) {
        console.log(`   ⚠️ Content fetch failed: ${item.title}`);
        return item;
      }
    })
  );

  const extractedCount = results.filter(
    (item, index) =>
      item.description &&
      item.description !== items[index].description
  ).length;

  console.log(
    `📄 Extracted content for ${extractedCount}/${items.length} candidates`
  );

  return results;
}

async function resolveGoogleNewsLinks(items) {
  const googleItems = items.filter(item =>
    typeof item.googleLink === 'string' &&
    item.googleLink.includes('news.google.com/rss/articles/')
  );

  if (googleItems.length === 0) {
    return items;
  }

  console.log(
    `🔗 Resolving ${googleItems.length} Google News links...`
  );

  let resolvedCount = 0;

  const resolvedItems = await Promise.all(
    items.map(async item => {
      if (
        typeof item.googleLink !== 'string' ||
        !item.googleLink.includes('news.google.com/rss/articles/')
      ) {
        return item;
      }

      try {
        const result = await googleDecoder.decode(item.googleLink);

        if (
          result &&
          result.status &&
          typeof result.decoded_url === 'string' &&
          /^https?:\/\//i.test(result.decoded_url)
        ) {
          resolvedCount++;

          return {
            ...item,
            link: result.decoded_url
          };
        }
      } catch (error) {
        console.warn(
          `⚠️ Google News URL resolution failed: ${item.title}`
        );
      }

      return item;
    })
  );

  console.log(
    `🔗 Resolved ${resolvedCount}/${googleItems.length} Google News links`
  );

  return resolvedItems;
}


function normalizeEventText(text = '') {
  let normalized = normalizeArabic(text);

  const eventAliases = [
    [/العوده|يعود|تعود|عاد|عادت/g, 'عود'],
    [/تدريب|مدرب|مديره الفني|مدربه/g, 'تدريب'],
    [/انتقال|ينتقل|انتقل|انتقلت|ينضم|انضم|انضمت/g, 'انتقال'],
    [/توقيع|يوقع|وقع|وقعت|تجديد|يجدد|جدد|جددت/g, 'عقد'],
    [/اهتمام|يرغب|يسعي|يسعى|مرشح/g, 'اهتمام'],
    [/اصابه|اصيب|أصيب|يغيب|غياب/g, 'اصابه'],
    [/اقاله|اقيل|إقاله|استقال|استقالت/g, 'اقاله']
  ];

  for (const [pattern, replacement] of eventAliases) {
    normalized = normalized.replace(pattern, replacement);
  }

  return normalized
    .replace(/\b(تقرير|مصدر|صحيفه|صحيفة|كشف|يكشف|تفاصيل|خاص|عاجل)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getEventTokens(item) {
  return new Set(
    normalizeEventText(item.title)
      .split(' ')
      .filter(token =>
        token.length >= 3 &&
        !new Set([
          'في', 'من', 'عن', 'على', 'الى', 'مع', 'بعد', 'قبل',
          'هذا', 'هذه', 'ذلك', 'تلك', 'الذي', 'التي', 'هو', 'هي',
          'ما', 'ماذا', 'هل', 'كيف', 'لماذا', 'تم', 'قد', 'كان',
          'كانت', 'يكون', 'يتم', 'امام', 'خلال', 'ضمن', 'حول',
          'اليوم', 'غدا', 'امس', 'اخبار', 'كره', 'قدم',
          'الدوري', 'الاسبان', 'الانجليزي', 'الايطالي', 'الالماني'
        ]).has(token)
      )
  );
}

function eventCategory(text = '') {
  const normalized = normalizeArabic(text);

  if (/(عود|تدريب|مدرب)/.test(normalized)) return 'coach';
  if (/(انتقال|ينضم|انضم|صفقه|يوقع|توقيع|تجديد|عقد)/.test(normalized)) return 'transfer';
  if (/(اصابه|اصيب|يغيب|غياب)/.test(normalized)) return 'injury';
  if (/(فاز|فوز|هزم|تاهل|يتاهل|يتوج|توج|هدف قاتل|ركله ترجيح)/.test(normalized)) return 'match';
  if (/(اقاله|استقال|عقوبه|غرامه|ايقاف)/.test(normalized)) return 'discipline';

  return 'general';
}

function areEventDuplicates(itemA, itemB) {
  const eventA = getEventTokens(itemA);
  const eventB = getEventTokens(itemB);

  const shared = [...eventA].filter(token => eventB.has(token));
  const overlap = jaccardSimilarity(eventA, eventB);
  const categoryA = eventCategory(itemA.title + ' ' + itemA.description);
  const categoryB = eventCategory(itemB.title + ' ' + itemB.description);

  if (categoryA !== 'general' && categoryA === categoryB) {
    if (shared.length >= 3 && overlap >= 0.35) {
      return true;
    }

    if (shared.length >= 4) {
      return true;
    }
  }

  return false;
}

function areNewsDuplicates(itemA, itemB) {
  return areSemanticallyDuplicate(itemA, itemB) ||
    areEventDuplicates(itemA, itemB);
}

function eventDeduplicate(items) {
  const groups = [];

  for (const item of items) {
    let matchedGroup = null;

    for (const group of groups) {
      if (areNewsDuplicates(item, group[0])) {
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
        googleLink: item.link,

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

  const semanticNews = semanticDeduplicate(freshNews);

  console.log(
    `🧠 Semantic dedup: ${beforeSemanticDedup} → ${semanticNews.length} unique stories`
  );

  const beforeEventDedup = semanticNews.length;
  const deduplicatedNews = eventDeduplicate(semanticNews);

  console.log(
    `🧩 Event dedup: ${beforeEventDedup} → ${deduplicatedNews.length} unique stories`
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

  const resolvedCandidates =
    await resolveGoogleNewsLinks(selectedCandidates);

  const enrichedCandidates =
    await fetchArticleContent(resolvedCandidates);

  console.log(
    `✅ Found ${enrichedCandidates.length} unique stories for Gemini (top ${MAX_NEWS})`
  );

  console.log('📊 SNR Scores:');

  for (const item of resolvedCandidates) {
    console.log(
      `   ${calculateNewsScore(item)} → ${item.title}`
    );
  }

  console.log('🔎 Candidates sent to Gemini:');

  resolvedCandidates.forEach((item, index) => {
    console.log(`--- Candidate ${index + 1} ---`);
    console.log(`Title: ${item.title}`);
    console.log(`Description: ${(item.description || '(empty)').slice(0, 500)}`);
    console.log(`Link: ${item.link}`);
    if (item.googleLink && item.googleLink !== item.link) {
      console.log(`Google Link: ${item.googleLink}`);
    }
  });
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

  const newsText = enrichedCandidates
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
أنت محرر أخبار كرة قدم مسؤول عن اختيار الأخبار التي تستحق النشر في قناة Telegram مصرية.

مهمتك ليست تلخيص كل الأخبار، بل انتقاء الأخبار المهمة فقط. اعتبر نفسك بوابة تحريرية صارمة.

معايير اختيار الخبر:
- يجب أن يحتوي الخبر على معلومة جديدة أو تطور واضح يمكن للقارئ الاستفادة منه.
- أعط الأولوية للأحداث ذات التأثير الحقيقي على نادٍ أو لاعب أو منتخب أو بطولة.
- انتقالات اللاعبين والمدربين: الصفقات الرسمية، الاتفاقات القوية، المفاوضات المتقدمة، أو تطورات انتقال مؤثرة.
- الإصابات والغيابات المهمة، خصوصًا للاعبين أساسيين أو نجوم.
- إقالات وتعيينات المدربين والقرارات الرسمية والعقوبات المهمة.
- نتائج وأحداث المباريات المهمة، خصوصًا النتائج الحاسمة أو الأحداث الاستثنائية.
- أخبار دوري أبطال أوروبا وكأس العالم وكأس أمم أفريقيا والدوريات الأوروبية الكبرى.
- الأهلي والزمالك ومنتخب مصر عندما يكون الخبر مهمًا فعلًا.
- التصريحات فقط عندما تتضمن موقفًا أو قرارًا أو معلومة جديدة ومؤثرة.

لا تنشر:
- أخبار الاستعداد للمباريات أو التدريبات العادية.
- التشكيلات المتوقعة أو التشكيلات العادية.
- أخبار المباريات المباشرة لحظة بلحظة.
- تصريحات المدربين واللاعبين الروتينية مثل "نريد الفوز" أو "النتائج لا تعكس المستوى".
- التحليلات والمقالات والرأي والتوقعات.
- أخبار التكريمات والفعاليات والمناسبات غير المهمة.
- الإعلانات والرعاية والتسويق.
- أخبار فرق الشباب أو الصالات أو الكرة النسائية إلا إذا كان هناك حدث استثنائي.
- العناوين التي تعتمد على الإثارة أو المبالغة بدون معلومة قوية.
- أي خبر مكرر لنفس الحدث، حتى لو جاء من مصدر مختلف.
- أي خبر لا تستطيع إثبات أهميته من المعلومات الموجودة في البيانات.

قاعدة مهمة:
وجود لاعب مشهور أو نادٍ كبير في الخبر لا يجعله مهمًا تلقائيًا.
وجود كلمات مثل "عاجل"، "مفاجأة"، "صدمة"، "صراع"، أو "مثير" لا يعني أن الخبر مهم.

قبل الاختيار، قارن الأخبار ببعضها واكتشف الأخبار التي تتحدث عن نفس الحدث. اختر حدثًا واحدًا فقط من كل مجموعة مكررة.

إذا لم توجد أخبار تستحق النشر، أعد:
{"news":[]}

لا تخترع أي معلومة ولا تضف تفاصيل غير موجودة في البيانات.
استخدم الرابط الموجود مع الخبر نفسه.

أعد النتيجة بصيغة JSON فقط، بدون Markdown أو \`\`\`json.

الصيغة الإلزامية:
{
  "news": [
    {
      "title": "عنوان عربي مختصر ودقيق",
      "summary": "ملخص واضح من سطر أو سطرين يعتمد فقط على بيانات الخبر",
      "link": "الرابط الأصلي للخبر"
    }
  ]
}

الأخبار المتاحة:

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

  const validSelectedNews = parsed.news.filter(item =>
    item &&
    typeof item.title === 'string' &&
    typeof item.summary === 'string' &&
    typeof item.link === 'string'
  );

  const selectedNews = eventDeduplicate(validSelectedNews);

  console.log(
    `🧩 Gemini event dedup: ${validSelectedNews.length} → ${selectedNews.length} news`
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

  for (const item of resolvedCandidates) {
    if (selectedLinks.has(item.link.trim())) {
      seen.add(item.googleLink || item.link);
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
  console.error('Name:', error?.name || 'Unknown');
  console.error('Message:', error?.message || '(empty)');
  console.error('Cause:', error?.cause || '(none)');
  console.error('Details:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));

  process.exit(1);
});
