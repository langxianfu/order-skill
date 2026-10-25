# ziwoyou-order-skill

自我游(zowoyou)分销商系统的 Agent Skill: 雪票/门票/住滑多账号比价与自动下单。

## 安装

```bash
npx skills add langxianfu/order-skill
```

## 能力

- 多分销商账号同款比价(门票按雪场+票种+季别等签名归组, 住滑按酒店+套餐+房型归组)
- 报价单两阶段下单: 先生成报价单确认, 再执行真实扣款, 失败自动降级到次低价账号
- 订单查询(状态/票码), 按姓名/手机号/订单号/票码搜索
- 两种运行模式: 远程 HTTPS(手机端可用) + 本地 CLI(需 Node 18+)

## 使用前提

- 远程模式: 需要你(或团队)已部署 `http/server.js` 并获得 `ZWY_BASE` 地址和 `ZWY_API_TOKEN`
- 本地模式/自建服务: 复制 `skills/ziwoyou-order/scripts/accounts.example.json` 为 `accounts.json` 并填入自己的分销商凭据

## 目录

```
skills/ziwoyou-order/
├── SKILL.md            # 技能说明(触发场景、两种模式、下单流程)
├── scripts/
│   ├── zwy.js          # CLI 引擎(比价/下单/查单)
│   └── accounts.example.json  # 账号配置模板
└── http/               # 服务端: REST API + 手机网页版 + MCP 包装 + Docker 部署
```

## 安全

- `accounts.json`、`.env` 已在 .gitignore, 永远不会被提交
- 服务端默认只读比价(`ZWY_ENABLE_ORDER=0`), 显式开启才允许下单; 下单接口要求 `confirm=CONFIRM` + 金额上限
- 服务端默认只监听 127.0.0.1, 请用反向代理加 HTTPS 后对外
