// Code Hunter API: zero dependencies, needs Node 18+. Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 3000;
const TTL = 30 * 60 * 1000;
const UA = 'Mozilla/5.0 (compatible; CodeHunter/1.0)';
const cache = new Map(), hits = new Map();

const strip = s => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const validCode = c => /^[A-Za-z0-9_-]{3,25}$/.test(c);

// Parser 1: codes stored in data attributes (common on coupon sites)
const JUNK = new Set(['TRUE','FALSE','NULL','NONE','UNDEFINED','COPY','CODE','COUPON','SHOW','REVEAL','CLICK','DEAL','OFFER','YES','NO']);
const plausible = c => validCode(c) && /^[A-Z0-9_-]+$/.test(c) && !JUNK.has(c) && c.length >= 4;
const cleanDesc = t => strip(t).replace(/<[^>]*$/, '').replace(/[<>]/g, '').trim();
function parseAttrs(html) {
  const out = [], re = /<[^>]+\b(?:data-(?:promo-|coupon-)?code|data-clipboard-text)=["']([^"']{3,25})["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (!plausible(m[1])) continue;
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 400);
    let desc = cleanDesc(after).slice(0, 120);
    if (/class=|=\"|style=/.test(desc)) desc = '';
    out.push({ code: m[1], description: desc });
  }
  return out;
}
// Parser 2: schema.org JSON-LD offers with a couponCode
function parseLd(html) {
  const out = [], re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  const walk = n => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.couponCode && plausible(String(n.couponCode)))
      out.push({ code: String(n.couponCode), description: strip(String(n.description || n.name || '')).slice(0, 140) });
    Object.values(n).forEach(walk);
  };
  let m;
  while ((m = re.exec(html))) { try { walk(JSON.parse(m[1])); } catch {} }
  return out;
}

// Add or fix providers here. The URL host is fixed, so users can't point the server elsewhere.
const PROVIDERS = [
  { name: 'CouponFollow', url: d => `https://couponfollow.com/site/${d}`, parse: h => [...parseLd(h), ...parseAttrs(h)] },
  { name: 'RetailMeNot', url: d => `https://www.retailmenot.com/view/${d}`, parse: h => [...parseLd(h), ...parseAttrs(h)] },
];

async function fromProvider(p, domain) {
  const url = p.url(domain);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' }, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { name: p.name, url, status: `HTTP ${r.status}`, codes: [] };
    const codes = p.parse(await r.text()).map(c => ({ ...c, source: p.name, url }));
    return { name: p.name, url, status: codes.length ? 'ok' : 'no codes parsed', codes };
  } catch (e) {
    return { name: p.name, url, status: 'error: ' + (e.name === 'TimeoutError' ? 'timeout' : e.message), codes: [] };
  }
}

async function lookup(domain) {
  const hit = cache.get(domain);
  if (hit && Date.now() - hit.t < TTL) return hit.v;
  const results = await Promise.all(PROVIDERS.map(p => fromProvider(p, domain)));
  const seen = new Set(), codes = [];
  for (const c of results.flatMap(r => r.codes)) if (!seen.has(c.code)) { seen.add(c.code); codes.push(c); }
  const v = { site: domain, codes, sources: results.map(({ name, url, status }) => ({ name, url, status })), fetchedAt: new Date().toISOString() };
  cache.set(domain, { t: Date.now(), v });
  return v;
}

const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/codes') {
    const ip = req.socket.remoteAddress, now = Date.now();
    const arr = (hits.get(ip) || []).filter(t => now - t < 60000);
    if (arr.length >= 20) return send(res, 429, { error: 'Too many requests, slow down.' });
    hits.set(ip, [...arr, now]);
    const domain = (u.searchParams.get('site') || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[\/?#]/)[0];
    if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(domain)) return send(res, 400, { error: 'Enter a valid domain like nike.com' });
    return send(res, 200, await lookup(domain));
  }
  const page = [path.join(__dirname, 'index.html'), path.join(__dirname, 'public', 'index.html')].find(p => fs.existsSync(p));
  if (!page) return send(res, 404, 'Not found', 'text/plain');
  fs.readFile(page, (e, d) => e ? send(res, 500, 'Error', 'text/plain') : send(res, 200, d, 'text/html; charset=utf-8'));
}).listen(PORT, () => console.log(`Code Hunter running at http://localhost:${PORT}`));
