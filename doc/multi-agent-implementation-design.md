# 多 Agent 系统在现有 Cumora 中的实施设计

版本：v0.2 · 实施契约与代码对照 · 2026-10-04

概念基线：[多 Agent 系统：概念、架构与数据流 v0.4](multi-agent-concepts-and-data-flow.md)。

代码依据：HEAD 为 `bfdb9492a1fabe77254da4b83ccdf9190ff74bae` 的工作树。实施 change 为 `introduce-channel-task-execution`，按用户选择覆盖全部 P0–P4；完成状态以其 tasks 与验收记录为准。运行协议、已验证组合和可重复命令见 [Task 执行与运维](../docs/TASK_EXECUTION.zh-CN.md)。

本文将讨论整理为可实施的模块边界、数据契约、接口、迁移顺序和验收场景。v0.4 中已记录的 D1、D2、D3 保持不变；本文新增的工程选择是建议实施默认值，不应描述为已经独立确认的产品决策。

本文保留设计不变量，并与正式 proposal、delta specs、design 和 tasks 相互对照。概念基线没有修改；实施没有切换业务 Workspace、运行生产迁移或归档 change。

## 1. 目标、范围与不变量

### 1.1 目标

在现有 Cumora 控制服务中建立以 Task 为中心的工作契约，复用会话、成员、消息、PostgreSQL、Redis、实时 outbox、云端 Pod、本地主机配对和引擎适配器。用户继续通过原群组或私聊交办工作，不需要先建小队。

保持 v0.4 四条数据流的责任与顺序：

1. 直接调用：归属解析 → 配置与授权 → 输入和记忆 → Agent → 动作检查 → 产物与发布 → 原 Channel → 候选记忆。
2. Aida 协作：父 Task → 计划 → 系统校验 → 同 Channel 子 Task → 执行 → 受控交接 → 汇总 → 原 Channel。
3. Runtime 交接：位置匹配 → 设备和数据目的地检查 → 受控上下文 → 动作检查 → 不可变产物 → 接收方检查 → 原 Task/Channel。
4. 知识流：来源与受众过滤 → 相关内容检索 → 接收方检查；候选提取 → 来源记录 → 归属与范围检查 → 受控保存或明确发布。

增加模块、字段和检查点不得改变这四条业务数据流。HTTP、SSE、队列和数据库事务只是实现方式。

| v0.4 基线 | 本文实施章节 | 保持的检查顺序 |
|---|---|---|
| §5 直接调用 | §5、§6、§7、§8.2 | Channel/Task → 授权 → 输入 → 执行 → 交付 → 记忆 |
| §6 Aida 小队 | §4.3、§5.3、§8.2 | 计划建议 → 系统校验 → 子任务 → 产物 → 汇总发布 |
| §7 Runtime 与交接 | §7、§8.1–§8.2 | 位置和目的地检查 → 受控执行 → 固定版本 → 接收方取回 |
| §8 可见范围与记忆 | §4.5、§8.3–§8.4 | 来源/受众过滤 → 检索；候选 → 来源/范围判断 → 保存或明确发布 |

### 1.2 第一版边界

- 同 Channel、已有有效 Binding 的一层委派；子 Task 不继续委派。
- Task Plan 支持 DAG；独立负责、独立验收的工作成为子 Task，Agent 内部步骤保留在计划或临时上下文中。
- 同一 Agent Identity 可以服务多个 Channel，但第一版每个身份同时只执行一个 Task；不同身份可以并行。会话轮换不能复用其他 Task 的上下文。
- 群组只导入可向该 Channel 共享的资料，不实现群组内仅部分成员可见的正文或交付产物。
- 第一闭环使用云端 Agent 循环、云端工具执行和获准云模型；后续闭环接入符合相同约束的本地执行组合与跨环境交接。
- Runtime 按实际能力准入；第一版只使用 Agent 当前有效设备分配，不通过修改全局设备分配实现任务级切换。
- 完整 Run 生命周期、通用重试编排、自动恢复、自动迁云、跨 Channel 委派和通用计费设计继续后置。
- 为避免重复执行和重复外部写入，保留必要的派发认领、操作事实和交付记录；它们不承担完整 Run 调度系统的职责。

### 1.3 必须落实的不变量

| 编号 | 不变量 | 落实位置 |
|---|---|---|
| I01 | Task 只能绑定一个有效 Channel，父子 Task 同租户、同 Channel | 数据库关系、Task 服务 |
| I02 | 执行负责人是有效 Binding，名称、模板或消息收件人不能代替身份 | Binding 服务、派发检查 |
| I03 | 授权来源必须合法；模型、Skill、Bundle 引用和宿主机登录态不能创造权限 | 授权服务、连接代理、执行环境 |
| I04 | 子授权只能收敛；Aida 协调权与其直接操作权分别判断 | 委派与动作服务 |
| I05 | 一个执行上下文只处理一个 Task，不隐式加载全部会话输入 | 上下文服务、Pod、daemon、session |
| I06 | 信息派生保留来源；归属、置顶、摘要或换 Agent 不扩大可见性 | 输入、产物、记忆、发布服务 |
| I07 | 受保护动作、读取和发布应用当前授权；配置快照不能抵消撤权 | 所有执行与读取入口 |
| I08 | 候选回复和产物检查通过后才能落入频道交付与广播链路 | 发布事务、消息存储、outbox |
| I09 | 交接和验证指向不可变内容；执行结束不等于工作交付 | 产物服务、交付服务 |
| I10 | 每个工作入口只有一个权威处理路径；失败不退回宽权限旧执行 | 入口适配、迁移门控、后台入口 |
| I11 | 数据目的地覆盖路由、分诊、embedding、主模型及工具返回处理 | 模型网关、知识服务、工具网关 |
| I12 | 审核通过、任务交付、执行完成分别记录，不互相自动覆盖 | Task、治理和观测适配 |

## 2. 当前架构与冲突证据

以下链接指向已有代码，作为实施时的入口索引。实际 schema 需结合 baseline 与追加迁移核实，不能只看 Drizzle 声明。

| 当前实现 | 证据 | 与目标契约的差距 |
|---|---|---|
| 群聊路由收窄，异常或歧义回退全员；可选 one-of-us 选举 | [routing.ts](../server/src/agents/routing.ts)、[scheduler.ts](../server/src/agents/scheduler.ts)、[routing-claims.ts](../server/src/agents/routing-claims.ts) | 消息响应协调不能成为 Task 负责权和授权来源 |
| 云端回合加载 Agent 全部未读，再按多个会话加载上下文 | [turn.ts](../server/src/agents/turn.ts)、[inproc-client.ts](../server/src/agents/runtime/inproc-client.ts) | 与单 Task 输入范围不兼容 |
| 本地 session 按 Agent、引擎和 provider profile 持久化 | [daemon.ts](../server/src/agents/computer/daemon.ts)、[session-store.ts](../server/src/agents/computer/session-store.ts) | 缺少 Task 和 Binding 的上下文隔离 |
| 运行中 session 可插入其他私聊消息；唤醒简报可合并 | [daemon.ts](../server/src/agents/computer/daemon.ts)、[wake-options.ts](../server/src/agents/runtime/wake-options.ts) | 不同任务不能合并成一个模型上下文 |
| 运行时 JWT 校验租户、Agent、Computer 和 assignment generation | [jwt.ts](../server/src/agents/runtime/jwt.ts)、[authorization.ts](../server/src/agents/runtime/authorization.ts) | 已有身份认证，但没有本设计的 Task Grant 与输入清单约束 |
| Agent FUSE 文件空间长期共享；文件接口按 Agent 读写 | [fs-namespace.ts](../server/src/agents/runtime/fs-namespace.ts)、[fs-endpoints.ts](../server/src/agents/runtime/fs-endpoints.ts) | 检索过滤不能限制对原始记忆文件的直接读取 |
| 项目记忆过滤；置顶和无项目来源内容默认全局；来源解析异常可退回全局 | [memory-scope.ts](../server/src/agents/memory-scope.ts)、[memory-write.ts](../server/src/agents/memory-write.ts) | 不满足 D2 的来源保留和显式发布 |
| Agent 待办按 Agent 保存，创建不要求 Channel | [migrate.ts](../server/src/db/migrate.ts)、[cli.ts](../server/src/agents/cli.ts) | `agent_tasks` 不能直接作为新 Task |
| 看板授权、父子 Action、审核与不可变产物绑定卡片 | [0007-organizational-governance.ts](../server/src/db/migrations/0007-organizational-governance.ts)、[governance-router.ts](../server/src/api/governance-router.ts) | 可复用机制，但领域实体不能直接等同于 Channel Task |
| Agent reply 经成员检查后写消息、实时 outbox；提示词允许 DM / pull-group 协作 | [cli.ts](../server/src/agents/cli.ts)、[personas.ts](../server/src/agents/personas.ts)、[realtime-outbox.ts](../server/src/realtime-outbox.ts) | 缺少任务发布契约；任务协作不能通过新群组改变归属 |
| 看板简报可用空 conversation 唤醒；日历会解析目标会话 | [kanban-wake.ts](../server/src/agents/kanban-wake.ts)、[calendar.ts](../server/src/calendar.ts) | 看板入口必须补齐 Channel；日历解析后还要进入 Task 服务 |
| 存储抽象可返回 public URL 或签名 URL | [storage.ts](../server/src/storage.ts) | 新受控产物必须使用受保护存储和授权取回，不能沿用任意公开 URL |
| 应用校验不可变迁移账本，仅支持显式 schema 范围 | [manifest.ts](../server/src/db/migrations/manifest.ts)、[schema-version.ts](../server/src/db/schema-version.ts) | 必须安排兼容版本和 expand/contract，不能假定旧版本支持新 schema |

## 3. 模块结构与权威边界

### 3.1 部署结构

第一版仍是一个模块化控制服务、PostgreSQL、Redis、受控对象存储、云端 worker 与本地连接器。无需按逻辑职责新增微服务。

```text
Messages / Calendar / Board / API / External Event
                       |
                       v
           Channel and Task ingress service
                       |
                       v
         Configuration and authorization resolver
                       |
                       v
             Task context and knowledge service
                       |
                       v
               Durable Task dispatch records
                       |
                 existing wake bus
                       |
               +-------+-------+
               v               v
          Cloud worker     Local connector
               |               |
               +-------+-------+
                       v
         Checked tools / connections / filesystem
                       |
                       v
        Artifact registry and publication service
                       |
         Messages + existing realtime outbox
                       |
                       v
                Original Channel
```

### 3.2 建议新增模块

名称为建议目录，可随仓库组织调整；职责和权威边界必须保留。

| 模块 | 唯一负责的事实 | 现有接入点 |
|---|---|---|
| `server/src/tasks/ingress.ts` | 入口关联、幂等创建、补充消息和歧义 | REST、WS、日历、看板、外部事件 |
| `server/src/tasks/service.ts` | Task、父子关系、负责 Binding、范围版本和交付状态 | Agent 协作、Task API |
| `server/src/agents/bindings.ts` | 当前频道有效 Agent Binding 与局部配置 | 成员增删、Agent 编辑、上下文 |
| `server/src/access/` | 资源、连接、Grant、数据策略、实时授权判断 | runtime HTTP、进程内客户端、工具代理 |
| `server/src/tasks/context.ts` | 经批准输入清单与执行上下文 | `AgentRuntimeClient`、Pod、daemon |
| `server/src/tasks/dispatch.ts` | 派发、独占认领和防重复启动 | scheduler、wake-bus、Pod、daemon |
| `server/src/artifacts/` | 通用内容版本、来源、取回和交接记录 | Storage、治理适配、Task 交付 |
| `server/src/tasks/publication.ts` | 候选交付校验、频道消息落库和事件语义 | reply、attachment、outbox |
| `server/src/knowledge/` | Channel/Agent 记忆、来源、失效与发布记录 | 现有 memory、FUSE、embedding |

进程内与 HTTP 路径都调用同一领域服务。身份认证可以因传输不同而不同，授权结果不能因部署不同而不同。

### 3.3 单一事实来源

| 事实 | 权威来源 | 不得用于替代的对象 |
|---|---|---|
| Workspace 所属 | `companies` / 成员关系 | Agent 文件目录、展示名称 |
| Channel 身份与成员 | `conversations` / `conversation_members` | 外部连接、thread、`members` JSON 投影 |
| Agent 身份 | Agent participant | Agent Definition、名称 |
| 任务负责与归属 | Task 与有效 Binding | 消息收件人、routing claim、待办、看板 assignee |
| 授权 | 有效 Access Grant、Task Grant 和当前策略 | Prompt、工具列表、静态配置快照 |
| 输入范围 | Task Input Manifest | 整个收件箱、全部历史、已读游标 |
| 内容版本 | Artifact Version | 分支名、绝对路径、模型描述 |
| Task 交付 | 受控 Delivery 记录 | `agent_runs.completed`、`set_turn_status=done` |
| 看板验收 | 现有治理审核和 finalize | Task 交付、执行结束 |

## 4. 数据模型与数据库约束

下述名称是建议实体/表名。新对象统一携带 `company_id`；API 可称 `workspaceId`，数据库沿用 `company_id`，不另建同义租户 ID。

调用主体使用带类型的 `PrincipalRef`：用户账号、已有授权的自动化入口或 Agent Binding。现有登录 `userId`、人类 participant ID 和 Agent participant ID 显式映射，不能因字符串相同而视为相同授权主体；外部消息作者也不是天然的 Workspace 成员。

### 4.1 复用与扩展

| 对象 | 实施契约 |
|---|---|
| `companies` | 继续承担 Workspace；增加个人/组织语义时使用兼容默认值，不强制重建现有租户 |
| `conversations` | 直接承担 Channel，复用 ID；扩展默认 Aida Binding、规则引用、配置版本、受众版本和工作入口模式 |
| `conversation_members` | 继续作为成员权威；新增/撤回成员和 Binding 状态变化在同一服务事务内协调 |
| `participants` | Agent 行承担 Agent Identity；关联定义版本；保留当前 ID、租户、退场和设备分配 |
| `messages` | 保留现有序号、引用与存储；通过关联表记录 Task 关系和消息用途，避免要求旧客户端理解所有新字段 |
| `agent_runs` | 增加 Task、Binding、context/dispatch 引用用于观测；保留已有治理 attempt 引用；不改变其完成语义 |
| `agent_tasks` | 保留旧待办；可增加 Task 引用并作为投影，不能反向创建或扩权 |

### 4.2 Agent 定义与 Binding

- `agent_definitions` / `agent_definition_versions`：定义标识、版本、职责、基础指令、能力需求、Subagent 引用、内容摘要、发布者。
- `channel_agent_bindings`：`id, company_id, conversation_id, agent_id, alias, definition_version_id, instruction_overrides, enabled_capabilities, direct_limits, delegation_limits, runtime_preferences, memory_policy, version, status`。
- 同 Channel、同 Agent 最多一个有效 Binding；使用部分唯一索引约束有效状态。
- Task 使用复合关系确保 Binding 的租户与 Channel 一致。创建和派发时再验证 Agent 为活跃 `kind='agent'`、成员关系有效。
- Binding 历史需要保留，不能将删除成员的级联删除传播到历史 Task。成员撤回时结束 Binding；重新加入可建立新 Binding，旧上下文不得因此恢复资格。
- 升级 Definition 或 Binding 明确产生新配置版本；不自动改变已创建 Task 的固定配置引用。

### 4.3 Task 与计划

| 实体 | 关键字段与约束 |
|---|---|
| `channel_tasks` | `id, company_id, conversation_id NOT NULL, creator_principal_id, accountable_binding_id, parent_task_id, root_task_id, objective, scope_revision, reply_target_ref, status, version, created_at` |
| `task_message_links` | Task、消息、用途 `TRIGGER/SUPPLEMENT/STATUS/DELIVERY`；重复入口关联幂等；跨 Channel 消息不能直接成为本 Task 输入 |
| `task_controller_grants` | 明确谁可补充、改目标、取消、改派；携带授权来源和有效性 |
| `task_plan_versions` | Task、不可变计划版本、提出者、校验结果、创建时间 |
| `task_plan_nodes` | 计划版本、node ID、负责 Binding、可选子 Task、输入契约、输出契约、验收条件 |
| `task_plan_edges` | 同一计划版本内节点依赖；服务校验无环，边两端必须存在 |
| `task_scope_revisions` | 目标/工作范围的不可变修订、操作者、变更依据；范围扩大必须关联有效授权 |
| `task_deliveries` | Task、scope revision、产物与证据版本、未完成项、交付校验和发布/交接位置 |

复合 FK 或约束触发器保证父子 Task 的 `company_id/conversation_id` 相同；根引用必须解析到同 Channel 根 Task。第一版只允许根 Task 创建一层子 Task。

建议最小 Task 状态为 `OPEN/BLOCKED/DELIVERED/CANCELLED`：表示目标与交付状态，不表示线程是否运行。范围修订后，旧 Delivery 仍是历史事实，但不能继续满足新修订的交付条件。`DELIVERED` 必须关联满足当前范围的 Delivery；阻塞原因保存结构化代码和可公开说明。

创建者默认拥有当前 Task 的补充、修改和取消权限，前提是仍为活跃成员且原调用资格有效；其他成员须有显式任务驱动授权。管理员身份不自动产生资源授权。自动化入口必须携带预先授予的主体和驱动资格。

### 4.4 资源与授权

| 实体 | 关键字段与约束 |
|---|---|
| `access_resources` | 资源类型、稳定资源标识、可校验范围，例如仓库/分支/路径、域名或 MCP 资源 |
| `access_connections` | 外部服务、实际访问身份、受控凭证引用、支持能力、有效状态；秘密不进入普通上下文 |
| `access_grants` / versions | 授权者与合法依据、调用主体、Workspace/Channel、目标 Binding/身份、资源、动作、参数范围、连接身份、数据目的地和有效期 |
| `access_bundle_versions` | 固定资源描述和 Grant/Connection 引用；分享版本不转授连接使用权 |
| `channel_access_refs` | Channel 对 Bundle 和额外授权的引用及来源；引用必须经过适用性校验 |
| `task_grant_versions` | Task、根来源、父授权引用、工作范围、执行目标约束、委派约束、版本及撤回状态 |
| `task_authorization_events` | 创建、收敛、拒绝、明确扩展、撤回的主体、依据与关联版本 |

每条授权保留完整关联条件。禁止分别合并资源、动作、身份和目标集合后拼出不存在的授权。例如“账号 A 只读仓库 X”和“账号 B 写仓库 Y”不能推出“账号 A 写仓库 X”。

根 Task Grant 从已有授权形成，可以允许指定专业 Agent 执行动作；Aida 自身仍受其直接限制。调查时只提供合法调查范围，后续确定修改目标：范围在既有 Grant 内则继续；超出时明确请求范围变更，由有权主体批准新修订后执行。

新增配置权限不自动扩大既有 Task。授权修订必须使旧执行上下文失效；子 Task 重新校验父范围，不能保留已被父任务撤回的动作。

### 4.5 输入、派发、产物与记忆

| 实体 | 关键字段与约束 |
|---|---|
| `task_input_manifests` | Task、scope/plan revision、输入引用、不可变版本、来源集合、相关性与接收方策略；每次执行按当前权限复核 |
| `task_execution_contexts` | Task、Binding、Grant、配置版本、输入 manifest、Runtime 三类位置、实际连接身份、目的地、有效期和撤回状态 |
| `task_dispatches` | Task、context、指定接收身份/设备、输入批次、唯一派发键、claim generation、lease、接收事实与结果引用 |
| `task_operation_records` | Task、context、规范化动作/参数摘要、操作幂等键、外部请求引用与 `PREPARED/DISPATCHED/SUCCEEDED/FAILED/UNKNOWN` 事实 |
| `artifact_versions` | 稳定 artifact ID、不可变 version ID、内容摘要、受控存储位置或 Git/补丁引用、Task、产生者、来源、读者及目的地策略 |
| `artifact_handoffs` | 发送/接收 Task 与 Binding、指定内容版本、取回与校验事实、证据所绑定版本 |
| `knowledge_entries` / versions | `owner_kind=CHANNEL/AGENT`、owner ID、正文版本、来源集合、确认/失效状态、受众与适用范围 |
| `knowledge_publications` | 选定条目版本、发布者、来源分享依据、目标 Channel/Workspace、有效性和撤回记录 |

授权关系、父子关系和有效版本尽量使用规范化关系及约束；JSON 用于不可变上下文快照和经服务验证的结构化范围，不能代替 FK 或实时授权检查。

来源表记录派生依赖，支持撤回后的索引、缓存与读取失效判断。无法确定来源时产生候选/待确认状态，不默认为全局可见。

## 5. 执行上下文与授权协议

### 5.1 身份认证与 Task 权限分开

保留现有 runtime JWT 作为 Agent 与设备认证。控制服务额外签发或保存短期任务执行能力，绑定 `Task + Binding + context + dispatch claim generation + Runtime`。

宽范围 runner 凭证只由受信控制进程持有，不能暴露给模型、shell、可写文件或模型控制的子进程。任务进程只拿任务级访问能力。共享 FUSE 挂载若使用宽范围 runner 凭证，不得进入任务沙箱。

任务 ID、客户端传来的 `--as`、环境变量和 wake 内容仅为关联信息；服务端从已验证身份和受控 context 推导权限。

每次受保护请求验证：

1. Agent、租户、设备分配和 claim generation 当前有效。
2. Binding 当前有效，Task 可驱动，scope/context revision 未被替换或撤回。
3. 操作者有权发起此操作，具体动作符合 Task Grant 和 Binding 的直接限制。
4. 资源、参数、连接身份和接收目的地满足当前策略。
5. 对派生内容再校验全部来源；持有引用不等于有读取权。

权限服务不可用时拒绝受保护动作或读取，不能回退 runner 的宽权限。

### 5.2 配置解析

普通设置按 Binding → Channel → Agent Definition → 系统默认解析。基础角色、Channel 规则、Binding 指令与任务要求组成工作说明；强制约束始终由结构化策略执行。

Skill/MCP 仅在“定义需要、当前授权允许、Task 需要、Runtime 支持”同时满足时启用。任务 Prompt 只列当前 Channel 的有效协作者和允许委派对象，不能继承整个租户都可 DM/pull-group 的任务协作假设。

群组默认选择合法的组织/频道服务连接；私聊默认选择合法个人连接。显式覆盖须验证适用授权。没有合适连接时阻塞；不得借用发起者或主机其他登录态。

配置入口支持定义版本安装、Binding 编辑、Bundle 引用、连接绑定、Grant 创建与撤回。资源管理者或合法代理的分享/授权资格必须由受信授权来源验证；频道管理员只管理 Channel 配置，不能凭该角色签发外部资源 Grant。第一版连接适配器限定为能够验证资源标识、访问身份、动作范围和分享依据的服务，不对任意 MCP 或 shell 自动推导这些保证。

### 5.3 建议领域接口

| 接口 | 输入 | 输出/行为 |
|---|---|---|
| `resolveTaskIngress` | 经认证主体、入口事件、Channel、消息/目标引用、幂等键 | 创建、补充、澄清或拒绝；解析负责 Binding |
| `resolveExecutionContext` | Task、scope revision、Binding、Runtime 候选 | 受控 context 引用或结构化阻塞原因 |
| `authorizeDelegation` | 父 Task、目标 Binding、工作和输入输出范围、计划版本 | 收敛子 Grant、子 Task 与派发，不增加根权限 |
| `authorizeAction` | 已验证执行能力、规范化资源/动作/参数、操作键 | 允许/拒绝和适用来源；实际秘密由代理使用 |
| `authorizeDataTransfer` | 内容/来源、接收身份、设备/模型/域名 | 许可或拒绝；失败不发送正文 |
| `resolveArtifact` | 当前主体、version ID、消费 Task/目的地 | 受控字节流和摘要；记录准确消费版本 |
| `publishTaskDelivery` | Task、scope revision、产物/证据版本、目标位置、幂等键 | 校验后原子写 Delivery、消息和 outbox |
| `publishKnowledge` | 条目版本、发布主体、目标范围、分享依据 | 显式发布记录或拒绝，保留来源 |

## 6. 入口、消息和唤醒的衔接

### 6.1 输入路由

启用新工作契约的 Workspace 中，各 Channel 工作入口统一进入 Task ingress。普通人类聊天仍可作为频道消息；一旦要求 Agent 承担实际工作或使用工具，就必须解析 Task。

- 显式 `@具体 Agent`：解析当前 Channel Binding，该 Binding 负责，Aida 不自动接管。
- `@Aida`：Aida 负责，可直接执行或提出受控委派。
- 无 `@`：优先使用显式 Task 引用、对应引用回复或已确认的任务选择；全新目标可交默认 Aida；多个可能目标时返回澄清，不选最近活跃任务。
- 模型可提供路由建议，不能决定调用资格或扩大输入范围。路由前检查该辅助模型的数据目的地；没有获准模型时采用确定性解析或澄清。
- 一条消息同时提到多个工作目标时，明确拆分为多个 Task 或计划，不将其作为全员自主接单指令。
- 消息已提交到 Channel 的事实不证明其中材料具有来源分享权。外部资源/附件导入需有结构化来源依据；系统不承诺识别用户粘贴文本的所有隐含限制，也不能以模型“已脱敏”声明授予分享资格。

### 6.2 非聊天入口

日历继续先解析已有目标会话，再使用已授权自动化主体创建 Task；无目标时明确阻塞，不静默新建带授权私聊。

看板动作使用显式卡片/看板工作 Channel 映射。现有 `wakeKanbanAgents(... conversationId=null ...)` 必须改为 Task ingress；没有映射时保存看板变更并返回工作阻塞，不能靠简报绕过 Channel。

API、定时、外部事件、idle、scanner 和 poll 路径均遵守相同要求：作为探测可仅发送无正文调度信号；发起实际工作时需解析有效 Channel、调用主体和 Task。不存在授权主体的后台机会性工作不执行。

### 6.3 唤醒协议

保留 Redis/SSE wake transport；增加版本化任务 envelope，至少含 `protocolVersion, dispatchId, taskId, contextRef, targetBindingId`。wake 不携带凭证、受限输入正文或完整授权。

runner 收到 wake 后向服务端查询并认领 dispatch，再取已批准上下文。数据库是派发事实来源，Redis 仅作通知；连接恢复主动查询未处理派发，不能只依赖有保留上限的 realtime outbox。

重复信号按 dispatch ID 去重，重复创建按入口幂等键去重。first version claim 使用数据库独占认领并记录 generation；同一 Agent 活跃 claim 排他。lease 到期仅表示控制权失效，不证明旧进程停止：runner 需本地执行锁和停止旧进程/沙箱的确认，不能在状态未知时启动第二个执行。

合并唤醒仅合并“有待处理派发”的通知，不合并不同 Task 的正文、背景简报或执行能力。旧 daemon 未宣告任务协议、隔离和代理能力时不能接任务，也不能忽略字段后退回普通 inbox 执行。

消息展示仍使用现有实时通道。Task `STATUS/DELIVERY` 事件不再作为独立新任务或全员执行触发；用户引用这些消息补充要求时，通过 Task link 返回原 Task。

### 6.4 任务内 steer

steer 先解析 Task、驱动主体和 scope revision。仅把同 Task、已通过输入检查的补充内容交给相关执行者。其他 Task 的消息进入各自队列，不注入正在运行的 session。

扩大目标或权限的 steer 不能只修改 Prompt，必须产生已授权范围修订和新的执行上下文。当前动作处于结果未知时先记录事实，不能把中断等同于失败后自动重试。

## 7. Runtime、工具和上下文隔离

### 7.1 执行器改造

保留 `runAgentTurn` 的模型/工具循环，但增加独立任务入口，例如 `runTaskTurn(contextRef)`。任务路径只能通过 Task Context API 获得输入，禁止调用现有全收件箱聚合路径；也不能通过旧 `/inbox`、`glance`、history、DM 或文件接口取回任务外资料。

Context Manifest 引用触发消息、明确补充、选定相关历史、记忆与产物版本。即使同 Channel，多任务也不自动共享全部历史；相关背景可在合法过滤后显式加入。

`loadContext`、`loadMemory`、persona、Skill、工具返回和附件正文统一经接收方/目的地检查。观测记录写 Task/context 引用和允许公开的摘要，原始工具输出不能自动成为公开日志或通知。

### 7.2 本地引擎 session

session 身份至少包含 `companyId + agentId + bindingId + taskId + engineId + providerFingerprint + contextCompatibilityGeneration`。

同 Task 的普通补充可在复核后续用 session；授权、来源可见性、提供方或不兼容配置变化时建立新 session，仅重新加载当前可用内容。旧 session 指针保留为历史但不得成为回退路径。

session 存储采用服务端确定的稳定 ID/hash，不拼接用户输入为文件路径。模型不能读取其他 Task 的引擎 transcript、session 文件或缓存。仅更换 session key 而仍暴露整个 Agent home，不满足隔离要求。

### 7.3 文件空间

任务目录按 Task/context 组织，使用独立工作目录或 worktree；共享可变代码路径只有明确单一写入责任时才允许。交接通过产物版本进行。

原 Agent home 由受信 runner 管理；任务沙箱获得 persona/Skill 的经批准版本、任务所需记忆视图和工作目录。长期记忆写入走候选 API，不能让模型直接修改全局记忆文件或 persona 来影响其他任务。

任务 FUSE/文件代理必须按任务级能力过滤 `list/read/write/stat`，同时限制目录枚举和元数据。原全量 `/workspace` 挂载或本地 Agent home 不能以“检索已过滤”为由进入新任务沙箱。

第一闭环建议使用短生命周期任务执行子进程/沙箱，现有长驻 Pod/daemon 作为受信 supervisor。云端身份数据以受控方式装入任务视图，不能将历史全量 FUSE 与 runner 令牌继承给子进程。

### 7.4 Runtime 准入与位置

设备心跳/配对扩展声明任务协议版本、session 隔离、文件隔离、网络约束、连接代理、进程控制和支持引擎；服务端维护实际验证结果，不能只相信客户端自报。

首期沿用 Agent 当前 Computer 分配。Binding 偏好和 Channel 策略过滤这套有效组合；无法满足时阻塞。设备分配变更继续沿用现有 assignment generation 失效机制。

Cloud/Local 和引擎名称不等于能力保证。每个组合分别记录 Agent 循环位置、工具位置和模型端点，并验证设备所有者、信任主体及网络目的地。

后续云端循环调用本地工具可增加远程工具适配器，但必须保持相同 Task/context、动作检查和结果目的地检查。不得为实现组合而静默修改 Agent 的全局 Computer 或借用另一设备身份。

### 7.5 工具与撤权

CLI/MCP/HTTP 工具先规范化动作和资源，再在执行点判断。长期凭证留在受信连接代理；任务只能请求当前 Grant 允许的操作。

通用 shell 需要实际目录、网络、进程及凭证隔离。外部仓库写入应通过可验证的代理动作或任务范围凭证；若 shell 可直接使用长期账号任意推送，该 Runtime 不能声称满足分支/路径级硬限制。

长驻进程和已发放访问也要定义撤权传播：撤回后禁止新调用、关闭受控连接、失效任务能力；已在执行的外部请求记录实际结果或未知。短期授权必须规定有效期，不能承诺撤回已发生的外部操作。

外部写操作先保存操作记录和规范化请求摘要，使用工具支持的幂等键；网络超时或中断时记录 `UNKNOWN`，先查询/对账。只允许明确无副作用的读取自动重试，不能以重新派发 Task 代替外部操作幂等。

## 8. 产物、发布、记忆与治理

### 8.1 通用产物与治理适配

新增通用 Artifact Registry，使用现有 Storage 的字节存取实现，但单独建立受保护对象前缀和授权取回接口。不能把新受限产物放入公开静态目录或只添加前缀而不修改访问门控。

内容 hash、version ID、Git commit 或固定补丁内容保持不可变；浮动分支只用于说明。验证记录绑定输入 version ID 与摘要、测试环境及测试证据版本。

现有 `governance_artifact_versions` 继续保留其卡片领域记录。适配器为已有产物建立稳定映射并读取原内容/版本；一个外部版本只映射一个通用版本。若写入两类元数据，必须同事务并以不可变 hash 验证一致性，不能维护两份可变正文。新普通 Task 不强制创建看板卡片。

治理请求同时满足通用 Task 授权与原 Mandate/Action/审批条件，不能因为绑定 Task 就跳过审核。治理预算继续使用原实现；普通 Task 的成本记入现有观测账本，不伪装成治理 attempt。

### 8.2 交接与交付

子 Task 向父 Task 提交结构化结果、产物版本、证据、未知项和失败原因。交接前检查目标接收者、Runtime 和准确版本。内部结果通过 Task 记录/事件传递，无需创建 DM 或 Agent-only group；内部日志仍按自身策略读取。

Aida 只接收有权接收的内容。委派前确认预期验收所需的证据可以合法交接；不能仅凭子 Agent 的“完成”声明交付需要验证的工作。

普通直接回复也作为当前 Task 的文本交付保存版本和来源。`set_turn_status=done` 只表示执行器声明，不直接写 Task `DELIVERED`。

`publishTaskDelivery` 在当前范围、产物完整性、来源和受众检查通过后，同一事务写 Delivery、Task 状态、目标消息及 realtime outbox。参与撤权和成员变化的记录使用一致锁序或版本 CAS，使发布与撤回/成员变化有明确先后。沿用现有成员操作的 participant → conversation 锁序，再按稳定顺序锁 Task/授权记录。

Task 产物下载第一版走在线授权代理，流开始前检查当前权限；每次新的读取重新检查。不向受保护交付暴露可长期复制的 bearer 下载 URL。若未来支持短期签名下载，须单独定义失效窗口和撤权传播契约。

### 8.3 D3 与成员变化

导入前确认资料可用于该群组，并分别确认接收 Agent、设备、模型端点。来源未知时限制为已配置的频道共享范围，否则拒绝该导入；不能先传给模型再判断是否可共享。

不兼容时，原 Task 保留 Channel 和无受限正文的阻塞说明。用户选择已有授权私聊后创建新 Task；旧 Task 不迁移，材料复制和引用重新授权。

新增成员前检查将向其开放的历史资料是否兼容。无法确认时，第一版拒绝生效该成员变更并说明需要有权主体调整授权；不通过自动新建受限历史区改变 D3。成员撤回与历史、产物读取检查共同失效，但不承诺撤回已合法展示的副本。

### 8.4 D2 与记忆

新知识服务维护 Channel 和 Agent Identity 两种归属。Task 草稿、原始日志和推测默认属于临时上下文/Artifact；只把具有长期价值的候选送入知识流程。

`pinned` 只表达重要性。条目归属于 Agent 不表示全 Workspace 可用；来源 Channel 限制默认保留。来源未知的旧条目保留存储但不进入新 Task，直至确认来源或由有权主体针对确定内容明确发布。

跨 Channel 发布记录选定内容版本、全部来源、分享依据、发布者和批准范围。发布不转授原材料、原连接或其他记忆。多来源约束同时满足，不能对受众取并集。

embedding 写入、语义查询、摘要和候选提取都先做模型目的地判断。没有获准 embedding 服务时允许词法/结构化检索，不能回退未授权提供方。索引和缓存保留来源与授权关联，检索后仍复核当前权限。

来源撤回后，相关条目/发布记录进入重新判断；无法证明仍合法时不返回。生成新 session 时不加载旧撤回内容；删除传播、备份保留和供应商副本策略另行规定，不将它们等同于普通访问撤回。

## 9. API、事件与错误契约

以下为建议接口草案，挂载方式沿用现有 API/runtime router。所有标识都是选择器，不能充当权限证明。

| 面向对象 | 建议接口 | 契约 |
|---|---|---|
| 配置用户 | `POST /agent-definitions/:id/versions` | 版本发布资格、能力需求和内容来源；定义发布不访问安装者私有数据 |
| 配置用户 | `POST /conversations/:id/agent-bindings` | 有效成员/Agent、配置权限、局部限制；安装默认 Aida 同样遵守资格和配额 |
| 配置用户 | `POST /conversations/:id/access-refs` | Bundle/Connection/Grant 引用的当前适用性检查，不转授秘密 |
| 授权用户 | `POST /access-grants`、`POST /access-grants/:id/revoke` | 验证资源授权来源，撤回传播至 context、连接、读取和派发 |
| 客户端 | `POST /conversations/:id/tasks` | 经认证主体、目标 Binding/默认 Aida、目标、输入引用和 idempotency key |
| 客户端 | `POST /tasks/:id/supplements` | 消息引用、expected scope revision、驱动权限和输入检查 |
| 客户端 | `POST /tasks/:id/scope-revisions` | 明确目标/范围变更、版本与授权依据；不得隐式扩权 |
| 客户端 | `POST /tasks/:id/cancel` | 驱动权限；撤回后续动作能力，保留未知外部操作事实 |
| 客户端 | `GET /tasks/:id` | 当前访问检查；返回可公开状态、责任和交付引用 |
| 受信 runner | `GET /runtime/task-dispatches` | 只返回当前身份/设备可接收的派发；用于重连排空 |
| 受信 runner | `POST /runtime/task-dispatches/:id/claim` | 数据库认领、唯一 generation、排他执行条件 |
| 任务执行器 | `GET /runtime/task-contexts/:id` | 使用任务级能力，只返回过滤后输入和有效配置 |
| 任务执行器 | `POST /runtime/tasks/:id/plan-versions` | 模型建议，经服务端验证后成为有效计划 |
| 任务执行器 | `POST /runtime/tasks/:id/delegations` | 同 Channel、有效 Binding、一层委派、收敛授权与输入输出 |
| 任务执行器 | `POST /runtime/task-actions` | 规范化工具动作、context、操作键，执行与结果转移分别检查 |
| 任务执行器 | `POST /runtime/tasks/:id/deliveries` | 提交准确产物、证据与未完成项，不直接广播 |
| 用户/Agent | `GET /artifact-versions/:id/content` | 当前访问与目的地检查，受控流；引用不会授予读取权 |
| 用户 | `POST /knowledge/:id/publications` | 指定条目版本、目标范围与来源分享依据 |

事件建议包括 `task.created, task.blocked, task.scope.changed, task.dispatch.ready, task.delivery.published, artifact.handoff.recorded, knowledge.publication.changed`。事件附带 Task、Channel、版本、关联 ID 和用途；正文仅按受众检查后出现。UI 更新事件与执行派发事件分开，展示通知不再次触发接单。

关键错误使用稳定代码，例如：

| 错误代码 | 含义与行为 |
|---|---|
| `CHANNEL_REQUIRED` | 无合法归属，保留入口阻塞，不能执行 |
| `TASK_TARGET_AMBIGUOUS` | 无法定位唯一任务，要求选择，不静默猜测 |
| `BINDING_INACTIVE` | 成员/Binding/Agent 无效，不寻找宽权限替代 |
| `TASK_DRIVE_DENIED` | 当前主体不能改变或继续驱动任务 |
| `GRANT_SCOPE_EXCEEDED` | 请求超出授权上限，转明确范围变更 |
| `DATA_AUDIENCE_INCOMPATIBLE` | 资料不能用于当前群组，不导入正文 |
| `DATA_DESTINATION_DENIED` | 模型、设备或网络目标不获准，不发送内容 |
| `RUNTIME_CAPABILITY_MISMATCH` | 协议或隔离能力不足，不退回旧执行 |
| `CONTEXT_STALE_OR_REVOKED` | 当前上下文已失效，需重新解析 |
| `ARTIFACT_VERSION_MISMATCH` | 内容不符，不声明验证完成 |
| `OPERATION_OUTCOME_UNKNOWN` | 外部动作结果未知，先对账，不自动重放 |

错误详情与阻塞说明也经过发布检查，不泄露受限资源名称、正文、账号或链接。

## 10. 兼容、迁移与回滚

### 10.1 切换单位与旧执行封闭

建议 Workspace 为最终执行切换单位。原因是现有同一 Agent 的 inbox、home 和 session 可以跨多个 Channel；仅改一个 Channel 的路由会留下同进程宽权限旁路。

Workspace 模式采用 `LEGACY/PREPARING/TASK`：

- `LEGACY`：现有行为，不宣称符合本文任务隔离保证。
- `PREPARING`：建立定义/Binding、合法资源与来源映射、升级 runner；停止新增旧 Agent 工作，等待或明确终止旧执行，处理未知操作；只允许无副作用的影子解析。
- `TASK`：全部 Agent 工作入口、主动扫描、日历、看板和工具能力受新服务约束。旧 runtime API 只保留受信 supervisor 所需控制操作，模型执行者不能使用宽范围内容和动作接口。

切换前清空旧待执行消息为必要条件之一，但“标记已读”不能替代任务关联：已确认未交付工作显式建立 Task link，无法归属的工作保留阻塞。旧消息与资料不会自动变成所有新 Task 的输入。

不能在同一受保护身份的旧 session 中同时运行 LEGACY 与 TASK 工作。若需要小范围试点，使用隔离测试 Workspace 或确实隔离的身份与资源，不通过给同一身份混用两套执行达到试点。

### 10.2 数据迁移规则

1. 保留 company、conversation、participant、message ID；以已有活跃 Agent 成员建立有效 Binding。
2. 从现有角色/Prompt/工具配置生成有来源的初始 Definition 版本；已有 Agent 关联该版本，不伪造历史版本。
3. 为 Channel 显式选择合法默认 Aida Binding；不存在 Aida 时按现有配额和创建流程安装，不能绕过配额或擅自转授资源。
4. 连接/授权由合法配置和有权主体建立，不能从主机中扫描登录态推断授权。
5. `agent_tasks` 和看板卡片保留原记录；仅把确认归属的未交付工作映射成 Task，保留映射依据。
6. 旧 Agent Memory 和引擎 session 保留；未知来源条目隔离，不自动发布；旧 session 不用于新任务。
7. 现有治理产物通过不可变映射接入；原历史审核状态不改写。
8. 新任务产物和知识采用受控路径；同步更新租户删除、GC、保留策略和外键处理，避免新对象被当作存储孤儿删除。

### 10.3 schema 与发布顺序

遵守现有 migration checksum 账本：只追加迁移，不能修改已应用 SQL、checksum 或历史编号。迁移序号在实施时按实际最新 manifest 分配，本文不预占编号。

实施版本的 manifest 支持范围为 `14..19`。迁移 15 建立任务体系，16 增加执行与引用约束，17 增加消息来源版本、不可变输入和治理映射，18 增加撤权、保留与生命周期约束，19 固定 Task 定义和局部配置；历史 1–14 不变。schema 14 只支持 LEGACY/兼容准备，实际 TASK 要求完整 schema 19。首先升级全部服务副本，再由迁移进程应用追加迁移；正常服务启动只验证 schema，不自行修改数据库。

随后部署新控制服务和能力合格的 Pod/daemon，在 PREPARING 完成数据与资源准备，通过验收后原子切换 Workspace。最后才能收紧旧入口和删除兼容投影。测试初始化、租户清理和 migration invariant 检查随新 schema 更新。

### 10.4 回滚边界

配置回滚不等于把正在执行的 Task 退回旧 Agent。已切换 TASK 的 Workspace 在回滚时停止新派发、撤回任务执行能力、保留 Task/产物/操作事实，等待支持新 schema 和新数据的兼容版本恢复。

只回退到已验证支持当前 schema 的服务版本；不能直接回退到仅支持 schema 14 的旧二进制。短期不做破坏性 down migration；未知外部写入须先对账。已交付数据和外部动作不会随应用回滚自动撤销。

## 11. 实施阶段与 OpenSpec 拆分

OpenSpec change `introduce-channel-task-execution` 包含下表 10 个 capability，使用实际 CLI scaffold 和 instructions 管理实施。

### 11.1 阶段与退出条件

| 阶段 | 实施范围 | 退出条件 |
|---|---|---|
| P0 · 基础与兼容准备 | schema 扩展、定义/Binding/Task、授权与输入契约、协议版本、Workspace 模式和存储门控 | 仅影子解析，不实际执行；迁移/回滚准备、租户与归属约束通过 |
| P1 · 云端直接调用闭环 | 单 Task 执行、隔离任务视图、CLI/文件/模型门控、受控交付、最小 Channel/Agent 知识、全部工作入口适配 | 简单回复与明确工具工作可回原 Channel；六类旁路封闭；旧调用不得兜底；符合来源限制 |
| P2 · Aida 一层协作闭环 | DAG、子 Task、授权收敛、独立工作目录、产物交接和验证汇总、治理适配 | 修复与验证示例完成；Aida 只读协调仍能安排合法专业动作 |
| P3 · 本地与跨环境闭环 | daemon Task 协议、任务 session、沙箱和连接代理、精确产物取回、离线与未知操作处理 | 合格本地 Runtime 验证同一版本；旧/不合格引擎被拒绝，断连无自动重放 |
| P4 · 经验发布与扩展 | 知识显式发布、撤权传播和索引缓存失效、性能与管理交互 | 跨 Channel 仅使用批准条目；来源撤回后所有读取路径重新判断 |

P1 所需的来源隔离、当前授权检查、候选记忆和安全检索不能推迟到 P4。P4 扩展的是跨 Channel 发布和管理能力。

阶段能力尚未实现时返回结构化阻塞：P1 遇到委派、本地执行、跨 Channel 经验发布或未接通的治理工作，分别等待对应后续阶段，不能转普通旧回合继续执行。P1 中已治理卡片的任务保留原治理条件；在通用 Task 与治理适配未完成前禁止产生相关受保护动作。支持全部入口表示所有入口经过同一归属和授权门控，不表示首期可以执行所有场景。

### 11.2 建议 capability

| capability | 需求内容 | 主要阶段 |
|---|---|---|
| `channel-task-routing` | 所有入口归属、任务关联、调用与驱动资格、唯一负责 Binding | P0/P1 |
| `agent-definitions-and-bindings` | 定义版本、租户身份、有效成员绑定与局部配置 | P0/P1 |
| `task-access-control` | Bundle/Connection/Grant、直接与委派、当前授权、数据目的地 | P0/P1/P2 |
| `task-context-isolation` | 输入 manifest、session、文件视图、steer 与旧接口旁路 | P1/P3 |
| `task-runtime-dispatch` | 受控派发、设备准入、认领与未知结果、协议兼容 | P1/P3 |
| `task-plan-delegation` | 一层子 Task、DAG、负责人、验收和有界工作 | P2 |
| `task-artifact-delivery` | 内容版本、受控取回、精确验证、交接和原 Channel 发布 | P1/P2/P3 |
| `channel-agent-knowledge` | 两类记忆、来源、候选/确认、显式发布与撤回 | P1/P4 |
| `task-governance-compatibility` | 看板领域规则、Task/Action 映射、审核与完成语义 | P2 |
| `task-workspace-migration` | 旧入口封闭、数据准备、schema 兼容与回滚 | P0/P1 |

本次按用户选择在一个 change 内完成 P0–P4，包含依赖齐全的 proposal/specs/design/tasks。各阶段边界与退出条件仍用于验证，不将来源检查或发布门控拆成独立上线的半成品。

### 11.3 实施影响文件

| 范围 | 已有文件或目录 | 预期变更 |
|---|---|---|
| 数据库 | `server/src/db/migrations/`、`manifest.ts`、`migrate.ts`、`schema.ts` | 追加 schema、约束、支持范围和测试初始化 |
| 入口 | `api/router.ts`、`ws.ts`、`calendar.ts`、`agents/kanban-wake.ts`、`agents/private_chat.ts` | 接入 Task ingress，消息/任务关联，非聊天归属 |
| 成员/配置 | `agents/create.ts`、`agents/membership.ts`、`agents/personas.ts` | 定义/Binding、失效、任务协作者 Prompt |
| 路由/后台 | `agents/scheduler.ts`、`routing*.ts`、`idle.ts`、`scanner.ts`、`agenda.ts` | 新旧唯一入口、定向派发、自动化主体 |
| 执行/传输 | `agents/turn.ts`、`runtime/client.ts`、`inproc-client.ts`、`http-client.ts`、`server.ts`、`wake-bus.ts`、`wake-options.ts`、`pod-agent.ts` | 任务入口、受控 context、认领与协议，不合并正文 |
| 工具/文件 | `agents/cli.ts`、`tools*.ts`、`runtime/pod-tools.ts`、`native-tools.ts`、`fs-namespace.ts`、`fs-endpoints.ts`、FUSE/容器配置 | 统一动作检查、任务视图、秘密隔离、发布入口 |
| 本地 | `computer/daemon.ts`、`engine.ts`、`session-store.ts`、`registry.ts`、固定 MCP/IPC shim | Task session、受信 supervisor、能力准入和代理 |
| 知识/存储 | `memory-scope.ts`、`memory-write.ts`、`embeddings.ts`、`storage.ts`、存储访问门控与 GC | 来源约束、受控前缀、embedding 目的地与保留 |
| 治理/观测 | `api/governance-router.ts`、`governance/runtime-budget.ts`、`agents/observability.ts`、`llm-ledger.ts` | 领域适配、Task 关联、原审核/预算不绕过 |
| 客户端 | `src/stores/messages.ts`、`conversations.ts`、`src/desktop/ChatPane.tsx`、`src/mobile/MobileChat.tsx`、`src/components/Message.tsx` | Task 引用、歧义选择、可见状态和交付，兼容旧消息 |
| 运行生命周期 | 租户删除、Agent 退场、Computer 撤回、对象 GC、outbox worker、shutdown | 新对象保留/清理、撤权传播与未知操作处理 |

## 12. 验收与测试矩阵

场景应转成 OpenSpec `WHEN/THEN` requirements，并实施可失败的集成测试；不能仅断言新增字段存在或 Prompt 包含限制文字。

| 编号 | 场景 | 必须观察到的结果 |
|---|---|---|
| A01 | 群组、私聊、日历、API、看板和后台发起工作 | 执行前都有唯一有效 Channel、主体和 Task；无归属不得执行 |
| A02 | `@代码 Agent` 与 `@Aida` 分别发起 | 负责 Binding 正确；Aida 不自动接管前者 |
| A03 | 同 Channel 两个 Task，补充消息目标不明 | 澄清；不按最近活跃任务选择 |
| A04 | 两副本处理重复入口，重复 wake 与重连 | 只创建一个 Task/派发；只允许一个有效执行 claim |
| A05 | claim 到期但旧本地进程停止未确认 | 不启动第二个执行；明确未知/阻塞 |
| A06 | 同一 Agent 先后处理两个 Channel/Task | 模型输入、session、原始文件与缓存无任务外内容 |
| A07 | 另一个私聊在 Task 执行中到达 | 不注入当前 Task，独立排队 |
| A08 | 非授权成员补充/取消/改目标 | 被拒绝；发言权不等于 Task 驱动权 |
| A09 | Aida 无直接写权、有合法委派权 | Aida 自写被拒绝；专业 Agent 在限定资源/身份内可写 |
| A10 | 子 Task 请求更宽资源、更高动作或二层委派 | 拒绝；授权链和父范围保持可追溯 |
| A11 | Agent 同名、定义同版本但 Workspace 不同 | 身份、连接、记忆和 Task 无交叉访问 |
| A12 | Bundle 被复制到另一 Channel | 不继承连接使用权，无适用授权则拒绝 |
| A13 | 不同账号/资源/动作的授权组合 | 不产生未授权的交叉组合 |
| A14 | 工具执行中撤权、Binding 结束或设备分配变化 | 新动作/读取被拒绝；现有结果记录事实，不自动撤回或重放 |
| A15 | 尝试旧 CLI、FUSE、history、DM、shell 凭证或 inbox 绕过 | 新任务上下文无法取得范围外能力和内容 |
| A16 | 群组导入仅发起者可读资料或来源不明资料 | 导入前拒绝；模型、日志、产物、候选记忆未获得受限正文 |
| A17 | 群组增加不能读取现有共享来源的成员 | 历史开放前阻止成员变更，等待授权调整 |
| A18 | 发布与撤权/成员变化并发 | 事务有明确先后；无过期授权发布和不受控广播 |
| A19 | 置顶、来源未知、摘要后的 Agent 记忆跨 Channel | 不自动可用；明确有效发布后仅批准范围可用 |
| A20 | 来源撤回后访问索引、缓存、原始记忆文件 | 所有路径应用当前限制 |
| A21 | 主模型获准，但 embedding/路由提供方未获准 | 不向未获准端点发送内容；使用合法替代或阻塞 |
| A22 | 测试 Agent 消费浮动分支或错误产物版本 | 不宣称验证完成；证据绑定准确 version/hash |
| A23 | 测试/产物不能合法交给 Aida | 委派前阻塞，或交接时明确失败；不以“完成”替代证据 |
| A24 | 回复写库成功但 Redis 断开 | 消息与 outbox 一致；恢复后展示，不重新接单 |
| A25 | 外部写入成功后网络超时或主机断连 | 记录 `UNKNOWN` 并对账，不重复写入、不静默迁云 |
| A26 | 旧 daemon、未验证引擎或隔离能力不足 | 拒绝任务，不降级全收件箱/无沙箱执行 |
| A27 | Agent turn 完成、子 Task 交付、看板待审核 | 三类状态独立；看板保持原审核规则 |
| A28 | schema 升级、混合版本与应用回滚 | 只支持明确兼容范围；历史迁移 checksum 不变；Task 不回退宽权限旧执行 |
| A29 | GC 或租户删除处理新产物/Task | 正确保留/删除和关联处理；有效产物不被当作孤儿清理 |
| A30 | “定位并修复 → 独立验证 → 汇总”完整例子 | 同 Channel、受限子任务、不可变交接、合法原位置交付和来源受限记忆 |

### 12.1 检查方式

- 单元测试覆盖关联授权条件、计划无环、范围收敛、session 身份和上下文过滤；测试必须覆盖拒绝路径。
- PostgreSQL/Redis 集成测试覆盖 FK、事务、CAS/锁、重复事件、outbox、撤权/发布并发和迁移。使用专用测试数据库，不能只以 mock 证明权限和并发行为。
- Pod/daemon 场景验证真实文件、进程、网络、MCP/CLI 与旧接口隔离；仅设置 shell cwd 或 Prompt“只读”不算通过。
- 客户端验证 Task 歧义选择、正确回复位置、阻塞状态与原消息兼容；不要求用户理解 Grant/context 内部结构。
- 对比单 Agent 与协作的交付质量、耗时、模型用量和人工返工；第一版设置有限子任务数/并发上限，默认建议最多 8 个子 Task、4 个并行成员，配置只能在平台上限内调整。

沿用仓库已有检查入口：`npm run server:typecheck`、涉及客户端时 `npm run typecheck`、相关 `npm test` 测试和专用数据库下的 `npm run test:integration`。集成 runner 未配置数据库时会跳过，跳过不能报告为通过。模型调用和引擎接入变更同时运行相关 `guard:*` 脚本。

验收使用 [Task 执行与运维](../docs/TASK_EXECUTION.zh-CN.md) 的专用环境命令，保留实际 assertion counts、日志与报告。矩阵是必须满足的行为契约，不用类型检查或跳过的测试代替运行证据。

## 13. OpenSpec 使用方式

继续实施使用 `$openspec-apply-change introduce-channel-task-execution`，查询进度使用 `openspec instructions apply --change introduce-channel-task-execution --json`，严格验证使用 `openspec validate introduce-channel-task-execution --strict`。此 change 覆盖全部 P0–P4；后续扩展基于实际 specs 和已准入组合另建 change。

实施时若发现必须改变 v0.4 的归属、授权或数据流，先修订对应规划并明确决策，不能以“兼容现有代码”为由静默改变基线。

完整 Run、跨 Channel 工作、群组部分成员交付、自动恢复/迁移，以及外部存储和模型供应商的删除保证，继续作为独立后续设计。新增能力不得绕过本文不变量。
