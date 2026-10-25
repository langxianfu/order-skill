'use strict';

// 自我游比价下单 HTTP 封装: 手机端 WorkBuddy 通过连接器调用, 账号密码只留在服务器
// 启动: ZWY_API_TOKEN=<至少16位> node http/server.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = process.env.ZWY_ROOT || path.resolve(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const ZWY = path.join(SCRIPTS, 'zwy.js');
const STATE = path.join(SCRIPTS, '.state');
const ACCOUNTS = path.join(SCRIPTS, 'accounts.json');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN = process.env.ZWY_API_TOKEN || '';
const ALLOWED_IPS = (process.env.ZWY_ALLOWED_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
const ENABLE_ORDER = String(process.env.ZWY_ENABLE_ORDER || '0') === '1';
// 自然语言解析: 复用现有拼车用的 Moonshot(kimi) 通道, 但独立配置, 不影响后端 /wolfsnow/ai/carpoolCar
const NLP_KEY = String(process.env.ZWY_NLP_API_KEY || '');
const NLP_URL = String(process.env.ZWY_NLP_URL || 'https://api.moonshot.cn/v1/chat/completions');
const NLP_MODEL = String(process.env.ZWY_NLP_MODEL || 'kimi-k3');
const NLP_TIMEOUT = Number(process.env.ZWY_NLP_TIMEOUT_MS || 25000);
// 选品要带着 50 个候选标题推理, 比单次抽取慢, 单独给更长预算
const PICK_TIMEOUT = Number(process.env.ZWY_PICK_TIMEOUT_MS || 60000);
const NLP_MAX_TEXT = 800;
const CACHE_TTL = Number(process.env.ZWY_CACHE_TTL_MS || 300000);
const CHILD_TIMEOUT = Number(process.env.ZWY_CHILD_TIMEOUT_MS || 240000);
const MAX_BODY = 64 * 1024;
const MAX_COUNT = 20;
const APP_HTML = (() => {
  try { return fs.readFileSync(path.join(__dirname, 'app.html')); } catch (_) { return null; }
})();

if (TOKEN.length < 16) {
  console.error('拒绝启动: 必须设置 ZWY_API_TOKEN 且长度不小于 16 位');
  process.exit(1);
}

const TOKEN_HASH = crypto.createHash('sha256').update(TOKEN).digest();

function tokenOk(given) {
  const h = crypto.createHash('sha256').update(String(given || '')).digest();
  return crypto.timingSafeEqual(h, TOKEN_HASH);
}

function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[0] : (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

const hitLog = new Map();
function rateOk(ip, limitPerMin = 30) {
  const now = Date.now();
  const arr = (hitLog.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hitLog.set(ip, arr);
  return arr.length <= limitPerMin;
}

// 上游扫描成本高(3 个账号 × 每个货品一次 reserve), 串行执行避免触发风控
let chain = Promise.resolve();
function serialize(fn) {
  const p = chain.then(fn, fn);
  chain = p.then(() => {}, () => {});
  return p;
}

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body 过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new Error('body 不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function runZwy(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [ZWY, ...args], { cwd: SCRIPTS, timeout: CHILD_TIMEOUT, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, timedOut: !!(err && err.killed), stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// 优先解析整段 JSON; 否则从最后一行往前找(执行阶段会先输出过程日志)
function pickJson(out) {
  const text = String(out || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) {}
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim();
    if (!s.startsWith('{')) continue;
    try { return JSON.parse(s); } catch (_) {}
  }
  return null;
}

const cache = new Map();
function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() - v.at > CACHE_TTL) { cache.delete(key); return null; }
  return { ...v.data, cached: true, cachedAt: new Date(v.at).toISOString() };
}
function cacheSet(key, data) {
  if (cache.size > 200) cache.clear();
  cache.set(key, { at: Date.now(), data });
}

function fail(res, code, msg) {
  send(res, code, { ok: false, error: msg });
}

function requireAuth(req, res) {
  const ip = clientIp(req);
  if (ALLOWED_IPS.length && !ALLOWED_IPS.includes(ip)) { fail(res, 403, `IP 不在白名单: ${ip}`); return false; }
  const h = req.headers['authorization'] || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : String(req.headers['x-api-token'] || '');
  if (!tokenOk(token)) { fail(res, 401, '缺少或错误的 API token'); return false; }
  if (!rateOk(ip)) { fail(res, 429, '请求过于频繁, 每分钟最多 30 次'); return false; }
  return true;
}

function aliases() {
  try {
    const all = JSON.parse(fs.readFileSync(ACCOUNTS, 'utf8'));
    return Object.keys(all).filter((k) => !k.startsWith('$'));
  } catch (_) {
    return [];
  }
}

function checkDate(d) {
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

function checkTree(t) {
  const v = t === undefined || t === null ? '0' : String(t);
  return ['0', '1', 'any'].includes(v) ? v : null;
}

async function handleBest(url, res) {
  const date = checkDate(url.searchParams.get('date'));
  if (!date) return fail(res, 400, 'date 必填且格式为 YYYY-MM-DD');
  const tree = checkTree(url.searchParams.get('tree'));
  if (!tree) return fail(res, 400, 'tree 只能是 0(门票) / 1(住滑) / any');
  const keyword = String(url.searchParams.get('keyword') || '').slice(0, 40);
  const pkey = String(url.searchParams.get('pkey') || '').slice(0, 40);

  const key = `best|${date}|${tree}|${keyword}|${pkey}`;
  const hit = cacheGet(key);
  if (hit) return send(res, 200, hit);

  const args = ['best', `--date=${date}`, `--tree=${tree}`, '--json'];
  if (keyword) args.push(`--keyword=${keyword}`);
  if (pkey) args.push(`--pkey=${pkey}`);

  const r = await serialize(() => runZwy(args));
  const data = pickJson(r.stdout);
  if (!data) return fail(res, 502, (r.stderr || r.stdout || '比价失败').trim().slice(0, 800));
  cacheSet(key, data);
  send(res, 200, data);
}

// ---------- 自然语言解析(新增, 独立于后端拼车接口, 只输出参数, 不触达下单) ----------
const NLP_SYSTEM = [
  '你是滑雪票务系统的需求抽取器。把用户的一段中文(常见于微信群里的订单模板或口语)抽成 JSON, 只输出 JSON, 不要解释、不要 markdown。',
  '字段固定为: date, checkin, checkout, nights, resort, hotel, room, pkgType, people, tree, session, count, name, phone, unmatched。',
  '模板原文常见形如「酒店名称:xxx / 入住日期:xxx / 离店日期:xxx / 套餐类型:2住2滑 / 房型:xxx / 姓名:xxx / 电话:xxx / 原价:xxx / 数量:1」, 请逐项对应到字段, 不要因为字段名有冒号就当成无法识别。',
  'date/checkin: 入住(或出行)日期, 统一 YYYY-MM-DD; 没写年份时按最近雪季推算(今天及以后算今年, 已过去的算明年); 抽不到填 "".',
  'checkout: 离店日期 YYYY-MM-DD, 未提到填 "". nights: 住宿晚数整数, 由离店-入住或套餐(如2住2滑)推算, 未提到填 "".',
  'resort: 雪场简称, 只能从 万龙/云顶/富龙/翠云山/雪如意/金山岭/太舞/密苑/银河/多乐美地/长城岭/崇礼/北大湖/松花湖/亚布力 里选; 同义写法取含雪场名的最短通用写法; 抽不到填 "".',
  'hotel: 酒店名(如 云顶大酒店), 只填酒店/公寓名称本身, 不含房型; 房型词(大床/双床/标间/园景/套房)不要写进 hotel。未提到填 "".',
  'room: 房型/床型关键词, 多个用空格分隔(如 "园景 大床"), 只保留用于匹配的词; 未提到填 "".',
  'pkgType: 住滑套餐形态, 归一为 N住N滑(如 2住2滑 / 1住1滑 / 3住3滑); 只说住不说滑填 "" (单房)。',
  'people: 套餐/订单覆盖的人数整数, 未提到填 "".',
  'tree: 0=门票/雪票(不含住宿), 1=住滑/酒店/含住宿套餐(提到酒店/入住/离店/住滑/套房一律填 1)。',
  'session: "日场" 或 "夜场", 全天/白天/上午都算日场; 没提到填 "".',
  'count: 购买份数/张数, 模板里的「数量」优先; 没说填 1; 中文数字转阿拉伯数字, 最多 20。',
  'name: 游客姓名, 没有填 "". phone: 11 位大陆手机号, 没有填 "".',
  'unmatched: 只有原文出现你确实无法归类的关键信息(如房型自相矛盾)时才填 true 并可用 remark 说明, 否则 false。'
].join('\n');

function extractJson(text) {
  const s = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const i = s.indexOf('{');
  const j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try { return JSON.parse(s.slice(i, j + 1)); } catch (_) { return null; }
}

function sanitizeParsed(o) {
  if (!o || typeof o !== 'object') return null;
  const dateOk = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '';
  const date = dateOk(o.date) || dateOk(o.checkin);
  const checkout = dateOk(o.checkout);
  const pkgMatch = String(o.pkgType || '').match(/(\d)\s*住\s*(\d)\s*滑/);
  const pkgType = pkgMatch ? `${pkgMatch[1]}住${pkgMatch[2]}滑` : '';
  let nights = parseInt(String(o.nights), 10);
  if (!(nights > 0) && date && checkout) {
    nights = Math.round((Date.parse(checkout) - Date.parse(date)) / 86400000);
  }
  if (!(nights > 0)) {
    const stay = String(o.pkgType || '').match(/(\d)\s*住/);
    nights = stay ? Number(stay[1]) : 0;
  }
  if (!(nights > 0) || nights > 30) nights = '';
  const resort = String(o.resort || '').replace(/[^\u4e00-\u9fa5]/g, '').slice(0, 12);
  const hotel = String(o.hotel || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').slice(0, 20);
  const room = String(o.room || '').replace(/[^\u4e00-\u9fa5]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 4).join(' ').slice(0, 20);
  const people = Math.min(20, Math.max(0, parseInt(String(o.people), 10) || 0));
  const tree = Number(o.tree) === 1 ? 1 : 0;
  const session = o.session === '夜场' ? '夜场' : (o.session === '日场' ? '日场' : '');
  const count = Math.min(MAX_COUNT, Math.max(1, parseInt(String(o.count), 10) || 1));
  const name = String(o.name || '').replace(/[^\u4e00-\u9fa5·]/g, '').slice(0, 20);
  const phone = String(o.phone || '').replace(/[^\d]/g, '').slice(0, 11);
  return {
    date, checkin: date, checkout, nights, resort, hotel, room, pkgType,
    people: people || '', tree, session, count, name,
    phone: /^1[3-9]\d{9}$/.test(phone) ? phone : ''
  };
}

async function handleParse(req, res) {
  const b = await readBody(req);
  const text = String(b.text || '').trim().slice(0, NLP_MAX_TEXT);
  if (!text) return fail(res, 400, 'text 必填');
  if (!NLP_KEY) return fail(res, 503, '自然语言解析未启用: 需在 .env 配置 ZWY_NLP_API_KEY 并重启');

  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), NLP_TIMEOUT);
  try {
    const r = await fetch(NLP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${NLP_KEY}` },
      body: JSON.stringify({
        model: NLP_MODEL,
        messages: [
          { role: 'system', content: `${NLP_SYSTEM}\n今天是 ${today}(北京时间)。` },
          { role: 'user', content: text }
        ]
      }),
      signal: ac.signal
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) return fail(res, 502, `模型返回 ${r.status}: ${((j && j.error && j.error.message) || '').slice(0, 200)}`.trim());
    const content = ((((j || {}).choices || [])[0] || {}).message || {}).content || '';
    const parsed = sanitizeParsed(extractJson(content));
    if (!parsed) return fail(res, 502, `模型输出无法解析: ${String(content).slice(0, 200)}`);
    return send(res, 200, { ok: true, stage: 'parse', parsed, model: NLP_MODEL });
  } catch (e) {
    return fail(res, 504, e && e.name === 'AbortError' ? '模型解析超时' : String(e.message || e));
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 候选重排(第二步): 让模型在「当天真实可售产品标题」里做选择题, 而不是凭记忆猜商品名 ----------
const PICK_SYSTEM = [
  '你是滑雪票务选品器。用户需求与当天上游真实可售产品候选(JSON 数组, 每项含序号 i、标题 title、结算价 price、账号 alias)已给出。',
  '从 candidates 中选出一项最符合需求的, 只输出 JSON, 不要解释、不要 markdown:',
  '{"pick": <候选序号>, "confidence": 0~1, "reason": "20 字以内理由", "alts": [<备选序号>, ...最多2个], "unmatched": false}',
  '规则:',
  '1) 必须在 candidates 里选, 序号必须真实存在; 严禁编造产品或不存在的序号。',
  '2) 住滑需求(有 hotel/room/pkgType)必须同时匹配: 酒店/公寓名 + 房型(大床/双床/标间/园景等) + 套餐形态(N住N滑) + 住宿晚数; 只满足价格低的「单房/不含雪票」不算符合。',
  '3) 价格只用于在同分候选中打破平局, 不得因为便宜而选不符合的产品。',
  '4) 需求里的字段互相矛盾(例如房型写"大床"又写"标间")时, 选覆盖度更好的那项并把 confidence 降到 0.6 以下, reason 写明矛盾点。',
  '5) 当天候选里确实没有符合项时输出 {"pick": null, "confidence": 0, "reason": "缺少什么", "alts": [], "unmatched": true}, 不要硬凑。',
  '6) 门票需求(无 hotel/room)按日期+雪场+日场/夜场+天数匹配, 不要选住滑套餐。'
].join('\n');

// 关键词打分召回: 把上百个候选压到 50 个再交给模型, 降低 token 与误选
function recallCandidates(intent, groups) {
  const list = [];
  for (const g of groups) {
    const low = g.lowest || {};
    if (!low.infoId) continue;
    if (/清账专用/.test(g.title || '')) continue;
    list.push({ title: String(g.title || ''), infoId: String(low.infoId), price: low.price, salePrice: low.salePrice, alias: low.alias });
  }
  const tokens = [intent.hotel, intent.room, intent.pkgType, intent.session, intent.resort]
    .filter(Boolean).join(' ').split(/\s+/).filter((t) => t.length >= 2);
  const scored = list.map((c) => {
    let score = 0;
    const t = c.title;
    if (intent.hotel && t.includes(intent.hotel)) score += 8;
    for (const tok of tokens) if (t.includes(tok)) score += 4;
    if (intent.pkgType && t.includes(intent.pkgType)) score += 8;
    if (intent.pkgType && /\[单房\]|单房&/.test(t)) score -= 10;   // 要住滑时不选纯房源
    if (!intent.pkgType && intent.tree === 1 && /住.*滑/.test(t)) score -= 6;
    if (intent.session && t.includes(intent.session)) score += 4;
    return { ...c, score };
  });
  scored.sort((a, b) => (b.score - a.score) || (Number(a.price) - Number(b.price)));
  return scored.slice(0, 50);
}

async function handlePick(req, res) {
  const b = await readBody(req);
  const date = checkDate(b.date);
  if (!date) return fail(res, 400, 'date 必填且格式为 YYYY-MM-DD');
  const tree = checkTree(b.tree);
  if (!tree) return fail(res, 400, 'tree 只能是 0 / 1 / any');
  const intent = sanitizeParsed(b.intent || {});
  if (!intent) return fail(res, 400, 'intent 必填');
  if (!NLP_KEY) return fail(res, 503, '选品模型未启用: 需在 .env 配置 ZWY_NLP_API_KEY 并重启');

  const cacheKey = `pick|${date}|${tree}|${intent.resort}|${intent.hotel}|${intent.room}|${intent.pkgType}|${intent.session}|${intent.nights}`;
  const hitCache = cacheGet(cacheKey);
  if (hitCache) return send(res, 200, hitCache);

  const kw = intent.resort || '';
  const bestKey = `best|${date}|${tree}|${kw}|`;
  let best = cacheGet(bestKey);
  if (!best) {
    const args = ['best', `--date=${date}`, `--tree=${tree}`, '--json'];
    if (kw) args.push(`--keyword=${kw}`);
    const r = await serialize(() => runZwy(args));
    best = pickJson(r.stdout);
    if (!best) return fail(res, 502, (r.stderr || r.stdout || '比价失败').trim().slice(0, 800));
    cacheSet(bestKey, best);
  }

  const cands = recallCandidates(intent, best.groups || []);
  if (!cands.length) {
    const empty = { ok: true, stage: 'pick', unmatched: true, reason: '当天该雪场没有可售产品', candidates: 0, model: NLP_MODEL };
    cacheSet(cacheKey, empty);
    return send(res, 200, empty);
  }

  const payload = { date, tree, intent, candidates: cands.map((c, i) => ({ i, title: c.title, price: c.price, alias: c.alias })) };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PICK_TIMEOUT);
  try {
    const r = await fetch(NLP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${NLP_KEY}` },
      body: JSON.stringify({
        model: NLP_MODEL,
        messages: [
          { role: 'system', content: PICK_SYSTEM },
          { role: 'user', content: JSON.stringify(payload) }
        ]
      }),
      signal: ac.signal
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) return fail(res, 502, `选品模型返回 ${r.status}: ${((j && j.error && j.error.message) || '').slice(0, 200)}`.trim());
    const content = ((((j || {}).choices || [])[0] || {}).message || {}).content || '';
    const out = extractJson(content);
    if (!out) return fail(res, 502, `选品输出无法解析: ${String(content).slice(0, 200)}`);

    const pickAt = (v) => (Number.isInteger(Number(v)) && cands[Number(v)] ? cands[Number(v)] : null);
    const chosen = out.unmatched ? null : pickAt(out.pick);
    if (!out.unmatched && !chosen) return fail(res, 502, `选品返回了不存在的候选序号: ${String(out.pick)}`);
    const alts = (Array.isArray(out.alts) ? out.alts : []).map((v) => cands[Number(v)]).filter(Boolean).slice(0, 2);

    const data = {
      ok: true,
      stage: 'pick',
      unmatched: !chosen,
      reason: String(out.reason || '').slice(0, 120),
      confidence: chosen ? Math.max(0, Math.min(1, Number(out.confidence) || 0)) : 0,
      pick: chosen ? { infoId: chosen.infoId, title: chosen.title, price: chosen.price, salePrice: chosen.salePrice, alias: chosen.alias } : null,
      alternatives: alts.map((c) => ({ infoId: c.infoId, title: c.title, price: c.price, alias: c.alias })),
      candidates: cands.length,
      model: NLP_MODEL
    };
    cacheSet(cacheKey, data);
    return send(res, 200, data);
  } catch (e) {
    return fail(res, 504, e && e.name === 'AbortError' ? '选品模型超时' : String(e.message || e));
  } finally {
    clearTimeout(timer);
  }
}

async function handlePlan(req, res) {
  const b = await readBody(req);
  const date = checkDate(b.date);
  if (!date) return fail(res, 400, 'date 必填且格式为 YYYY-MM-DD');
  const tree = checkTree(b.tree);
  if (!tree) return fail(res, 400, 'tree 只能是 0 / 1 / any');
  const count = Number(b.count || 1);
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) return fail(res, 400, `count 必须是 1-${MAX_COUNT} 的整数`);

  const args = ['orderbest', `--date=${date}`, `--tree=${tree}`, `--count=${count}`, '--json'];
  if (b.infoId) args.push(`--infoId=${String(b.infoId).replace(/[^\d]/g, '')}`);
  if (b.pick) args.push(`--pick=${String(b.pick).replace(/[^\d]/g, '')}`);
  if (b.keyword) args.push(`--keyword=${String(b.keyword).slice(0, 40)}`);
  if (b.pkey) args.push(`--pkey=${String(b.pkey).slice(0, 20)}`);
  if (b.maxPrice) args.push(`--maxPrice=${Number(b.maxPrice)}`);

  const r = await serialize(() => runZwy(args));
  const data = pickJson(r.stdout);
  if (!data) return fail(res, 502, (r.stderr || r.stdout || '生成报价单失败').trim().slice(0, 800));
  send(res, 200, data);
}

async function handleExecute(req, res) {
  if (!ENABLE_ORDER) return fail(res, 403, '下单接口未开启: 需在 .env 设置 ZWY_ENABLE_ORDER=1 并重启服务');
  const b = await readBody(req);
  if (b.confirm !== 'CONFIRM') return fail(res, 400, '必须传 confirm="CONFIRM" 表示已人工确认扣款');
  const date = checkDate(b.date);
  if (!date) return fail(res, 400, 'date 必填且格式为 YYYY-MM-DD');
  const count = Number(b.count || 1);
  if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) return fail(res, 400, `count 必须是 1-${MAX_COUNT} 的整数`);
  const maxMoney = Number(b.maxMoney || 0);
  if (!(maxMoney > 0)) return fail(res, 400, 'maxMoney 必填, 需大于 0');
  const plan = path.basename(String(b.plan || ''));
  if (!/^plan-\d{4}-\d{2}-\d{2}-\d+\.json$/.test(plan)) return fail(res, 400, 'plan 必须是本服务生成的报价单文件名');
  if (!fs.existsSync(path.join(STATE, plan))) return fail(res, 404, `报价单不存在或已清理: ${plan}`);

  const args = ['orderbest', '--execute', `--plan=${plan}`, `--date=${date}`, `--count=${count}`, `--max-money=${maxMoney}`, '--json'];
  if (b.phone) args.push(`--phone=${String(b.phone).replace(/[^\d]/g, '').slice(0, 11)}`);
  if (b.name) args.push(`--name=${String(b.name).slice(0, 20)}`);

  const r = await serialize(() => runZwy(args));
  const data = pickJson(r.stdout);
  if (!data) return fail(res, 502, (r.stderr || r.stdout || '执行失败').trim().slice(0, 800));
  data.plan = plan;
  send(res, 200, data);
}

// 订单查询: 按姓名/手机号/订单号/票码 + 日期, 可跨账号(上流不支持日期参数, 本地过滤)
async function handleOrderSearch(url, res) {
  const key = String(url.searchParams.get('key') || '').trim().slice(0, 30);
  const rawDate = String(url.searchParams.get('date') || '').trim();
  const account = String(url.searchParams.get('account') || '').trim();
  if (!key && !rawDate) return fail(res, 400, 'key 或 date 至少填一个');
  const date = rawDate ? checkDate(rawDate) : '';
  if (rawDate && !date) return fail(res, 400, 'date 格式为 YYYY-MM-DD');
  if (account && !aliases().includes(account)) return fail(res, 400, `account 必须是: ${aliases().join(' / ')}`);

  const args = ['orders', '--json'];
  if (key) args.push(`--key=${key}`);
  if (date) args.push(`--date=${date}`);
  if (account) args.push(`--account=${account}`);

  const r = await serialize(() => runZwy(args));
  const data = pickJson(r.stdout);
  if (!data) return fail(res, 502, (r.stderr || r.stdout || '查询失败').trim().slice(0, 800));
  send(res, 200, data);
}

async function handleDetail(url, res) {
  const orderId = String(url.searchParams.get('orderId') || '').replace(/[^\d]/g, '');
  const account = String(url.searchParams.get('account') || '');
  if (!orderId) return fail(res, 400, 'orderId 必填');
  if (!aliases().includes(account)) return fail(res, 400, `account 必须是: ${aliases().join(' / ')}`);
  const r = await serialize(() => runZwy(['detail', `--account=${account}`, `--orderId=${orderId}`, '--json']));
  const data = pickJson(r.stdout);
  if (!data) return fail(res, 502, (r.stderr || r.stdout || '查询失败').trim().slice(0, 800));
  send(res, 200, data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';

  if (p === '/health') return send(res, 200, { ok: true, service: 'zwy-http', accounts: aliases().length, uptimeSec: Math.round(process.uptime()) });
  // 手机网页版: 页面本身不含任何凭据, 用户打开后自行填 token
  if (req.method === 'GET' && (p === '/app' || p === '/')) {
    if (!APP_HTML) return fail(res, 404, 'app.html 未随镜像打包');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    return res.end(APP_HTML);
  }
  if (!requireAuth(req, res)) return;

  try {
    if (req.method === 'GET' && p === '/accounts') return send(res, 200, { ok: true, accounts: aliases() });
    if (req.method === 'GET' && p === '/best') return await handleBest(url, res);
    if (req.method === 'POST' && p === '/parse') return await handleParse(req, res);
    if (req.method === 'POST' && p === '/pick') return await handlePick(req, res);
    if (req.method === 'POST' && p === '/order/plan') return await handlePlan(req, res);
    if (req.method === 'POST' && p === '/order/execute') return await handleExecute(req, res);
    if (req.method === 'GET' && p === '/order/detail') return await handleDetail(url, res);
    if (req.method === 'GET' && p === '/order/search') return await handleOrderSearch(url, res);
    return fail(res, 404, `未知接口 ${req.method} ${p}`);
  } catch (e) {
    return fail(res, 500, e.message);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`zwy-http 已启动: http://${HOST}:${PORT}  账号=${aliases().join(',') || '(未找到 accounts.json)'}  缓存=${Math.round(CACHE_TTL / 1000)}s`);
});
