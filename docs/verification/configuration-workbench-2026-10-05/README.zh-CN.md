# 配置工作台正式实现验收

对应 OpenSpec `implement-configuration-workbench`，基线为[原型 v2](../../prototypes/configuration-workbench-v2.html)、[设计](../../prototypes/configuration-workbench-v2/DESIGN.zh-CN.md)和[验收条件](../../prototypes/configuration-workbench-v2/ACCEPTANCE.zh-CN.md)。本记录覆盖正式 React 页面、真实 API、Postgres 和部署；原型的 22 项通过单独保留。

2026-10-06 按用户要求同步主规格并归档，任务记录见[归档变更](../../../openspec/changes/archive/2026-10-06-implement-configuration-workbench/tasks.md)。

## 环境与入口

- 应用：http://192.168.28.113:5181；工作区：`gaohua chen's workspace` / `co-a09a2bc0-f`。
- 桌面侧栏「配置」打开三栏工作台：Agent、Access Bundles、群聊、Skill 库，以及独立的工作区执行准备入口。
- 默认 Aida：`aida-lnn7`，本地计算机 `gh` / `comp-11c2fc72-048`，Codex 引擎。
- 数据库已应用迁移 20，历史账本 1–19 保持原 checksum。工作区仍采用原有有效 `LEGACY` 模式，配置编辑不自动切换执行模式。
- 真实浏览器使用 1440 × 1000 桌面视口、临时登录会话。验收后删除会话，报告中不保存登录凭证。验证对象名称和 ID 见 [acceptance.json](acceptance.json)。

## 验收结果

| 检查 | 结果与证据 |
|---|---|
| 实际桌面页面 | 25 项通过，0 个浏览器运行异常；[浏览器记录](acceptance.json) |
| 默认 Aida、本地 Agent、Skills | WB01–04，服务端发布并刷新读回；[本地 Aida](screenshots/01-local-aida.png)、[固定 Skills](screenshots/03-agent-skills.png) |
| MCP、域名、GitHub 配置 | WB05、WB07，明确逐资源身份、身份来源、端口、工具、仓库/分支/路径/动作；[连接编辑](screenshots/04-bundle-connections.png)、[资源投影](screenshots/06-effective-resources.png) |
| 仅 Aida、多个 Agent 群聊 | WB06，实际成员和默认 Binding 自动初始化；[群聊成员](screenshots/05-multi-agent-group.png) |
| 不可变版本及显式升级 | WB08–14，Skill 发布不改 Agent，Agent 发布不改旧群聊，Bundle 普通确认不升级；[Agent 版本](screenshots/07-fixed-agent-version.png)、[Bundle 选择器](screenshots/09-bundle-fixed-picker.png) |
| 群聊与成员语言 | WB10–11，固定定义、群聊、成员各层显示具体值与来源；[成员语言](screenshots/08-member-language.png) |
| 嵌套 Skill 导入 | WB15–16，取消/成功都返回原选择器并保留选择；确认只修改当前成员；[导入选择器](screenshots/10-import-picker.png) |
| all/subset/none | WB17–18，删除最后一个引用保持空子集，重新加入 Bundle 不扩大旧子集；[空子集](screenshots/11-empty-subset.png) |
| 撤销、切换与冲突 | WB02 × 4、WB19–20，撤销新建恢复有效对象，切换可保存/放弃/继续，修订冲突保留草稿；[冲突草稿](screenshots/12-conflict-draft.png) |
| 应用刷新 | WB21，重新加载后服务端固定引用和成员配置仍存在；[刷新后成员](screenshots/13-persisted-members.png) |
| 单元及历史账本 | 24 项通过：配置解析 5 项、迁移契约 19 项 |
| 真实数据库集成 | 36 项相关用例通过：现有 Task 执行 26 项、工作台配置 6 项、默认 Aida/新群聊固定版本 4 项 |
| 类型、构建与规格 | 前后端类型检查、Docker 内前端生产构建、改动文件 lint、严格 OpenSpec 校验通过 |
| 部署一致性 | schema 20、健康接口成功、临时会话已清理、运行时文件 hash 与工作区一致；[部署记录](deployment.json) |

配置集成测试额外验证根任务与委派任务携带固定 Skill 内容和完整配置；配置升级不改已领取的执行上下文，Runtime 重新分配仍阻断旧上下文；普通群聊设置即使使用三字段旧定义也进入快照。新群聊选择发布后的最新 Agent 定义，重新初始化旧群聊保持旧引用。

## 实现与使用边界

配置工作台复用现有 `participants`、`conversations`、`conversation_members`、定义/Binding/Bundle 表。新增不可变 `skill_versions`、工作区配置修订与语言，以及群聊配置和执行资格修订字段。服务端 `GET/PATCH /api/tasks/workbench` 管理发布和保存；`POST /api/tasks/workbench/preview` 接受 `channelId`、可选 `bindingId` 和群聊/成员草稿，使用与 Task 创建相同的解析器。

Task 模式中的新根任务及委派任务固定配置，保存/升级不反写旧任务。原有 LEGACY 聊天路径继续保留；当前工作区没有因本次页面部署自动转为 TASK。模型偏好、响应/输出/记忆配置进入固定投影与指令，并行数约束协作计划；模型偏好不创建新模型服务商连接，记忆设置不改变知识发布和授权的数据流。

MCP、Domains、GitHub 本轮可编辑、发布、引用、预览和固定快照，页面显示「外部执行未准入」。本次没有创建真实外部连接凭证，也没有验证外部工具调用或模型真实推理。现有第一方 channel adapter 和实时执行准入仍沿用原路径。手机端保持现有执行配置页面，本轮未改造手机工作台；云服务及权限议题继续不扩展。

概念数据流文档 `doc/multi-agent-concepts-and-data-flow.md` 未修改，SHA-256：`809a9c159f46f50ab7b47b3fd03095430ccbf4a65ff65e82e6eb3ebf5afd6d11`。

## 复现

```bash
npm run typecheck
npm run server:typecheck
node --import tsx --test server/src/__tests__/configuration-resolution.test.ts server/src/__tests__/schema-migrations.test.ts
openspec validate --specs --strict
node scripts/verify-configuration-prototype.mjs
node scripts/verify-configuration-workbench.mjs
```

数据库集成用例必须连接独立测试 Postgres 和 Redis，表会在用例之间清空。设置本地 `INTEGRATION_DATABASE_URL`、`INTEGRATION_REDIS_URL` 后可执行以下相关套件；不要指向应用工作区数据库。

```bash
DATABASE_URL="$INTEGRATION_DATABASE_URL" REDIS_URL="$INTEGRATION_REDIS_URL" \
node --import tsx --test --test-concurrency=1 \
  server/src/__integration__/channel-task-execution.test.ts \
  server/src/__integration__/configuration-workbench.test.ts \
  server/src/__integration__/group-default-aida.test.ts
```

正式浏览器脚本需要本机 Chrome、Node 22+、运行中的 Docker 服务；默认连接上述验收工作区，创建带「验证」前缀的配置对象，保留以便人工核对。可用 `WORKBENCH_URL`、`WORKBENCH_COMPANY`、`WORKBENCH_USER`、`WORKBENCH_CONTAINER` 切换测试目标。脚本通过容器建立短期会话，结束后撤销会话，不打印凭证。

部署沿用现有 compose：构建 server → 执行 migrate → 重建 server。源码与镜像 ID、浏览器结果分别记录在两个 JSON 文件中，截图为实际应用页面。

后续默认 Aida 的本地 Codex 模型兼容性问题已单独修复并完成真实推理验证，见[修复记录](../aida-local-codex-2026-10-05/README.zh-CN.md)。本页保留配置工作台验收时的镜像和证据。
