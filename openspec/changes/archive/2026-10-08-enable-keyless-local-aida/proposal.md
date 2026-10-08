# Proposal

## Why

当前本地 Codex 已能使用主机登录态，但服务端仍强制要求 OpenAI Key，旧群聊还通过服务端模型选择接收者。用户需要不配置任何服务端模型凭证也能运行，并由默认 Aida 理解需求、分工和汇总。

## What Changes

- OpenAI Key 改为可选，未配置时自动进入本地运行模式；服务端禁止模型调用，不借用数据库里的租户 Key 或主机登录态。
- **BREAKING** 普通群聊取消服务端语义选举。明确提及/人类引用直接投递，未指定对象交给默认负责人（通常为 Aida），显式 `@all` 才广播。
- 消息工作接收者持久化，唤醒和重连 inbox 使用相同结果，避免后台轮询重新唤醒全组；Aida 自己的无目标发言不重新唤醒自己或全组，回复引用不会把完成消息再次派给成员。
- 本地 Task 的模型从 Agent/计算机/实际账户目录解析，使用已准入的 Codex 登录态；需要服务端模型的执行方式明确阻塞。
- 无 Key 时记忆保留固定/近期检索，跳过 embedding；头像等服务端模型能力明确显示不可用。桌面配置页展示实际运行能力。
- 部署并在真正移除服务端 Key 后进行浏览器与真实本地 Codex 验收。无需历史数据迁移兼容，但不主动删除已有业务数据。

## Capabilities

### New Capabilities

- `keyless-local-runtime`: 服务端无模型凭证启动、能力展示、模型调用阻断及辅助功能降级。

### Modified Capabilities

- `channel-task-routing`: 确定性投递与持久接收者，Aida 负责语义协调。
- `task-runtime-dispatch`: 本地登录态模型选择与无 Key 下的执行准入。
- `configuration-workbench`: 在配置入口说明本地模式与需要登录/连接的能力。

## Impact

涉及 env、模型客户端和 embedding、消息 schema 与 scheduler/inbox、Task 本地模型/准入、配置 API/UI、Compose 环境与验收脚本。保持 Channel → Binding → Task → ExecutionContext → Runtime → Artifact → Delivery 数据流。云执行和真实 MCP/GitHub 适配器不扩展；无 Key 不代表离线模型。
