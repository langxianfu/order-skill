#!/usr/bin/env node
// 自我游(zowoyou)多账号下单 CLI。无任何依赖,Node 18+。
//
// 用法:
//   node zwy.js login    --account=account-a                          登录并缓存 token
//   node zwy.js views    --account=account-a                          列出该账号的产品视图
//   node zwy.js products --account=account-a --view=wlhxc             列出某视图下的产品(infoId/价格)
//   node zwy.js order    --account=account-a --infoId=49383899 --date=2026-11-30 [--count=5] [--name=张三] [--phone=...] [--dry]
//   node zwy.js detail   --account=account-a --orderId=1219953828     查订单详情(状态/票码)
//   node zwy.js search   --account=account-a --key=王磊                按姓名/手机号/订单号/票码查订单
//   node zwy.js orders   [--account=account-a] [--key=梁爽] [--date=2026-11-11] [--json]   按姓名/日期跨账号查订单
//   node zwy.js best     --date=2026-12-19 [--keyword=万龙] [--tree=0|1|any]   三账号同款比价
//   node zwy.js orderbest --date=... [--keyword=...] [--count=N] [--pick=N|--infoId=...]   比价并生成报价单
//   node zwy.js orderbest --execute --plan=<报价单> --date=... --count=N --max-money=<上限>   人工确认后按最低价自动降级下单
//
// 模式: 账号配置 mode=b2b 时走账号密码录单(orderSource=1, B2B 图标);
//       mode=fan 时走 openId 静默登录的粉丝下单(orderSource=19, 手机图标)。

const fs = require('fs');
const path = require('path');

const API = 'https://task-api.zowoyoo.com';
const DIR = __dirname;
const ACCOUNTS_PATH = path.join(DIR, 'accounts.json');
const STATE_DIR = path.join(DIR, '.state');

const SURNAMES = ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙', '胡', '朱', '高', '林', '何', '郭', '马', '罗'];
const GIVEN = ['伟', '芳', '娜', '敏', '静', '磊', '军', '洋', '勇', '艳', '杰', '娟', '涛', '明', '超', '秀兰', '霞', '平', '刚', '桂英'];
const randomName = () => SURNAMES[Math.floor(Math.random() * SURNAMES.length)] + GIVEN[Math.floor(Math.random() * GIVEN.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => min + Math.floor(Math.random() * (max - min));

function die(msg) { console.error('错误: ' + msg); process.exit(1); }

function parseArgs() {
  const args = { _: null };
  for (const a of process.argv.slice(2)) {
    if (!a.startsWith('--')) { args._ = args._ || []; args._.push(a); continue; }
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
    if (m) args[m[1]] = m[2] === undefined ? true : m[2];
  }
  args._ = args._ || [];
  return args;
}

function loadAccount(alias) {
  if (!fs.existsSync(ACCOUNTS_PATH)) die('缺少 accounts.json,见 references/api.md');
  const all = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
  const acc = all[alias];
  if (!acc) die(`accounts.json 中无账号 "${alias}",现有: ${Object.keys(all).filter(k => !k.startsWith('$')).join(', ')}`);
  return { alias, ...acc };
}

// ---------- HTTP ----------
let cookies = '';
function collectCookies(resp) {
  const set = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
  if (!set.length) return;
  const jar = Object.fromEntries(cookies.split('; ').filter(Boolean).map((c) => {
    const i = c.indexOf('='); return [c.slice(0, i), c.slice(i + 1)];
  }));
  for (const sc of set) {
    const pair = sc.split(';')[0];
    const i = pair.indexOf('=');
    jar[pair.slice(0, i)] = pair.slice(i + 1);
  }
  cookies = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function api(method, url, body, token) {
  const headers = { 'Content-Type': 'application/json;charset=UTF-8', lang: 'cn' };
  if (cookies) headers.Cookie = cookies;
  if (token) headers.authtoken = token;
  const resp = await fetch(API + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  collectCookies(resp);
  const json = await resp.json().catch(() => null);
  return { status: resp.status, json, authtoken: resp.headers.get('authtoken') };
}

// ---------- 登录 ----------
function tokenPath(acc) { return path.join(STATE_DIR, `token-${acc.alias}.json`); }

async function login(acc, force = false) {
  if (!force && fs.existsSync(tokenPath(acc))) {
    try {
      const saved = JSON.parse(fs.readFileSync(tokenPath(acc), 'utf8'));
      if (saved.token && Date.now() - saved.savedAt < 6 * 3600 * 1000) return saved.token;
    } catch {}
  }
  await api('GET', `/api/user/saasInfo?url=${Buffer.from(acc.domain).toString('base64')}`);
  let body;
  if (acc.mode === 'b2b') {
    body = { userId: acc.userId, password: acc.password, saleChannel: 0, parentCustId: acc.parentCustId };
  } else {
    body = {
      code: '', appId: '', unionId: '', parentCustId: acc.parentCustId,
      openId: acc.openId, orderCustId: acc.orderCustId, userId: acc.userId, client: '', saleChannel: 4,
      h5LoginUserRequest: { avatarUrl: '', email: '', identification: '', nickName: '', realName: '' },
    };
  }
  const r = await api('POST', '/api/user/login', body);
  if (!r.authtoken) throw new Error(`登录失败(${acc.alias}/${acc.mode}): ${JSON.stringify(r.json).slice(0, 200)}`);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(tokenPath(acc), JSON.stringify({ token: r.authtoken, savedAt: Date.now() }));
  console.log(`[登录] ${acc.alias} (${acc.mode}) 新 token 已保存`);
  return r.authtoken;
}

async function apiAuthed(acc, method, url, body, ctx) {
  let r = await api(method, url, body, ctx.token);
  if (r.status === 401) {
    console.log('[登录] token 失效,重新登录');
    ctx.token = await login(acc, true);
    r = await api(method, url, body, ctx.token);
  }
  return r;
}

// ---------- 命令 ----------
async function cmdViews(acc, ctx, tree) {
  const r = await apiAuthed(acc, 'GET', `/api/product/common/views?parentCustId=${acc.parentCustId}&orderCustId=${acc.orderCustId}&userId=${acc.userId}&treeId=${tree}`, null, ctx);
  const rs = (r.json && r.json.data && r.json.data.results) || [];
  console.log(`${acc.alias} 共 ${rs.length} 个视图(tree=${tree}${tree === 1 ? ' 酒店/住滑' : ' 门票'}):`);
  for (const v of rs) {
    console.log(`  ${v.viewId}  ${v.viewName}  ¥${v.minPrice}~¥${v.maxPrice}  ${v.address || ''}`);
  }
}

async function cmdProducts(acc, ctx, view, tree) {
  if (!view) die('--view 必填,如 --view=wlhxc 或 --view=view_1707912');
  const r = await apiAuthed(acc, 'GET', `/api/product/common/view/viewProds/${encodeURIComponent(view)}?treeId=${tree}`, null, ctx);
  const rs = (r.json && r.json.data) || [];
  if (!rs.length) { console.log(`视图 ${view} 下无产品(或 viewId 错误)`); return; }
  console.log(`视图 ${view} 共 ${rs.length} 个产品:`);
  for (const p of rs) {
    console.log(`  infoId=${p.infoId}  ${String(p.infoTitle || '').slice(0, 44)}  门市=¥${p.salePrice} 结算=¥${p.price}`);
  }
}

async function reserveCheck(acc, ctx, infoId, date, num) {
  const r = await apiAuthed(acc, 'GET', `/api/product/common/reserve?infoId=${infoId}&travelDate=${date}&num=${num}&isSend=0`, null, ctx);
  const d = r.json && r.json.data;
  if (!r.json || r.json.state !== 1 || !d) return { ok: false, reason: JSON.stringify(r.json).slice(0, 200) };
  if (!d.price || d.price <= 0) return { ok: false, reason: '价格为0(可能不在售卖期)' };
  if (d.maxNum < num) return { ok: false, reason: `库存不足(maxNum=${d.maxNum})` };
  return { ok: true, price: d.price, salePrice: d.salePrice, maxNum: d.maxNum };
}

async function placeOrder(acc, ctx, infoId, date, name, phone) {
  const orderSourceId = `dd${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const body = {
    infoId: String(infoId), travelDate: date, num: 1, specName: 0, planId: '-99',
    linkMan: name, linkPhone: phone, linkEmail: '', linkAddress: '', linkAreaId: '',
    linkCreditType: '', linkCreditNo: '', orderSourceId, orderMemo: '', lang: 'cn',
    details: [{ cond: date, num: 1, peopleType: '' }],
    orderAttrsReq: [], incrementsReq: [], peoplesReq: [], setMealProdsReq: [], customInputsReq: [],
    getType: '', hotelArriveTime: '', salePrice: '',
  };
  const r = await apiAuthed(acc, 'POST', '/api/order/common/placeOrder', body, ctx);
  const j = r.json || {};
  if (j.state !== 1) return { ok: false, reason: JSON.stringify(j).slice(0, 300), orderSourceId };
  const d = j.data || {};
  let orderId = null;
  if (typeof d === 'number' || typeof d === 'string') orderId = String(d);
  else if (d && typeof d === 'object') {
    const cand = d.orderId ?? d.id ?? d.orderNo ?? d.no;
    if (cand != null) orderId = String(cand);
  }
  return { ok: true, orderId, orderSourceId };
}

async function findOrderIdBySource(acc, ctx, orderSourceId) {
  const r = await apiAuthed(acc, 'GET', `/api/order/common/orders?keyType=13&key=${encodeURIComponent(orderSourceId)}&state=&page=0&resultNum=5`, null, ctx);
  const list = r.json && r.json.data && r.json.data.results;
  if (Array.isArray(list) && list.length) return String(list[0].orderId);
  return null;
}

async function payOrder(acc, ctx, orderId) {
  const pay = await apiAuthed(acc, 'PUT', `/api/order/common/orderPay/${orderId}?payType=1`, null, ctx);
  const pj = pay.json || {};
  if (pj.state !== 1) {
    const msg = (pj.msg || JSON.stringify(pj)).slice(0, 200);
    if (/已经支付/.test(msg)) return { ok: true };
    return { ok: false, reason: msg };
  }
  return { ok: true };
}

async function orderDetail(acc, ctx, orderId) {
  const r = await apiAuthed(acc, 'GET', `/api/order/common/orderDetail/${orderId}`, null, ctx);
  return (r.json && r.json.data) || null;
}

async function cmdOrder(acc, ctx, args) {
  const { infoId, date } = args;
  if (!infoId || !date) die('--infoId 和 --date 必填');
  const count = parseInt(args.count || '1', 10);
  const phone = args.phone || acc.phone;
  if (!phone) die('缺少手机号: --phone 或账号配置 phone');
  const dry = !!args.dry;

  console.log(`[启动] 账号=${acc.alias}(${acc.mode}) infoId=${infoId} date=${date} count=${count} dry=${dry}`);
  const results = [];
  for (let i = 1; i <= count; i++) {
    const name = args.name || randomName();
    console.log(`\n[第${i}单] 游客=${name} 手机=${phone}`);
    const chk = await reserveCheck(acc, ctx, infoId, date, 1);
    if (!chk.ok) { console.log(`  校验失败: ${chk.reason}`); results.push({ ok: false, name }); break; }
    console.log(`  可订: 结算价=¥${chk.price} 门市价=¥${chk.salePrice} maxNum=${chk.maxNum}`);
    if (dry) { results.push({ ok: true, name, dry: true }); continue; }

    const ord = await placeOrder(acc, ctx, infoId, date, name, phone);
    if (!ord.ok) { console.log(`  下单失败: ${ord.reason}`); results.push({ ok: false, name }); continue; }
    let orderId = ord.orderId;
    if (!orderId) {
      await sleep(800);
      orderId = await findOrderIdBySource(acc, ctx, ord.orderSourceId);
    }
    if (!orderId) { console.log('  未获得 orderId'); results.push({ ok: false, name }); continue; }
    console.log(`  下单成功: orderId=${orderId}`);

    const pay = await payOrder(acc, ctx, orderId);
    if (!pay.ok) { console.log(`  支付失败: ${pay.reason}`); results.push({ ok: false, name, orderId }); continue; }

    const det = await orderDetail(acc, ctx, orderId);
    const st = det ? `${det.stateDesc}(state=${det.state})` : '查询失败';
    const code = det && det.printExcode ? det.printExcode : '-';
    console.log(`  支付成功: ${st} 金额=¥${det ? det.orderMoney : '?'} 票码=${code}`);
    results.push({ ok: true, name, orderId, code, money: det && det.orderMoney });
    if (i < count) await sleep(jitter(2000, 4000));
  }
  const ok = results.filter((r) => r.ok).length;
  console.log(`\n[汇总] 尝试 ${count} 单, 成功 ${ok}, 失败 ${count - ok}`);
  results.forEach((r, i) => console.log(`  #${i + 1} ${r.ok ? 'OK' : 'FAIL'} ${r.name} ${r.orderId || ''} ${r.code ? '票码=' + r.code : ''}`));
}

async function cmdDetail(acc, ctx, args) {
  if (!args.orderId) die('--orderId 必填');
  const d = await orderDetail(acc, ctx, args.orderId);
  if (!d) die('未查询到订单');
  const keys = ['orderId', 'stateDesc', 'state', 'infoId', 'prodDetail', 'linkMan', 'linkPhone', 'orderMoney', 'printExcode', 'orderSource', 'orderSourceId', 'travelDate'];
  if (args.json) {
    const out = {};
    for (const k of keys) out[k] = d[k] ?? null;
    process.stdout.write(JSON.stringify({ ok: true, stage: 'detail', order: out }) + '\n');
    return;
  }
  for (const k of keys) console.log(`  ${k} = ${d[k] ?? ''}`);
}

async function cmdSearch(acc, ctx, args) {
  if (!args.key) die('--key 必填(姓名/手机号/订单号/票码)');
  // keyType: 1=订单号 2=手机号 3=姓名 13=渠道单号; 依次尝试
  for (const kt of [1, 3, 2, 13]) {
    const r = await apiAuthed(acc, 'GET', `/api/order/common/orders?keyType=${kt}&key=${encodeURIComponent(args.key)}&state=&page=0&resultNum=10`, null, ctx);
    const list = (r.json && r.json.data && r.json.data.results) || [];
    if (list.length) {
      console.log(`keyType=${kt} 命中 ${list.length} 笔:`);
      for (const o of list) {
        console.log(`  ${o.orderId} ${o.stateDesc} ${o.prodDetail || ''} ${o.linkMan} ${o.linkPhone} ¥${o.orderMoney} 票码=${o.printExcode || '-'}`);
      }
      return;
    }
  }
  console.log('未找到订单');
}

// ---------- 订单查询: 姓名/手机号/订单号/票码 + 日期, 可跨账号 ----------
// 上游只支持按 key 搜索, 不支持日期参数, 所以日期在本地按「游玩日期或下单日期」过滤
function tsToDay(ts) {
  const n = Number(ts);
  return n > 1e11 ? new Date(n + 8 * 3600 * 1000).toISOString().slice(0, 10) : String(ts || '');
}

function normOrder(alias, o) {
  const d = (o.b2bTicketDetails && o.b2bTicketDetails[0]) || {};
  return {
    account: alias,
    orderId: o.orderId,
    stateDesc: o.stateDesc || '',
    prodDetail: o.prodDetail || d.infoTitle || '',
    // 不同账号字段不一致: 门票明细里有 condition, 住滑/部分账号只有顶层 travelDate(时间戳)
    travelDate: d.condition || tsToDay(o.travelDate),
    orderDate: tsToDay(o.orderDate),
    name: o.linkMan || '',
    phone: o.linkPhone || '',
    num: o.num,
    money: o.orderMoney,
    code: o.printExcode || ''
  };
}

async function fetchOrdersByKey(acc, ctx, key, size) {
  // keyType=0 是「全部」模糊搜索, 订单号/手机号/姓名都能命中; 票码不支持搜索
  const r = await apiAuthed(acc, 'GET', `/api/order/common/orders?keyType=0&key=${encodeURIComponent(key)}&state=&page=0&resultNum=${size}`, null, ctx);
  return (r.json && r.json.data && r.json.data.results) || [];
}

async function fetchOrdersAll(acc, ctx, maxPages) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const r = await apiAuthed(acc, 'GET', `/api/order/common/orders?page=${page}&resultNum=50`, null, ctx);
    const d = (r.json && r.json.data) || {};
    const list = d.results || [];
    if (!list.length) break;
    out.push(...list);
    const pages = Number(d.pageCount || 0);
    if (pages && page + 1 >= pages) break;
  }
  return out;
}

async function cmdOrders(args) {
  const key = String(args.key || '').trim();
  const date = String(args.date || '').trim();
  if (!key && !date) die('--key 或 --date 至少填一个');
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) die('--date 格式为 YYYY-MM-DD');
  const all = loadAllAccounts();
  const list = args.account ? [args.account] : Object.keys(all);
  const maxPages = Math.max(1, Number(args.maxPages || 10));
  const orders = [];
  const scanned = {};

  for (const alias of list) {
    try {
      const acc = loadAccount(alias);
      const ctx = { token: await login(acc) };
      const raw = key ? await fetchOrdersByKey(acc, ctx, key, 50) : await fetchOrdersAll(acc, ctx, maxPages);
      const rows = raw.map((o) => normOrder(alias, o));
      const hit = date ? rows.filter((r) => r.travelDate === date || r.orderDate === date) : rows;
      const uniq = new Map();
      for (const r of hit) uniq.set(`${r.account}|${r.orderId}`, r);
      scanned[alias] = { fetched: rows.length, matched: uniq.size };
      orders.push(...uniq.values());
    } catch (e) {
      scanned[alias] = { error: String((e && e.message) || e).slice(0, 120) };
    }
  }

  orders.sort((a, b) => String(b.orderDate).localeCompare(String(a.orderDate)) || String(b.orderId).localeCompare(String(a.orderId)));
  if (args.json) {
    process.stdout.write(JSON.stringify({ ok: true, stage: 'orders', key, date, scanned, count: orders.length, orders }) + '\n');
    return;
  }
  if (!orders.length) { console.log('未找到订单'); return; }
  console.log(`共 ${orders.length} 笔:`);
  for (const o of orders) {
    console.log(`  [${o.account}] ${o.orderId} ${o.stateDesc} 游玩=${o.travelDate || '-'} 下单=${o.orderDate || '-'} ${o.name} ${o.phone} ${String(o.prodDetail).slice(0, 40)} ¥${o.money} 票码=${o.code || '-'}`);
  }
}

// ---------- 多账号比价 ----------
function loadAllAccounts() {
  if (!fs.existsSync(ACCOUNTS_PATH)) die('缺少 accounts.json,见 references/api.md');
  const all = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8'));
  return Object.fromEntries(Object.entries(all).filter(([k]) => !k.startsWith('$')));
}

// 门票用特征签名做同款判定: 三家标题写法差异大, 纯字符串归一化匹配不上,
// 改成提取「雪场+票种+季别+平日周末+场次+天数+时长+雪具」这组特征后比较
function prodSig(title, viewName) {
  const s = `${title || ''} ${viewName || ''}`;
  const resort = ['万龙', '云顶', '富龙', '翠云山', '雪如意', '金山岭'].find((r) => s.includes(r)) || '';
  const kind = ['新手票', '次卡', '季卡', '温泉', '晚餐', '长龙之星', '住滑', '单房', '餐券'].find((x) => s.includes(x)) || (/滑雪票|雪票/.test(s) ? 'ticket' : 'other');
  // 雪具口径只对单张雪票有意义; 次卡/季卡/餐券等标题有的写"不含雪具"有的不写, 不能因此拆成两组
  const gear = kind !== 'ticket' ? '-'
    : /不含雪具|自带板|不含装备/.test(s) ? 'noGear'
      : /含雪具|含装备|含全套/.test(s) ? 'withGear' : '-';
  const session = /夜场/.test(s) ? (/下午场/.test(s) ? 'pm+night' : 'night') : (/下午场/.test(s) ? 'pm' : 'day');
  const dm = s.match(/(\d+)\s*天/);
  const days = dm ? `${dm[1]}d` : '1d';
  const dur = /4\s*小时/.test(s) ? '4h' : 'allday';
  // "全雪季"是默认口径, 多数账号不写, 视为无季节标签
  const season = ['开板季', '爽滑季', '畅滑季', '乐滑季', '封板季', '淡季'].find((x) => s.includes(x)) || '';
  const dayType = /周末/.test(s) ? 'weekend' : /平日/.test(s) ? 'weekday' : '-';
  return [resort, kind, season, dayType, session, days, dur, gear].join('|');
}

// 住滑/单房用特征签名: 酒店名+套餐形态(1住1滑/单房)+入住人数+房型+早餐+雪具口径
function hotelSig(title, viewName) {
  const s = `${title || ''} ${viewName || ''}`;
  const hotel = ['太子公寓', '南翼公寓', '北翼公寓', '云顶大酒店', '云顶之星', '盛龙公寓', '双龙酒店', '悦龙酒店', '龙宫酒店', '雪场公寓', '万龙', '云顶'].find((x) => s.includes(x)) || '';
  const pm = s.match(/(\d+)\s*住\s*(\d+)\s*滑/);
  const pkg = pm ? `${pm[1]}住${pm[2]}滑` : /单房/.test(s) ? '单房' : 'other';
  const occ = ['单人', '双人', '三人', '四人', '家庭'].find((x) => s.includes(x)) || '-';
  const room = ['一室一厅', '两室一厅', '一居室', '青旅', '太空舱', '家庭亲子套房', '大床房', '双床房', '标间', '套房'].find((x) => s.includes(x)) || '';
  // "不含早/无早"优先判定(否则会被"含早"子串误判成含早); 未写早餐的一律按不含早处理
  const board = /不含早|无早/.test(s) ? 'noBreakfast' : /含早|含双早|含早餐/.test(s) ? 'withBreakfast' : 'noBreakfast';
  // 只有明确写"含雪具/含装备"才算含雪具; "自带板"和不写视为同一口径
  const gear = /含雪具|含装备|含全套/.test(s) ? 'withGear' : '-';
  return [hotel, pkg, occ, room, board, gear].join('|');
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

// 关键词清洗: 用户常把"云顶11.11雪票""万龙12月19号一天多少钱"整句粘进来,
// 若按字面串匹配视图名会一个都命中不了。这里剥离日期/数字/泛词, 只留雪场名等有效词。
const KW_NOISE = /雪票|门票|价格|多少钱|一天|两天|三天|日场|夜场|预售|套餐|次卡|季卡|滑雪|的|吗|呢|号|日/g;
function kwTokens(kw) {
  return String(kw || '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(KW_NOISE, ' ')
    .replace(/[\d.．\/\\\-_年月~～至到]/g, ' ')
    .split(/[\s,，、;；:：()（）【】\[\]]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

// 先要求命中全部有效词, 命中不到再退化为命中任意一个, 避免"云顶 住滑"这类多词一次全部落空
function filterViews(views, tokens) {
  if (!tokens.length) return views;
  const hay = (v) => String(v.viewName || '') + ' ' + String(v.address || '');
  const allHit = views.filter((v) => tokens.every((t) => hay(v).includes(t)));
  if (allHit.length) return allHit;
  return views.filter((v) => tokens.some((t) => hay(v).includes(t)));
}

async function scanAll(date, keyword, trees, pkey) {
  const all = loadAllAccounts();
  const rows = [];
  const tokens = kwTokens(keyword);

  for (const alias of Object.keys(all)) {
    const acc = { alias, ...all[alias] };
    try {
      const ctx = { token: await login(acc) };
      for (const tree of trees) {
        const vr = await apiAuthed(acc, 'GET', `/api/product/common/views?parentCustId=${acc.parentCustId}&orderCustId=${acc.orderCustId}&userId=${acc.userId}&treeId=${tree}`, null, ctx);
        const views = filterViews((vr.json && vr.json.data && vr.json.data.results) || [], tokens);
        for (const view of views) {
          try {
            const pr = await apiAuthed(acc, 'GET', `/api/product/common/view/viewProds/${encodeURIComponent(view.viewId)}?treeId=${tree}`, null, ctx);
            const prods = ((pr.json && pr.json.data) || []).filter((p) => !pkey || String(p.infoTitle || '').includes(pkey));
            const checks = await mapLimit(prods, 6, async (p) => {
              const chk = await reserveCheck(acc, ctx, p.infoId, date, 1);
              if (!chk.ok) return null;
              return { alias, tree, view: view.viewName, infoId: p.infoId, title: p.infoTitle, price: chk.price, salePrice: chk.salePrice, maxNum: chk.maxNum, key: tree === 1 ? hotelSig(p.infoTitle, view.viewName) : prodSig(p.infoTitle, view.viewName) };
            });
            for (const c of checks) if (c) rows.push(c);
          } catch (e) {
            console.log(`[跳过视图] ${alias}/${view.viewName}: ${e.message}`);
          }
        }
      }
    } catch (e) {
      console.log(`[跳过] ${alias}: ${e.message}`);
    }
  }

  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.key)) groups.set(r.key, []);
    groups.get(r.key).push(r);
  }
  const sorted = [...groups.values()].map((g) => g.sort((a, b) => a.price - b.price || b.maxNum - a.maxNum)).sort((a, b) => a[0].price - b[0].price);
  return { all, rows, groups: sorted };
}

async function cmdBest(args) {
  const date = args.date;
  if (!date) die('--date 必填,如 --date=2026-12-19');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) die('--date 格式应为 YYYY-MM-DD');
  const keyword = args.keyword || '';
  const trees = args.tree === 'any' ? [0, 1] : [Number(args.tree || 0)];
  const { all, rows, groups: sorted } = await scanAll(date, keyword, trees, args.pkey);

  console.log(`[比价] 日期=${date} 关键词=${keyword || '(全部)'}${args.pkey ? ` 产品筛选=${args.pkey}` : ''} 产品树=${trees.map((t) => (t === 1 ? '酒店/住滑' : '门票')).join('+')} 账号=${Object.keys(all).length}`);
  console.log(`可售 ${rows.length} 个产品, 归并为 ${sorted.length} 个同款组\n`);
  const aliases = Object.keys(all);
  if (args.json) {
    const out = {
      ok: true,
      stage: 'best',
      date,
      keyword,
      pkey: args.pkey || '',
      tree: args.tree || '0',
      accounts: aliases,
      sellableCount: rows.length,
      groups: sorted.map((g) => ({
        title: g[0].title,
        lowest: { alias: g[0].alias, price: g[0].price, salePrice: g[0].salePrice, maxNum: g[0].maxNum, infoId: g[0].infoId, tree: g[0].tree },
        options: g.map((r) => ({ alias: r.alias, price: r.price, salePrice: r.salePrice, maxNum: r.maxNum, infoId: r.infoId, tree: r.tree, view: r.view, diff: Number((r.price - g[0].price).toFixed(2)) })),
        missing: aliases.filter((a) => !g.some((r) => r.alias === a)),
      })),
    };
    process.stdout.write(JSON.stringify(out) + '\n');
    return;
  }
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...String(s)].reduce((w, c) => w + (c.charCodeAt(0) > 255 ? 2 : 1), 0)));
  for (const g of sorted) {
    g.sort((a, b) => a.price - b.price || b.maxNum - a.maxNum);
    const sellable = aliases.filter((a) => g.some((r) => r.alias === a));
    const missed = aliases.filter((a) => !sellable.includes(a));
    console.log(`◆ ${g[0].title}`);
    const dupCount = {};
    for (const r of g) dupCount[r.alias] = (dupCount[r.alias] || 0) + 1;
    const dupSeen = {};
    for (const r of g) {
      const star = r === g[0] ? '★' : ' ';
      const gap = g.length > 1 && r !== g[0] ? `  (比最低 +¥${(r.price - g[0].price).toFixed(2)})` : '';
      const dup = dupCount[r.alias] > 1 ? `  [同名货品 ${(dupSeen[r.alias] = (dupSeen[r.alias] || 0) + 1)}/${dupCount[r.alias]}]` : '';
      console.log(`  ${star} ${pad(r.alias, 12)} ¥${String(r.price).padEnd(8)} 门市¥${String(r.salePrice).padEnd(6)} 库存${String(r.maxNum).padEnd(5)} infoId=${r.infoId}${r.tree === 1 ? '  [酒店]' : ''}${gap}${dup}`);
    }
    for (const a of missed) console.log(`    ${a}: —(当日无此产品)`);
    console.log('');
  }
  console.log(`最低价清单(共 ${sorted.length} 组):`);
  for (const g of sorted) {
    const r = g[0];
    const gap = g.length > 1 ? `  次低 ¥${g[1].price}(${g[1].alias})  价差 ¥${(g[1].price - r.price).toFixed(2)}` : '  仅一家在售';
    console.log(`  ¥${r.price}  ${r.alias}  infoId=${r.infoId}  ${String(r.title).slice(0, 36)}${gap}`);
  }
  console.log(`\n下单前请确认: node zwy.js order --account=<账号> --infoId=<infoId> --date=${date} --count=1 [--name=姓名] [--phone=手机] --dry`);
}

// ---------- 比价 + 自动降级下单(两阶段: 先出报价单, 人工确认后再执行) ----------
async function cmdOrderBest(args) {
  const date = args.date;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) die('--date 必填且格式 YYYY-MM-DD');
  const count = parseInt(args.count || '1', 10);
  if (!(count > 0)) die('--count 必须为正整数');

  if (args.execute) {
    const planPath = args.plan;
    if (!planPath) die('--execute 需要 --plan=<报价单路径>');
    const maxMoney = Number(args['max-money'] || 0);
    if (!(maxMoney > 0)) die('--execute 必须给出 --max-money=<金额上限>, 防止超出授权额度');
    // 支持只传报价单文件名(HTTP 封装为了路径安全只传 basename), 优先在 .state 目录查找
    const abs = path.isAbsolute(planPath)
      ? planPath
      : fs.existsSync(path.join(STATE_DIR, planPath))
        ? path.join(STATE_DIR, planPath)
        : path.join(DIR, planPath);
    if (!fs.existsSync(abs)) die(`报价单不存在: ${abs}`);
    const plan = JSON.parse(fs.readFileSync(abs, 'utf8'));
    if (Date.now() - plan.createdAt > 30 * 60 * 1000) die('报价单已超过 30 分钟, 价格可能变动, 请重新 --plan');
    if (plan.date !== date) die(`报价单日期 ${plan.date} 与 --date=${date} 不一致`);
    if (plan.count !== count) die(`报价单数量 ${plan.count} 与 --count=${count} 不一致`);
    if (!plan.candidates.length) die('报价单没有候选账号');
    const perOrderCap = maxMoney / count;
    const worst = Math.max(...plan.candidates.map((c) => c.price)) * count;
    console.log(`[执行] 报价单=${abs}\n  产品=${plan.groupTitle}\n  数量=${count}  候选=${plan.candidates.length} 个账号  最坏总价=¥${worst.toFixed(2)}  上限=¥${maxMoney}`);
    if (worst > maxMoney + 0.001) die(`最坏总价 ¥${worst.toFixed(2)} 超过 --max-money ¥${maxMoney}, 拒绝执行`);
    console.log('  已通过人工确认的报价单与金额上限校验, 开始自动降级下单\n');

    const all = loadAllAccounts();
    const ctxCache = {};
    const blocked = {};
    const results = [];
    let done = 0;
    let halted = '';

    while (done < count) {
      let placed = false;
      for (const cand of plan.candidates) {
        if (blocked[cand.alias]) continue;
        const acc = { alias: cand.alias, ...all[cand.alias] };
        const phone = args.phone || acc.phone;
        if (!phone) { console.log(`[跳过] ${cand.alias}: 无手机号`); blocked[cand.alias] = '无手机号'; continue; }
        const ctx = ctxCache[cand.alias] || (ctxCache[cand.alias] = { token: await login(acc) });
        const name = args.name || randomName();
        console.log(`\n[第${done + 1}/${count}单] 尝试 ${cand.alias} ¥${cand.price} infoId=${cand.infoId} 游客=${name}`);

        const chk = await reserveCheck(acc, ctx, cand.infoId, date, 1);
        if (!chk.ok) { console.log(`  ✗ 库存/售卖校验失败: ${chk.reason} → 降级下一账号`); blocked[cand.alias] = chk.reason; continue; }
        if (chk.price > perOrderCap + 0.001) {
          console.log(`  ✗ 当前价 ¥${chk.price} 超出单均上限 ¥${perOrderCap.toFixed(2)} → 跳过该账号`);
          blocked[cand.alias] = `价格¥${chk.price}超限`;
          continue;
        }
        if (Math.abs(chk.price - cand.price) > 0.011) console.log(`  ! 价格变动: ¥${cand.price} → ¥${chk.price}(仍在授权范围内)`);

        const ord = await placeOrder(acc, ctx, cand.infoId, date, name, phone);
        if (!ord.ok) { console.log(`  ✗ 下单失败: ${ord.reason} → 降级下一账号`); blocked[cand.alias] = ord.reason; continue; }
        let orderId = ord.orderId;
        if (!orderId) { await sleep(800); orderId = await findOrderIdBySource(acc, ctx, ord.orderSourceId); }
        if (!orderId) {
          console.log(`  ✗ 已提交但未取到 orderId(渠道单号 ${ord.orderSourceId}) → 停止降级, 请人工核对`);
          results.push({ ok: false, alias: cand.alias, name, reason: '未取到orderId, 可能已占单' });
          halted = `渠道单号 ${ord.orderSourceId} 未取到 orderId, 可能已占单`;
          break;
        }
        console.log(`  下单成功: orderId=${orderId} 单价=¥${chk.price}`);

        const pay = await payOrder(acc, ctx, orderId);
        if (!pay.ok) {
          console.log(`  ✗ 支付失败: ${pay.reason} → 停止降级(订单 ${orderId} 已创建, 换账号重下会重复占单, 需人工处理)`);
          results.push({ ok: false, alias: cand.alias, name, orderId, reason: pay.reason });
          halted = `订单 ${orderId} 支付失败: ${pay.reason}`;
          break;
        }
        const det = await orderDetail(acc, ctx, orderId);
        const st = det ? `${det.stateDesc}(state=${det.state})` : '查询失败';
        const code = det && det.printExcode ? det.printExcode : '-';
        const money = det ? det.orderMoney : chk.price;
        console.log(`  支付成功: ${st} 金额=¥${money} 票码=${code}`);
        results.push({ ok: true, alias: cand.alias, name, orderId, code, money });
        done++;
        placed = true;
        if (done < count) await sleep(jitter(2000, 4000));
        break;
      }
      if (halted) break;
      if (!placed && plan.candidates.every((c) => blocked[c.alias])) {
        console.log('\n[中止] 候选账号全部失败, 剩余单未完成');
        break;
      }
    }

    const okList = results.filter((r) => r.ok);
    console.log(`\n[汇总] 目标 ${count} 单, 成功 ${okList.length}, 未完成 ${count - okList.length}`);
    results.forEach((r, i) => console.log(`  #${i + 1} ${r.ok ? 'OK' : 'FAIL'} ${r.alias} ${r.name} orderId=${r.orderId || '-'} ${r.code ? '票码=' + r.code : ''}${r.reason ? '  原因=' + r.reason : ''}`));
    if (okList.length) console.log(`  合计 ¥${okList.reduce((s, r) => s + Number(r.money || 0), 0).toFixed(2)}  用到的账号: ${[...new Set(okList.map((r) => r.alias))].join(', ')}`);
    if (Object.keys(blocked).length) console.log(`  被跳过/失败的账号: ${Object.entries(blocked).map(([k, v]) => `${k}(${String(v).slice(0, 40)})`).join('; ')}`);
    if (halted) console.log(`  ⚠ 已停止降级: ${halted}`);
    if (args.json) {
      const total = okList.reduce((s, r) => s + Number(r.money || 0), 0);
      process.stdout.write(JSON.stringify({ ok: okList.length === count, stage: 'execute', count, success: okList.length, total: Number(total.toFixed(2)), results, blocked, halted: halted || null }) + '\n');
    }
    if (okList.length < count) process.exitCode = 2;
    return;
  }

  // 阶段一: 只做比价 + 生成报价单, 不下单
  const keyword = args.keyword || '';
  const trees = args.tree === 'any' ? [0, 1] : [Number(args.tree || 0)];
  const { all, groups } = await scanAll(date, keyword, trees, args.pkey);
  let group;
  if (args.infoId) {
    group = groups.find((g) => g.some((r) => String(r.infoId) === String(args.infoId)));
    if (!group) die(`infoId=${args.infoId} 在 ${date} 不可售或不属于同款组`);
  } else {
    const pick = parseInt(args.pick || '1', 10);
    group = groups[pick - 1];
    if (!group) die(`没有第 ${pick} 个同款组(共 ${groups.length} 组)`);
  }
  const maxPrice = args.maxPrice ? Number(args.maxPrice) : Infinity;
  const candidates = group.filter((r) => r.price <= maxPrice).map((r) => ({ alias: r.alias, infoId: r.infoId, price: r.price, salePrice: r.salePrice, maxNum: r.maxNum }));

  console.log(`[候选组] ${group[0].title}`);
  candidates.forEach((c, i) => console.log(`  ${i + 1}. ¥${c.price}  ${c.alias}  infoId=${c.infoId}  库存${c.maxNum}`));
  if (!candidates.length) die(`组内没有价格 ≤ ¥${maxPrice} 的账号`);

  const plan = { date, count, groupTitle: group[0].title, candidates, createdAt: Date.now(), accounts: Object.keys(all) };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const planPath = path.join(STATE_DIR, `plan-${date}-${Date.now()}.json`);
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  const worst = Math.max(...candidates.map((c) => c.price)) * count;
  if (args.json) {
    process.stdout.write(JSON.stringify({ ok: true, stage: 'plan', planPath, date, count, groupTitle: group[0].title, candidates, worst: Number(worst.toFixed(2)), expiresAt: plan.createdAt + 30 * 60 * 1000 }) + '\n');
    return;
  }
  console.log(`\n[报价单] ${planPath}`);
  console.log(`  下单 ${count} 单, 最坏总价 ¥${worst.toFixed(2)}, 有效期 30 分钟`);
  console.log('  确认后执行(把 <上限> 换成你愿意承担的最高金额):');
  console.log(`  node zwy.js orderbest --execute --plan="${planPath}" --date=${date} --count=${count} --max-money=<上限> [--phone=...]`);
}

(async () => {
  const args = parseArgs();
  const cmd = args._[0];
  if (!cmd) die('缺少命令: login/views/products/best/orderbest/order/detail/search/orders');
  if (cmd === 'best') { await cmdBest(args); return; }
  if (cmd === 'orderbest') { await cmdOrderBest(args); return; }
  if (cmd === 'orders') { await cmdOrders(args); return; }
  if (!args.account) die('--account 必填(accounts.json 中的别名)');
  const acc = loadAccount(args.account);
  const ctx = { token: await login(acc) };

  switch (cmd) {
    case 'login': console.log(`[OK] ${acc.alias} 登录成功`); break;
    case 'views': await cmdViews(acc, ctx, Number(args.tree || 0)); break;
    case 'products': await cmdProducts(acc, ctx, args.view, Number(args.tree || 0)); break;
    case 'order': await cmdOrder(acc, ctx, args); break;
    case 'detail': await cmdDetail(acc, ctx, args); break;
    case 'search': await cmdSearch(acc, ctx, args); break;
    default: die(`未知命令 ${cmd}`);
  }
})().catch((e) => die(e.message));
