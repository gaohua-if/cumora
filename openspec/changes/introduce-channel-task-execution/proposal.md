# Proposal

## Why

Cumora 当前按会话消息唤醒 Agent，回合与本地 session 会跨会话复用输入，缺少以 Channel Task 为中心的负责人、来源、权限和交付契约。实施多 Agent 设计需要先建立统一任务路径，避免复用旧执行造成重复接单、越权或信息串用。

## What Changes

- 以 `doc/multi-agent-concepts-and-data-flow.md` v0.4 和 `doc/multi-agent-implementation-design.md` 为基线，保持四条数据流及 D1/D2/D3。
- 建立定义版本、频道 Binding、同频道 Task/子任务/计划、任务授权、输入清单、独占派发、不可变产物和来源受限知识。
- 配置与身份复用现有租户、会话、成员、Agent、设备、模型账本和实时 outbox；Agent 待办、看板审核和执行完成保持各自语义。
- 引入显式 Workspace 执行模式与兼容迁移；默认保留现有工作模式，切换任务模式前验证前置条件。
- **BREAKING（仅切换任务模式的 Workspace）**：所有 Agent 工作经 Task 路径；禁止旧全收件箱回合、跨任务 session、宽权限文件/CLI 和未授权目的地回退。
- 按 P0/P1 基础和云端直接闭环、P2 一层委派、P3 本地及跨环境、P4 显式知识发布推进；每阶段只有完成自身闭环与验收后才能启用。

## Capabilities

### New Capabilities

- `channel-task-routing`：入口归属、输入关联、调用和驱动权限、唯一负责人。
- `agent-definitions-and-bindings`：可复用版本定义、租户身份与有效频道绑定。
- `task-access-control`：资源/连接/授权来源、范围收敛、动作与目的地检查。
- `task-context-isolation`：单 Task 输入、session、文件视图与 steer。
- `task-runtime-dispatch`：派发认领、设备准入、协议兼容和未知结果。
- `task-plan-delegation`：有界 DAG、一层同频道子任务和交接责任。
- `task-artifact-delivery`：不可变产物、准确验证、受控读取与发布。
- `channel-agent-knowledge`：两类记忆、来源约束、明确发布和失效。
- `task-governance-compatibility`：Task 与看板、治理授权、预算和审核的适配。
- `task-workspace-migration`：兼容 schema、旧入口封闭、迁移与回滚。

### Modified Capabilities

无；当前 OpenSpec durable specs 为空。

## Impact

涉及数据库追加迁移、Task/Access/Artifact/Knowledge 领域服务、REST/WS/日历/看板入口、scheduler、runtime 客户端和 HTTP API、云端 worker、本地 daemon/session/工具代理、文件与模型边界、发布 outbox、客户端任务交互及清理生命周期。初始实现使用已有依赖和受控测试环境；后续部署与浏览器修复已获用户授权，仅操作隔离的测试工作区并保留既有数据。本轮修复以本地计算机为验收范围，不处理创建 Agent 未选计算机的问题和云服务场景。最终以 OpenSpec validation、类型检查、针对性单元/真实 PostgreSQL/Redis 集成及边界测试验证。

## Browser repair scope (2026-10-04)

补齐定义/绑定/默认 Aida/执行模式的配置页面，支持局域网 HTTP 的驱动和产物 hash 校验，取消后只展示当前状态。接通本地 Aida 的有界计划与验证证据归集，使用经准入的本地计算机完成单 Agent 和多 Agent 验证。真实模型连接与确定性测试分别记录；模型凭证不进入任务沙箱。

用户指出普通工作区缺少可发现的独立配置页面和默认 Aida。Channel 在产品中直接对应 IM 群聊，复用现有 conversation；提供桌面导航和手机入口的独立配置页面，新群聊自动加入本工作区 Aida 并建立默认 Binding，已有群聊打开时幂等初始化。复用已有 Aida 或按正常配额安装，优先本地计算机；不创建另一套频道，不改变用户已指定的默认负责人和历史任务。真实验收需覆盖用户指定的 5181、gaohua chen 工作区以及普通新建群聊路径。
