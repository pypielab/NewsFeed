// Feed 서버 — 외부 패키지 없이 Node 18+ 만으로 동작
// 실행: node server.js  →  http://localhost:3000
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

// .env 로드 (이미 설정된 환경 변수는 덮어쓰지 않음). 키 값은 어디에도 출력하지 않는다.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch { /* .env 없음 */ }

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const KW_FILE = path.join(DATA_DIR, 'keywords.json');
const ART_FILE = path.join(DATA_DIR, 'articles.json');
const MAX_ARTICLES = 3000;
const KEEP_MS = 7 * 24 * 3600 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

fs.mkdirSync(DATA_DIR, { recursive: true });
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

// groups: 그룹 이름 목록(순서 유지), groupOf: { 키워드: 그룹 이름 } — 그룹이 없는 키워드는 "미분류"
let settings = { keywords: [], intervalSec: 60, groups: [], groupOf: {}, dismissed: [] };
Object.assign(settings, readJson(KW_FILE, {}));
let articles = readJson(ART_FILE, []);           // 중복 제거가 끝난 기사 목록
const sourceStatus = {};                          // 포털별 마지막 수집 결과
let saveTimer = null;
const saveSettings = () => fs.writeFileSync(KW_FILE, JSON.stringify(settings, null, 2));
const saveArticles = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFile(ART_FILE, JSON.stringify(articles), () => {}), 500);
};

// ---------- 유틸 ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', middot: '·', ndash: '–', mdash: '—', times: '×', lsaquo: '‹', rsaquo: '›', laquo: '«', raquo: '»' };
const decode = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
const clean = (s) => decode((s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<\/?(?:b|mark|em|strong|i)\b[^>]*>/gi, '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

async function fetchText(url, { encoding = 'utf-8' } = {}) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'ko-KR,ko;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = new TextDecoder(encoding).decode(await res.arrayBuffer());
  if (res.url.includes('captcha')) throw new Error('캡차 차단');
  if (/captcha\.search\.daum\.net/.test(text.slice(0, 600))) throw new Error('캡차 차단');
  return text;
}

// "5분 전", "2시간전", "2026.10.13." 등을 시각으로 변환
function parseWhen(t, now = Date.now()) {
  if (!t) return now;
  let m = t.match(/(\d+)\s*(초|분|시간|일|주)\s*전/);
  if (m) {
    const unit = { 초: 1e3, 분: 6e4, 시간: 36e5, 일: 864e5, 주: 6048e5 }[m[2]];
    return now - Number(m[1]) * unit;
  }
  m = t.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})\.?(?:\s*(\d{1,2}):(\d{2}))?/);
  if (m) return new Date(+m[1], m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)).getTime();
  return now;
}

// ---------- 포털별 수집기 ----------
async function searchGoogle(q) {
  const xml = await fetchText(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko`);
  const out = [];
  for (const it of xml.split('<item>').slice(1)) {
    const get = (tag) => (it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)) || [])[1] || '';
    let title = clean(get('title'));
    const press = clean(get('source'));
    if (press && title.endsWith(' - ' + press)) title = title.slice(0, -(press.length + 3));
    const link = clean(get('link'));
    if (!title || !link) continue;
    out.push({ title, url: link, press, time: new Date(get('pubDate')).getTime() || Date.now(), summary: clean(get('description')).replace(title, '').replace(press, '').trim() });
  }
  return out;
}

const HIDDEN = /<span class="fender-ui_[^>]*>[^<]*<\/span>/g;   // "새 창 열림" 같은 접근성용 숨김 텍스트
async function searchNaver(q) {
  const html = await fetchText(`https://search.naver.com/search.naver?where=news&sort=1&query=${encodeURIComponent(q)}`);
  const out = [];
  const re = /<a [^>]*href="([^"]+)"[^>]*data-heatmap-target="\.tit"[^>]*>([\s\S]*?)<\/a>/g;
  const hits = [...html.matchAll(re)];
  hits.forEach((m, i) => {
    // 제목 앵커 앞 구간(언론사·시간)과 뒤 구간(요약)을 각각 잘라서 사용
    const prevEnd = i ? hits[i - 1].index + hits[i - 1][0].length : Math.max(0, m.index - 6000);
    const before = html.slice(prevEnd, m.index);
    const next = i + 1 < hits.length ? hits[i + 1].index : m.index + 6000;
    const after = html.slice(m.index + m[0].length, next);
    const pressM = [...before.matchAll(/profile-info-title-text[^>]*>([\s\S]*?)<\/span>/g)];
    const press = pressM.length ? clean(pressM[pressM.length - 1][1]) : '';
    const timeM = (before + after).match(/(\d+\s*(?:초|분|시간|일|주)\s*전|\d{4}\.\d{1,2}\.\d{1,2}\.)/);
    const sum = after.match(/data-heatmap-target="\.body"[^>]*>([\s\S]*?)<\/a>/);
    const im = after.match(/<img[^>]+src="(https?:[^"]+)"/);
    out.push({ title: clean(m[2].replace(HIDDEN, '')), url: decode(m[1]), press, time: parseWhen(timeM && timeM[1]), summary: sum ? clean(sum[1].replace(HIDDEN, '')) : '', thumb: im ? decode(im[1]) : '' });
  });
  return out;
}

async function searchDaum(q) {
  const html = await fetchText(`https://search.daum.net/search?w=news&DA=PGD&sort=recency&q=${encodeURIComponent(q)}`);
  const out = [];
  for (const li of html.split(/<li data-docid=/).slice(1)) {
    const t = li.match(/item-title[\s\S]*?<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!t) continue;
    const press = (li.match(/class="tit_item" title="([^"]*)"/) || [])[1] || '';
    const timeM = li.match(/(\d+\s*(?:초|분|시간|일|주)\s*전|\d{4}\.\d{1,2}\.\d{1,2}\.)/);
    const sum = li.match(/conts-desc[^>]*>([\s\S]*?)<\/p>/);
    const im = li.match(/item-thumb[\s\S]*?data-original-src="(https?:[^"]+)"/);
    out.push({ title: clean(t[2]), url: decode(t[1]), press: clean(press), time: parseWhen(timeM && timeM[1]), summary: sum ? clean(sum[1]) : '', thumb: im ? decode(im[1]) : '' });
  }
  return out;
}

async function searchNate(q) {
  const html = await fetchText(`https://news.nate.com/search?q=${encodeURIComponent(q)}&sort=date`, { encoding: 'euc-kr' });
  const out = [];
  for (const li of html.split(/<li class="items">/).slice(1)) {
    const a = li.match(/<a href="([^"]+)"/);
    const t = li.match(/<h2 class="tit">([\s\S]*?)<\/h2>/);
    if (!a || !t) continue;
    const sum = li.match(/<span class="txt">([\s\S]*?)<\/span>/);
    const tm = li.match(/<span class="time">([\s\S]*?)<\/span>\s*<\/span>/) || li.match(/<span class="time">([\s\S]*?)<\/span>/);
    const tmText = tm ? tm[1] : '';
    const timeM = tmText.match(/(\d+\s*(?:초|분|시간|일|주)\s*전|\d{4}\.\d{1,2}\.\d{1,2}\.?)/);
    const press = clean(tmText.split('<span class="div">')[0]);
    const im = li.match(/class="thumb"[\s\S]*?<img[^>]+src="([^"]+)"/);
    const abs = (u) => (u.startsWith('//') ? 'https:' + u : u);
    out.push({ title: clean(t[1]), url: abs(a[1]), press, time: parseWhen(timeM && timeM[1]), summary: sum ? clean(sum[1]) : '', thumb: im ? abs(decode(im[1])) : '' });
  }
  return out;
}

const SOURCES = {
  naver: { label: '네이버', fn: searchNaver },
  google: { label: '구글', fn: searchGoogle },
  daum: { label: '다음', fn: searchDaum },
  nate: { label: '네이트', fn: searchNate },
};

// ---------- 중복 제거 ----------
const TRACK = /^(utm_|fbclid|gclid|from|ref|cid|input|nsctype|rcd)/i;
function canonUrl(u) {
  try {
    const x = new URL(u);
    if (x.hostname === 'news.google.com') return null;       // 구글 뉴스는 리다이렉트 링크라 URL 비교 불가
    for (const k of [...x.searchParams.keys()]) if (TRACK.test(k)) x.searchParams.delete(k);
    x.searchParams.sort();
    return x.hostname.replace(/^(www|m|n)\./, '') + x.pathname.replace(/\/$/, '') + x.search;
  } catch { return null; }
}
const normTitle = (t) => t.toLowerCase()
  .replace(/\[[^\]]{1,12}\]|\([^)]{1,12}\)|【[^】]*】/g, '')       // [단독] (종합) 같은 말머리
  .replace(/[^0-9a-z가-힣]/g, '');
const grams = (s) => { const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; };
function similar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const short = a.length < b.length ? a : b, long = a === short ? b : a;
  if (short.length >= 12 && long.includes(short)) return true;   // 말줄임(...)된 제목
  const ga = grams(a), gb = grams(b);
  let inter = 0; for (const x of ga) if (gb.has(x)) inter++;
  return inter / (ga.size + gb.size - inter || 1) >= 0.6;
}

const hasKw = (a, kw) => a.keywords.includes(kw);
// 새 기사를 병합. 반환: 'new' | 'merged' (신규 / 기존 기사에 합쳐짐)
function ingest(item, source, keyword) {
  const nt = normTitle(item.title);
  if (nt.length < 4) return null;
  const startOfToday = new Date().setHours(0, 0, 0, 0);          // 오늘 0시(서버 로컬 시간) 이전 기사는 수집하지 않음
  if (item.time < startOfToday) return null;
  const cu = canonUrl(item.url);
  const cutoff = Date.now() - 36 * 3600 * 1000;
  let hit = null;
  for (const a of articles) {
    if ((cu && a.canon === cu) || (a.time > cutoff || item.time > cutoff) && similar(a.nt, nt)) { hit = a; break; }
  }
  if (hit) {
    let changed = false;
    if (!hit.sources.includes(source)) { hit.sources.push(source); changed = true; }
    if (!hit.keywords.includes(keyword)) { hit.keywords.push(keyword); changed = true; }
    if (!hit.links[source]) { hit.links[source] = item.url; changed = true; }
    if (!hit.press && item.press) hit.press = item.press, changed = true;
    if (!hit.summary && item.summary) hit.summary = item.summary, changed = true;
    if (!hit.thumb && item.thumb) hit.thumb = item.thumb, changed = true;
    // 구글 링크보다 원문 링크를 대표 URL로
    if (/news\.google\.com/.test(hit.url) && !/news\.google\.com/.test(item.url)) { hit.url = item.url; hit.canon = cu; changed = true; }
    return changed ? { kind: 'merged', article: hit } : null;
  }
  const art = {
    id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36),
    title: item.title, url: item.url, canon: cu, nt, press: item.press, summary: item.summary.slice(0, 300),
    thumb: item.thumb || '', time: item.time, fetchedAt: Date.now(), keywords: [keyword], sources: [source], links: { [source]: item.url },
  };
  articles.push(art);
  return { kind: 'new', article: art };
}

// ---------- 기사 본문 추출 (오른쪽 패널용) ----------
// 언론사 사이트는 iframe 삽입을 막는 경우가 많아, 서버에서 받아 본문만 뽑아 보여준다.
async function resolveGoogle(link) {
  const id = new URL(link).pathname.split('/').pop();
  const html = await fetchText(`https://news.google.com/rss/articles/${id}?hl=ko&gl=KR&ceid=KR:ko`);
  const sg = html.match(/data-n-a-sg="([^"]+)"/), ts = html.match(/data-n-a-ts="([^"]+)"/);
  if (!sg || !ts) throw new Error('구글 링크 해석 실패');
  const inner = JSON.stringify(['garturlreq', [['X', 'X', ['X', 'X'], null, null, 1, 1, 'US:en', null, 1, null, null, null, null, null, 0, 1], 'X', 'X', 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0], id, +ts[1], sg[1]]);
  const r = await fetch('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'User-Agent': UA },
    body: 'f.req=' + encodeURIComponent(JSON.stringify([[['Fbv4je', inner, null, 'generic']]])), signal: AbortSignal.timeout(15000),
  });
  const parts = JSON.parse((await r.text()).split('\n\n')[1]);
  return JSON.parse(parts[0][2])[1];
}

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ko-KR,ko;q=0.9', Accept: 'text/html,*/*;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const buf = new Uint8Array(await res.arrayBuffer());
  let cs = ((res.headers.get('content-type') || '').match(/charset=([\w-]+)/i) || [])[1];
  if (!cs) cs = (new TextDecoder('latin1').decode(buf.slice(0, 3000)).match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1] || 'utf-8';
  let text; try { text = new TextDecoder(cs).decode(buf); } catch { text = new TextDecoder('utf-8').decode(buf); }
  return { html: text, url: res.url };
}

const BOILER = /글자\s*크기|요약본으로|AI가?\s*요약|기사\s*요약|프린트|인쇄|저작권|무단\s*(전재|복제|배포)|재배포|ⓒ|Copyright|구독|댓글|로그인|기사\s*제보|광고문의|@[\w.-]+\.[a-z]{2,}|바로가기|관련\s*기사|공유하기|페이스북|카카오톡/i;
function extractArticle(html) {
  const meta = (name) => {
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i'));
    const c = m && m[0].match(/content=["']([^"']*)["']/i);
    return c ? decode(c[1]).trim() : '';
  };
  // 본문 컨테이너 시작점을 먼저 찾고, 그 지점부터 일정 길이만 정리한다 (전체 페이지를 먼저 지우면 닫는 태그 불일치로 본문이 날아갈 수 있음)
  const START = /itemprop=["']articleBody["']|id=["'](?:article-view-content-div|articleBodyContents|dic_area|newsct_article|articleBody|article_body|news_body_area|newsContent|view_con|cont_newstext|articeBody)["']|<article\b/i;
  const toLines = (src) => decode(src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|iframe|figcaption|button|select)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n').replace(/<[^>]*>/g, ''))
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => (l.length >= 40 || (l.length >= 25 && /[.다요]["”’']?$/.test(l))) && !(l.length < 120 && BOILER.test(l)));
  const sm = START.exec(html);
  const from = sm ? html.indexOf('>', sm.index) + 1 : 0;      // 시작 태그의 속성 조각이 본문에 섞이지 않도록 '>' 이후부터
  let lines = sm ? toLines(html.slice(from, from + 80000)) : [];
  if (lines.length < 3) lines = toLines(html);
  const title = meta('og:title');
  const tkey = (title || '').replace(/\s+/g, '').slice(0, 14);
  const seen = new Set();
  let paragraphs = lines.filter((l) => !seen.has(l) && seen.add(l) && !(tkey.length >= 8 && l.replace(/\s+/g, '').includes(tkey)));  // 제목 반복 줄 제거
  const cut = paragraphs.findIndex((l) => /^(관련\s*기사|관련\s*뉴스|많이\s*본|추천\s*기사|인기\s*기사|이\s*시각|주요\s*뉴스|함께\s*보면)/.test(l));
  if (cut > 2) paragraphs = paragraphs.slice(0, cut);                                                                                  // 하단 추천 영역 제외
  paragraphs = paragraphs.slice(0, 60);
  return { title, image: meta('og:image'), site: meta('og:site_name'), description: meta('og:description') || meta('description'), paragraphs };
}

const readerCache = new Map();
async function getReader(a) {
  const hit = readerCache.get(a.id);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.data;
  let url = a.url;
  try { if (/news\.google\.com/.test(url)) url = await resolveGoogle(url); } catch { /* 링크만 못 풀고 요약으로 대체 */ }
  let data = { url, ok: false };
  if (!/news\.google\.com/.test(url)) {
    try {
      const page = await fetchPage(url);
      data = { url: page.url, ok: true, ...extractArticle(page.html) };
      if (!a.articleUrl) a.articleUrl = page.url;
    } catch (e) { data.error = String(e.message || e); }
  }
  readerCache.set(a.id, { at: Date.now(), data });
  if (readerCache.size > 200) readerCache.delete(readerCache.keys().next().value);
  return data;
}

// ---------- 실시간 푸시 (SSE) ----------
const clients = new Set();
const publicArt = ({ canon, nt, ...rest }) => rest;
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(msg);
}

// ---------- 수집 루프 ----------
let running = false;
let queued = null;                       // 수집 중에 들어온 요청: 키워드 Set 또는 'all'
async function collect(only) {
  const want = only ? (Array.isArray(only) ? only : [only]) : null;
  if (running) {                          // 건너뛰지 않고 현재 수집이 끝난 뒤 이어서 처리
    if (!want) queued = 'all';
    else if (queued !== 'all') { queued = queued || new Set(); want.forEach((k) => queued.add(k)); }
    return;
  }
  running = true;
  broadcast('status', { collecting: true });
  const kws = want || settings.keywords;
  const batch = [];
  try {
    for (const kw of kws) {
      const results = await Promise.allSettled(Object.entries(SOURCES).map(async ([key, s]) => {
        const items = await s.fn(kw);
        return { key, items };
      }));
      results.forEach((r, i) => {
        const key = Object.keys(SOURCES)[i];
        if (r.status === 'fulfilled') {
          sourceStatus[key] = { ok: true, count: r.value.items.length, at: Date.now(), keyword: kw };
          if (!r.value.items.length) sourceStatus[key].note = '결과 0건 (구조 변경 또는 차단 가능성)';
          // 오래된 순으로 넣어 최신 기사가 마지막에 오게 함
          for (const it of r.value.items.slice().reverse()) {
            const res = ingest(it, key, kw);
            if (res) batch.push(res);
          }
        } else {
          sourceStatus[key] = { ok: false, error: String(r.reason && r.reason.message || r.reason), at: Date.now(), keyword: kw };
        }
      });
    }
  } finally {
    running = false;
    articles = articles.filter((a) => Date.now() - a.time < KEEP_MS).sort((a, b) => b.time - a.time).slice(0, MAX_ARTICLES);
    saveArticles();
    const map = new Map();
    for (const b of batch) map.set(b.article.id, b);                // 같은 기사의 중복 이벤트 정리
    if (map.size) broadcast('articles', [...map.values()].map((b) => ({ kind: b.kind, article: publicArt(b.article) })));
    broadcast('status', { collecting: false, sources: sourceStatus, lastRun: Date.now() });
    if (queued) {
      const q = queued; queued = null;
      setImmediate(() => collect(q === 'all' ? null : [...q].filter((k) => settings.keywords.includes(k))));
    }
  }
}

let timer = null;
function schedule() {
  clearInterval(timer);
  timer = setInterval(() => settings.keywords.length && collect(), Math.max(20, settings.intervalSec) * 1000);
}

// ---------- LLM (Gemini 무료 등급) ----------
// 한도: 모델별 RPM/RPD 가 따로 있고 프로젝트 단위로 적용된다. 하루 한도는 태평양 시간 자정에 초기화.
// 그래서 (1) 모델별 하루 호출 상한을 두고 (2) 호출 간격을 벌리고 (3) 실패하면 다음 모델로 넘어간다.
const LLM_FILE = path.join(DATA_DIR, 'llm-usage.json');
const JUDGE_FILE = path.join(DATA_DIR, 'llm-judgments.json');
const llmCfg = () => ({
  key: process.env.GEMINI_API_KEY || '',
  models: (process.env.GEMINI_MODELS || 'gemini-3.1-flash-lite,gemini-3.5-flash-lite').split(',').map((x) => x.trim()).filter(Boolean),
  cap: Number(process.env.LLM_DAILY_CAP) || 300,
});
const ptDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());   // 예: 2026-10-14
let llmUsage = readJson(LLM_FILE, { day: '', counts: {} });
const usageNow = () => { if (llmUsage.day !== ptDay()) llmUsage = { day: ptDay(), counts: {} }; return llmUsage; };
const bumpUsage = (model) => { const u = usageNow(); u.counts[model] = (u.counts[model] || 0) + 1; fs.writeFile(LLM_FILE, JSON.stringify(u), () => {}); };
let judgments = readJson(JUDGE_FILE, {});                       // { "그룹|용어": { verdict, reason, at } }
const saveJudgments = () => fs.writeFile(JUDGE_FILE, JSON.stringify(judgments), () => {});
let judgeVersion = 0;

let lastLlmAt = 0, llmChain = Promise.resolve();
const llmGate = () => (llmChain = llmChain.then(async () => {            // 호출을 직렬화하고 최소 간격(분당 ≤13회)을 보장
  const wait = lastLlmAt + 4600 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastLlmAt = Date.now();
}));

function llmStatus() {
  const c = llmCfg(), u = usageNow();
  return { enabled: !!c.key, models: c.models, cap: c.cap, used: Object.fromEntries(c.models.map((m) => [m, u.counts[m] || 0])), day: u.day };
}

// prompt → JSON(스키마 고정). 실패 시 다음 모델로.
async function llmJson(prompt, schema) {
  const c = llmCfg();
  if (!c.key) throw new Error('GEMINI_API_KEY 가 설정되지 않았습니다 (.env 확인)');
  let lastErr = new Error('사용 가능한 모델이 없습니다');
  for (const model of c.models) {
    if ((usageNow().counts[model] || 0) >= c.cap) { lastErr = new Error(`${model}: 오늘 호출 상한(${c.cap}) 도달`); continue; }
    await llmGate();
    bumpUsage(model);                                                     // 실패해도 보수적으로 센다
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': c.key },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', responseSchema: schema, temperature: 0.1 },
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 429 || res.status >= 500) { lastErr = new Error(`${model}: HTTP ${res.status} (한도/혼잡)`); continue; }
      if (!res.ok) { const t = await res.text(); throw new Error(`${model}: HTTP ${res.status} ${t.slice(0, 160)}`); }
      const j = await res.json();
      const text = (((j.candidates || [])[0] || {}).content || {}).parts;
      if (!text) throw new Error(`${model}: 빈 응답`);
      return { model, data: JSON.parse(text.map((p) => p.text || '').join('')) };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// 추천 후보가 "이 모니터링 범위에 맞는 검색 키워드인가"를 판정
async function judgeCandidates(group, scope = 'today') {
  const sugg = buildSuggestions(scope);
  const g = sugg.groups.find((x) => x.group === group);
  if (!g || !g.items.length) return { judged: 0 };
  const todo = g.items.filter((i) => !i.ai).slice(0, 30);
  if (!todo.length) return { judged: 0 };
  const prompt = `당신은 뉴스 모니터링 키워드 큐레이터입니다.
모니터링 범위는 사용자가 등록한 아래 키워드로 정의됩니다.
등록 키워드: ${g.seeds.join(', ') || '(없음)'}

아래 "후보 용어"가 이 범위의 뉴스를 찾는 데 쓸 검색 키워드로 적합한지 판정하세요. 각 후보에는 실제 기사 제목 예시가 있습니다.
- relevant: 범위와 직접 관련된 구체적인 용어(사건, 기관, 기법, 제품, 규제 등). 검색 키워드로 추가할 가치가 있음
- generic: 너무 일반적이라 검색 키워드로 부적합(예: 사고, 피해, 추가, 점검 같은 흔한 단어)
- offtopic: 범위와 무관한 주제
reason 은 한국어 한 문장(30자 이내). 후보 목록의 term 을 그대로 사용하세요.

후보 용어:
${JSON.stringify(todo.map((i) => ({ term: i.term, 기사수: i.df, 제목예시: i.samples.map((x) => x.title) })))}`;
  const schema = {
    type: 'ARRAY',
    items: { type: 'OBJECT', properties: { term: { type: 'STRING' }, verdict: { type: 'STRING', enum: ['relevant', 'generic', 'offtopic'] }, reason: { type: 'STRING' } }, required: ['term', 'verdict', 'reason'] },
  };
  const { model, data } = await llmJson(prompt, schema);
  let n = 0;
  const valid = new Set(todo.map((i) => i.term));
  for (const r of Array.isArray(data) ? data : []) {
    if (!valid.has(r.term) || !['relevant', 'generic', 'offtopic'].includes(r.verdict)) continue;
    judgments[group + '|' + r.term] = { verdict: r.verdict, reason: String(r.reason || '').slice(0, 80), model, at: Date.now() };
    n++;
  }
  if (n) { saveJudgments(); judgeVersion++; }
  return { judged: n, asked: todo.length, model };
}

// ---------- 설정: API 키 (.env) ----------
// 키는 .env 에만 저장하고, 화면으로는 절대 돌려보내지 않는다(뒤 4자리만 표시).
const ENV_FILE = path.join(__dirname, '.env');
function writeEnv(updates) {                                    // 값이 null/'' 이면 해당 줄 삭제. 다른 줄과 주석은 그대로 둔다
  let lines = [];
  try { lines = fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/); } catch { /* 새로 만든다 */ }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();     // 끝의 빈 줄을 먼저 정리해야 새 줄이 중간에 끼지 않는다
  for (const [k, v] of Object.entries(updates)) {
    const idx = lines.findIndex((l) => new RegExp('^\\s*' + k + '\\s*=').test(l));
    if (v === null || v === '') { if (idx >= 0) lines.splice(idx, 1); delete process.env[k]; }
    else { if (idx >= 0) lines[idx] = k + '=' + v; else lines.push(k + '=' + v); process.env[k] = v; }
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n', { mode: 0o600 });
}
function keySource() {
  try { if (/^\s*GEMINI_API_KEY\s*=\s*\S+/m.test(fs.readFileSync(ENV_FILE, 'utf8'))) return '.env'; } catch { /* 없음 */ }
  return process.env.GEMINI_API_KEY ? 'system' : 'none';
}
function settingsView() {
  const c = llmCfg(), k = c.key;
  return {
    llm: {
      configured: !!k, masked: k ? '••••••••' + k.slice(-4) : '', source: keySource(),
      models: c.models, cap: c.cap, status: llmStatus(),
    },
  };
}
async function testGeminiKey(key) {                             // 모델 목록 조회 — 생성 호출이 아니라서 일일 호출 한도를 쓰지 않는다
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(15000) });
    if (res.ok) return { ok: true, message: '연결 성공: 키가 유효합니다.' };
    let m = ''; try { m = JSON.parse(await res.text()).error.message || ''; } catch { /* 본문 없음 */ }
    return { ok: false, message: `HTTP ${res.status}: ${m.split(key).join('***').slice(0, 140)}` };
  } catch (e) { return { ok: false, message: '연결 실패: ' + String(e.message || e).split(key).join('***').slice(0, 140) }; }
}

// ---------- 카테고리 브리핑 (Gemini) ----------
// 카테고리의 최신 기사 제목(중요 기사 우선)을 모델에 보내 "지금 무슨 일이 일어나는가"를 요약한다.
// 사용자가 버튼을 눌렀을 때만 생성하며, 같은 상태에서는 30분간 저장본을 재사용해 호출을 아낀다.
// 분석 범위: 'today' = 서버 PC 기준 오늘 0시 이후 기사, 'all' = 보관 중인 전체 기사
const todayStart = () => new Date().setHours(0, 0, 0, 0);
const scopeArts = (scope) => (scope === 'all' ? articles : articles.filter((a) => a.time >= todayStart()));
const briefKey = (g, scope) => (scope === 'all' ? g + '#all' : g);
const BRIEF_FILE = path.join(DATA_DIR, 'llm-briefings.json');
let briefs = readJson(BRIEF_FILE, {});                        // { 그룹: { headline, topics, watch, at, model, count, used } }
const saveBriefs = () => fs.writeFile(BRIEF_FILE, JSON.stringify(briefs), () => {});
// 범위(scope) 도입 전에 만든 브리핑은 보관 전체 기사 기준이므로 '전체' 범위 키로 옮긴다
for (const [k, v] of Object.entries(briefs)) if (v && v.scope === undefined && !k.endsWith('#all')) { briefs[k + '#all'] = { ...v, scope: 'all' }; delete briefs[k]; }
const briefBusy = new Set();

async function makeBrief(group, force, scope = 'today') {
  scope = scope === 'all' ? 'all' : 'today';
  const bkey = briefKey(group, scope);
  const gOf = (k) => settings.groupOf[k] || '';
  const seeds = settings.keywords.filter((k) => gOf(k) === group);
  const pool = scopeArts(scope).filter((a) => a.keywords.some((k) => gOf(k) === group));
  if (!pool.length) throw new Error(scope === 'today' ? '오늘 수집된 기사가 없습니다 (‘오늘만’을 끄면 이전 기사로 만들 수 있습니다)' : '이 카테고리에 수집된 기사가 없습니다');
  const prev = briefs[bkey];
  if (!force && prev && Date.now() - prev.at < 30 * 60 * 1000 && prev.count === pool.length) return { ...prev, reused: true };
  if (briefBusy.has(bkey)) throw new Error('이미 생성 중입니다');
  briefBusy.add(bkey);
  try {
    const joint = (a) => a.keywords.filter((k) => gOf(k) === group).length >= 2;
    const picked = pool.slice().sort((a, b) => (joint(b) - joint(a)) || (b.time - a.time)).slice(0, 60);   // 중요 기사 우선, 최대 60건
    const hhmm = (t) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
    const lines = picked.map((a, i) => `${i + 1}. [${hhmm(a.time)}] ${a.title}${a.press ? ` (${a.press})` : ''}${joint(a) ? ' ★' : ''}`);
    const prompt = `당신은 뉴스 모니터링 요약 담당자입니다.
모니터링 범위는 사용자가 등록한 키워드로 정의됩니다: ${seeds.join(', ') || '(없음)'}
아래는 ${scope === 'today' ? '오늘' : '최근 며칠간'} 수집된 기사 제목 목록입니다(번호, 시각, 제목, 언론사). ★ 표시는 여러 등록 키워드에 동시에 잡힌 기사입니다.

지금 무슨 일이 일어나고 있는지 브리핑하세요.
- headline: 오늘 흐름을 한 문장(60자 이내)으로 요약
- topics: 주요 주제 3~5개. 같은 사건을 다룬 기사들은 하나의 주제로 묶고, 각 주제마다 title(20자 이내), summary(1~2문장), articles(근거가 되는 기사 번호 1~5개)를 작성
- watch: 앞으로 주목할 점 0~3개(각 한 문장). 제목에서 근거를 찾을 수 없으면 비워 두세요
반드시 제목에 있는 내용만 사용하고, 제목에 없는 사실·수치·원인을 추측해서 쓰지 마세요. 한국어로 작성하세요.

기사 목록:
${lines.join('\n')}`;
    const schema = {
      type: 'OBJECT',
      properties: {
        headline: { type: 'STRING' },
        topics: { type: 'ARRAY', items: { type: 'OBJECT', properties: { title: { type: 'STRING' }, summary: { type: 'STRING' }, articles: { type: 'ARRAY', items: { type: 'INTEGER' } } }, required: ['title', 'summary', 'articles'] } },
        watch: { type: 'ARRAY', items: { type: 'STRING' } },
      },
      required: ['headline', 'topics', 'watch'],
    };
    const { model, data } = await llmJson(prompt, schema);
    const brief = {
      headline: String(data.headline || '').slice(0, 200),
      topics: (Array.isArray(data.topics) ? data.topics : []).slice(0, 6).map((t) => ({
        title: String(t.title || '').slice(0, 60),
        summary: String(t.summary || '').slice(0, 400),
        articleIds: [...new Set((Array.isArray(t.articles) ? t.articles : []).map((n) => picked[n - 1] && picked[n - 1].id).filter(Boolean))].slice(0, 5),
      })).filter((t) => t.title && t.summary),
      watch: (Array.isArray(data.watch) ? data.watch : []).slice(0, 3).map((x) => String(x).slice(0, 200)).filter(Boolean),
      at: Date.now(), model, count: pool.length, used: picked.length, scope,
    };
    briefs[bkey] = brief;
    saveBriefs();
    return brief;
  } finally { briefBusy.delete(bkey); }
}

// ---------- 추천 키워드 후보 (시험) ----------
// 카테고리별로, 이미 수집된 기사(제목+요약)에서 "자주·다양한 언론사에서·최근 늘어난" 단어/명사구를 찾아 후보로 올린다.
// 형태소 분석기 없이 조사 제거 + 불용어 규칙으로 근사한다 (품질은 실제 데이터로 확인 필요).
const JOSA = /(에서는|으로는|에게는|이라는|이라고|으로서|으로써|까지는|부터는|에서도|에서|에게|으로|까지|부터|라는|라고|로서|로써|처럼|보다|마다|조차|이나|이며|이고|이란|께서|한테|에는|에도|과의|와의|으로의|로의|은|는|이|가|을|를|의|에|와|과|도|만|로|들)$/;
const VERBISH = /(했다|한다|된다|하는|하게|하고|하며|하기|했던|해도|이다|입니다|이라|라며|라고|다|며|한|할|된|될|적|등|및)$/;
const STOP = new Set(('기자 지난 이번 관련 대한 통해 위해 통한 위한 대해 관해 따라 따르면 있다 있는 없는 이후 이날 올해 내년 지난해 오는 최근 현재 대비 기준 경우 가능성 예정 진행 발표 밝혔다 말했다 것으로 이상 이하 정도 때문 오전 오후 한편 또한 하지만 그러나 특히 다만 이어 앞서 대상 방안 추진 강화 확대 개최 공개 제공 운영 지원 전체 모두 다른 같은 여러 매우 가장 계속 이를 이에 그는 이는 것이 수가 등이 한다 했다 된다 위원 대표 회장 사장 관계자 담당 부문 기업 업계 시장 국내 해외 정부 회사 우리 지금 오늘 어제 내일 사진 제공 출처 영상 뉴스 단독 종합 속보 포토 인터뷰 칼럼 사설 기관 상반기 하반기 분기 만나 면담 생산 성장 투자 확인 설명 논의 계획 관련해 이어서 대해서 그리고 따라서 사용 이용 구축 도입 마련 실시 결과 내용 상황 문제 필요 중심 분야 부분 수준 규모 단계 과정 방식 형태 요구 요청 조치 대응 입장 의견 주장 지적 평가 전망 예상 우려 기대 가운데 사이 위치 모습 모양 자리 사람 한국 서울 대한민국').split(' '));
const NUMUNIT = /^(년|월|일|억|조|만|천|백|배|개|명|건|곳|회|차|위|번)[가-힣]*$|^[가-힣]*(억|조|만)(원|달러|엔|위안)$/;
const normT = (t) => t.replace(/\s+/g, '').toLowerCase();

function tokenize(text) {
  const out = [];
  for (const sent of text.split(/[.!?\n"“”'‘’…·()\[\]{}<>|]|[,:;]\s/)) {
    const toks = [];
    for (const m of sent.matchAll(/CVE-\d{4}-\d{4,}|[A-Za-z][A-Za-z0-9.+#-]{1,}|[가-힣]{2,}/g)) {
      let t = m[0];
      if (/^[가-힣]+$/.test(t)) {
        for (let i = 0; i < 2; i++) { const j = t.match(JOSA); if (j && t.length - j[0].length >= 2) t = t.slice(0, -j[0].length); else break; }
        if (VERBISH.test(t) && t.length <= 4) { toks.push(null); continue; }   // 동사·형용사로 보이는 말은 건너뛰고 명사구를 끊는다
      } else if (!/^CVE-/.test(t) && t.length < 3 && t === t.toLowerCase()) { toks.push(null); continue; }
      toks.push(STOP.has(t) || t.length < 2 || NUMUNIT.test(t) ? null : t);
    }
    out.push(toks);
  }
  return out;
}

let suggCache = { key: '', at: 0, data: null };
function buildSuggestions(scope = 'today') {
  scope = scope === 'all' ? 'all' : 'today';
  const base = scopeArts(scope);
  const cacheKey = `${scope}:${base.length}:${settings.keywords.join()}:${(settings.dismissed || []).length}:${JSON.stringify(settings.groupOf)}:${judgeVersion}`;
  if (suggCache.key === cacheKey && Date.now() - suggCache.at < 30000) return suggCache.data;
  const dismissed = new Set((settings.dismissed || []).map(normT));
  const kwNorm = settings.keywords.map(normT);
  const pressNorm = new Set(base.map((a) => normT(a.press || '')).filter((p) => p.length >= 2));
  const gOf = (k) => settings.groupOf[k] || '';
  const now = Date.now(), DAY = 864e5;

  // 기사별 후보 용어 집합 (제목에서 나온 것 / 제목+요약에서 나온 것)
  const termsOf = new Map();
  const termsFor = (a) => {
    if (termsOf.has(a.id)) return termsOf.get(a.id);
    const all = new Set(), inTitle = new Set();
    for (const [text, isTitle] of [[a.title, true], [a.summary || '', false]]) {
      for (const toks of tokenize(text)) {
        for (let i = 0; i < toks.length; i++) {
          if (!toks[i]) continue;
          const uni = toks[i]; all.add(uni); if (isTitle) inTitle.add(uni);
          if (toks[i + 1]) { const bi = uni + ' ' + toks[i + 1]; all.add(bi); if (isTitle) inTitle.add(bi); }
        }
      }
    }
    const r = { all, inTitle };
    termsOf.set(a.id, r);
    return r;
  };

  const groups = [...new Set([...settings.groups, ...settings.keywords.filter((k) => !gOf(k)).map(() => '')])];
  const total = base.length;
  const dfAll = new Map();
  for (const a of base) for (const t of termsFor(a).all) dfAll.set(t, (dfAll.get(t) || 0) + 1);

  const result = groups.map((g) => {
    const seeds = settings.keywords.filter((k) => gOf(k) === g);
    const corpus = base.filter((a) => a.keywords.some((k) => gOf(k) === g));
    const stat = new Map();
    for (const a of corpus) {
      const { all, inTitle } = termsFor(a);
      for (const t of all) {
        let s = stat.get(t);
        if (!s) stat.set(t, (s = { df: 0, title: 0, presses: new Set(), recent: 0, prev: 0, multi: 0, seeds: new Set(), arts: [] }));
        s.df++; if (inTitle.has(t)) s.title++;
        if (a.press) s.presses.add(a.press);
        if (now - a.time < 3 * 36e5) s.recent++; else s.prev++;       // 최근 3시간 vs 그 이전
        const mine = a.keywords.filter((k) => gOf(k) === g);
        if (mine.length >= 2) s.multi++;                                // 이 카테고리 키워드 2개 이상에 잡힌 기사(= '중요' 기사)
        mine.forEach((k) => s.seeds.add(k));
        s.arts.push(a);
      }
    }
    const N = corpus.length;
    const recentShare = N ? corpus.filter((a) => now - a.time < 3 * 36e5).length / N : 0;   // 전체 기사 중 최근 3시간 비중(기준선)
    const jointArticles = corpus.filter((a) => a.keywords.filter((k) => gOf(k) === g).length >= 2).length;
    const strict = seeds.length >= 2 && jointArticles >= 10;                   // 키워드 2개 이상에 함께 잡힌 기사가 충분할 때만 엄격하게 거른다
    const items = [];
    for (const [term, s] of stat) {
      if (s.df < 3 || s.title < 1 || s.presses.size < 3) continue;           // 최소 빈도·제목 등장·언론사 다양성
      if (seeds.length >= 2 && s.seeds.size < 2) continue;                      // 키워드 한 개에서만 나오는 말은 범위 이탈 가능성이 커서 제외
      if (strict && (s.multi < 3 || s.multi / s.df < 0.05)) continue;           // 범위 적합도가 너무 낮은 말(예: 한 키워드의 다른 이슈)은 제외
      if (N && s.df / N > 0.35) continue;                                       // 너무 흔한 말(범위 자체를 가리키는 말)
      const tn = normT(term);
      if (dismissed.has(tn) || pressNorm.has(tn) || [...pressNorm].some((p) => p.length >= 3 && tn === p)) continue;
      if (kwNorm.some((k) => k === tn || (tn.length >= 2 && (k.includes(tn) || tn.includes(k))))) continue;   // 이미 등록했거나 그 일부/확장
      const idf = Math.log((total + 1) / (dfAll.get(term) + 1)) + 1;
      const precision = dfAll.get(term) ? s.df / dfAll.get(term) : 1;          // 이 용어가 들어간 기사 중 이 카테고리 비율
      const trendRatio = recentShare > 0 ? (s.recent / (s.df || 1)) / recentShare : 1;   // 1보다 크면 최근 3시간에 몰림
      const burst = Math.min(1, Math.max(0, trendRatio - 1));
      const multiRate = s.multi / s.df;                                          // 범위 적합도: 중요 기사에서 얼마나 나오는가
      const phrase = term.includes(' ');
      const score = s.df * Math.log(1 + s.presses.size) * idf * (0.5 + precision) * (0.3 + multiRate * 2) * (1 + 0.5 * burst) * (phrase ? 1.25 : 1);
      const together = {};
      for (const a of s.arts) for (const k of a.keywords) if (gOf(k) === g) together[k] = (together[k] || 0) + 1;
      const jd = judgments[g + '|' + term];
      items.push({
        ai: jd && Date.now() - jd.at < 3 * DAY ? { verdict: jd.verdict, reason: jd.reason } : null,
        term, df: s.df, titleDf: s.title, presses: s.presses.size, recent3h: s.recent, trend: Math.round(trendRatio * 10) / 10,
        seedCount: s.seeds.size, multi: s.multi, fit: Math.round(multiRate * 100), precision: Math.round(precision * 100), score: Math.round(score * 10) / 10,
        together: Object.entries(together).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k]) => k),
        samples: s.arts.sort((x, y) => y.time - x.time).slice(0, 2).map((a) => ({ title: a.title, press: a.press })),
      });
    }
    // 명사구와 그 구성 단어가 비슷한 빈도면 더 구체적인 쪽(명사구)만 남긴다
    const byTerm = new Map(items.map((i) => [i.term, i]));
    const drop = new Set();
    for (const i of items) {
      if (!i.term.includes(' ')) continue;
      for (const part of i.term.split(' ')) { const u = byTerm.get(part); if (u && i.df >= u.df * 0.6) drop.add(part); }
    }
    const list = items.filter((i) => !drop.has(i.term)).sort((x, y) => y.score - x.score).slice(0, 15);
    return { group: g, seeds, articles: N, jointArticles, evidence: strict ? 'strong' : 'weak', items: list };
  });

  const data = { generatedAt: now, groups: result, totalArticles: total, scope };
  suggCache = { key: cacheKey, at: Date.now(), data };
  return data;
}

// ---------- HTTP ----------
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const cleanGroup = (g) => { g = String(g || '').trim().slice(0, 30); return g === '미분류' ? '' : g; };
const jsonState = (res) => json(res, 200, { keywords: settings.keywords, groups: settings.groups, groupOf: settings.groupOf });
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try {
    if (u.pathname.startsWith('/api/') && req.method !== 'GET') {
      const host = String(req.headers.host || ''), origin = req.headers.origin;
      const okHost = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
      if (!okHost || req.headers['x-feed'] !== '1' || (origin && origin !== 'http://' + host)) return json(res, 403, { error: '허용되지 않은 요청입니다' });
    }
    if (u.pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(`event: status\ndata: ${JSON.stringify({ collecting: running, sources: sourceStatus })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clients.delete(res); clearInterval(ping); });
      return;
    }
    if (u.pathname === '/api/state' && req.method === 'GET') {
      return json(res, 200, {
        keywords: settings.keywords, groups: settings.groups, groupOf: settings.groupOf, intervalSec: settings.intervalSec, collecting: running, sources: sourceStatus,
        sourceLabels: Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, v.label])),
        articles: articles.slice().sort((a, b) => b.time - a.time).map(publicArt),
      });
    }
    if (u.pathname === '/api/article' && req.method === 'GET') {
      const a = articles.find((x) => x.id === u.searchParams.get('id'));
      if (!a) return json(res, 404, { error: '기사를 찾을 수 없습니다' });
      return json(res, 200, await getReader(a));
    }
    if (u.pathname === '/api/settings' && req.method === 'GET') return json(res, 200, settingsView());
    if (u.pathname === '/api/settings/llm' && req.method === 'POST') {
      const b = await body(req), upd = {};
      if (b.apiKey !== undefined && String(b.apiKey).trim() !== '') {
        const k = String(b.apiKey).trim();
        if (!/^[A-Za-z0-9_-]{20,200}$/.test(k)) return json(res, 400, { error: 'API 키 형식이 올바르지 않습니다 (영문·숫자·-·_ 만, 20자 이상)' });
        upd.GEMINI_API_KEY = k;
      }
      if (b.models !== undefined) {
        const m = String(b.models).split(',').map((x) => x.trim()).filter(Boolean);
        if (!m.length || !m.every((x) => /^[a-z0-9][a-z0-9.\-]*$/.test(x))) return json(res, 400, { error: '모델 이름 형식이 올바르지 않습니다 (예: gemini-3.1-flash-lite, gemini-3.5-flash-lite)' });
        upd.GEMINI_MODELS = m.join(',');
      }
      if (b.cap !== undefined) {
        const n = Number(b.cap);
        if (!Number.isInteger(n) || n < 10 || n > 1000) return json(res, 400, { error: '하루 호출 상한은 10~1000 사이 정수여야 합니다' });
        upd.LLM_DAILY_CAP = String(n);
      }
      writeEnv(upd);
      return json(res, 200, settingsView());
    }
    if (u.pathname === '/api/settings/llm-key' && req.method === 'DELETE') {
      if (keySource() === 'system') return json(res, 400, { error: '시스템 환경 변수로 설정된 키라 여기서 삭제할 수 없습니다' });
      writeEnv({ GEMINI_API_KEY: null });
      return json(res, 200, settingsView());
    }
    if (u.pathname === '/api/settings/llm/test' && req.method === 'POST') {
      const b = await body(req);
      const key = b.apiKey && String(b.apiKey).trim() ? String(b.apiKey).trim() : llmCfg().key;
      if (!key) return json(res, 200, { ok: false, message: '등록된 키가 없습니다' });
      if (!/^[A-Za-z0-9_-]{20,200}$/.test(key)) return json(res, 200, { ok: false, message: 'API 키 형식이 올바르지 않습니다' });
      return json(res, 200, await testGeminiKey(key));
    }
    if (u.pathname === '/api/briefing' && req.method === 'GET') return json(res, 200, briefs);
    if (u.pathname === '/api/briefing' && req.method === 'POST') {                  // 사용자가 버튼을 눌렀을 때만 외부(Gemini)로 전송
      const b = await body(req);
      const group = String(b.group || '');
      if (group && !settings.groups.includes(group)) return json(res, 404, { error: '없는 카테고리입니다' });
      const scope = b.scope === 'all' ? 'all' : 'today';
      try { return json(res, 200, { group, scope, key: briefKey(group, scope), brief: await makeBrief(group, !!b.force, scope), llm: llmStatus() }); }
      catch (e) { return json(res, 502, { error: String(e.message || e), llm: llmStatus() }); }
    }
    if (u.pathname === '/api/llm/status' && req.method === 'GET') return json(res, 200, llmStatus());
    if (u.pathname === '/api/suggestions/judge' && req.method === 'POST') {       // 사용자가 버튼을 눌렀을 때만 외부(Gemini)로 전송
      const jb = await body(req), scope = jb.scope === 'all' ? 'all' : 'today';
      const groups = buildSuggestions(scope).groups.map((x) => x.group);
      const results = [], errors = [];
      for (const g of groups) {
        try { results.push({ group: g, ...(await judgeCandidates(g, scope)) }); } catch (e) { errors.push(String(e.message || e)); break; }
      }
      return json(res, 200, { ...buildSuggestions(scope), judge: { results, errors }, llm: llmStatus() });
    }
    if (u.pathname === '/api/suggestions' && req.method === 'GET') return json(res, 200, buildSuggestions(u.searchParams.get('scope')));
    if (u.pathname === '/api/suggestions/dismiss' && req.method === 'POST') {
      const db = await body(req);
      const term = String(db.term || '').trim();
      if (term) { settings.dismissed = [...new Set([...(settings.dismissed || []), term])].slice(-500); saveSettings(); }
      return json(res, 200, buildSuggestions(db.scope));
    }
    if (u.pathname === '/api/suggestions/reset' && req.method === 'POST') { const rb = await body(req); settings.dismissed = []; saveSettings(); return json(res, 200, buildSuggestions(rb.scope)); }
    if (u.pathname === '/api/keywords' && req.method === 'POST') {
      const b = await body(req);
      // "a, b, c" 처럼 쉼표로 여러 개를 한 번에 등록할 수 있다
      const kws = String(b.keyword || '').split(',').map((k) => k.trim().slice(0, 50)).filter(Boolean);
      if (!kws.length) return json(res, 400, { error: '키워드를 입력하세요' });
      const group = cleanGroup(b.group);
      const added = [];
      for (const kw of kws) {
        if (!settings.keywords.includes(kw)) { settings.keywords.push(kw); added.push(kw); }
        if (group) settings.groupOf[kw] = group;       // 이미 있는 키워드는 그룹만 이동
      }
      if (group && !settings.groups.includes(group)) settings.groups.push(group);
      saveSettings();
      if (added.length) collect(added);
      return jsonState(res);
    }
    if (u.pathname === '/api/keywords/group' && req.method === 'POST') {   // 키워드를 다른 그룹으로 이동 (빈 값 = 미분류)
      const b = await body(req);
      if (!settings.keywords.includes(b.keyword)) return json(res, 404, { error: '없는 키워드입니다' });
      const group = cleanGroup(b.group);
      if (group) { settings.groupOf[b.keyword] = group; if (!settings.groups.includes(group)) settings.groups.push(group); }
      else delete settings.groupOf[b.keyword];
      saveSettings();
      return jsonState(res);
    }
    if (u.pathname === '/api/groups' && req.method === 'POST') {           // 그룹 만들기 / 이름 바꾸기
      const b = await body(req);
      const to = cleanGroup(b.name);
      if (!to) return json(res, 400, { error: '그룹 이름을 입력하세요' });
      if (b.from) {
        const i = settings.groups.indexOf(b.from);
        if (i < 0) return json(res, 404, { error: '없는 그룹입니다' });
        if (to !== b.from && settings.groups.includes(to)) return json(res, 400, { error: '이미 있는 그룹 이름입니다' });
        settings.groups[i] = to;
        for (const k of Object.keys(settings.groupOf)) if (settings.groupOf[k] === b.from) settings.groupOf[k] = to;
      } else if (!settings.groups.includes(to)) settings.groups.push(to);
      saveSettings();
      return jsonState(res);
    }
    if (u.pathname === '/api/groups' && req.method === 'DELETE') {         // 그룹 삭제: 소속 키워드는 미분류로
      const name = u.searchParams.get('name');
      settings.groups = settings.groups.filter((g) => g !== name);
      if (briefs[name] || briefs[name + '#all']) { delete briefs[name]; delete briefs[name + '#all']; saveBriefs(); }
      for (const k of Object.keys(settings.groupOf)) if (settings.groupOf[k] === name) delete settings.groupOf[k];
      saveSettings();
      return jsonState(res);
    }
    if (u.pathname === '/api/keywords' && req.method === 'DELETE') {
      const kw = u.searchParams.get('keyword');
      settings.keywords = settings.keywords.filter((k) => k !== kw);
      delete settings.groupOf[kw];
      saveSettings();
      articles.forEach((a) => (a.keywords = a.keywords.filter((k) => k !== kw)));
      articles = articles.filter((a) => a.keywords.length);
      saveArticles();
      broadcast('keywords', { keywords: settings.keywords });
      return jsonState(res);
    }
    if (u.pathname === '/api/interval' && req.method === 'POST') {
      const s = Number((await body(req)).intervalSec);
      if (s >= 20 && s <= 3600) { settings.intervalSec = s; saveSettings(); schedule(); }
      return json(res, 200, { intervalSec: settings.intervalSec });
    }
    if (u.pathname === '/api/refresh' && req.method === 'POST') { collect(); return json(res, 200, { ok: true }); }
    if (u.pathname === '/api/clear' && req.method === 'POST') { articles = []; saveArticles(); broadcast('keywords', {}); return json(res, 200, { ok: true }); }

    if (u.pathname === '/' || u.pathname === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) { json(res, 500, { error: String(e.message || e) }); }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Feed 실행 중 → http://localhost:${PORT}`);
  schedule();
  if (settings.keywords.length) collect();
});
