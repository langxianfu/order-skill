---
name: ziwoyou-order
description: 自我游(zowoyou)分销商系统雪票/门票/住滑的价格查询、多账号比价与自动下单。当用户问"XX雪场某天多少钱""一天/两天票价格""哪家最便宜""帮我比价""查一下最低价"，或要下单雪票/门票/预售票/住滑套餐、查询与管理自我游订单、查票码、转发微信里的订票需求时使用。支持远程 HTTPS 模式(手机端可用)与本地 CLI 模式、B2B 录单、批量下单、比价后自动降级下单。不用于非自我游体系的平台。
---

# 自我游下单

## 触发场景

- **询价比价(最高频)**: "万龙 2026-12-19 一天多少钱"、"XX 雪场某天票价"、"哪家便宜/最便宜"、"帮我比价"、"查下最低价" → 只比价, 不下单, 不要因为没有"下单"字样就跳过
- 用户转发微信消息, 形如"万龙 淡季平日 2026-11-30 张三 138xxxxxxxx 2张"
- 用户说"给 XX 雪场下 N 单"、"随便哪家能下就下"、"查订单 121995xxxx 的票码"
- 用户问住滑: "万龙住滑多少钱"、"双龙酒店一晚含雪票" → tree=1

只问价时只比价; 只有用户明确要下单才进入报价/下单流程。

## 两种运行模式

### 远程模式(默认, 手机端/无 Node 环境必选)

服务部署者已把 `http/server.js` 挂在某个 HTTPS 地址下。调用前需要两个凭据:

- `ZWY_BASE`: 服务地址, 形如 `https://<域名>/zwy`(不带尾部斜杠)
- `ZWY_TOKEN`: API token(Bearer)

**首次使用时向用户索要这两项, 不要编造、不要硬编码到任何文件。** 拿到后本次会话内复用。

用任意 HTTP 能力(curl / fetch / 网络请求工具)调用:

```bash
# 通用形式: 除 /health 外所有接口都要 Authorization: Bearer <ZWY_TOKEN>
curl -s -H "Authorization: Bearer $ZWY_TOKEN" "$ZWY_BASE/best?date=2026-12-19&keyword=万龙&tree=0"
```

| 接口 | 方法 | 参数 | 用途 |
|---|---|---|---|
| /health | GET | 无(免鉴权) | 探活 |
| /accounts | GET | 无 | 列出可用分销商账号别名 |
| /best | GET | date(必填,YYYY-MM-DD), keyword, pkey, tree(0门票/1住滑/any) | 多账号同款比价, 结果缓存约 5 分钟 |
| /order/plan | POST | JSON: date, count, keyword 或 infoId 或 pick, tree, maxPrice | 生成报价单(不扣款), 返回 plan 文件名 |
| /order/execute | POST | JSON: plan, date, count, maxMoney, confirm="CONFIRM", phone?, name? | 真实下单扣款, 需服务端开启 ZWY_ENABLE_ORDER=1 |
| /order/detail | GET | orderId, account | 查订单状态/票码 |
| /order/search | GET | key(姓名/手机/订单号/票码) 或 date, account 可选 | 搜订单 |

错误约定: 401=token 缺失或错误; 400=参数问题(读 error 字段); 403=下单接口未开启; 404=报价单不存在或已过期; 502=上游(自我游)失败, 可稍后重试一次。单次 /best 可能耗时 1-4 分钟(全账号实时核价), 请求超时至少设 240 秒。

### 本地模式(桌面端, 有 Node 18+)

skill 目录下的 `scripts/zwy.js` 是完整 CLI, 需要先按「账号配置」一节备好 `scripts/accounts.json`:

```bash
node scripts/zwy.js views    --account=<别名>                          # 列门票产品视图
node scripts/zwy.js views    --account=<别名> --tree=1                 # 列酒店/住滑视图
node scripts/zwy.js products --account=<别名> --view=<视图标识>          # 列产品(infoId/价格)
node scripts/zwy.js products --account=<别名> --view=<视图标识> --tree=1 # 酒店/住滑产品
node scripts/zwy.js order    --account=<别名> --infoId=49383899 --date=2026-11-30 --count=5 [--name=张三] [--phone=...] [--dry]
node scripts/zwy.js detail   --account=<别名> --orderId=1219953828     # 查状态/票码
node scripts/zwy.js search   --account=<别名> --key=王磊                # 按姓名/手机/订单号/票码搜
node scripts/zwy.js best     --date=2026-12-19 [--keyword=万龙] [--tree=0|1|any]   # 多账号同款比价
```

`--tree` 区分产品树: 0=门票/雪票(默认), 1=酒店/住滑。住滑产品单位是「套」(通常含 1 晚住宿 + N 人雪票), 下单流程与票类一致, 数量按套数算, 房型/含人数写在产品标题里。

`--dry` 只校验库存价格不真下单。批量时每单 1 人(预售票类 maxNum=1 的限制), 间隔 2-4 秒。

## 下单执行流程(两种模式通用)

1. **解析意图**: 提取 账号(缺省用默认)、产品关键词、日期、数量、游客姓名(缺省随机)、手机号(缺省用账号配置)。
2. **定位产品**: 若用户给的是产品关键词而非 infoId, 先比价/列产品得到候选, 让用户确认或自动匹配唯一项。
3. **确认后再下单**: 下单会把真实授信扣款。列出"账号/套餐/日期/数量/单价合计", **等用户确认后**再执行(除非用户已在指令里明确说"直接下")。
4. **执行**: 远程模式走 plan → execute 两阶段; 本地模式直接 order/orderbest。
5. **汇报**: 每笔给出 orderId、状态、票码; 票码缺失时提示稍后用 detail 复查。

## 比价口径(best / /best)

用户说"哪家最便宜""帮我找最优惠的""随便哪个能下就下"时, 先跑比价, 再按最低价账号下单。

- **严格同款比价**。门票按「雪场+票种+季别+平日/周末+场次+天数+时长+雪具口径」特征签名归组; 住滑/单房按「酒店+套餐形态(1住1滑/单房)+入住人数+房型+早餐+雪具口径」归组, 不同房型/不同酒店不混比。
- keyword 过滤视图(雪场/酒店名), pkey 过滤产品标题(如 1住1滑), 两者可叠加。
- 每个产品都实时校验当天价格与库存, 不可售的自动跳过。
- 输出每组的全账号价格对照: 组内按价格升序, 最低价标 ★, 其余标注「比最低 +¥x.xx」; 没有该产品的账号显式标注, 方便核对有没有漏算。

## 自动降级下单(两阶段, 必须先生成报价单)

用户说"随便哪家能下就下, 要最便宜的"时使用。**必须两阶段执行, 不要跳过报价单**:

```bash
# 阶段一: 比价 + 生成报价单(不扣款)
curl -s -X POST -H "Authorization: Bearer $ZWY_TOKEN" -H "content-type: application/json" \
  -d '{"date":"2026-12-19","count":2,"keyword":"万龙","tree":"0"}' "$ZWY_BASE/order/plan"

# 阶段二: 用户明确确认后执行, 必须同时给出金额上限
curl -s -X POST -H "Authorization: Bearer $ZWY_TOKEN" -H "content-type: application/json" \
  -d '{"plan":"<阶段一返回的文件名>","date":"2026-12-19","count":2,"maxMoney":1100,"confirm":"CONFIRM","phone":"13800000000"}' \
  "$ZWY_BASE/order/execute"
```

执行阶段行为:

- 候选按单价从低到高排列, 逐单从最低价账号开始;
- 账号登录失败/当日不可售/库存不足/下单被拒 → 自动降级到下一个账号;
- 下单前实时复核价格; 若当前价超出单均上限(maxMoney/count)则跳过该账号;
- **下单成功但支付失败, 或提交后取不到 orderId → 立即停止降级并输出 orderId/渠道单号**, 换账号重下会重复占单, 需人工处理;
- 报价单有效期 30 分钟, 日期/数量与请求不一致会被拒绝;
- 最坏总价(候选最高单价 × 数量)超过 maxMoney 直接拒绝执行。

phone 会覆盖所有候选账号的联系电话; 候选账号自身没配 phone 且未传 phone 会被跳过, 跨账号降级前先确认手机号。

## 账号配置

本地模式或服务端部署都需要 `scripts/accounts.json`(从 `scripts/accounts.example.json` 复制修改):

- 每个顶层键是一个账号别名, 值为 `{domain, parentCustId, orderCustId, userId, password, mode, phone, views?}`。
- `mode:"b2b"` = 账号密码录单(订单显示 B2B 图标, 后台可管理); `mode:"fan"` = openId 粉丝下单, 需另配 `openId`。
- views 字段可记录常用视图别名, 如 `"wlhxc": "日场"`。
- **accounts.json 含真实凭据, 已在 .gitignore 中, 永远不要提交或外发。**

## 自建服务部署(远程模式的服务端)

`http/` 目录是完整服务端, 需要一台有 Node 18+ 的机器:

```bash
cd http && cp .env.example .env
# .env 里填 ZWY_API_TOKEN(openssl rand -hex 32 生成); ZWY_ENABLE_ORDER=1 才允许真实下单
cp ../scripts/accounts.example.json ../scripts/accounts.json   # 填真实账号
docker compose up -d --build                                   # 或 node server.js
```

- 容器以非 root 运行、只读根文件系统、默认只监听 127.0.0.1, 对外用 nginx/Caddy 做 HTTPS 反代
- 服务自带手机网页版: `https://<域名>/`(或 /app), 页面不含凭据, 打开后自行填 token
- `http/mcp.js` 是可选的 MCP 包装(SSE + Streamable HTTP), 供支持远程 MCP 的客户端接入
- /best 结果默认缓存 5 分钟, 扫描请求全局串行以避免触发上游风控

## 规则

- **默认 B2B 录单**: 粉丝模式(orderSource=19)的单在 B2B 后台列表里查不到订单号/二维码, 只有用户明确要求才用。
- **下单即扣款**: 使用授信支付(payType=1), 勿对未确认的指令执行真实下单。
- **供应商可能退单**: 批量下完后抽查 detail, 确认 state=2 已支付已出票。
- **凭据纪律**: token、accounts.json 只从用户处获得, 不写入仓库、不打印到输出。
