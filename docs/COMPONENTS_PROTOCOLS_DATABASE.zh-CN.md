# Cumora 组件、数据协议与数据库说明

本文面向开发、联调和运维人员，按当前仓库实现梳理 Cumora 的主要组件、组件间协议、核心数据对象与 PostgreSQL 表。系统边界和关键链路可同时参考 [架构文档](ARCHITECTURE.zh-CN.md)，部署参数参考 [部署文档](DEPLOYMENT.zh-CN.md)。

> 文档基线：2026-09-15；应用版本见根目录 `package.json`。接口和数据库持续演进，发生冲突时以文末列出的代码事实源为准。

## 1. 总体组成

```mermaid
flowchart LR
  subgraph Client[客户端]
    React[React UI]
    Electron[Electron]
    Mobile[Capacitor iOS / Android]
  end

  subgraph Control[控制平面]
    API[Express REST API]
    WS[WebSocket 实时网关]
    Jobs[调度与后台任务]
    Runtime[/runtime 智能体接口]
  end

  subgraph RuntimePlane[智能体执行平面]
    Pod[Cloud Agent Pod]
    Daemon[BYOA Computer daemon]
    Fuse[agent-fuse]
  end

  React -->|HTTPS JSON| API
  React <-->|WSS JSON / Yjs Base64| WS
  Electron --> React
  Mobile --> React
  API --> PG[(PostgreSQL)]
  WS <-->|Pub/Sub| Redis[(Redis)]
  Jobs --> PG
  Jobs --> Redis
  Pod <-->|HTTP JSON + SSE| Runtime
  Daemon <-->|HTTPS JSON + SSE| Runtime
  Fuse <-->|HTTP JSON| Runtime
  Runtime --> PG
  Runtime --> Redis
  API --> R2[R2 / 本地对象存储]
  Email[email-gate] -->|HMAC JSON webhook| API
```

基本原则：PostgreSQL 是业务事实源；Redis 只承担实时扇出、唤醒和短期协调；普通客户端写操作走 REST，WebSocket 主要传递实时事件与协作文档更新；Cloud Agent 和 BYOA Agent 共用同一套服务端业务数据。

## 2. 组件职责

### 2.1 客户端与原生外壳

| 组件 | 目录/入口 | 功能 | 主要依赖 |
|---|---|---|---|
| React 应用入口 | `src/App.tsx`、`src/main.tsx` | 登录门禁、工作区切换、桌面/移动端分流、邀请、等待名单和管理员入口 | React、Zustand |
| 桌面视图 | `src/desktop/` | 会话、智能体、看板、日历、文档、Shipping、可观测性等主工作台 | 共享组件与 stores |
| 移动视图 | `src/mobile/` | 移动端聊天、会话、日历、智能体、资料库等适配界面 | Capacitor 能力、共享 stores |
| Web 外壳 | `src/web/` | 浏览器环境的顶层外壳 | Vite SPA |
| 管理后台 | `src/admin/` | 用户、等待名单、平台设置与全局 LLM 可观测性 | `/api/admin/*` |
| 通用组件 | `src/components/` | 消息、编辑器、投票、附件、成员选择、认证、通知等可复用 UI | Tiptap、React Markdown、Framer Motion |
| 状态层 | `src/stores/` | 会话、消息、参与者、看板、日历、文档、设备、偏好等前端状态 | Zustand、REST/WS 对账 |
| API 与协议类型 | `src/api/client.ts`、`src/types.ts` | REST 客户端、WS 客户端、领域 DTO 和枚举 | Bearer token、`x-company-id` |
| 文档协作客户端 | `src/lib/yjsClient.ts` | Y.Doc 订阅、增量更新、光标 awareness 和断线重连 | Yjs、WebSocket |
| Electron 外壳 | `electron/` | 桌面窗口、托盘、深链、自动更新、通知窗和预加载桥 | Electron |
| iOS/Android 外壳 | `ios/`、`android/`、`capacitor.config.ts` | 原生容器、推送、Apple 登录、触觉反馈和状态栏适配 | Capacitor |

前端不直接访问 PostgreSQL 或 Redis。各 store 从 REST 获取完整事实状态，再用 WS 事件增量刷新；断线重连后仍应重新拉取 REST，不能把 WS 当成可重放日志。

### 2.2 服务端控制平面

| 组件 | 目录/入口 | 功能 |
|---|---|---|
| 进程入口 | `server/src/index.ts` | 装配 HTTP、WS、SPA、runtime 路由，启动调度器、回收器和健康检查 |
| 业务 REST API | `server/src/api/router.ts` | 认证、工作区、参与者、消息、看板、日历、文档、邮件、上传、推送等接口 |
| 管理 API | `server/src/api/admin-router.ts` | 平台管理员设置、用户、等待名单和全局观测数据 |
| Shipping API | `server/src/api/shipping-router.ts` | 功能契约、不变量、验证、发布、回归和摩擦报告 |
| 实时网关 | `server/src/ws.ts` | WS 鉴权、租户过滤、Redis 事件扇出、文档房间协议和在线状态 |
| 数据库访问 | `server/src/db/` | pg 连接池、部分 Drizzle 映射、版本化迁移与启动兼容性检查 |
| 实时 outbox | `server/src/realtime-outbox.ts` | 在业务事务内记录实时事件，提交后以至少一次语义发布到 Redis |
| 文档房间 | `server/src/documents/rooms.ts` | Yjs update 持久化、快照压缩、跨实例更新和 awareness 转发 |
| 日历与投票 | `server/src/calendar.ts`、`server/src/polls.ts` | 周期事件派发、提醒、投票到期关闭和幂等控制 |
| 文件存储 | `server/src/storage.ts`、`server/src/local-attachment-files.ts` | R2 预签名上传/读取或本地开发存储 |
| 邮件 | `server/src/email.ts`、`server/src/api/inbound-email.ts` | Resend 出站、入站邮件落库、线程归并、附件与重试 |
| 推送 | `server/src/push.ts`、`server/src/fcm.ts` | APNs/FCM 设备注册和消息提醒 |
| 后台维护 | `server/src/*-gc.ts`、`workspace-cleanup.ts`、`trial-sweep.ts`、`shipping-maintenance.ts` | 数据保留、外部资源清理、试用降级和发布读回维护 |

### 2.3 智能体与执行平面

| 组件 | 目录/入口 | 功能 |
|---|---|---|
| 智能体调度器 | `server/src/agents/scheduler.ts`、`scanner.ts`、`idle.ts` | 消息唤醒、后台扫描、空闲议程和运行位置选择 |
| 云端回合执行 | `server/src/agents/turn.ts`、`agents/runtime/pod-agent.ts` | 上下文构建、模型多跳、工具执行、回复与成本记录 |
| 运行时 API | `server/src/agents/runtime/server.ts` | 向 Cloud Pod/BYOA 提供 inbox、上下文、CLI、状态、运行日志、SSE 唤醒等接口 |
| 运行时鉴权 | `server/src/agents/runtime/jwt.ts`、`authorization.ts` | HS256 runtime JWT；绑定 agent、tenant、Computer 和运行分配代次 |
| 云端编排 | `server/src/agents/runtime/orchestrator.ts` | Kubernetes Pod、FUSE、Chromium profile PVC 和回收流程 |
| BYOA 守护进程 | `agent-cli/`、`server/src/agents/computer/daemon.ts` | 设备配对、引擎发现、本地模型会话、唤醒消费、心跳与版本上报 |
| 引擎适配器 | `server/src/agents/computer/engine.ts` | Claude、Codex、Grok、Cursor、OpenCode、pi、Gemini、Qwen、Antigravity 等 CLI 协议适配 |
| Agent CLI 语义层 | `server/src/agents/cli.ts`、`agent-cli/src/cli.ts` | `cumora` 命令解析和服务端动作；运行时身份由 JWT 固定，不能由调用者冒充 |
| Agent FUSE | `agent-fuse/main.go` | 把 `agent_workspace` 中的文件映射为 Pod 内 `/workspace`，自身不持有数据库凭据 |
| 协作防冲突 | `seen-boundary.ts`、`thinking-convos.ts`、`inbox-triage.ts`、`triage-core.ts` | 已读边界、回复新鲜度、工作认领、小脑分诊和并发抑制 |
| 记忆与技能 | `memory-write.ts`、`memory-scope.ts`、`embeddings.ts`、`skills.ts` | 文件化记忆、语义检索、技能装载与提示词注入 |
| 可观测性与成本 | `observability.ts`、`llm-ledger.ts`、`llm-rollup.ts`、`cost.ts` | run/event/call 级记录、成本核算和小时聚合 |

Cloud Pod 与 BYOA daemon 都不直连业务数据库。Cloud Pod 通过 `/runtime/*` 回到服务器；BYOA daemon 也只通过 HTTPS/SSE 与服务器交互，服务商凭据保留在用户设备上。

### 2.4 边缘、网站与部署组件

| 组件 | 目录 | 功能 |
|---|---|---|
| Email Gate | `workers/email-gate/` | 接收 Cloudflare Email Routing 邮件，解析 MIME，构造并签名入站 webhook |
| R2 Gate | `workers/r2-gate/` | 读取 R2 对象；`attachments/` 校验过期时间和 HMAC 签名，头像公开缓存 |
| 营销网站 | `website/` | `cumora.ai` 静态站点和隐私页面 |
| Kubernetes | `server/k8s/` | Cumora Server、服务账户、运行参数和云端 Agent 相关部署清单 |
| 基准测试 | `benchmarks/` | 多智能体接龙、计数、狼人杀、看板等端到端行为基准 |

## 3. 数据协议

### 3.1 通用约定

| 项目 | 约定 |
|---|---|
| 编码 | REST、WS 和 SSE 的业务负载使用 UTF-8 JSON；Yjs 二进制放在 JSON 的 Base64 字段中 |
| 时间 | API 使用 ISO 8601 字符串；SSE/握手事件中的 `at`、`ts` 使用 Unix 毫秒；数据库使用 `TIMESTAMP WITH TIME ZONE` |
| ID | 业务实体大多使用不透明 `TEXT` ID；不要从 ID 推导租户或类型 |
| 租户 | 用户 API 通过 `x-company-id` 选择工作区，服务端仍会查询 `company_members`；事件必须携带 `companyId` 才会被 WS 扇出 |
| 错误 | REST 通常返回 `{ "error": "..." }` 并使用 4xx/5xx；客户端的 `ApiError` 同时保留 HTTP 状态码 |
| 大小限制 | 普通 `/api` 与 `/runtime` JSON 为 256 KiB/4 MiB；Base64 上传为 34 MiB；入站邮件 webhook 为 25 MiB；单个 WS 入站帧最大 4 MiB |
| 幂等 | 消息用 `clientId`；Agent、看板、日历、文档创建可用 `requestId`，服务端同时保存请求哈希以拒绝同 key 异 payload |

### 3.2 用户 REST API

- 基础路径：`/api`。
- 鉴权：`Authorization: Bearer <session-token>`；OAuth 起始/回调、健康检查和部分公开配置属于公开接口。
- 工作区接口还需 `x-company-id: <company-id>`；该头只负责选择租户，不授予权限。
- 普通请求和响应为 `application/json`。上传在 R2 模式下先请求预签名 URL，再由客户端直接 PUT 对象；本地开发模式可向服务器提交 Base64。

接口按领域分组如下；表中列的是协议入口，不替代逐路由实现。

| 领域 | 代表性路由 | 主要负载/结果 |
|---|---|---|
| 健康与公开配置 | `GET /livez`、`GET /health`、`GET /public/signup-config` | 进程存活、数据库健康、注册开关 |
| OAuth 与会话 | `/auth/providers`、`/auth/start/:provider`、`/auth/callback/:provider`、`POST /auth/logout`、`GET /auth/me` | 用户、session token、可用工作区 |
| 工作区与成员 | `/companies`、`/companies/:id/members`、`/companies/:id/invitations` | Company、成员角色、邀请令牌 |
| Agent 与 Computer | `/participants`、`/agents`、`/computers`、`/agents/:id/runtime-token` | 参与者人设、模型/引擎配置、运行位置、设备状态 |
| 项目 | `/projects`、`/conversations/:id/project` | 项目元数据和会话归属 |
| 会话与消息 | `/conversations`、`/conversations/:id/messages`、`/messages/:id/reactions` | Conversation、Message、引用回复、附件、反应、已读/静音/输入状态 |
| 投票 | `POST /polls`、`POST /polls/:messageId/vote|close` | PollPayload、选项 tally、关闭原因 |
| 邮件 | `/email/send`、`/email/reply/:messageId`、`/email/:messageId/html` | 邮件头、正文、线程、传输状态与附件 |
| 搜索与旁观 | `GET /search`、`GET /peek/agent-chats` | 按租户过滤的跨实体搜索和 owner 监督视图 |
| Convene | `/conversations/:id/convene`、`/convene/:sessionId/transcript` | 实时会议状态与顺序化 transcript |
| 看板 | `/boards`、`/boards/:id/columns`、`/boards/:id/cards` | BoardSnapshot、列、卡片、评论和 @mention |
| 日历 | `/calendar/events`、`/calendar/events/:id/run-now`、`.../dispatches` | CalendarEvent、RecurrenceRule、派发结果和提醒 |
| 文档 | `/documents`、`/documents/:id` | 文档元数据；正文通过 WS/Yjs 协议同步 |
| 上传与推送 | `/uploads/*`、`/push/register|unregister` | 存储能力、预签名 URL、设备 token |
| 可观测性 | `/agents/observability/*` | run、event、triage、wake、LLM spend |
| Shipping | `/shipping/features`、`/shipping/friction` 等 | 功能契约、验证、发布、回归和证据 |
| 平台管理 | `/admin/users`、`/admin/waitlist`、`/admin/settings`、`/admin/observability/llm` | 仅 `users.is_admin` 可访问的平台级数据 |

### 3.3 WebSocket 协议

连接流程：

1. 客户端携带 session Bearer token 调用 `POST /api/auth/ws-ticket`。
2. 服务端返回一个 60 秒有效、仅可使用一次、数据库中只保存哈希的 ticket。
3. 客户端连接 `wss://<host>/ws?t=<ticket>`。
4. 服务端返回 `hello`，随后按用户的工作区成员关系过滤并推送事件。

普通聊天写入仍走 REST。WS 的服务端事件主要包括：

| `type` | 关键字段 | 语义 |
|---|---|---|
| `hello` | `instanceId`, `ts` | 连接/重连完成，可重新发送文档订阅和 awareness |
| `message.new` | `conversationId`, `message` | 已持久化的新消息 |
| `message.delta` | `messageId`, `delta`, `sequence`, `done` | 智能体流式回复片段；`done=true` 表示结束 |
| `typing` | `conversationId`, `agentId`, `done` | 临时输入状态 |
| `participants.status` / `participants.avatar` / `participants.added` | participant 字段 | 名册状态变化 |
| `computers.status` | `computerId`, `status` | BYOA/云端运行主机状态变化 |
| `message.reactions` / `poll.updated` | `messageId`, 聚合结果 | 反应和投票快照更新 |
| `conversation.updated` / `group.pulled` / `convene` | 会话或 session ID | 会话元数据、拉群、会议变更 |
| `board.changed` | `kind`, `boardId`, 可选实体 ID | 看板粗粒度失效通知，客户端可据此重拉 |
| `doc.changed` / `doc.mention` | document 字段 | 文档索引变更和 @mention 通知 |
| `calendar.changed` / `calendar.reminder` | event 字段 | 日历失效通知与定向提醒 |
| `workspace.membership` | `kind`, `recipientUserIds` | 角色变化、成员移除或工作区删除 |

文档协作是 WS 上的双向子协议：

```json
{ "type": "doc.subscribe", "documentId": "doc-id" }
{ "type": "doc.sync", "documentId": "doc-id", "stateB64": "...", "originId": "..." }
{ "type": "doc.update", "documentId": "doc-id", "updateB64": "...", "originId": "..." }
{ "type": "doc.awareness", "documentId": "doc-id", "updateB64": "...", "originId": "..." }
{ "type": "doc.unsubscribe", "documentId": "doc-id" }
```

`doc.update` 会写入 PostgreSQL；`doc.awareness` 只实时转发、不持久化。客户端必须先订阅后才能发送更新。`originId` 用于抑制发送端回声，不能作为用户身份或授权依据。

### 3.4 Agent Runtime HTTP/SSE 协议

- 基础路径：`/runtime`。
- 鉴权：`Authorization: Bearer <runtime-jwt>`。
- JWT 固定包含 `sub`（agent ID）、`companyId`、`computerId`、`assignmentId`、`scope=agent-runner`、`iat`、`exp`，默认有效期一小时。
- 服务端除验签和过期时间外，还会查询当前 participant、Computer 和 `runtime_assignment_id`；Agent 被移机、离职或 Computer 被撤销后，旧 token 立即失效。

| 分组 | 路由 | 功能 |
|---|---|---|
| 唤醒 | `GET /runtime/wake-stream` | `text/event-stream`；推送 `wake` 或 `steer` 事件，注释帧作为 keepalive |
| 收件箱与上下文 | `/inbox`、`/inbox-triage/payload`、`/context`、`/persona`、`/roster`、`/agenda` | 构造回合所需的事实输入 |
| 动作 | `POST /cli` | 请求 `{argv: string[]}`，响应 `{text, exitCode, ok, sideEffects}`；服务端覆盖调用者身份 |
| 生命周期 | `/status`、`/status/heartbeat`、`/busy/*`、`/thinking/*` | Agent 在线/忙碌租约、回合思考和过期清理 |
| 观测 | `/runs`、`/events`、`/triage`、`/llm-calls`、`/runs/:id/*` | 运行、事件、模型调用和成本记录 |
| 协作 | `/worklog/claim|release|peek`、`/conversation/mark-read` | 原子工作认领与已读边界 |
| 工作区文件 | `/fs/list|read|write|unlink|stat` | JWT 固定 Agent 的文本文件系统；路径拒绝绝对路径、`..` 和 NUL |

SSE wake 数据的公共信封为 `{id, at, kind, ...}`：

- `kind=\"wake\"`：含 `reason=message.new|idle|manual|background_scan|poll.updated`，消费者随后从持久 inbox 拉取事实状态。
- `kind=\"steer\"`：含 `conversationId`、`messageId`、`authorName`、`body`，用于在正在运行的回合中安全插入新消息。

BYOA Computer 另有 `GET /api/computers/me/control-stream`，当前控制事件为 `engine.detect`；数据库中的 `detect_requested_at` 是断流后的持久兜底。

### 3.5 Redis 内部事件协议

Redis channel 包括 `cumora:msg.new`、`msg.delta`、`typing`、`status`、`reactions`、`polls`、`group.pulled`、`convo.updated`、`convene`、`boards`、`docs`、`doc.update`、`doc.awareness`、`doc.mention`、`calendar.*`、`workspaces`，以及按 Agent/Computer 分片的 wake/control channel。

除文档房间专用事件外，所有可向客户端扇出的事件都必须携带 `companyId`；缺少租户标签的事件会被丢弃。`realtime_outbox` 的投递为至少一次，因此事件可重复，消费者应按实体 ID、`deliveryId` 或重新拉取事实状态实现幂等。

### 3.6 邮件与对象存储协议

- 入站邮件：`email-gate` 解析 MIME 后调用 `POST /webhooks/email/inbound`，头为 `x-cumora-signature: sha256=<hex>`；签名内容是原始 JSON bytes，算法为 HMAC-SHA256。
- 入站附件：单附件原始数据上限 10 MiB，总原始数据上限 18 MiB；超限附件仅传元数据并标记 `truncated=true`。
- R2 读取：`attachments/` 使用 `?exp=<unix-seconds>&sig=<hex>`，签名明文为 `<key>:<exp>`，最长有效期 24 小时；头像路径无需签名。
- 邮件附件目前使用 `email-attachments/` 前缀，而 `r2-gate` 当前只强制校验 `attachments/`。因此不能把邮件附件 URL 视为已由该 Worker 强制签名保护。

## 4. 核心领域数据对象

| 对象 | 关键字段/取值 | 说明 |
|---|---|---|
| Participant | `kind=human|agent`；`status=avail|working|thinking|waiting|resting` | 人和 Agent 共用名册；展示角色 `participants.role` 不等于工作区权限角色 |
| Computer | `kind=cloud|local|vps`；`status=online|offline|busy` | Agent 的运行主机；引擎可为 managed、Claude、Codex 等 |
| Conversation | API `kind=group|direct|whisper|email` | `whisper` 是客户端监督/旁观语义；成员授权以 `conversation_members` 为准 |
| Message | `kind=text|tool|attachment|whisper-link|thought|system|email|poll` | `sequence` 在会话内递增；可带引用、反应、附件、邮件或投票扩展 |
| PollPayload | `mode=single|multi`、`options[]`、`expiresAt`、`closedAt` | 结构存在 `messages.poll`，票记录单独规范化 |
| RecurrenceRule | `freq=daily|weekly|monthly|yearly`、`interval`、可选 `byweekday/until/count` | 日历自有的窄 recurrence 协议，不是通用 RRULE |
| BoardSnapshot | board + `columns[]` + `cards[]` | 列和卡片用浮点 `position` 支持中间插入 |
| Document | 元数据 + Yjs state | 元数据走 REST，正文走 WS/Yjs；快照和增量分开保存 |
| ShippingFeature | 状态、优先级、风险、builder、关联项目/会话/文档/卡片 | 以功能契约为根，串联不变量、独立验证和发布证据 |

## 5. PostgreSQL 数据模型

### 5.1 数据库约定

- 当前迁移版本为 6，记录在 `schema_migrations`。应用启动只读校验版本和 checksum，不执行 DDL；DDL 由 `npm run migrate` 独立执行。
- `server/src/db/schema.ts` 只是部分 Drizzle 映射，不是完整数据库字典。完整事实源是 `server/src/db/migrate.ts` 与 `server/src/db/migrations/`。
- 多租户实体通常带 `company_id`。代码查询必须显式带租户条件；不要仅凭全局看似唯一的业务 ID 假设租户隔离。
- 正式的会话成员关系在 `conversation_members`；`conversations.members` 仅是兼容投影，由数据库函数/触发器同步。
- 大量 `JSONB` 用于开放式载荷、快照或小型数组；需参与约束、去重或高频查询的关系会拆为独立表。
- 外键删除策略以业务归属为准：子实体多为 `ON DELETE CASCADE`；需要保留历史但允许目标消失的引用多为 `ON DELETE SET NULL` 或软引用。
- `agent_workspace.embedding` 使用 pgvector `vector(1536)`；搜索迁移启用 `pg_trgm`。

### 5.2 身份、租户与权限

| 表 | 主键/关键关系 | 功能与关键字段 |
|---|---|---|
| `users` | `id`；email 唯一 | 平台用户、OAuth 展示资料、tier/sub2api、管理员、暂停和软删除状态 |
| `user_identities` | `(provider, provider_id)` → users | Google/GitHub/GitLab/Apple 等 OAuth 身份映射 |
| `sessions` | `token_hash` → users | 可撤销登录会话；只保存原始 token 的 SHA-256 哈希、有效期和客户端信息 |
| `ws_tickets` | `token_hash` → users | 60 秒、一次性 WS 连接票据，消费后写 `used_at` |
| `companies` | `id`；`slug` 唯一 | 工作区、owner、配对 token、默认 Agent/DM/all-hands 初始化标记 |
| `company_members` | `(company_id, user_id)` → companies | 工作区成员及 `owner|admin|member` 权限角色 |
| `company_invitations` | `token_hash` → companies | 邀请角色、可选邮箱限制、有效期、次数、撤销和最后接受者 |
| `participants` | `(id, company_id)` | 租户内统一的人/Agent 名册；人设、状态、邮箱、模型、Computer、引擎、离职和 runtime assignment |
| `user_preferences` | 用户/租户维度 | JSONB 用户偏好；注意历史 schema 的主键演进，以迁移结果为准 |
| `app_settings` | `key` | 全局 JSONB 设置，如 waitlist 和暂停注册 |
| `waitlist` | `id`；`(provider, provider_id)` 唯一 | 新 OAuth 用户的等待名单及审批状态 |
| `auth_attempts` | `BIGSERIAL id` | 登录限流与锁定判断所需的成功/失败记录 |
| `audit_events` | `BIGSERIAL id` | 登录、注册、工作区创建等安全相关审计事件 |
| `push_devices` | `id`；`(platform, token)` 唯一 → users | APNs/FCM/Web push token、设备元数据和禁用时间 |

### 5.3 会话、消息、会议与投票

| 表 | 主键/关键关系 | 功能与关键字段 |
|---|---|---|
| `conversations` | `id`；可关联 company/project | 会话类型、标题、主题、兼容成员投影、置顶、标签和拉群信息 |
| `conversation_members` | `(conversation_id, participant_id)`；复合租户外键 | 权威会话成员关系和稳定 `ordinal` |
| `conversation_counters` | `conversation_id` → conversations | 原子分配下一条消息 `sequence` |
| `messages` | `id` → conversations | 消息正文、kind、sequence、引用、附件/tool/poll JSONB、幂等 `client_id`、离场定向投递 |
| `message_reactions` | `(message_id, user_id, emoji)` → messages | 每个用户对消息的反应明细 |
| `conversation_reads` | `(user_id, conversation_id)` | 已读时间与同时间戳消息 ID 游标 |
| `conversation_mutes` | `(user_id, conversation_id)` | 永久或截止时间静音；静音不等于已读 |
| `convening_info` | `conversation_id` → conversations | Agent 主动拉群时的依据、诉求、证据、推理和状态 |
| `convene_sessions` | `id` → conversations | 实时 Convene 会话的开始/结束和状态 |
| `convene_transcript` | `id` → convene_sessions | 按 `sequence` 排序的发言、思考、工具和决策记录 |
| `poll_votes` | `(message_id, voter_participant_id, option_id)` → messages | 单选/多选投票明细；投票定义本身在 `messages.poll` |

### 5.4 Agent、运行时与可观测性

| 表 | 主键/关键关系 | 功能与关键字段 |
|---|---|---|
| `computers` | `id` | Cloud/BYOA 主机、所有者、设备凭据哈希、引擎清单、检测请求、心跳、版本和撤销状态 |
| `agent_workspace` | `(agent_id, path)` | Agent 文件系统；正文、meta、更新时间及可选语义向量；新记忆也以 `memory/` 文件存放 |
| `agent_memory` | `id` | 旧版结构化记忆表，已回填到 `agent_workspace`，仍保留用于兼容/历史数据 |
| `agent_climate` | `(agent_id, about_id)` | Agent 对成员的 affinity、trust、最近备注和历史 |
| `agent_log` | `id` | Agent 活动日志；kind、正文和关联 ID |
| `agent_tasks` | `id` | Agent 私有任务、状态、截止时间和引用 |
| `agent_autonomy` | `(user_id, agent_id)` | 自主拉群阈值及 pulled/led/dissolved 统计 |
| `agent_runs` | `id` | 一次 Agent 回合的触发、状态、阶段、输入消息、token、成本和耗时聚合 |
| `agent_events` | `id` → agent_runs | 回合内按时间追加的 debug/info/warn/error 事件 |
| `agent_triages` | `id` | 小模型分诊的 actionable 结论、原因、token、成本、来源和关联 run |
| `tool_calls` | `id`；可关联 message/run | 工具名称、参数、结果、状态、错误和耗时 |
| `llm_calls` | `id` | 每次模型调用的用途、来源、模型、token 分类、成本、状态、耗时和 daemon 版本 |
| `llm_calls_rollup` | 小时+租户+Agent+用途+模型+来源+版本唯一 | 可观测性页面使用的小时级预聚合 |

### 5.5 项目、看板、日历与文档

| 表 | 主键/关键关系 | 功能与关键字段 |
|---|---|---|
| `projects` | `id` → companies | 项目名称、说明、颜色和 active/archived 状态 |
| `boards` | `id` → companies | 看板元数据和创建幂等字段 |
| `board_columns` | `id` → boards | 列标题、顺序和语义 `kind=todo|doing|done|null` |
| `board_cards` | `id` → board/column | 卡片、位置、assignee、mentions 和作者 |
| `board_card_comments` | `id` → board_cards | 卡片评论及 mentions |
| `board_mention_reads` | `user_id` | 看板 @mention 的最近读取时间 |
| `calendar_events` | `id` → companies；可关联 conversation | personal/agent_task、时间、recurrence、assignee、提醒、隐私和创建幂等字段 |
| `calendar_dispatches` | `id` → calendar_events；`(event_id, scheduled_for)` 唯一 | 每个实际触发时隙的派发、目标消息和错误 |
| `calendar_reminders` | `id` → calendar_events；`(event_id, scheduled_for)` 唯一 | 每个 occurrence 的提醒渠道、收件人和结果 |
| `documents` | `id`；可关联 conversation | 文档元数据和创建幂等字段 |
| `document_updates` | `BIGSERIAL id` → documents | 追加式 Yjs 二进制更新日志和 author |
| `document_snapshots` | `document_id` → documents | 合并后的 Yjs state 与已覆盖的最大 update ID |
| `document_mentions` | `id` → documents | 文档 @mention 的追加式通知/审计记录 |

### 5.6 邮件与附件

| 表 | 主键/关键关系 | 功能与关键字段 |
|---|---|---|
| `email_messages` | `message_id` → messages，一对一 | in/out 方向、传输状态、RFC Message-ID、回复链、地址、HTML、自动邮件标记和重试状态 |
| `email_attachments` | `id` → messages/conversations | 文件名、MIME、大小、对象存储 key 和截断标记 |
| `email_contacts` | `(company_id, address)` | 外部联系人的最近名称、消息数和最后出现时间 |

### 5.7 Shipping 交付域

| 表 | 主键/关键关系 | 功能与关键字段 |
|---|---|---|
| `shipping_features` | `id` → company；可关联 project/conversation/document/card | 功能问题、目标、契约、状态、优先级、风险、builder 和发布目标 |
| `shipping_invariants` | `id` → feature | behavior/architecture/data/security 等必须保持的性质 |
| `shipping_verifications` | `id` → feature；可关联 invariant | 验证方法、owner、独立验证者、证据、状态和截止时间 |
| `shipping_releases` | `id` → feature | 环境、版本/commit、审批、回滚、smoke、读回状态和证据 |
| `shipping_friction_reports` | `id` → company；可关联 feature/conversation | 摩擦问题、严重度、频率、证据、次数和处理状态 |
| `shipping_regressions` | `id` → feature；可关联 invariant/verification | 自动/基准/人工回放/监控型回归项和最近结果 |
| `shipping_events` | `id` → company/feature | 不可变更的追加式交付审计与证据时间线 |

### 5.8 基础设施与可靠性

| 表 | 主键/关键关系 | 功能与关键字段 |
|---|---|---|
| `realtime_outbox` | `id` | 事务性实时事件；channel、payload、租约、重试、发布/丢弃时间 |
| `workspace_cleanup_jobs` | `id`；刻意不设 company 外键 | 工作区删除后的对象存储、Agent 和运行资源清理；支持崩溃后重试 |
| `schema_migrations` | `version`；name 唯一 | 不可变迁移账本、checksum、耗时和应用时间 |

历史迁移中创建后又删除的 `email_verification_tokens`、`password_reset_tokens`，以及已移除的 mock 表 `notion_pages`、`github_branches` 不属于当前有效数据模型。迁移 0002 使用的 archive 表也是迁移过程临时产物，不应被业务代码依赖。

## 6. 关键关系与一致性边界

1. `companies` 是租户根；`company_members` 决定人类权限，`participants` 是租户内业务名册。
2. `conversation_members` 决定谁能读取/写入会话；`messages.company_id` 与 conversation tenant 必须一致。
3. 消息序号由 `conversation_counters` 的行锁串行分配；`(conversation_id, author_id, client_id)` 防止网络重试产生重复消息。
4. 看板、日历、文档等持久写入与 `realtime_outbox` 同事务提交；Redis 发布失败不会回滚业务事实，worker 会重试。
5. 日历派发和提醒都以 `(event_id, scheduled_for)` 唯一约束去重，适应多副本调度和崩溃重试。
6. 文档冷启动读取最近 snapshot，再重放 `snapshot_at_update_id` 之后的 updates；awareness 不参与恢复。
7. Runtime 授权以数据库中的当前 assignment 为准，不只相信 JWT 中的签名快照。
8. 删除工作区时，数据库事务先记录 `workspace_cleanup_jobs`，再由后台任务清理数据库之外的资源。

## 7. 代码事实源与维护规则

| 内容 | 事实源 |
|---|---|
| REST 路由与权限 | `server/src/api/router.ts`、`admin-router.ts`、`shipping-router.ts`、`inbound-email.ts` |
| 客户端 DTO 与 WS 联合类型 | `src/api/client.ts`、`src/types.ts` |
| WS/Redis 事件 | `server/src/ws.ts`、`server/src/redis.ts` |
| Runtime HTTP/SSE | `server/src/agents/runtime/server.ts`、`wake-bus.ts`、`jwt.ts` |
| 数据库完整结构 | `server/src/db/migrate.ts`、`server/src/db/migrations/manifest.ts`、`server/src/db/migrations/*.ts` |
| 部分 Drizzle 类型 | `server/src/db/schema.ts` |
| BYOA 行为 | `agent-cli/`、`server/src/agents/computer/`、[BYOA 文档](BYOA.zh-CN.md) |

新增或修改协议时应同步更新服务端类型、客户端 DTO/联合类型和本文件；新增数据库结构必须追加版本化迁移，不能修改已经发布迁移的 SQL 或 checksum。新增租户数据表时，应同时检查租户过滤、删除清理、备份恢复、GC、实时事件和测试数据清理路径。
