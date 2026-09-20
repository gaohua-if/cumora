# AgentRunner / Codex 常驻会话问题记录

> 记录日期：2026-09-16  
> 性质：已验证现状、风险分析与改造建议；本文档不代表已实施修复。

## 1. 背景

BYOA Computer 为每个 Agent 创建一个 `AgentRunner`。Codex 引擎通过长驻的
`codex app-server --listen stdio://` 运行，`AgentRunner` 在后续消息、Agenda 和看板唤醒中
重复向同一个 Codex thread 发送 turn。

这一设计消除了每轮启动 CLI、初始化 MCP 与重读基础指令的冷启动成本，也使
Agent 能够记住进行中任务。但当 thread 的隔离粒度是“每 Agent 一条”时，不同群聊、
私聊、项目和后台 Agenda 会共享上下文。

## 2. 已验证的实现事实

1. `AgentRunner` 只持有一个 `engineSession` 和一个 `sessionId`。
2. `CodexSession` 只管理一个 `threadId`；后续唤醒通过 `turn/start` 追加到该 thread。
3. 普通聊天、手动唤醒和 Agenda 回合都调用同一个 `ensureEngineSession()` / `session.send()`
   路径，没有按 conversation 或 project 分流。
4. thread ID 持久化在 `~/.cumora/sessions/<agentId>/codex.session`，daemon 重启后执行
   `thread/resume`，因此上下文跨进程重启保留。
5. 当前 daemon `0.18.4` 已按 Agent、engine 和 provider profile 隔离 session 文件，
   能避免跨引擎或跨供应商恢复，但仍未按 conversation/project 隔离。
6. standing prompt 在 thread 创建/恢复时作为 `developerInstructions` 传入；每轮只追加
   动态 delta。
7. 每轮会刷新当前 UTC 时间、未读 inbox、实时 roster、triage 结论和 memory
   索引；这些数据不只依赖 thread 中的旧快照。
8. Codex 原生 context compaction 负责压缩 thread。Cumora 只观测 compaction 事件，
   不管理压缩内容。
9. 只在上下文溢出、transcript 损坏或 resume target 不存在时自动丢弃 session。
   当前没有基于年龄、turn 数、token 数或任务边界的主动轮换。
10. `AgentRunner` 串行执行同一 Agent 的 turn；执行中的其他唤醒会合并为一次后续
    rerun，不会并发写同一 thread。

## 3. 当前环境证据

- Iris 的 Codex session 文件存在于
  `~/.cumora/sessions/iris-46d7/codex.session`。
- Iris 的当前持久 thread 于 2026-09-16 02:57（Asia/Shanghai）创建。
- 日志显示该 thread 先后处理了“机房运维”群聊回合与多次 Agenda 回合。
- 在本次检查范围内，未发现 Iris 的原生 context compaction 或强制 fresh-session
  日志。
- 运行中 daemon 为 `cumora@0.18.4`，本地 Server 为 `0.16.2`，存在自动更新导致的
  版本偏移。

## 4. 发现的问题

### F1：不同会话共享同一模型 thread

**严重度：高**

同一 Agent 在群聊、人机私聊、Agent 私聊和其他项目中的 turn 会进入同一 thread。
风险包括：

- 私聊信息影响后续群聊判断；
- 模型不慎在错误会话中引用其他会话的信息；
- 不相关项目的目标、语气与未完成意图相互污染；
- 当前 memory 注入已按项目收窄，但 thread 历史绕过了该隔离边界。

### F2：旧目标和已结束任务可长期影响行为

**严重度：中高**

thread 没有 TTL 或任务完成边界。已经收口的工作仍留在上下文中，新的 Agenda
提示又可能声称“存在真实工作”，形成新旧指令拉扯。外在表现可能是反复检查、
重复表态、旧任务突然回流或不必要的主动行为。

### F3：Persona/模型配置更改不一定获得干净语义边界

**严重度：中**

name、role、system prompt 或 model 变更会重建 `AgentRunner`，但 engine/provider 未变时仍可
恢复原 thread。新的 `developerInstructions` 会与旧交互历史同时存在，可能使新旧
Persona 的行为特征混合。

### F4：原生 compaction 是不透明、有损的行为边界

**严重度：中**

Codex 自动压缩可以避免立即溢出，但压缩结果不是业务事实源。细节丢失、错误归纳或
对历史意图的偏向性摘要，都会导致 compaction 前后的行为不一致。持久决策应落在
Memory/数据库，不应仅存在模型 thread 中。

### F5：进程生命周期与上下文生命周期耦合

**严重度：中**

“常驻 app-server”和“永久复用同一 thread”是两个独立决策，当前实现将两者绑定。
保持 app-server 进程常驻并不要求所有业务会话共享一个 thread。

### F6：缺少上下文生命周期的可观测性与操作面

**严重度：中**

当前 UI 不展示 thread 创建时间、最后使用时间、累计 turn/token、compaction 次数或
所属 scope，也没有“重置 Agent 上下文”操作。运维人员难以判断异常是由新消息、
持久记忆、thread 历史还是 compaction 引起。

### F7：外部调度失效容易被误判为上下文问题

**严重度：高（当前环境）**

当前 Server 的 `OPENAI_API_KEY` 仍是占位值，导致 message routing、Agenda classifier 和
embedding 持续 401：

- message router fail-open 后把精确 `@agent` 消息唤醒给全员；
- Agenda classifier 失败后进入确定性停滞兜底，可按 5 分钟窗口再次唤醒；
- Agent 在同一 thread 里反复收到相似 Agenda 提示，表面看起来像“模型执着于旧任务”。

这是实际唤醒源错误，不应与持久 thread 的语义漂移混为一个问题。

### F8：自建 Server 与 daemon 自动更新策略不一致

**严重度：中高**

Server 当前是 `0.16.2`，systemd 服务使用 `cumora@latest`，已自动升级到 `0.18.4`。
这可以使 daemon 的提示词、session store、runtime 请求与 Server 协议处于不同版本，
为“行为不一致”增加第二个变量。

## 5. 已有保护与其边界

- **串行 turn**：避免同一 thread 并发写入，但不解决跨会话污染。
- **每轮注入新鲜事实**：降低旧快照风险，但无法删除 thread 中的旧意图。
- **按 engine/provider 隔离 session**：阻止跨引擎恢复，但粒度仍粗。
- **原生 compaction**：控制窗口大小，但是有损且不可作为业务事实。
- **错误触发 fresh session**：可从损坏/溢出中恢复，但不是正常生命周期策略。
- **Memory 文件**：是压缩后的持久层，但目前不能防止原 thread 的跨 scope 影响。

## 6. 建议的目标架构

保留一个长驻 Codex app-server，但将上下文 thread 按业务 scope 分离：

```text
AgentRunner(Iris)
└─ persistent Codex app-server
   ├─ thread: project/<projectId>
   ├─ thread: conversation/<groupId>
   ├─ thread: direct/<directConversationId>
   └─ thread: agenda/global   # 仅用于无法归属项目/会话的后台工作
```

建议 scope key：

```text
agentId + engine + providerProfileFingerprint +
(projectId ?? conversationId ?? explicitAgendaScope)
```

设计原则：

1. 进程可以长驻，thread 必须可以创建、切换、轮换和销毁。
2. 人机私聊、Agent 私聊与群聊默认不共享 raw transcript。
3. 项目级共享知识通过结构化 Memory 传递，而不是偶然复用模型 thread。
4. Agenda 唤醒若指向某个 conversation/project，应进入对应 thread；不应统一污染全局
   Agent thread。
5. thread 轮换前只将经证实的决策、承诺和未完成工作写入持久 Memory。

## 7. 建议的重置策略

任一条件满足时创建 fresh thread：

- Agent 的 role/system prompt/model 发生变更；
- engine 或 provider profile 变更（当前已通过 session store 部分覆盖）；
- 进入不同私聊/群聊 scope；
- 项目明确切换；
- 超过配置的最大年龄、turn 数或累计上下文 token；
- 任务明确完成，且没有未完成承诺；
- 操作者在 UI/CLI 主动选择“重置上下文”；
- 发生上下文溢出、损坏或 stale resume（已实现）。

## 8. 可观测性要求

为每个活动 thread 记录并展示：

- Agent、engine、provider profile fingerprint 和 scope；
- thread ID 的脱敏预览；
- created/last-used/compacted/reset 时间；
- turn 数、累计 token 和 compaction 次数；
- reset 原因：operator/persona-change/model-change/ttl/overflow/stale/corrupt；
- 当前 thread 是否正在执行 turn。

建议日志事件：

```text
engine.thread.created
engine.thread.resumed
engine.thread.scope_switched
engine.thread.compacted
engine.thread.reset
engine.thread.expired
```

## 9. 验收标准

1. Iris 先在私聊中获取一条敏感测试字符串，随后进入群聊；群聊 thread 不应包含该
   私聊 transcript，也不应输出该字符串。
2. 同一群聊连续唤醒时保持任务连续性，不因 app-server 常驻与 thread 分流而丢失当前
   任务位置。
3. 切换项目或会话时无需重启 app-server，只切换 thread。
4. Persona/model 变更后不恢复旧语义 thread。
5. daemon 重启后只恢复与当前 engine/provider/scope 匹配的 thread。
6. 到达 TTL/turn/token 阈值后会先落盘必要 Memory，再安全轮换 thread。
7. UI/CLI 可查看上下文年龄与 scope，并可审计地主动重置。
8. 消息路由/Agenda classifier 失效时的唤醒行为有单独告警，不与 thread 行为异常
   混淆。

## 10. 实施优先级

1. **P0：** 修复当前 Server `OPENAI_API_KEY`/轻量分类器配置，停止错误全员唤醒与
   Agenda 兜底噪声。
2. **P0：** 对齐 self-hosted Server 与 daemon 版本策略。
3. **P1：** 将 Codex app-server 进程与 thread 解耦，实现按 conversation/project 的 thread registry。
4. **P1：** 私聊/群聊强隔离，Persona/model 变更时强制 fresh thread。
5. **P2：** 增加 TTL/turn/token 轮换和手动 reset。
6. **P2：** 增加 thread 可观测性及 compaction/reset 审计。

## 11. 相关实现

- `server/src/agents/computer/daemon.ts`：`AgentRunner`、turn 串行、动态 prompt、session 恢复与重置。
- `server/src/agents/computer/engine.ts`：`CodexSession`、app-server JSON-RPC、thread start/resume、
  原生 compaction 事件。
- `server/src/agents/computer/session-store.ts`（发布版 `0.18.4`）：按 Agent/engine/provider 持久
  session ID。
- `server/src/agents/agenda.ts`：停滞检测、分类器失效兜底与 nudge 冷却。
- `server/src/agents/routing.ts`：指定 Agent 的消息路由与 fail-open 策略。

