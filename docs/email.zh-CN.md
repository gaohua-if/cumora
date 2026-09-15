# 邮件——每个智能体一个真实的外部邮箱

每个智能体都有一个真实地址(`<participantId>.<companySlug>@<EMAIL_DOMAIN>`),既能发信也能收信。智能体通过 `cumora email …` CLI 子命令使用它,这些命令经由固定的 Cumora CLI 桥接抵达服务器——在安全模式下即 `cli(argv)` MCP 工具,因为引擎根本没有 Bash 工具;`cumora` shell shim 只存在于无沙箱兼容模式。入站邮件会像其他消息一样唤醒收件智能体;空闲心跳唤醒则让一个安静的智能体有机会自行决定发送 / 回复 / 开启一个邮件线程。

> 本文件是 [email.md](email.md) 的简体中文翻译;如与英文原文有出入,以英文原文为准。

## 架构

```
┌──────────────┐  MIME    ┌────────────────────────┐  HMAC-signed JSON   ┌──────────────────┐
│  Sender MTA  │ ───────► │  Cloudflare            │ ──────────────────► │  cumora-server   │
│ (gmail, etc) │   MX     │  Email Routing +       │   POST /webhooks/   │  /webhooks/email │
└──────────────┘          │  workers/email-gate    │   email/inbound     │  /inbound        │
                          └────────────────────────┘                     └──────────────────┘
                                                                                 │
                                                                                 ▼ wakes the recipient agent
                                                                         ┌──────────────────┐
                                                                         │  agent (pod or   │
                                                                         │  BYOA) runs a    │
                                                                         │  turn, replies   │
                                                                         └──────────────────┘
                                                                                 │
                                                                                 ▼ cumora email send/reply
                                                                         ┌──────────────────┐
                                                                         │  Resend HTTP API │
                                                                         └──────────────────┘
                                                                                 │
                                                                                 ▼ DKIM/SPF, MTA queue
                                                                         ┌──────────────────┐
                                                                         │  Recipient MTA   │
                                                                         └──────────────────┘
```

- **入站**:Cloudflare Email Workers(免费)解析 MIME 并 POST 签名后的 JSON。服务器把收件人解析到智能体,依据 In-Reply-To / References 归入线程,写入 `messages`(kind=`email`)+ `email_messages`,并发布 `CH_MESSAGE_NEW`,让收件智能体通过既有的调度器被唤醒。
- **出站**:Resend 的 HTTP API。Mock 模式(未设置 `RESEND_API_KEY`)返回一个假 message-id 并打日志——对本地开发很有用。

## 存储模型

- 每个邮件线程一个**会话(conversation)**(`conversations.kind = 'email'`)。
- 每封单独的邮件一条**消息(message)**(`messages.kind = 'email'`)。
- 一条以 messages.id 为键的伴随 **email_messages** 行,存放 SMTP 层面的字段:`smtp_message_id`(不含尖括号的 RFC 5322 Message-ID)、`in_reply_to`、`references_chain`、`direction`(`in`/`out`)、`transport_status`(`queued`/`sent`/`failed`/`received`)、`subject`、`from_addr`、`to_addrs`、`cc_addrs`。`/conversations/:id/messages` 端点对它做 LEFT JOIN,并在每条消息上输出一个类型化的 `email` 字段——渲染层无需去理解 JSONB 的形状。
- **email_contacts** 表记录与我们有过往来的外部地址,让心跳提示词可以推荐已知收件人。

线程归并规则:一封入站邮件会归入任何一条 `email_messages.smtp_message_id` 与其 `In-Reply-To` 或其 `References` 中任一 id 匹配的既有会话。没有匹配 → 新建会话,以清洗后的主题为标题。

## 地址方案

`<净化后的 participantId>.<companySlug>@<EMAIL_DOMAIN>` —— 例如 `aurora.acme@cumora.ai`。`participants.email` 列在第一次有任何操作触到该智能体地址时惰性填充;既有智能体会在其下一次与邮件相关的动作时自动获得地址,无需回填迁移。

故意使用顶点域(apex domain)。早期版本用过每租户子域(`aurora@acme.cumora.ai`),但那意味着每新增一个 `<slug>.cumora.ai` 都要在 Resend 做一次独立 DKIM 验证,若没有调用 Resend 域名 API 并写 DNS 记录的每租户自动化,就无法扩展。点-顶点形式保住了视觉结构("`<谁>` at `<哪里>`"),同时把运维成本压低为一次性的顶点域配置。租户隔离在收件人解析器中强制执行,而不是在 DNS 中。

local-part 解析回 `(id, slug)` 是无歧义的,因为 `safeLocalPart` 会把 `.` 从智能体 id 中剥离——slug 永远是 local-part 中**最后一个** `.` 之后的子串。

Worker 的 `EMAIL_ROOT_DOMAINS` 变量就是允许清单;清单之外的邮件以 `550` 退信。

## 搭建

### 1. 服务器

在 `.env` 中添加:

```
RESEND_API_KEY=re_xxxxxxxxxxxxxxxx
EMAIL_DOMAIN=cumora.ai
EMAIL_INBOUND_HMAC_SECRET=<openssl rand -hex 32>
```

运行一次 `npm run migrate`,然后重启服务器。`participants.email` 列与 `email_messages` / `email_contacts` 表都在 `server/src/db/migrate.ts` 的基线 schema 中,因此不涉及单独的版本化迁移;正常的服务器启动只会校验迁移台账。

### 2. Resend

1. Resend 控制台 → API Keys → 创建一个。
2. 添加发信域名 `cumora.ai`。
3. 把 SPF + DKIM TXT 记录拷入你的 DNS(Cloudflare)。
4. 等待 Resend 把域名标记为 "Verified"。

### 3. Cloudflare Email Worker

```bash
cd workers/email-gate
npm install
npx wrangler login
npx wrangler secret put EMAIL_INBOUND_HMAC_SECRET   # 粘贴服务器侧的值
npx wrangler deploy
```

Cloudflare 控制台 → 你的 zone → **Email → Email Routing**:

1. 启用 Email Routing(这一步会写入顶点域 MX 记录)。
2. **Catch-all** → "Send to a Worker" → `cumora-email-gate`。

这样就完成了——所有 `*@<EMAIL_DOMAIN>` 都会落入 worker,由它把 local-part 解码为 (id, slug)。没有任何每租户 DNS 工作。

### 4. 端到端验证

- 用 gmail 向 `<已知的智能体-id>.<公司-slug>@cumora.ai` 发一封邮件。
- `wrangler tail` 显示 worker 接受并 POST 了请求。
- 服务器日志出现 `[inbound-email] delivered`。
- 智能体在几秒内被唤醒。它的下一个回合会在 `cumora email inbox` 中看到这封邮件,并自行决定是否回复。

## 测试

本仓库有两层邮件测试:

### 单元(`npm test`)

纯函数覆盖——`sanitizeSubject`、`splitReplyAddresses`、`sanitizeEmailHtml`、`parseAddress`、`normalizeMessageId`、`computeAgentAddress`,外加 Cloudflare Worker 辅助函数(`recipientAccepted`、`readArrayHeader`、`toBase64`、`getHeader`)与 GC 对账(`pickOrphans`)。约 0.5s 跑完,无需 DB / Redis。

### 集成(`npm run test:integration`)

针对**真实的** Postgres + Redis 端到端运行。默认跳过——由 `INTEGRATION_DATABASE_URL` 环境变量把关。搭建:

```bash
# 用你手头 whichever Postgres 都行:
createdb cumora_test
# 或用 Docker:
docker run -d --name pg-test -p 5433:5432 \
  -e POSTGRES_USER=cumora -e POSTGRES_PASSWORD=cumora \
  -e POSTGRES_DB=cumora_test postgres:16-alpine

# 运行套件(运行器拒绝 TRUNCATE 看起来不像测试库的 URL):
INTEGRATION_DATABASE_URL=postgres://cumora:cumora@localhost:5433/cumora_test \
  npm run test:integration
```

覆盖单元测试覆盖不了的部分:
- **入站 webhook 端到端**——HMAC 门禁、对 `participants.email` 的收件人解析、`email_messages` + `email_attachments` 行写入、重复投递 Message-ID 的幂等去重、解析不到收件人时的 404 退信、`Auto-Submitted` 标志传递。
- **重试 worker 的 SQL**——`SELECT … FOR UPDATE SKIP LOCKED` 认领、退避递进(60s → 5m → 30m → 2h → 6h → 24h)、最后一步之后 `next_retry_at=NULL` 的终态、入站/已发行的被正确忽略。

运行器强制 `RESEND_API_KEY=''`(mock 模式),免得开发者 `.env` 里的真实密钥意外打到线上 Resend API(带着一个未验证的测试域名)。测试用 `node:test` + `tsx`——不引入新框架。

### 真实 Resend(`RESEND_LIVE_TEST=1`)

选择性启用的层级,对 Resend 提供的用于测试的魔法地址(magic sink addresses)走真实的 Resend HTTP 路径:

| 地址 | 行为 |
|---|---|
| `delivered@resend.dev` | API 返回 200,无真实投递 |
| `bounced@resend.dev`   | API 返回 200,异步退信 webhook |
| `complained@resend.dev`| API 返回 200,异步投诉 webhook |

这些地址**不消耗任何配额**,也永远不会投递给真实收件人——在每次 CI 运行中调用都安全。搭建:

```bash
RESEND_LIVE_TEST=1 \
  RESEND_API_KEY=re_real_key \
  EMAIL_DOMAIN=your-verified-domain.com \
  INTEGRATION_DATABASE_URL=postgres://... \
  npm run test:integration
```

没有同时提供 `RESEND_API_KEY` 与 `EMAIL_DOMAIN` 时,harness 拒绝进入 live 模式;未设置 `RESEND_LIVE_TEST=1` 时,live 规格登记为 `skipped` 而不会运行。发信会带上 `[CUMORA-LIVE-TEST]` 主题前缀,方便在 Resend 控制台中识别。

live 测试能抓到、而 mock 模式抓不到的:

- 到 `api.resend.com` 的真实 HTTP 路径(TLS、请求头、响应解析)
- Resend 对 `From` / `Reply-To` / `In-Reply-To` / `References` / `attachments[]` 的校验
- 我们记录并持久化的 `provider_id` + `smtp_message_id` 的确切形状

它们抓不到的:端到端 MIME 投递(魔法地址并不真的投递)与退信/投诉处理(那些通过 webhook 异步触发,不在同一个请求里)。

## 本地开发(没有真实 DNS)

开发不需要真实域名。两条路:

- **Mock 模式**:把 `RESEND_API_KEY` 留空。`cumora email send` 会打日志并返回一个假 id。入站比较麻烦——没有好用的本地 Email Worker 模拟器。可用 `workers/email-gate/README.md` 里的 curl 配方来触发模拟入站投递。

- **隧道真实模式**:`cloudflared tunnel --url http://localhost:5181`,把 worker 的 `CUMORA_INBOUND_URL` 指向隧道,部署 worker。发往你测试域名的真实邮件就会打到你的笔记本。

## 智能体可用的命令

```
cumora email whoami                              # 你的地址
cumora email contacts                            # 你能写信给谁
cumora email inbox [--unread] [--limit N]        # 你的邮件线程
cumora email show <conversation_id>              # 完整线程
cumora email send --to <addr|id>[,...] [--cc ...] --subject "..." --body "..."
cumora email reply <message_id> --body "..." [--cc ...]
```

`--to` 与 `--cc` 既接受真实地址(`someone@example.com`),也接受参与者 id(`aurora`);id 会针对该智能体所属租户解析。

智能体 CLI 的邮件是纯文本。邮件命令会拒绝 `--attach`,而不是把一个运行时参数当作 Cumora 服务器上的路径来解释。未来的附件接口必须使用带租户与对象所有权校验的服务器托管对象引用;文件系统路径永远不会被当作上传引用。

## 心跳集成

`server/src/agents/idle.ts` 每个 `IDLE_INTERVAL_MS`(默认 15 分钟)运行一次。每次 tick 从每个租户挑选一个安静的智能体,通过正常的回合循环给它一个合成的空闲唤醒——调度器从不决定智能体该说什么。唤醒大脑之前,一个廉价的分类器会检查该智能体是否有可行动的看板卡片或当前时段的日历事件;若有,唤醒会附带一份聚焦的日程简报。无论哪种情况,该回合都可以使用完整 CLI,因此发送、回复或开启一个邮件线程,都是智能体可以自行决定采取的行动之一。

设置 `IDLE_INTERVAL_MS=0`(或 `ENABLE_IDLE=false`)可整体禁用心跳,而不必移除邮件功能。
