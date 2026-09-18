const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'football-news-bot-'));

const {
  areSemanticallyDuplicate,
  semanticDeduplicate,
  areEventDuplicates,
  eventDeduplicate,
  atomicWriteJson,
  loadSeen,
  saveSeen,
  validateGeminiNews,
  fetchRssFeeds,
  readResponseTextLimited,
  resolveGoogleNewsLinks,
  hasPublishedEvent,
  markSeen,
  extractMatchScore,
  getEventFingerprint
} = require('../index');

const story = (title, description = '', date = new Date()) => ({ title, description, date });

test('semantic dedup recognizes close paraphrases and keeps one', () => {
  const items = [
    story('برشلونة يعلن تجديد عقد رافينيا حتى 2028', 'النادي أعلن التجديد رسميًا', new Date('2026-09-19T00:00:00Z')),
    story('برشلونة يعلن تجديد عقد رافينيا حتى 2028 رسميًا', 'تم الإعلان رسميًا عن تمديد عقد اللاعب', new Date('2026-09-18T23:55:00Z'))
  ];
  assert.equal(areSemanticallyDuplicate(items[0], items[1]), true);
  assert.equal(semanticDeduplicate(items).length, 1);
});

test('semantic dedup does not merge different event types', () => {
  const a = story('محمد صلاح يجدد عقده مع ليفربول', 'النجم المصري مستمر مع النادي');
  const b = story('محمد صلاح يغيب عن المباراة بسبب الإصابة', 'اللاعب لن يشارك بسبب إصابة عضلية');
  assert.equal(areSemanticallyDuplicate(a, b), false);
});

test('event dedup catches same transfer event with different wording', () => {
  const a = story('ليفربول يتوصل لاتفاق انتقال لاعب الوسط');
  const b = story('ليفربول يعلن اتفاق انتقال لاعب الوسط');
  assert.equal(areEventDuplicates(a, b), true);
  assert.equal(eventDeduplicate([a, b]).length, 1);
});

test('event dedup keeps different events involving the same player', () => {
  const a = story('محمد صلاح يجدد عقده مع ليفربول');
  const b = story('محمد صلاح يغيب بسبب الإصابة');
  assert.equal(areEventDuplicates(a, b), false);
});

test('seen persistence saves, reloads, and leaves no temp file', () => {
  const seen = new Set(['https://example.com/a', 'https://example.com/b']);
  saveSeen(seen);
  const file = path.join(process.env.DATA_DIR, 'seen.json');
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual([...loadSeen().keys()].sort(), [...seen].sort());
  assert.deepEqual(fs.readdirSync(process.env.DATA_DIR).filter(x => x.endsWith('.tmp')), []);
});

test('loadSeen quarantines corrupt JSON instead of resetting silently', () => {
  const file = path.join(process.env.DATA_DIR, 'seen.json');
  fs.writeFileSync(file, '{not-json', 'utf8');
  assert.throws(() => loadSeen(), /could not be loaded safely/);
  assert.equal(fs.readdirSync(process.env.DATA_DIR).filter(x => x.startsWith('seen.json.corrupt-')).length, 1);
});

test('atomicWriteJson replaces target without leaving temp file', () => {
  const file = path.join(process.env.DATA_DIR, 'atomic.json');
  atomicWriteJson(file, { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ok: true });
  assert.equal(fs.existsSync(`${file}.${process.pid}.tmp`), false);
});

test('Gemini validation accepts only candidate links and removes duplicates', () => {
  const candidates = [
    { title: 'A', description: 'A', link: 'https://example.com/a', googleLink: 'https://news.google.com/a' },
    { title: 'B', description: 'B', link: 'https://example.com/b', googleLink: 'https://news.google.com/b' }
  ];
  const result = validateGeminiNews({
    news: [
      { title: 'عنوان A', summary: 'ملخص A', link: 'https://example.com/a' },
      { title: 'عنوان A مكرر', summary: 'ملخص مكرر', link: 'https://example.com/a' },
      { title: 'رابط غير مرشح', summary: 'يجب رفضه', link: 'https://evil.example/x' },
      { title: 'بدون رابط', summary: 'يجب رفضه', link: '' }
    ]
  }, candidates);
  assert.equal(result.length, 1);
  assert.equal(result[0].link, 'https://example.com/a');
  assert.equal(result[0].googleLink, 'https://news.google.com/a');
});

test('Gemini validation rejects malformed top-level output', () => {
  assert.throws(() => validateGeminiNews({ news: 'not-an-array' }, []), /missing news array/);
});


test('SSRF guard blocks private IPv4 and IPv4-mapped IPv6 addresses', async () => {
  const { assertSafeExternalUrl } = require('../index');
  await assert.rejects(
    () => assertSafeExternalUrl('http://127.0.0.1/'),
    /Private IP blocked/
  );
  await assert.rejects(
    () => assertSafeExternalUrl('http://[::ffff:127.0.0.1]/'),
    /Private IP blocked/
  );
});

test('SSRF guard blocks local hostnames before DNS resolution', async () => {
  const { assertSafeExternalUrl } = require('../index');
  await assert.rejects(
    () => assertSafeExternalUrl('http://localhost/'),
    /Private\/local hostname blocked/
  );
});


test('RSS handling keeps successful feeds when one feed fails', async () => {
  const result = await fetchRssFeeds(
    ['feed-1', 'feed-2', 'feed-3'],
    async (_url, index) => {
      if (index === 1) {
        throw new Error('temporary RSS outage');
      }

      return {
        items: [
          {
            title: `story-${index}`,
            link: `https://example.com/${index}`
          }
        ]
      };
    }
  );

  assert.equal(result.successfulCount, 2);
  assert.equal(result.failedCount, 1);
  assert.equal(result.items.length, 2);
  assert.deepEqual(
    result.items.map(item => item.title),
    ['story-0', 'story-2']
  );
});

test('RSS handling aborts when every feed fails instead of reporting no news', async () => {
  await assert.rejects(
    () => fetchRssFeeds(
      ['feed-1', 'feed-2'],
      async () => {
        throw new Error('RSS unavailable');
      }
    ),
    /All 2 RSS feeds failed/
  );
});


test('seen retention removes entries older than 30 days and keeps recent entries', () => {
  const file = path.join(process.env.DATA_DIR, 'seen.json');
  const now = Date.now();
  fs.writeFileSync(file, JSON.stringify([
    { url: 'https://example.com/old', seenAt: now - 31 * 24 * 60 * 60 * 1000 },
    { url: 'https://example.com/recent', seenAt: now - 29 * 24 * 60 * 60 * 1000 }
  ]), 'utf8');

  const seen = loadSeen();

  assert.equal(seen.has('https://example.com/old'), false);
  assert.equal(seen.has('https://example.com/recent'), true);
});

test('seen retention saves timestamps and prunes old entries', () => {
  const old = Date.now() - 31 * 24 * 60 * 60 * 1000;
  const recent = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const seen = new Map([
    ['https://example.com/old', old],
    ['https://example.com/recent', recent]
  ]);

  saveSeen(seen);

  const saved = JSON.parse(
    fs.readFileSync(path.join(process.env.DATA_DIR, 'seen.json'), 'utf8')
  );

  assert.deepEqual(saved.map(item => item.url), ['https://example.com/recent']);
  assert.equal(typeof saved[0].seenAt, 'number');
});

test('RSS reader rejects responses larger than the configured limit', async () => {
  const response = {
    headers: new Headers({ 'content-length': String(1024 * 1024 + 1) }),
    text: async () => 'x'
  };

  await assert.rejects(
    () => readResponseTextLimited(response, 1024 * 1024),
    /Response too large/
  );
});

test('Google News decoder failure drops unresolved Google URL candidates', async () => {
  const items = [
    {
      title: 'خبر يفشل فك رابطه',
      description: 'وصف',
      link: 'https://news.google.com/rss/articles/abc',
      googleLink: 'https://news.google.com/rss/articles/abc'
    },
    {
      title: 'خبر آخر',
      description: 'وصف',
      link: 'https://news.google.com/rss/articles/def',
      googleLink: 'https://news.google.com/rss/articles/def'
    }
  ];

  const result = await resolveGoogleNewsLinks(items, async url => {
    if (url.endsWith('/abc')) {
      throw new Error('decoder unavailable');
    }

    return {
      status: true,
      decoded_url: 'https://example.com/def'
    };
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].link, 'https://example.com/def');
});


test('published event dedup blocks the same match from a different source', () => {
  const seen = new Map();
  markSeen(seen, {
    link: 'https://site-a.example/match',
    googleLink: 'https://news.google.com/rss/articles/a',
    title: 'برينتفورد يهزم تشيلسي بثلاثية نظيفة',
    description: 'برينتفورد يفوز على تشيلسي في الدوري الإنجليزي',
    date: new Date('2026-09-19T00:00:00Z')
  }, Date.parse('2026-09-19T00:00:00Z'));

  const sameEventFromAnotherSource = {
    link: 'https://site-b.example/match',
    googleLink: 'https://news.google.com/rss/articles/b',
    title: 'تشيلسي يتلقى هزيمة قاسية أمام برينتفورد بثلاثة أهداف',
    description: 'برينتفورد يحسم المباراة بثلاثية في الجولة الخامسة',
    date: new Date('2026-09-19T00:30:00Z')
  };

  assert.equal(hasPublishedEvent(seen, sameEventFromAnotherSource), true);
});

test('published event dedup keeps a different event for the same player', () => {
  const seen = new Map();
  markSeen(seen, {
    link: 'https://site-a.example/salah-contract',
    title: 'محمد صلاح يجدد عقده مع ليفربول',
    description: 'النجم المصري مستمر مع النادي',
    date: new Date('2026-09-19T00:00:00Z')
  }, Date.parse('2026-09-19T00:00:00Z'));

  const differentEvent = {
    link: 'https://site-b.example/salah-injury',
    title: 'محمد صلاح يغيب عن المباراة بسبب الإصابة',
    description: 'اللاعب لن يشارك بسبب إصابة عضلية',
    date: new Date('2026-09-19T00:30:00Z')
  };

  assert.equal(hasPublishedEvent(seen, differentEvent), false);
});

test('published event dedup does not block the same teams for a much later match', () => {
  const seen = new Map();
  markSeen(seen, {
    link: 'https://site-a.example/match-old',
    title: 'برينتفورد يهزم تشيلسي بثلاثية نظيفة',
    description: 'برينتفورد يفوز على تشيلسي',
    date: new Date('2026-09-10T00:00:00Z')
  }, Date.parse('2026-09-10T00:00:00Z'));

  const laterMatch = {
    link: 'https://site-b.example/match-new',
    title: 'تشيلسي يهزم برينتفورد بهدفين',
    description: 'تشيلسي يحقق الفوز في مباراة جديدة',
    date: new Date('2026-09-19T00:00:00Z')
  };

  assert.equal(hasPublishedEvent(seen, laterMatch), false);
});


test('published event dedup catches alternate match wording across sources', () => {
  const seen = new Map();
  markSeen(seen, {
    link: 'https://site-a.example/match',
    title: 'برينتفورد يهزم تشيلسي بثلاثية نظيفة',
    description: 'برينتفورد يفوز على تشيلسي في الدوري الإنجليزي',
    date: new Date('2026-09-19T00:00:00Z')
  }, Date.parse('2026-09-19T00:00:00Z'));

  const alternateSource = {
    link: 'https://site-d.example/match',
    title: 'تشيلسي يسقط أمام برينتفورد بثلاثة أهداف',
    description: 'هزيمة تشيلسي بثلاثية أمام برينتفورد',
    date: new Date('2026-09-19T00:20:00Z')
  };

  assert.equal(hasPublishedEvent(seen, alternateSource), true);
});


test('match fingerprint dedup handles different wording with the same score', () => {
  const a = story(
    'برينتفورد يهزم تشيلسي 3-0',
    'برينتفورد يفوز على تشيلسي بثلاثة أهداف'
  );
  const b = story(
    'تشيلسي يسقط بثلاثية أمام برينتفورد',
    'هزيمة تشيلسي أمام برينتفورد بنتيجة 0-3'
  );

  assert.deepEqual(extractMatchScore(a.title + ' ' + a.description), [3, 0]);
  assert.deepEqual(extractMatchScore(b.title + ' ' + b.description), [0, 3]);
  assert.equal(getEventFingerprint(a).type, 'match-score');
  assert.equal(getEventFingerprint(b).type, 'match-score');
  assert.equal(
    hasPublishedEvent(
      new Map([['https://site-a.example/match', {
        seenAt: Date.parse('2026-09-19T00:00:00Z'),
        title: a.title,
        description: a.description,
        eventFingerprint: getEventFingerprint(a)
      }]]),
      { ...b, date: new Date('2026-09-19T00:30:00Z') }
    ),
    true
  );
});

test('match fingerprint does not merge the same teams when the score is different', () => {
  const seen = new Map();
  const oldMatch = story(
    'برينتفورد يهزم تشيلسي 3-0',
    'فوز برينتفورد على تشيلسي'
  );
  markSeen(seen, {
    ...oldMatch,
    link: 'https://site-a.example/match',
    date: new Date('2026-09-19T00:00:00Z')
  }, Date.parse('2026-09-19T00:00:00Z'));

  const differentMatch = {
    ...story(
      'تشيلسي يهزم برينتفورد 2-1',
      'تشيلسي يفوز على برينتفورد'
    ),
    date: new Date('2026-09-19T12:00:00Z')
  };

  assert.equal(hasPublishedEvent(seen, differentMatch), false);
});

test('match fingerprint uses a short fallback window when no score is available', () => {
  const seen = new Map();
  const oldMatch = story(
    'برينتفورد يهزم تشيلسي',
    'الفريق يحقق الفوز على تشيلسي'
  );
  markSeen(seen, {
    ...oldMatch,
    link: 'https://site-a.example/match',
    date: new Date('2026-09-19T00:00:00Z')
  }, Date.parse('2026-09-19T00:00:00Z'));

  assert.equal(
    hasPublishedEvent(seen, {
      ...story('تشيلسي يسقط أمام برينتفورد', 'هزيمة أمام برينتفورد'),
      date: new Date('2026-09-19T06:00:00Z')
    }),
    true
  );

  assert.equal(
    hasPublishedEvent(seen, {
      ...story('تشيلسي يسقط أمام برينتفورد', 'هزيمة أمام برينتفورد'),
      date: new Date('2026-09-19T20:00:00Z')
    }),
    false
  );
});
