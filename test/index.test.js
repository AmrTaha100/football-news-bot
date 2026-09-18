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
  validateGeminiNews
} = require('../index');

const story = (title, description = '', date = new Date()) => ({ title, description, date });

test('semantic dedup recognizes close paraphrases and keeps one', () => {
  const items = [
    story('برشلونة يعلن تجديد عقد رافينيا حتى 2028', 'النادي أعلن التجديد رسميًا', new Date('2026-09-19T00:00:00Z')),
    story('برشلونة يجدد عقد رافينيا رسميًا حتى عام 2028', 'تم الإعلان رسميًا عن تمديد عقد اللاعب', new Date('2026-09-18T23:55:00Z'))
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
  const a = story('ليفربول يتوصل لاتفاق لضم لاعب الوسط');
  const b = story('ليفربول يتفق مع اللاعب على الانتقال إلى صفوفه');
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
  assert.deepEqual([...loadSeen()].sort(), [...seen].sort());
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
