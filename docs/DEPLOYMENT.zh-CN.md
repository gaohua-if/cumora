# 部署文档：本地与生产

本文是当前仓库的部署入口，具体生产资源创建命令见 [`server/k8s/gke.md`](../server/k8s/gke.md)，发布操作见 [发布手册](RELEASE.zh-CN.md)。组件职责、角色、协议和数据流见 [架构文档](ARCHITECTURE.zh-CN.md)。

## 部署单元

| 单元 | 运行位置 | 依赖及职责 |
|---|---|---|
| Web / Electron / 移动客户端 | 浏览器或终端；生产 Web SPA 内置于 server 镜像 | 访问同一 Cumora API/WS。`website/` 是独立营销网站，不是业务 SPA。 |
| `cumora-server` | 本地 Node 或 GKE Deployment（清单默认 2 副本） | 提供 `/api`、`/ws`、`/runtime`、SPA；连接 PostgreSQL/Redis，运行调度与后台任务，通过 `kubectl` 管理云端智能体 Pod。GKE Pod 同容器组有 Cloud SQL Auth Proxy。 |
| `cumora-agent-computer` | GKE 按智能体创建的 Pod | 运行模型/工具循环及 `cumora-fuse`；通过 `/runtime/*` 与服务器通信，按需退出；Chromium profile 使用按智能体 PVC。 |
| BYOA Computer | 操作者自己的 Mac / Linux / Windows 主机 | 用 `npx cumora agent computer` 配对；本地引擎使用操作者的服务商凭据。可与云端 Pod 并存，不需要部署者替用户保存这些凭据。 |
| PostgreSQL / Redis | 本机服务或 Cloud SQL / Memorystore | PostgreSQL 存事实与迁移；Redis 供实时通知、唤醒及短期状态。 |
| Cloudflare Workers、R2、Resend、APNs/FCM | 外部可选服务 | 邮件、对象存储/CDN、移动推送；未配置时相应功能降级或禁用。 |

生产公共入口的 DNS、证书、Ingress/负载均衡配置不在 [`cumora-server.gke.yaml`](../server/k8s/cumora-server.gke.yaml) 中；该清单只创建集群内 `Service:5181`。需要让 `app.cumora.ai` 与 `api.cumora.ai` 到达同一服务，并让边缘支持 WebSocket 升级和长连接 SSE。`api.*` 只返回 API/运行时内容，业务 SPA 从 `app.*` 提供。营销网站走独立 `website` 工作流。

## 本地开发

需要 Node/npm、PostgreSQL、Redis。先创建数据库并提供可用的模型服务凭据；如使用向量能力，数据库还需支持 pgvector。开发默认数据库为 `postgres://$USER@localhost:5432/cumora`，Redis 为 `redis://localhost:6379`。

```bash
createdb -h localhost cumora
export OPENAI_API_KEY=sk-...
npm run setup
npm run dev:all
```

`dev:all` 先运行 `npm run migrate`，再启动 Vite `:5180` 与 API `:5181`。打开 `http://localhost:5180`；桌面开发可用 `npm run electron:dev`。单独启动后端前也应先执行 `npm run migrate`。本地未配置 R2 时附件落在 `server/uploads/`；此模式不适合多副本生产。

## 首次生产部署

1. 按 [`server/k8s/gke.md`](../server/k8s/gke.md) 准备 GKE、Artifact Registry、Cloud SQL（含 pgvector）、Memorystore、Workload Identity、Kubernetes ServiceAccount/RBAC 和 `/dev/fuse` 设备插件。确认 server 能在目标 namespace 管理智能体 Pod 与 PVC，节点有足够 FUSE/CPU/内存容量。
2. 准备 `cumora` Kubernetes Secret，至少包括 `DATABASE_URL`、`REDIS_URL`、`OPENAI_API_KEY`、高熵 `AGENT_RUNTIME_SECRET`。`NODE_ENV=production` 时，运行时密钥仍为源码开发默认值会拒绝启动。生产建议配置 R2 四个核心变量（`R2_ENDPOINT`、`R2_BUCKET`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`）及 `R2_PUBLIC_BASE`/`R2_URL_SIGNING_SECRET`；按需配置 OAuth、邮件、推送等。完整变量与默认值以 [`env.ts`](../server/src/env.ts) 为准。
3. 让 `AGENT_RUNTIME_SERVER_URL` 指向目标 namespace 的集群内 `/runtime`，并使 `CUMORA_AGENT_COMPUTER_IMAGE` 与 server 的运行时协议版本兼容。`CUMORA_AGENT_NAMESPACE`、对应 RoleBinding、镜像拉取权限和可用的 PVC StorageClass 必须一致。BYOA 使用面向公网的 HTTPS API origin，不使用该集群内地址。
4. 配置公共域名/TLS 与外部可选服务。邮件需共享 `EMAIL_INBOUND_HMAC_SECRET` 给 server 和 `email-gate`；R2 签名读取需共享 `R2_URL_SIGNING_SECRET` 给 server 和 `r2-gate`。移动推送分别参见 [推送文档](PUSH_NOTIFICATIONS.zh-CN.md)。
5. 先用候选 server 镜像**单独运行一次** `npm run migrate`，再启动/滚动应用副本。应用启动只检查 `schema_migrations` 兼容性，不执行 DDL。生产推荐使用 [Deploy 工作流](../.github/workflows/deploy.yml)，它会创建一次性迁移 Job。

仓库中的 GKE 基础清单仍含 `REPLACE-*`、旧 `quay.io` 镜像与 `quay-pull` 引用。它是首次建集群的模板，不是可直接 `kubectl apply` 的生产最终状态；使用 Artifact Registry 时须替换镜像并按拉取方式处理 pull secret。该清单的 liveness 仍指向 `/api/health`，而 Deploy 工作流会修正为 `/api/livez`；手工应用清单时也必须按 [`gke.md` 的探针补丁](../server/k8s/gke.md)修正。readiness 保持 `/api/health`。

## 日常发布与回滚

`main` 推送触发 [Build 工作流](../.github/workflows/build.yml)：通过静态检查、单元/集成测试后把 server 镜像（受影响时还包括 agent-computer 镜像）发布到 Artifact Registry，按 Git SHA 标记。构建成功**不会**自动部署。操作者手动触发受 `production` 环境保护的 Deploy，选择精确 SHA，并在智能体运行时/CLI 协议变更时一起更新 agent 镜像。

Deploy 把 tag 解析成不可变 digest，先对现网做带鉴权预检，再用候选镜像跑迁移 Job；迁移失败不修改 Deployment。之后按 digest 滚动 server、等待就绪并跑带鉴权的租户冒烟。冒烟失败会执行 `kubectl rollout undo` 并验证旧 revision 就绪。数据库迁移不会随应用回滚自动逆向撤销，因此迁移需要兼容滚动窗口内的新旧应用；不要直接修改已经应用的迁移。

```bash
kubectl rollout status deployment/cumora-server
kubectl get pods -l app=cumora-server
kubectl get pods -l app=cumora-agent
kubectl logs deployment/cumora-server -c server --tail=100
```

验证时区分 `GET /api/livez`（进程活着）与 `GET /api/health`（数据库可用）。再以真实会话验证：登录、读取会话、发送消息、观察 WS 更新及智能体回复；可选功能启用后分别验证文件直传/读取、入站/出站邮件和移动推送。发布工作流的自动冒烟覆盖 auth、conversations 与 Shipping 路径，但不代替所有外部服务的端到端验证。检查客户端重连后能通过 REST 补齐状态，并观察迁移 Job、server/agent 日志及未完成的 outbox/失败的 agent run。

## 配置与容量边界

- `PORT` 默认 `5181`；生产 server 镜像内置 SPA，开发 Vite 使用 `5180`。公共 HTTPS/WSS 通常在集群外终止，集群内 server 与 agent Pod 走 HTTP。
- R2 未完整配置时会退回本地磁盘；若部署多个 server 副本，必须使用共享对象存储，避免某副本写入的附件在另一副本不可见。
- 当前 `r2-gate` 只对 `attachments/` 验签，`email-attachments/` 不在其验签列表中。若对外开放 R2 公共域名，部署前应补齐该前缀的访问控制，不能只依赖服务器生成的签名 URL。
- Cloud Agent 需要 Kubernetes Pod/PVC 权限及 FUSE 插件。`AGENT_POD_ADMISSION_MAX` 限制应用侧并发 Pod；当前基础 RBAC 不含节点读取权限，集群 FUSE 使用率读取失败时不能依赖其作为准入上限，详情见 [`gke.md`](../server/k8s/gke.md)。
- Redis Pub/Sub 不保存可回放的客户端事件。问题排查时先确认 PostgreSQL 写入，再检查 outbox/Redis/WS；智能体还可通过收件箱读取恢复漏掉的唤醒。
- `OPENAI_API_KEY` 是服务启动必需项；BYOA 的本地引擎凭据由用户机器自己持有。Resend、R2、APNs/FCM、sub2api 等按需配置，不应把未配置的可选功能误判为主链路故障。
