# 发布手册

如何为 Cumora 发一个新的桌面版本。

> 本文件是 [RELEASE.md](RELEASE.md) 的简体中文翻译;如与英文原文有出入,以英文原文为准。

## TL;DR

```bash
# 1. 提升 package.json 中的版本号
npm version patch       # → 0.1.0 → 0.1.1   (在本地创建 tag)

# 2. 推送 tag —— 剩下的交给 GitHub Actions
git push origin main --tags
```

推送到 `v*` tag 会触发桌面发布工作流:

- 本仓库的 **`.github/workflows/release.yml`** → 派发到 `yetone/cumora-releases`,由它为 macOS(arm64 + Intel)、Windows 与 Linux 构建 + 签名 + 发布 Electron 应用。最终产物落在 https://github.com/yetone/cumora-releases/releases。

它**不会**部署 API 服务器。后端生产部署是显式的、单独审批的动作;桌面 tag 绝不能悄悄改动后端。

桌面应用的自动更新器从 `https://updates.cumora.ai`(R2 支撑的 `generic` feed)读取,以 `cumora-releases` 的 GitHub Release 作为回退。发布工作流跑完(约 15–20 分钟)且 R2 镜像步骤执行后,正在运行的客户端会在下一次周期性更新检查时拿到新版本。

## 后端发布:先构建候选镜像,再点火上生产

每次推送到 `main` 都会运行 `.github/workflows/build.yml`。在发布镜像之前,它必须通过两个 TypeScript 项目、big-brain 与 tracked-LLM 守卫、单元测试,以及 Postgres/Redis 集成套件。一次成功的运行会产生不可变的、以 SHA 为 tag 的 server 镜像(以及,在受影响时,agent-computer 镜像)。它不会部署它们。

要部署一个候选镜像:

1. 打开 **Actions → Deploy → Run workflow**。
2. 输入 Build 产生的确切的短 SHA tag。有 SHA 可用时避免 `latest`;Deploy 在触碰 GKE 之前会把任一种 tag 解析为 digest。
3. 当这次构建改动了 `server/src/agents/**`、打包进镜像的 CLI/runtime,或 agent-computer 镜像时,设置 `include_agent=Y`。否则用 `N`。除非你在清除迁移 0002 的前置条件,否则保持 `repair_0002=off`——见下文。
4. 审批受保护的 `production` 环境。对高风险改动,审批者不应当是构建该功能的人。
5. 核对 workflow summary 中包含所选 digest、上一个 server 镜像、已完成的滚动发布,以及通过的带鉴权冒烟测试。

Deploy 首先证明既有生产 API 与冒烟凭据是健康的,然后运行一个候选镜像的迁移 Job 并校验其不可变的台账/索引门禁,把当前 revision 记录为回滚基线,按 digest 更新 server(以及可选的 agent runtime),等待 GKE,再演练真实的带鉴权租户路径:auth、conversations,以及 Shipping 概览/schema。迁移失败时 Deployment 不受影响;部署后冒烟失败会自动执行 `kubectl rollout undo`,等待旧 revision 重新就绪,并让 workflow 失败。

#### 当迁移 0002 拒绝应用时

迁移 0002 规范化会话成员关系(ADR 0004),当 `conversations.members` 里的某个 id 在该会话的租户中没有对应参与者时,它会 fail-closed(失败即停)。Job 日志会先给出一份预检报告——按类别计数外加脱敏样本——所以先读它,再做任何事。

这些条目早于 `startPulledGroup` 中的租户守卫,且今天不授予任何东西:每条读路径都是租户作用域的,外来的成员 id 是不可达的成员关系,而且 ADR 0004 的复合外键根本无法表示它。用 `repair_0002=archive-detach` 重新运行 Deploy,可以让 0002 清除自己的前置条件:

- 每一对违规的 `(conversation, member)` 会先被复制进 `conversation_members_detached_0002`——连同它的序号**和**整个 detach 前的 members 数组——然后才被移除;
- `messages` 永远不会被触碰,所以一个在会话中发过言的被归档成员仍保留其作者身份;
- 预检随后会重跑,所以任何 detach 修不了的东西(比如说一个没有 `company_id` 的会话)仍会挡住部署;
- 这一切都运行在 0002 自己的事务内,所以之后任何失败都会连同 detach 一起回滚。

归档是一份完整记录,不是一键撤销。0002 一旦应用,其投影触发器会在每一次写入上强制 ADR 0004,所以把一个被 detach 的 id 放回 `conversations.members` 会失败,直到该 id 成为该租户中的真实参与者——而这正是这条迁移要建立的不变量。归档给你的是看清"到底移除了什么、从哪里移除"的能力:

```sql
SELECT conversation_id, member_id, ordinal, authored_messages,
       participant_elsewhere, original_members
  FROM conversation_members_detached_0002
 ORDER BY conversation_id, ordinal;
```

真正的恢复意味着:先把该 id 变得可解析(在该租户中重建或移入该参与者),再通过 `addConversationMember` 把它加回来。`original_members` 记录了确切的 detach 前数组,供恢复时对照。

`repair_0002` 只对那一次运行生效——它作为显式的容器 `env` 条目传入,覆盖 `cumora` Secret,且默认为 `off`,因此普通部署继续保持 fail-closed。

交付中的功能还会追踪一个生产回读(readback)截止时间,默认为成功发布后 24 小时。Ship 工作区会呈现到期项;服务器把错过的截止时间转化为 `overdue` 发布状态外加高严重度摩擦。`.github/workflows/production-readback.yml` 每天独立检查带鉴权的生产路径。一个功能只有在生产发布拥有显式回读证据、且没有失败的回归资产之后,才会到达 `Learned`。

### 必需的后端 secrets 与环境保护

在 `yetone/cumora` 上:

| 名称 | 用途 |
|------|---------|
| `GCP_WIF_PROVIDER` | 用于解析与部署镜像的 Workload Identity Federation provider。 |
| `GCP_DEPLOY_SA` | 用于 Artifact Registry 与生产 GKE 部署的最小权限服务账号。 |
| `CUMORA_SMOKE_TOKEN` | 专用的、可撤销的会话/服务 token,仅用于带鉴权的冒烟/回读。 |
| `CUMORA_SMOKE_COMPANY_ID` | 冒烟身份所属的非敏感租户 id。 |

用必需评审者(required reviewers)保护 `production` GitHub environment。把冒烟 secrets 同时放进 `production` 与 `production-readback`(或把后者配置为继承仓库 secrets)。像对待其他生产凭据一样轮换冒烟 token,且绝不在 workflow 输出中打印它。

## 发布工作流做什么

1. 在四个 runner 上矩阵构建 Electron 应用(macOS arm64、macOS Intel、Windows、Linux)。
2. 在 macOS 上,把 Developer ID 证书导入临时钥匙串,签名 app bundle,并用 GitHub Secrets 中的 Apple 凭据进行公证(notarise)。
3. 上传平台相关产物(DMG、ZIP、EXE、AppImage、DEB、`latest*.yml` 自动更新 feed、blockmap)。
4. 合并各架构的 `latest-mac.yml`,让一份 feed 同时通告 arm64 与 Intel。
5. 通过 OpenAI API,根据上一个 tag 与本次 tag 之间的提交列表生成一份用户友好的更新日志(changelog)。
6. 把所有东西镜像到 `cumora-updates` Cloudflare R2 bucket(仅当配置了 R2 secrets 时——可选)。
7. 创建 GitHub Release,附上产物,正文用生成的更新日志。
8. 向 Discord 发布频道发一条公告(仅当配置了 webhook 时——可选)。

## 一次性搭建(已完成;仅供参考)

### 必需的 GitHub Secrets

在 `yetone/cumora` 上:

| 名称 | 用途 |
|------|---------|
| `RELEASES_REPO_TOKEN` | 作用于 `yetone/cumora-releases` 的细粒度 PAT。需要 `Actions: write`。 |

在 `yetone/cumora-releases` 上:

| 名称 | 用途 |
|------|---------|
| `CUMORA_REPO_TOKEN`             | 作用于 `yetone/cumora` 的细粒度 PAT。需要 `Contents: read`。 |
| `MAC_CERTIFICATE_P12`           | Base64 编码的 Developer ID Application 证书(`.p12`)。`base64 -i Certificates.p12 \| pbcopy`。 |
| `MAC_CERTIFICATE_PASSWORD`      | 上述 `.p12` 的密码。 |
| `APPLE_ID`                      | Apple Developer 账号邮箱。 |
| `APPLE_APP_SPECIFIC_PASSWORD`   | 用于公证的 App 专用密码。在 appleid.apple.com → Sign-In and Security → App-Specific Passwords 生成。 |
| `APPLE_TEAM_ID`                 | 来自 developer.apple.com → Account → Membership 的 10 位 Team ID。 |
| `OPENAI_API_KEY`                | 用于生成更新日志。 |
| `R2_ACCESS_KEY_ID`              | (可选)`cumora-updates` bucket 的 R2 镜像。 |
| `R2_SECRET_ACCESS_KEY`          | (可选)R2 镜像凭据。 |
| `CLOUDFLARE_ACCOUNT_ID`         | (可选)R2 endpoint 作用域。 |
| `DISCORD_RELEASE_WEBHOOK_URL`   | (可选)用于发布公告的 Discord 频道 webhook。 |

任何一个可选 secret 未设置时,工作流会跳过该步骤并依然成功。

### Cumora 侧的一次性接线

- `package.json` 中的 `build.publish` 是一个**有序数组**:第一个条目是 `https://updates.cumora.ai` 的 `generic` feed(R2 支撑),也是 electron-updater 实际轮询的对象;指向 `yetone/cumora-releases` 的 `github` 条目是回退 feed。见 `electron/autoUpdater.cjs`。
- `build.mac.notarize` 为 `true`;electron-builder 从 workflow 环境中读取 `APPLE_TEAM_ID`(连同 `APPLE_ID` 与 `APPLE_APP_SPECIFIC_PASSWORD`)。
- `build/entitlements.mac.plist` 声明了 Electron 需要的 hardened-runtime 权限(JIT、网络访问、dyld 变量)。

## 发布 npm 上的 `cumora` CLI

用户用 `npx cumora@latest` 安装的 BYOA 守护进程是与桌面应用**相互独立**的产物:npm 包 `cumora`,从 `agent-cli/` 构建。它有自己的工作流,不属于 `v*` tag 发布的一部分。

`.github/workflows/publish.yml` 在任何触及 `agent-cli/**` 的 `main` 推送时发布它——通常是 `agent-cli/package.json` 中的 `chore(agent-cli): release cumora@X` 版本提升。要发布一个 CLI 版本:

```bash
# 提升 agent-cli/package.json 自己的 "version",然后合并进 main。
# 工作流会运行 `node build.mjs` 与 `npm publish --access public`。
```

注意:

- 只有当这个确切版本尚未在 registry 上时才发布,所以重新推送 `main` 是无操作而不是失败。
- 它需要仓库 secret `NPM_TOKEN`(一个 npm **automation** token,可绕过 2FA 进行写入)。在该 secret 存在之前,工作流会干净地 no-op 而不是失败。
- `agent-cli/package.json` 的版本独立于根 `package.json` 的版本。靠约定保持它们同步,而不是靠工具。

## 手动重建过去的版本

如果某个历史版本需要重制(签名失败、产物缺失等),使用 `yetone/cumora-releases` 上的 `workflow_dispatch` 表单:

1. 前往 https://github.com/yetone/cumora-releases/actions/workflows/release.yml
2. **Run workflow** → 填入:
   - `ref` = 本仓库的 tag(例如 `v0.1.0`)
   - `version` = 裸版本号(例如 `0.1.0`)
3. 工作流会重新构建并覆盖既有 release 的产物。

## 常见问题

- **macOS 公证失败。** 最常见的是 `APPLE_APP_SPECIFIC_PASSWORD` 被轮换过,或证书过期。检查 `https://appleid.apple.com` 以及装有该证书的 Mac 上的 `Keychain Access`。
- **构建跑了,但没有创建 GitHub Release。** publish job 需要 `permissions: contents: write`,workflow 里已经设置。如果你 fork 了这两个仓库,确保你的 fork 上也授予了该权限。
- **`latest-mac.yml` 只提到一种架构。** 两个 Mac runner 之一在产出 yml 之前失败了。查看 `build-mac-arm64` / `build-mac-x64` 上的 `Upload build artifacts` 步骤。
- **桌面应用看不到更新。** 自动更新器在启动 3 秒后检查一次,之后每 **30 分钟**一次(`electron/autoUpdater.cjs` 显式设置了该间隔)。可以从应用菜单强制检查,或重启应用。
