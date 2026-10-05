# Channel Task 执行与运维

本变更 `introduce-channel-task-execution` 覆盖 P0–P4。概念数据流仍以 [multi-agent-concepts-and-data-flow.md](../doc/multi-agent-concepts-and-data-flow.md) 为准；Task、Binding、Grant、产物和知识服务接入现有单体、PostgreSQL、Redis 与消息 outbox。任务始终属于原 Channel，子任务不新建协作群，只有根任务发布频道交付。

## 数据与兼容

此版本支持 schema `14..19`；TASK 功能要求完整应用到 19。正常服务启动只验证版本与 checksum，不执行迁移。15 建立任务记录，16 增加执行独占与引用约束，17 增加消息来源版本和治理映射，18 增加撤权、保留与生命周期约束，19 固定 Task 创建时的 Definition 与局部配置。迁移 1–14 的 SQL/checksum 未修改。

版本 14 下新服务保持 LEGACY，Task 准备请求返回 `TASK_SCHEMA_MIGRATION_REQUIRED`。PREPARING 封闭旧任务执行入口，允许管理员配置和处理已有执行的停止事实。只有 readiness 通过后才可进入 TASK。

已有 participant、conversation、message 和看板 ID 保留。Definition 由管理员明确版本化，Binding 只绑定有效频道 Agent；离开后重新加入不会恢复旧 Binding。旧 inbox、原始记忆、引擎 HOME/session 不导入 Task。已确认归属的看板工作通过显式入口映射；未知归属和旧记忆保留原记录，不猜测来源。

## 已准入组合

| 组合 | 任务能力与验证边界 |
|---|---|
| 托管云端 worker | 固定 `artifact_create`、根任务 `task_plan`；批准输入、来源受限知识、既有 tracked model client 与治理预算；无旧 inbox、FUSE、shell 或 runner 凭证 |
| Linux x86_64 + Codex CLI + bubblewrap | 已用 Codex 0.158.0、Node 24.11.1 实测。准入绑定实际二进制 SHA-256 与操作员审查的验证记录；每次 Task 新进程、新 HOME、只读输入、独立可写目录、PID/网络隔离、清空环境 |
| 云端 Aida → 本地 Codex WORK → 云端 VERIFY → 云端汇总 | 已用真实 CLI、HTTP/JWT、PostgreSQL 和 tracked 模型代理验证不可变产物交接。模型响应由确定性测试服务提供，未调用真实付费提供方 |

本地模型请求经过任务沙箱外的受信 supervisor。默认使用服务端模型代理；管理员明确准入 `codex-login` 后，可使用主机已有 Codex ChatGPT 登录态的受控代理。供应商凭证、设备 JWT、dispatch token 不进入 CLI 环境或任务文件。两种连接均使用远程模型，不能标注为“全本地推理”。Codex 的 web_search、tool_search、MCP、插件、浏览器、多 Agent、记忆、共享 worktree 等宽入口未准入；工具发现不创造授权。只接收 function/custom 类型的本地工具（包括只含此类工具的 namespace）。

macOS、Windows、其他 CLI 引擎和任意第三方连接器必须分别证明隔离/身份/数据目的地后才能准入；当前返回 `RUNTIME_CAPABILITY_UNQUALIFIED` 或 `RESOURCE_ADAPTER_UNSUPPORTED`。首个可配置资源 adapter 是第一方 `channel`，群组使用频道 SERVICE 身份，私聊使用已验证 PERSONAL 身份。Git、SSH、任意 MCP 或主机已有个人登录态不因管理员权限自动可用。

受信连接 adapter 可复用 `TaskOperationService.execute`：先写操作事实、再执行一次外部效果。相同 key/payload 的成功结果可重读；冲突 payload 拒绝；超时、写后断连留下 UNKNOWN，不能自动重放或迁移。操作员确认实际效果及原执行已停止后，才可对账为 SUCCEEDED/FAILED。新增 adapter 必须实施同样的关联授权与边界验收。

## 准备、切换与停止

桌面左侧导航的「配置」打开独立配置页面；手机从「我 → 群聊与 Agent 配置」进入。群聊中的「群聊配置」直接打开该群的配置，LEGACY 下也可访问。页面支持追加 Definition 版本、选择频道和现有 Agent、创建/修改 Binding、原子切换默认负责人、查看计算机 placement 与 readiness，以及准备、启用、暂停和恢复聊天模式。已有 Task 固定的定义与责任归属不随新版本改变。Agent 的运行计算机仍在现有 Agent 编辑页选择。

Channel 就是现有 IM 群聊，不需要另建任务专用群。打开创建群聊窗口时自动复用或安装工作区 Aida，并默认选中；可以直接创建只有自己和 Aida 的群聊，也可以选择多个专业 Agent。正常创建或打开既有群聊时，服务端添加 Aida 并初始化缺失的成员 Binding；管理员已明确选择的默认负责人保留。安装遵循现有 Agent 配额，优先使用已配对且可运行 Codex 的本地计算机；没有合适设备时保持未分配，配置页显示实际状态。自动初始化不会切换工作区执行模式、复制其他群的局部配置或授权，也不会让未准入设备执行 Task。用户实际工作区的复验见[群聊默认 Aida 与配置入口验收](TASK_EXECUTION_GROUP_DEFAULTS.zh-CN.md)。

Linux 本地设备先执行真实边界验证。使用本机 Codex 登录态时，命令为：

```sh
node --import tsx scripts/qualify-local-task.mjs /tmp/cumora-local-task-admission.json codex-login
```

省略最后的 `codex-login` 则使用服务端模型代理。审查生成的记录并在配置页选择已配对计算机、导入 JSON；记录绑定实际 Codex 二进制 hash 和验证日志 hash，不可用手填的全 true 替代实际验证。CLI 升级后重新验证并导入。执行该命令的系统必须允许 bubblewrap 的用户/PID/网络隔离。

`codex-login` 仅由本机受信 supervisor 读取当前用户私有、正规、非符号链接的 Codex `auth.json`，使用固定 Codex Responses 目的地；服务端不接收登录凭证。每次调用先取得当前 Task/claim 的持久许可，再执行推理和提交用量回执，回执确认后才把结果交回沙箱。已有服务器 API Key 不被替换。401/403 返回 `CODEX_LOGIN_REQUIRED`，需要操作员在主机重新登录后明确继续任务；没有凭证复制、自动刷新或切换提供方重试。传输适配已用 Codex 0.158.0 与真实登录态验证，上游协议升级需要重新验证。

本地 Aida 可直接完成单 Agent 任务，也可在获准的根任务中写入 `/workspace/task-plan.json` 提交一层计划。其格式与 Task plan API 一致：`{"parallelism":1,"members":[{"key":"work","bindingId":"B_WORK","objective":"生成产物","dependsOn":[],"grantIds":[],"role":"WORK"},{"key":"verify","bindingId":"B_VERIFY","objective":"验证交接产物","dependsOn":["work"],"grantIds":[],"role":"VERIFY"}]}`。只可选择当前频道 eligibleBindings 和根任务已批准 Grant；沙箱退出后才提交计划，计划文件不发布为产物或临时答复。WORK → VERIFY → Aida 通过准确版本/hash 的产物交接，根任务汇总附上当前 VERIFY 证据；子任务和已规划根任务不再次委派。工作目录相互独立，Verifier 读取的是交接版本，而非 Worker 主机目录。

实际单 Aida 与全部本地 Aida/Worker/Verifier 的浏览器验收结果见[本地修复验收](TASK_EXECUTION_LOCAL_REPAIR.zh-CN.md)。

公共接口前缀为 `/api/tasks`，需要现有用户会话及 `x-company-id`。管理员配置还要求实际 workspace owner/admin 资格。请求体中的 companyId、creatorId、agentId 等不能覆盖认证主体；未知字段拒绝。下列步骤中的 ID 取自真实接口返回值。

1. 使用支持 `14..19` 的准备版本升级全部副本；按原迁移程序在目标数据库应用 15–19，核对不可变账本。
2. `POST /workspace/prepare`，body `{}`。PREPARING 禁止旧回合继续取得宽接口或调用模型。
3. 明确配置 Definition、每个有 Agent 的频道默认 Binding，以及需要的 Connection/Grant/Bundle。仅引用 Bundle 不转授原连接使用权。
4. 本地设备运行边界验证后，由管理员提交 admission；检查二进制 hash 与实际部署一致。
5. `GET /workspace` 取得 failures；处理全部缺失默认 Binding、旧 agent_runs/live Convene、未停止 executor、UNKNOWN 操作和未准入设备。
6. `POST /workspace/activate`，body `{}`。Workspace generation 递增，TASK 成为唯一工作路径。

`POST /workspace/stop` 停止新派发、撤回上下文、取消 PENDING，已执行但停止未确认的 dispatch 保留 UNKNOWN。执行器必须证明实际进程及子进程退出，或由管理员提交审查后的停止证据。`POST /workspace/rollback` 只在所有执行及未知操作处理后恢复 LEGACY；保留 Task/Delivery/Artifact/操作事实。应用二进制只能回到支持当前 schema 的版本，不执行破坏性 down migration。

回滚后，已有 Task 的输入/交付消息不会进入旧 wake、inbox、模型上下文、CLI 消息/搜索/概览或 Convene grounding；对这些消息的引用也不会携带正文。普通新 LEGACY 消息仍按原规则工作。保留 Task 事实继续通过当前授权的 Task API 读取，不能把保留记录解释为宽权限重接单。

## 公共接口契约

所有 Task API 响应为 `Cache-Control: private, no-store`。以下 body 是接口格式示例；测试中的真实请求见 [channel-task-execution.test.ts](../server/src/__integration__/channel-task-execution.test.ts)。

| 方法及路径（相对 `/api/tasks`） | body / 含义 |
|---|---|
| GET `/configuration` | 管理员配置投影：可访问频道、当前 Agent/Binding、Definition 版本和计算机准入；不返回设备或模型凭证 |
| POST `/definitions` | `{"definitionId":"worker","name":"Worker","role":"WORK","instructions":"只处理本任务批准输入"}`；追加不可变版本 |
| POST `/bindings` | `{"channelId":"C","agentId":"A","definitionVersionId":"D","alias":"Worker","isDefault":true}` |
| PATCH `/bindings/B` | 同定义/别名/默认配置（无 channelId/agentId），可增加 instructions；版本变化撤回旧 context |
| POST `/connections` | `{"channelId":"C","adapter":"channel"}`；第一方身份由服务端解析 |
| POST `/grants` | `{"channelId":"C","rule":{"resource":"channel:C","actions":["read","publish"],"identity":"service:channel:C","audience":{"kind":"CHANNEL","id":"C"},"destinations":["task-model","artifact","channel"],"expiresAt":"2099-01-01T00:00:00Z"}}` |
| POST `/bundles` | `{"bundleId":"review","grantIds":["G"]}`；创建 immutable bundle 版本 |
| POST `/access-refs` | `{"channelId":"C","bundleVersionId":"BV"}`；必须已有适用当前 caller/audience 的授权 |
| POST `/grants/G/revoke`、`/connections/X/revoke` | `{}`；原 issuer/owner 撤回，旧 snapshot 不继续授权 |
| GET `/channel-state?channelId=C` | LEGACY / PAUSED / TASK |
| GET `/?channelId=C`、`/T` | 当前成员取得 Task 状态、输入元数据及 Delivery 引用；不返回未发布正文 |
| POST `/` | `{"channelId":"C","objective":"审查补丁","ingressKey":"request:123","grantIds":["G"]}`；可显式 bindingId/messageId 或完整治理映射 |
| POST `/T/inputs` | `{"messageId":"M"}` 或 `{"text":"补充重现条件"}`；MESSAGE 只允许调用者在同频道的当前消息，来源由服务端生成 |
| POST `/T/inputs/I/retire` | `{}`；控制者撤回输入，input revision 增加 |
| POST `/T/drive` | `{"key":"drive:123"}`；creator 或具有 drive 权限的 controller |
| POST `/T/steer` | `{"key":"steer:123","text":"检查重试路径"}`；同一事务增加批准输入和派发；旧 context 被版本隔离 |
| POST `/T/cancel` | `{}`；取消根与其子任务，实际停止仍须确认 |
| POST `/T/scope` | `{"objective":"新的明确目标"}`；要求原 executor 已停止；旧输入/Grant 上界退役，重新批准权限 |
| POST `/T/grants` | `{"grantIds":["G"]}`；在当前 scope 明确批准，不从 Bundle 自动复制 |
| POST `/T/controllers` | `{"principalId":"U","actions":["drive"]}`；只有 creator 可配置，`[]` 撤回 |
| POST `/board` | `{"channelId":"C","cardId":"CARD","grantIds":[]}`；普通看板明确 work channel 和 assignee Binding；固定 title/description 内容 hash，来源变化阻塞 |
| POST `/board` | `{"channelId":"C","attemptId":"ATTEMPT","grantIds":[]}`；已治理卡片继续验证 Mandate、Primary、预算、epoch、placement 和 attempt |
| POST `/T/governance-artifacts` | `{"versionId":"GV","content":"准确原内容"}`；hash/media/完整频道读取权验证，唯一版本桥接；不改变审核状态 |
| GET `/artifacts/V`、`/artifacts/V/content` | 当前成员、发布及来源授权检查后返回确切内容/hash；私有草稿仅 creator；字节路径 nosniff/ETag，不返回公开存储 URL |
| POST `/knowledge/candidates` | `{"artifactVersionId":"V","body":"来源受限经验","ownerKind":"AGENT"}`；也可 CHANNEL；仅候选 |
| POST `/knowledge/K/confirm`、`/knowledge/K/invalidate` | `{}`；确认来源/撤回条目和发布 |
| POST `/knowledge/K/publish` | `{"targetChannelId":"C2"}`；明确版本发布并证明每项来源分享权，不转授连接或原材料 |

聊天仍用 `POST /api/conversations/C/messages`：`{"body":"补充","clientId":"stable-id","taskId":"T"}`。taskId 可为 `new`；省略时只在明确引用或唯一未完成根任务时自动关联，多任务返回 `TASK_SELECTION_REQUIRED` 并回滚消息/outbox。clientId 重试返回同一消息与 Task，不能换 body 或任务重新解释原请求。成员可补充，发言资格不自动赋予 drive/cancel/scope 权限。

日历 TASK 模式要求明确 target_conversation_id、有效 assignee Binding 和原创建者资格；私有日历只进入 DIRECT。WS 文档提及、缺失 Channel 的旧看板简报不能创建隐式 DM。idle/background_scan/poll.updated/manual 使用管理员明确配置的自动化 policy 和对应 `automate:<reason>` Grant；缺少权限留下拒绝事实。Delivery/STATUS 只展示，不重新接单。

旧 Convene 的宽会话模型入口在 PREPARING/TASK 返回 `TASK_CONTEXT_REQUIRED`；协作改用该 Channel 的显式 Task/Plan。原有 live Convene 结束前不能激活/回滚，新模型调用和结果追加也检查切换状态。未切换 Workspace 保持既有 Convene 行为。

本地 `/runtime/tasks/{claim,context,heartbeat,model,plan,artifacts,deliver,block,stopped}` 需要现有 Agent JWT、当前 placement 和 claim 的 id/contextId/generation/token。token 仅 supervisor 保存；每个动作重新验证当前 scope/input/binding/assignment/Grant/来源。旧 `/runtime` inbox/CLI/fs/memory 等接口在 PREPARING/TASK 返回 `TASK_CONTEXT_REQUIRED`；旧 run finish 仅允许保存停止事实。

## 产物、知识和生命周期

产物只接收 UTF-8 text/plain、text/markdown、text/x-diff、application/json，每版本最多 2 MB。不可变 version/hash 是交接与测试证据依据，本地路径和浮动分支不能作为完成证明。Aida 最多一层、8 个子任务、4 个并行成员；VERIFY 独立于其生产者，证据必须绑定被测版本。依赖交付和不可变 handoff 都成立后才能派发消费者。

来源带 MESSAGE 当前版本、TASK_SCOPE revision、Grant version、Artifact/Knowledge 固定版本、治理 immutable version 或 BOARD 内容 hash。每次模型输入、产物、交付、检索和下载重新验证来源与目的地。置顶只影响排序；未知来源旧记忆不自动进入 Task。没有获准 embedding 目的地时不调用 embedding 服务，当前知识检索使用受控数据库记录，不用全局记忆缓存兜底。

Task 详情只返回当前获准的根交付。消息历史、侧栏预览、搜索、回复引用和 WS 也应用当前来源检查；撤权后的产物和摘要保留事实，不继续通过这些读取路径返回原正文。

新增成员与发布/撤权使用相同事务锁；在新增成员提交前，检查未关闭 Task 的批准输入及频道已发布产物的当前来源。无法确认全部来源仍允许向完整频道分享时，返回 `MEMBERSHIP_SOURCE_AUTHORITY_REQUIRED`，成员、加入提示和 outbox 一同回滚。来源已撤回、旧范围失效或来源主体离开时采取保守拒绝，需要有权主体先按保留政策处理历史与授权。

离职、成员移除、设备撤回会结束 Binding、撤回上下文/连接/Grant，PENDING 取消，停止不明的执行留 UNKNOWN。默认产物保留 365 天；有效 handoff、Delivery、知识、输入或治理引用阻止 GC。`POST /workspace/gc` 只删除已过保留期且无引用、生产 Task 已关闭的非治理版本，不清除事实历史。含 Task/治理保留事实的 workspace 删除返回 409，进入已有受控保留处置流程。

## 可重复验收

必须使用独立 PostgreSQL/Redis；测试会 TRUNCATE 数据。以下容器只服务测试，与运行中的业务容器分开：

```bash
docker run -d --name cumora-task-test-postgres -p 127.0.0.1:15432:5432 -e POSTGRES_USER=cumora_task_test -e POSTGRES_PASSWORD=task-test-only -e POSTGRES_DB=cumora_task_test postgres:16-alpine
docker run -d --name cumora-task-test-redis -p 127.0.0.1:16379:6379 redis:7-alpine
export INTEGRATION_DATABASE_URL=postgres://cumora_task_test:task-test-only@127.0.0.1:15432/cumora_task_test
export REDIS_URL=redis://127.0.0.1:16379
node scripts/verify-channel-tasks.mjs all /tmp/cumora-task-all-report.json
```

本地过程验收还需要实际 Codex 二进制、Linux bubblewrap 可建立 PID/network namespace、Node、headless Chrome。若宿主限制 namespace/socket，执行验证需对应宿主许可；不能跳过后宣称通过。也可分别运行 `checks`、`unit`、`integration`、`workflow`、`rollback`、`native`、`ui`，第三参数选择报告位置；`workflow` 专门复测协调修复、所有入口与 Convene 兼容，`rollback` 聚焦私聊隔离及回滚后不重接单。

脚本逐文件独立运行 `node --import tsx --test --test-isolation=none --test-reporter=spec`，检查实际测试数量、零失败、零取消、零跳过，并保留逐文件日志。缺少 dedicated test DB/Redis、原生工具或必要 assertion counts 会失败。测试使用真实 PG/Redis、CLI、HTTP、进程/文件/网络与 Chrome；模型响应通过确定性 adapter，外部写入测试使用可计数的受信效果，不调用付费模型或真实第三方写入。

本次逐项验收与执行证据见 [TASK_EXECUTION_VERIFICATION.zh-CN.md](TASK_EXECUTION_VERIFICATION.zh-CN.md)。
