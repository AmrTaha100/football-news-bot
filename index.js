const Parser = require('rss-parser');
const { GoogleGenAI } = require('@google/genai');
const { GoogleDecoder } = require('google-news-url-decoder');
const fs = require('fs');
const dns = require('dns').promises;
const net = require('net');

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
const CANDIDATE_POOL_SIZE = 25;
const SNR_PRIMARY_COUNT = 10;
const HOURS_BACK = 1.25;

const ARTICLE_MAX_BYTES = 300 * 1024;
const ARTICLE_MAX_CHARS = 2200;
const GEMINI_MAX_INPUT_CHARS = 30000;
const ARTICLE_FETCH_CONCURRENCY = 3;
const GOOGLE_DECODE_CONCURRENCY = 2;

const FETCH_TIMEOUT_MS = 8000;
const GEMINI_TIMEOUT_MS = 45000;
const TELEGRAM_TIMEOUT_MS = 15000;
const RSS_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;

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

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const SEEN_FILE = `${DATA_DIR}/seen.json`;
const RUN_LOCK_FILE = `${DATA_DIR}/run.lock`;

const IS_TEST = process.env.NODE_ENV === 'test';

if (!IS_TEST && !GEMINI_API_KEY) {
  throw new Error('❌ GEMINI_API_KEY غير موجود');
}

if (!IS_TEST && !TELEGRAM_BOT_TOKEN) {
  throw new Error('❌ TELEGRAM_BOT_TOKEN غير موجود');
}

if (!IS_TEST && !TELEGRAM_CHAT_ID) {
  throw new Error('❌ TELEGRAM_CHAT_ID غير موجود');
}

fs.mkdirSync(DATA_DIR, { recursive: true });

const ai = GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: GEMINI_API_KEY })
  : null;

const googleDecoder = new GoogleDecoder();

/*
  =========================================================
  HELPERS
  =========================================================
*/

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getErrorText(error) {
  return [
    error?.message,
    error?.cause?.message,
    error?.status ? `status=${error.status}` : '',
    error?.code ? `code=${error.code}` : ''
  ].filter(Boolean).join(' | ');
}

function isRetryableError(error) {
  const text = getErrorText(error).toLowerCase();
  const status = Number(error?.status || error?.code);

  return (
    [408, 425, 429, 500, 502, 503, 504].includes(status) ||
    /timeout|timed out|econnreset|econnrefused|socket|fetch failed|temporar|unavailable|resource.?exhausted/.test(text)
  );
}

async function withRetry(fn, { name = 'operation', attempts = MAX_RETRIES, baseDelay = 1000 } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableError(error)) throw error;

      const retryAfterMs = Number(error?.retryAfter || 0) * 1000;
      const jitter = Math.floor(Math.random() * 500);
      const delay = retryAfterMs > 0
        ? retryAfterMs + jitter
        : Math.min(8000, baseDelay * (2 ** (attempt - 1)) + jitter);

      console.warn(`⚠️ ${name} failed (attempt ${attempt}/${attempts}). Retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }

  throw lastError;
}

async function withTimeout(promise, ms, label) {
  let timer;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

function isPrivateIp(address) {
  const version = net.isIP(address);

  if (version === 4) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }

  if (version === 6) {
    const normalized = address.toLowerCase();

    // IPv4-mapped / compatible IPv6 addresses can bypass a naive
    // IPv6 prefix check (e.g. ::ffff:127.0.0.1).
    const mappedIpv4Match = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (mappedIpv4Match && net.isIP(mappedIpv4Match[1]) === 4) {
      return isPrivateIp(mappedIpv4Match[1]);
    }

    // Some parsers represent an IPv4-mapped address in hexadecimal,
    // e.g. ::ffff:7f00:1 == 127.0.0.1.
    const mappedHexMatch = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHexMatch) {
      const high = Number.parseInt(mappedHexMatch[1], 16);
      const low = Number.parseInt(mappedHexMatch[2], 16);
      const ipv4 = [
        high >> 8,
        high & 0xff,
        low >> 8,
        low & 0xff
      ].join('.');
      return isPrivateIp(ipv4);
    }

    // IPv4-compatible IPv6 and IPv4-embedded forms.
    const embeddedIpv4Match = normalized.match(/^::(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (embeddedIpv4Match && net.isIP(embeddedIpv4Match[1]) === 4) {
      return isPrivateIp(embeddedIpv4Match[1]);
    }

    // Unspecified, loopback, link-local, unique-local, multicast,
    // documentation, and other non-global IPv6 ranges.
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb') ||
      normalized.startsWith('ff') ||
      normalized.startsWith('2001:db8:')
    );
  }

  return true;
}

async function assertSafeExternalUrl(rawUrl) {
  let url;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only HTTP/HTTPS URLs are allowed');
  }

  const hostname = url.hostname.toLowerCase();

  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error('Private/local hostname blocked');
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('Private IP blocked');
    return url;
  }

  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });

  if (!addresses.length || addresses.some(entry => isPrivateIp(entry.address))) {
    throw new Error('Hostname resolves to a private or unsafe IP');
  }

  return url;
}

async function readResponseTextLimited(response, maxBytes) {
  const contentLength = Number(response.headers.get('content-length') || 0);
