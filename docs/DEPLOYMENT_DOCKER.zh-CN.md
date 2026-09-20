# Cumora 单机 Docker 部署手册（不使用 Kubernetes）

本文说明如何在一台 Linux 服务器或局域网主机上，使用 Docker Compose 和仓库自带的 Dockerfile 一键部署 Cumora。该方案不安装、不连接 Kubernetes，智能体统一使用 BYOA（Bring Your Own Agent）Computer 运行。

相关文档：

- [组件、协议与数据库说明](COMPONENTS_PROTOCOLS_DATABASE.zh-CN.md)
- [BYOA 使用说明](BYOA.zh-CN.md)
- [通用部署说明](DEPLOYMENT.zh-CN.md)

## 1. 适用范围

本方案包含：

- Cumora Web SPA、REST API、WebSocket 和 Agent Runtime
- PostgreSQL 及 pgvector
- Redis
- 单机持久化附件
- 局域网中的人类与 Agent 私聊、群聊、看板、日历和协作文档
- 在局域网主机上运行的 BYOA Agent

本方案不包含：

- Kubernetes/GKE
- Cumora Cloud 托管 Agent Pod
- `/dev/fuse` 设备插件和 Agent PVC
- Cloudflare R2、邮件、移动推送等可选外部服务

> Compose 会构建 Dockerfile 的 `standalone` 目标，镜像中不包含 `kubectl`。同时还会关闭集群后台任务，并要求把所有 Agent 分配到 BYOA Computer。

## 2. 部署结构

```text
局域网浏览器
    │ HTTP/HTTPS + WebSocket
    ▼
cumora-server 容器 :5181
    ├── PostgreSQL 容器（业务数据）
    ├── Redis 容器（实时事件与短期协调）
    └── uploads Docker volume（本地附件）

局域网 BYOA 主机
    ├── cumora agent computer
    └── Claude Code / Codex / 其他受支持引擎
            │ HTTPS/HTTP + SSE
            └──────────────► cumora-server
```

PostgreSQL 是业务事实源。Redis 不保存可恢复的聊天事实；Redis 短暂不可用可能延迟实时刷新，但消息仍以 PostgreSQL 中的数据为准。

## 3. 前置要求

- 一台 Linux 主机，建议至少 2 CPU、4 GiB 内存和 20 GiB 可用磁盘
- [Docker Engine](https://docs.docker.com/engine/install/) 及 Docker Compose v2（命令为 `docker compose`）
- 能在构建时访问 npm registry 和 Debian 软件源；Compose 的 `standalone` 构建不访问 `dl.k8s.io`
- 一个可用的 OpenAI API key；当前 server 启动时强制要求 `OPENAI_API_KEY`
- 至少一种登录方式：Google、GitHub 或 GitLab OAuth
- 每台 BYOA 主机安装 Node.js 18 或更高版本，以及至少一个受支持的本地 Agent CLI

### 3.1 完全内网环境的认证限制

Cumora 当前没有用户名/密码登录，Web 登录只支持 OAuth：Google、GitHub、GitLab；iOS 另支持原生 Apple 登录。因此：

- 可以访问互联网时，可配置 Google 或 GitHub OAuth。
- 完全隔离的局域网建议配置自建 GitLab，并使用 `GITLAB_BASE_URL` 指向内网 GitLab。
- 没有任何 OAuth Provider 时，服务虽然能够启动，但普通用户无法从登录页面创建会话。
- 如果不希望部署 GitLab，需要先为 Cumora 增加本地身份认证，不能用开发种子用户替代生产登录。

“部署在局域网”不等于“完全离线运行”。当前 server 在启动时强制要求 `OPENAI_API_KEY`，头像、embedding 及部分辅助模型能力也会调用云端模型。BYOA 可以让 Agent 主回合在局域网主机执行，但不能自动把所有 server 侧模型调用变成本地调用。严格隔离、无法访问互联网的环境还需要改造认证与模型 Provider；不能只依靠本手册中的环境变量达到完整离线运行。

OAuth 回调必须和 Provider 中登记的地址完全一致：

```text
<CUMORA_PUBLIC_ORIGIN>/api/auth/callback/google
<CUMORA_PUBLIC_ORIGIN>/api/auth/callback/github
<CUMORA_PUBLIC_ORIGIN>/api/auth/callback/gitlab
```

## Docker Compose 一键部署（推荐）

仓库根目录已提供 [compose.yaml](../compose.yaml) 和 [.env.docker.example](../.env.docker.example)。Compose 会自动完成以下顺序：

```text
PostgreSQL/pgvector + Redis 健康
                  ↓
          migrate 迁移成功
                  ↓
       Cumora Server 启动并自检
```

首次部署只需准备一次配置：

```bash
cp .env.docker.example .env.docker
chmod 600 .env.docker
```

编辑 `.env.docker`，至少替换：

- `POSTGRES_PASSWORD` 以及 `DATABASE_URL` 中的同一密码；
- `OPENAI_API_KEY`；
- 通过 `openssl rand -hex 32` 生成的 `AGENT_RUNTIME_SECRET`；
- 实际的 `CUMORA_PUBLIC_ORIGIN` 和至少一组 OAuth 配置。

然后从仓库根目录执行一条命令：

```bash
docker compose up --build -d
```

该命令会构建 Dockerfile 的 `standalone` 目标、创建内部网络与持久卷、启动 PostgreSQL/Redis、执行数据库迁移，最后启动 Server。重复执行是安全的；迁移有版本记录并且具有幂等保护。

查看状态和验证服务：

```bash
docker compose ps -a
docker compose logs migrate
docker compose logs server --tail 100
curl -fsS http://127.0.0.1:5181/api/livez
curl -fsS http://127.0.0.1:5181/api/health
```

`migrate` 容器显示 `Exited (0)` 是正常现象，它是一次性任务。`server`、`postgres` 和 `redis` 应为运行/健康状态。

> 下面第 4–8 节保留了等价的 Docker CLI 拆分步骤，仅用于排障或定制；日常部署优先使用 Compose。

## 4. 手动准备目录与配置（仅排障/定制）

以下命令均在仓库根目录执行。

创建一个专用 Docker 网络和持久卷：

```bash
docker network create cumora-net
docker volume create cumora-postgres-data
docker volume create cumora-redis-data
docker volume create cumora-uploads
```

新建仅供部署主机读取的 `.env.docker`，并确保它不提交到 Git：

```dotenv
# ── 容器与核心服务 ────────────────────────────────────────────────
NODE_ENV=production
PORT=5181

# 密码中如果包含 @、:、/、# 等字符，必须在 DATABASE_URL 中进行 URL 编码。
POSTGRES_USER=cumora
POSTGRES_PASSWORD=CHANGE_THIS_DATABASE_PASSWORD
POSTGRES_DB=cumora
DATABASE_URL=postgres://cumora:CHANGE_THIS_DATABASE_PASSWORD@cumora-postgres:5432/cumora
REDIS_URL=redis://cumora-redis:6379

# 当前服务启动必需。
OPENAI_API_KEY=sk-REPLACE_ME

# 使用 `openssl rand -hex 32` 生成；生产模式禁止使用源码中的开发默认值。
AGENT_RUNTIME_SECRET=REPLACE_WITH_AT_LEAST_32_RANDOM_BYTES

# ── 明确关闭 Kubernetes 路径 ──────────────────────────────────────
ENABLE_AGENT_POD_GC=false
ENABLE_CHROME_PVC_GC=false
ENABLE_CLUSTER_MONITOR=false
WORKSPACE_RUNTIME_CLEANUP_ENABLED=false

# 可选：即使某个 Agent 被误配为 managed，也让 kubectl 调用立即失败，
# 而不是尝试寻找不存在的集群。
CUMORA_KUBECTL=/bin/false

# ── 浏览器访问地址 ─────────────────────────────────────────────────
# 替换成浏览器实际访问的内网域名或地址；三个值的 scheme/host/port 要一致。
CUMORA_PUBLIC_ORIGIN=http://cumora.lan:5181
CUMORA_AUTH_DONE_URL=http://cumora.lan:5181/
CUMORA_AUTH_RETURN_ALLOWLIST=http://cumora.lan:5181/
CUMORA_INVITE_BASE_URL=http://cumora.lan:5181

# 首次使用此邮箱登录后会成为平台管理员。
CUMORA_ADMIN_EMAILS=admin@example.lan

# ── 至少选择一种 OAuth ────────────────────────────────────────────
# Google
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# GitHub
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# 自建 GitLab，适合完全内网部署
GITLAB_BASE_URL=https://gitlab.example.lan
GITLAB_CLIENT_ID=
GITLAB_CLIENT_SECRET=

# ── 本方案不启用邮件和 R2 ─────────────────────────────────────────
RESEND_API_KEY=
EMAIL_DOMAIN=
EMAIL_INBOUND_HMAC_SECRET=
R2_ENDPOINT=
R2_BUCKET=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_PUBLIC_BASE=
R2_URL_SIGNING_SECRET=
```

同一个 `.env.docker` 同时传给 PostgreSQL 和 Cumora 容器。`POSTGRES_PASSWORD` 与 `DATABASE_URL` 中的密码不会自动互相展开，修改时必须保持一致。

保护配置文件：

```bash
chmod 600 .env.docker
```

## 5. 启动 PostgreSQL 和 Redis

数据库必须支持 pgvector。以下使用 pgvector 官方 PostgreSQL 16 镜像，并固定扩展/基础镜像版本，避免移动 tag 在重建时静默变化。可用 tag 以 [pgvector 官方安装说明](https://github.com/pgvector/pgvector#docker) 为准：

```bash
docker run -d \
  --name cumora-postgres \
  --restart unless-stopped \
  --network cumora-net \
  --env-file .env.docker \
  -v cumora-postgres-data:/var/lib/postgresql/data \
  --health-cmd='pg_isready -U cumora -d cumora' \
  --health-interval=10s \
  --health-timeout=5s \
  --health-retries=10 \
  pgvector/pgvector:0.8.6-pg16-bookworm
```

Redis 只加入内部 Docker 网络，不映射到宿主机端口：

```bash
docker run -d \
  --name cumora-redis \
  --restart unless-stopped \
  --network cumora-net \
  -v cumora-redis-data:/data \
  --health-cmd='redis-cli ping' \
  --health-interval=10s \
  --health-timeout=5s \
  --health-retries=10 \
  redis:7-alpine \
  redis-server --appendonly yes
```

确认两个基础服务正常：

```bash
docker ps --filter name=cumora-postgres --filter name=cumora-redis
docker logs cumora-postgres --tail 50
docker logs cumora-redis --tail 50
```

不要将 PostgreSQL `5432` 或 Redis `6379` 暴露到整个局域网。如果确实需要从宿主机管理，应只绑定到管理网地址或 `127.0.0.1`，并为 Redis增加认证。

## 6. 使用仓库 Dockerfile 构建镜像

从仓库根目录构建：

```bash
docker build \
  -f server/docker/cumora-server.Dockerfile \
  --target standalone \
  -t cumora-server:0.16.2 \
  .
```

该多阶段 Dockerfile 会：

1. 安装 server 运行依赖。
2. 编译 React/Vite SPA。
3. 构建最终 Node 20 runtime 镜像。
4. 将 SPA、API、WebSocket 和 `/runtime` 一起放入同一个镜像。

如需启用 PostHog，相关 `VITE_PUBLIC_*` 值必须作为 build args 传入，因为它们会编译进前端包；本地部署通常不需要配置。

检查镜像：

```bash
docker image inspect cumora-server:0.16.2
```

## 7. 执行数据库迁移

应用进程启动时只检查数据库版本，不会自动执行 DDL。首次部署和每次升级都必须先使用候选镜像单独运行迁移：

```bash
docker run --rm \
  --name cumora-migrate \
  --network cumora-net \
  --env-file .env.docker \
  cumora-server:0.16.2 \
  npm run migrate
```

成功日志应包含：

```text
[db] schema is current at version ...
```

如果出现 `extension "vector" is not available`，说明使用了不带 pgvector 的 PostgreSQL 镜像。如果出现权限错误，应确认 `POSTGRES_USER` 对目标数据库具有创建 extension、表和索引的权限。

## 8. 启动 Cumora Server

```bash
docker run -d \
  --name cumora-server \
  --restart unless-stopped \
  --network cumora-net \
  --env-file .env.docker \
  -p 5181:5181 \
  -v cumora-uploads:/app/server/uploads \
  cumora-server:0.16.2
```

查看启动日志：

```bash
docker logs -f cumora-server
```

验证进程和数据库：

```bash
curl -fsS http://127.0.0.1:5181/api/livez
curl -fsS http://127.0.0.1:5181/api/health
```

- `/api/livez` 返回成功，表示 Node 进程正在响应。
- `/api/health` 返回成功，表示数据库连接及服务健康检查通过。
- 浏览器访问 `http://cumora.lan:5181/`，应看到内置 SPA。

如果使用 `cumora.lan`，需要在局域网 DNS 中配置 A/AAAA 记录；临时测试也可以在每台客户端的 hosts 文件中指向 Docker 主机 IP。

## 9. 登录配置

### 9.1 Google/GitHub

在对应 Provider 创建 OAuth Application，将 callback 设置为：

```text
http://cumora.lan:5181/api/auth/callback/google
http://cumora.lan:5181/api/auth/callback/github
```

将 Client ID/Secret 写入 `.env.docker` 后，执行 `docker compose up -d` 重建容器以加载新环境变量。部分公网 OAuth Provider 会限制非 HTTPS 或私有域名回调；若 Provider 不接受内网地址，应使用受信任的 HTTPS 域名，或采用自建 GitLab。

### 9.2 自建 GitLab

在内网 GitLab 创建 OAuth Application：

```text
Redirect URI: http://cumora.lan:5181/api/auth/callback/gitlab
Scope: read_user
```

配置：

```dotenv
GITLAB_BASE_URL=https://gitlab.example.lan
GITLAB_CLIENT_ID=<application-id>
GITLAB_CLIENT_SECRET=<application-secret>
```

GitLab 是当前代码支持的完全内网 OAuth 入口。Cumora 会信任该 GitLab 返回的邮箱身份，因此必须由受信任的内部管理员控制。

## 10. 配置无 Kubernetes 的 BYOA Agent

本部署模式不运行 managed/cloud Agent。每个 Agent 必须分配给一个 `local` 或 `vps` 类型的 BYOA Computer。

1. 登录 Cumora。
2. 进入“我的/You → Computers → Add a computer”。
3. 复制配对命令中的 token。
4. 在要运行 Agent 的局域网机器上安装 Node.js 18+ 和受支持的 Agent CLI。
5. 执行：

```bash
npx --yes cumora@0.16.2 agent computer \
  --pair '<pair-token>' \
  --server http://cumora.lan:5181
```

后续启动不再需要配对 token：

```bash
npx --yes cumora@0.16.2 agent computer --server http://cumora.lan:5181
```

一个 daemon 可以承载同一工作区中的多个 Agent。服务商密钥和本地 CLI 登录凭据保留在 BYOA 主机上，不上传到 Cumora Server。

在 Agents 页面确认每个 Agent 的 Computer 都是刚配对的本地主机，不能选择 “Cumora Cloud”。如果 daemon 离线，消息会留在 PostgreSQL inbox 中，daemon 重连后继续处理。

命令固定了与 server 相同的 CLI 版本，避免 `npx` 自动取得不兼容的新版本。升级 server 时应同步替换这里的版本号。

完全隔离且不能访问 npm registry 时，可在一台有完整仓库依赖的构建机上执行：

```bash
npm ci
npm --prefix agent-cli run build
```

再把生成的、自包含的 `agent-cli/dist/cli.js` 复制到 BYOA 主机，通过 `node cli.js agent computer ...` 运行；server 与 daemon 应使用同一发布版本。

## 11. 局域网 HTTPS 与反向代理

即使只在局域网使用，也建议启用 HTTPS，因为 session token、runtime token 和聊天内容都会经过网络。反向代理必须支持：

- `/ws` 的 WebSocket Upgrade
- `/runtime/wake-stream` 和 Computer control stream 的长连接 SSE
- SSE 禁止代理缓冲
- 至少 34 MiB 的请求体上限，兼容本地 Base64 上传

反向代理后，应把以下地址统一改为浏览器看到的 HTTPS origin：

```dotenv
CUMORA_PUBLIC_ORIGIN=https://cumora.example.lan
CUMORA_AUTH_DONE_URL=https://cumora.example.lan/
CUMORA_AUTH_RETURN_ALLOWLIST=https://cumora.example.lan/
CUMORA_INVITE_BASE_URL=https://cumora.example.lan
```

同时将 OAuth Provider 中登记的 callback 改为 HTTPS。内部 CA 签发的证书需要安装到所有浏览器、BYOA 主机和反向代理所在系统的信任库。

## 12. 不启用邮件、R2 和 Kubernetes时的行为

### 12.1 邮件

`RESEND_API_KEY`、`EMAIL_DOMAIN`、`EMAIL_INBOUND_HMAC_SECRET` 留空后，真实外部邮件不可用。Agent 和人类之间的 Cumora 私聊/群聊不受影响，它们使用 PostgreSQL、Redis、REST、WS 和 SSE，不经过 SMTP。

### 12.2 附件

R2 配置留空后，附件保存在 Compose 的 `uploads` volume（实际卷名为 `cumora_uploads`）。该模式适用于一个 server 容器；不要启动多个 server 副本共享同一个普通 Docker volume，除非底层确实提供一致的共享文件系统。

### 12.3 Kubernetes

关闭集群任务后，启动日志不应周期性出现 Pod GC、PVC GC 或 cluster monitor 消息。若看到 `kubectl`/Pod 创建错误，检查：

- 环境变量是否实际传入新容器；
- Agent 是否被误分配到 Cumora Cloud；
- 用户 tier 是否被手工改为 pro/max 后又选择了 managed Computer；
- BYOA Computer 是否在线且 Agent 已分配到该 Computer。

## 13. 日常运维

### 13.1 查看状态与日志

```bash
docker compose ps -a
docker compose logs server --tail 200
docker compose logs postgres --tail 100
docker compose logs redis --tail 100
```

数据库事实健康与实时链路应分开判断：消息已写入但页面没有立即刷新时，先检查 PostgreSQL，再检查 `realtime_outbox`、Redis 和 WebSocket。

### 13.2 停止和启动

```bash
docker compose stop
docker compose start
```

Compose 会按健康检查和依赖条件恢复服务。配置或镜像变更后不要只执行 `start`，应重新执行 `docker compose up --build -d`。

删除容器但保留数据：

```bash
docker compose down
```

`docker compose down -v` 会同时删除 PostgreSQL、Redis 和附件卷，属于清空数据操作，日常运维不要使用。

### 13.3 PostgreSQL 备份

在宿主机创建自定义格式备份：

```bash
mkdir -p backups
docker compose exec -T postgres \
  pg_dump -U cumora -d cumora -Fc \
  > backups/cumora-$(date +%Y%m%d-%H%M%S).dump
```

同时备份附件 volume。可以将 volume 内容复制到一个备份目录：

```bash
docker run --rm \
  -v cumora_uploads:/source:ro \
  -v "$PWD/backups":/backup \
  alpine \
  tar -czf /backup/cumora-uploads.tar.gz -C /source .
```

Redis 不是业务事实源，但保留它的 volume 有助于恢复部分短期状态。正式恢复前应先停止 Cumora Server，恢复 PostgreSQL 和附件，再启动 Redis 与 Server。

### 13.4 容量观察

```bash
docker compose stats
docker system df
docker volume inspect cumora_postgres-data cumora_redis-data cumora_uploads
```

重点关注 PostgreSQL 数据、`llm_calls`、Agent 日志、文档增量和附件 volume。不要通过直接删除数据库文件释放空间，应使用应用已有的 GC、SQL 保留策略或经过验证的数据库维护流程。

## 14. 升级与回滚

升级前先备份 PostgreSQL 和附件，切换到目标代码后执行：

```bash
docker compose up --build -d
```

该命令会先构建新镜像、重新执行幂等迁移，只有迁移成功才会重建 Server。验证：

```bash
docker compose ps -a
docker compose logs migrate
curl -fsS http://127.0.0.1:5181/api/health
```

验证 `/api/livez`、`/api/health`、登录、消息发送、WS 更新和 BYOA Agent 回复。确认稳定后再删除旧容器。

数据库迁移不会随镜像回滚自动逆向撤销，而且应用会严格检查支持的 schema 版本。如果新迁移不兼容旧镜像，直接启动旧容器可能拒绝运行；此时只能按该版本的迁移策略处理，或从升级前备份恢复到独立数据库后切换。

## 15. 常见问题

### 服务启动后立即退出

检查：

```bash
docker compose logs server --tail 200
docker compose logs migrate --tail 200
```

常见原因包括缺少 `OPENAI_API_KEY`、生产环境仍使用默认 `AGENT_RUNTIME_SECRET`、数据库不可达或尚未执行迁移。

### `/api/livez` 正常但 `/api/health` 失败

Node 进程正常，但 PostgreSQL 不可用。检查 `DATABASE_URL`、Docker 网络、数据库健康状态和密码 URL 编码。

### 页面正常但无法登录

至少一个 OAuth Provider 未正确配置，或 callback/return URL 与 `CUMORA_PUBLIC_ORIGIN`、`CUMORA_AUTH_RETURN_ALLOWLIST` 不一致。完全离线环境还需确认自建 GitLab 可从 Cumora Server 和用户浏览器访问。

### 消息存在但 Agent 不回复

检查 BYOA daemon 是否在线、Agent 是否分配到该 Computer、主/快模型是否都健康，以及 daemon 是否能访问 `http(s)://cumora.lan[:port]`。无 K8s 模式下，managed/cloud Agent 不会自动运行。

### 附件重启后丢失

确认 server 容器始终挂载：

```text
uploads:/app/server/uploads
```

数据库只保存附件元数据和路径，不会把普通附件文件内容保存到 PostgreSQL。

## 16. 上线检查清单

- [ ] `.env.docker` 权限为 `600`，且未提交 Git
- [ ] 数据库密码和 `DATABASE_URL` 一致
- [ ] `AGENT_RUNTIME_SECRET` 使用高熵随机值
- [ ] PostgreSQL 与 Redis 未暴露到不受信任网络
- [ ] `npm run migrate` 成功
- [ ] `/api/livez` 与 `/api/health` 均正常
- [ ] 至少一个 OAuth Provider 可登录
- [ ] 管理员邮箱配置正确
- [ ] 四个 Kubernetes 相关开关已按本文关闭
- [ ] 所有 Agent 均分配到 BYOA Computer
- [ ] BYOA daemon 可以连接 server 并处理测试消息
- [ ] `uploads` volume 已纳入备份
- [ ] 已验证 PostgreSQL 备份可以恢复
- [ ] 正式局域网已启用可信 HTTPS
