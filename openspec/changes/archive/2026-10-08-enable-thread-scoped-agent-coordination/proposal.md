# Proposal

## Why

Aida 当前用普通聊天委派工作，成员回复中的同事 @ 会覆盖归集目的地，且完成状态没有持久化；真实多成员任务因此没有最终汇总。计算机执行器还复用 Agent 全局 session，不能隔离同一频道的并发任务。

## What Changes

- 新发给 Aida 的任务自动创建持久化 thread；thread 内的补充明确关联当前工作，引用只用于展示上下文。
- 本地原生 Codex/Claude 执行按 workspace/channel/thread/Agent/engine/provider 配置隔离 session 和工作目录，追问恢复同一 session。
- Aida 通过受控工具提交最多一层的成员计划。服务端记录 Task、ExecutionContext、Artifact 和 Delivery，按任务关系归集，不依赖回复正文的 @。
- 所有成员结束（完成、阻塞、失败或超时）后确定性唤醒 Aida。Aida 汇总现有结果与缺口，阻塞时标记待补充；归集、重试和重启具有幂等性。
- 桌面 thread 展示完整对话与成员状态，新增真实多成员及双 thread 验收。

## Capabilities

### New Capabilities

- `thread-agent-coordination`: 持久化 thread、原生本地 Agent 会话、成员归集和汇总生命周期。

### Modified Capabilities

无；原有受保护 TASK 模式继续使用其准入、授权和隔离执行器。本次增加 LEGACY 工作区的显式原生聊天任务适配器，不将其声明为受保护沙箱。

## Impact

新增不可变 schema 23；修改消息入口、runtime 工具、计算机 daemon 和桌面 thread。复用现有 Binding、Task、ExecutionContext、Artifact、Delivery 记录，保持 `doc/multi-agent-concepts-and-data-flow.md` 与其数据流不变。不扩展云服务、手机端或权限配置；现有业务数据无需清空。
