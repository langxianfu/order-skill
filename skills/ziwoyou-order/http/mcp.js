'use strict';

// 自我游 MCP 端点: 把已有 REST 接口包装成 MCP 工具, 供 WorkBuddy 桌面端/手机端连接器接入
// 支持 SSE 传输(GET /sse + POST /messages) 与 Streamable HTTP(POST /mcp)
// 启动: ZWY_API_TOKEN=<与 zwy-http 相同> ZWY_BASE=http://zwy-http:8080 node http/mcp.js

const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.ZWY_MCP_PORT || 8081);
const HOST = process.env.ZWY_MCP_HOST || '0.0.0.0';
const TOKEN = process.env.ZWY_API_TOKEN || '';
const BASE = String(process.env.ZWY_BASE || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const CALL_TIMEOUT = Number(process.env.ZWY_CHILD_TIMEOUT_MS || 240000) + 20000;
// 反向代理带路径前缀时(如 /zwy-mcp/), SSE 下发的 endpoint 需带同一前缀
const PATH_PREFIX = String(process.env.ZWY_MCP_PATH_PREFIX || '').replace(/\/+$/, '');
const SERVER_INFO = { name: 'ziwoyou-order', version: '1.1.0' };

if (TOKEN.length < 16) {
  console.error('拒绝启动: 必须设置 ZWY_API_TOKEN 且长度不小于 16 位');
  process.exit(1);
}
const TOKEN_HASH = crypto.createHash('sha256').update(TOKEN).digest();
function tokenOk(given) {
  return crypto.timingSafeEqual(crypto.createHash('sha256').update(String(given || '')).digest(), TOKEN_HASH);
}

const TOOLS = [
  {
    name: 'zwy_best_price',
    description: '查询指定日期自我游各账号的雪票/住滑价格并跨账号比价, 返回按同款分组的最低价与全部账号报价。用户问"某雪场某天多少钱""哪家便宜"时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '出行日期, 格式 YYYY-MM-DD' },
        keyword: { type: 'string', description: '雪场/产品关键词过滤, 如 万龙、云顶' },
        pkey: { type: 'string', description: '产品标题关键词过滤, 如 1住1滑、日场' },
        tree: { type: 'string', enum: ['0', '1', 'any'], description: '0=门票(默认), 1=住滑, any=全部' },
      },
      required: ['date'],
    },
  },
  {
    name: 'zwy_order_plan',
    description: '生成下单报价单(不扣款)。按比价结果给出候选账号与最坏总价, 返回报价单文件名, 供用户确认后再执行。',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '出行日期 YYYY-MM-DD' },
        count: { type: 'integer', minimum: 1, maximum: 20, description: '张数/单数, 默认 1' },
        keyword: { type: 'string', description: '雪场/产品关键词' },
        infoId: { type: 'string', description: '指定产品 infoId, 跳过比价' },
        pick: { type: 'integer', description: '比价结果中第几组(从 1 开始)' },
        tree: { type: 'string', enum: ['0', '1', 'any'], description: '0=门票, 1=住滑, any=全部' },
        maxPrice: { type: 'number', description: '单张价格上限' },
      },
      required: ['date'],
    },
  },
  {
    name: 'zwy_order_execute',
    description: '执行报价单真实下单并扣授信, 失败自动降级到次低价账号。必须先在服务端开启 ZWY_ENABLE_ORDER=1, 且 confirm 传 CONFIRM。',
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'zwy_order_plan 返回的报价单文件名' },
        date: { type: 'string', description: '与报价单一致的日期' },
        count: { type: 'integer', minimum: 1, maximum: 20, description: '与报价单一致的数量' },
        maxMoney: { type: 'number', description: '本次总金额上限, 必须大于 0' },
        confirm: { type: 'string', enum: ['CONFIRM'], description: '人工确认标记' },
        phone: { type: 'string', description: '游客手机号, 未配置手机号的账号必需' },
        name: { type: 'string', description: '游客姓名' },
      },
      required: ['plan', 'date', 'count', 'maxMoney', 'confirm'],
    },
  },
  {
    name: 'zwy_order_detail',
    description: '查询订单详情与票码。',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'string', description: '自我游订单号' },
        account: { type: 'string', description: '下单账号别名, 如 account-a/account-b(以实际 accounts.json 为准)' },
      },
      required: ['orderId', 'account'],
    },
  },
  {
    name: 'zwy_list_accounts',
    description: '列出可用的自我游分销商账号。',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callApi(path, method = 'GET', body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT);
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { json = { ok: res.ok, raw: text.slice(0, 500) }; }
    return { status: res.status, data: json };
  } finally {
    clearTimeout(timer);
  }
}

function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

async function runTool(name, a) {
  a = a || {};
  if (name === 'zwy_best_price') {
    return await callApi(`/best${qs({ date: a.date, keyword: a.keyword, pkey: a.pkey, tree: a.tree })}`);
  }
  if (name === 'zwy_order_plan') {
    return await callApi('/order/plan', 'POST', {
      date: a.date, count: a.count || 1, keyword: a.keyword, infoId: a.infoId, pick: a.pick, tree: a.tree, maxPrice: a.maxPrice,
    });
  }
  if (name === 'zwy_order_execute') {
    return await callApi('/order/execute', 'POST', {
      plan: a.plan, date: a.date, count: a.count, maxMoney: a.maxMoney, confirm: a.confirm, phone: a.phone, name: a.name,
    });
  }
  if (name === 'zwy_order_detail') {
    return await callApi(`/order/detail${qs({ orderId: a.orderId, account: a.account })}`);
  }
  if (name === 'zwy_list_accounts') {
    return await callApi('/accounts');
  }
  throw new Error(`未知工具: ${name}`);
}

async function handleRpc(msg) {
  const { id, method, params } = msg || {};
  if (id === undefined || id === null) return null;

  const reply = (result) => ({ jsonrpc: '2.0', id, result });
  const error = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

  try {
    if (method === 'initialize') {
      return reply({
        protocolVersion: params && params.protocolVersion ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });
    }
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: TOOLS });
    if (method === 'resources/list') return reply({ resources: [] });
    if (method === 'prompts/list') return reply({ prompts: [] });
    if (method === 'tools/call') {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const r = await runTool(name, args);
      return reply({
        content: [{ type: 'text', text: JSON.stringify(r.data) }],
        isError: !(r.status >= 200 && r.status < 300) || (r.data && r.data.ok === false),
      });
    }
    return error(-32601, `未实现的方法: ${method}`);
  } catch (e) {
    return error(-32603, e.message);
  }
}

function bearer(req, url) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  return String(req.headers['x-api-token'] || url.searchParams.get('token') || '');
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body 过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new Error('body 不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

const sessions = new Map();

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
}

function handleSse(req, res, url) {
  if (!tokenOk(bearer(req, url))) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: '缺少或错误的 API token' }));
  }
  const sid = crypto.randomBytes(16).toString('hex');
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  sessions.set(sid, res);
  const path = url.pathname.replace(/\/sse$/, '');
  sseWrite(res, 'endpoint', `${PATH_PREFIX}${path}/messages?sessionId=${sid}`);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
  req.on('close', () => { clearInterval(ping); sessions.delete(sid); });
  console.log(`[mcp] SSE 会话建立 ${sid} (在线 ${sessions.size})`);
}

async function handleMessages(req, res, url) {
  if (!tokenOk(bearer(req, url))) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: '缺少或错误的 API token' }));
  }
  const sid = url.searchParams.get('sessionId') || '';
  const stream = sessions.get(sid);
  if (!stream) {
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: '会话不存在或已断开' }));
  }
  const msg = await readBody(req);
  res.writeHead(202, { 'content-type': 'text/plain' });
  res.end('accepted');
  const out = await handleRpc(msg);
  if (out) sseWrite(stream, 'message', out);
}

async function handleStreamable(req, res, url) {
  if (!tokenOk(bearer(req, url))) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: '缺少或错误的 API token' }));
  }
  const msg = await readBody(req);
  const out = await handleRpc(msg);
  if (!out) { res.writeHead(202); return res.end(); }
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(out));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (p === '/health' || p === '/mcp/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, service: 'zwy-mcp', tools: TOOLS.length, sessions: sessions.size, base: BASE }));
    }
    if (req.method === 'GET' && (p === '/sse' || p === '/mcp/sse')) return handleSse(req, res, url);
    if (req.method === 'POST' && (p === '/messages' || p === '/mcp/messages')) return await handleMessages(req, res, url);
    if (req.method === 'POST' && (p === '/mcp' || p === '/')) return await handleStreamable(req, res, url);
    if (req.method === 'DELETE' && (p === '/mcp' || p === '/')) { res.writeHead(200); return res.end('{}'); }
    if (req.method === 'GET' && p === '/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, service: 'zwy-mcp', sse: '/sse', streamable: '/mcp' }));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: `未知路径 ${p}` }));
  } catch (e) {
    if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`zwy-mcp 已启动: http://${HOST}:${PORT}  SSE=/sse  HTTP=/mcp  上游=${BASE}  工具=${TOOLS.length}`);
});
