# Proposal

## Why

现有配置页面主要管理执行准备与基础定义，不能完整管理 Agent/Skill、群聊规则或访问资源包。已确认的桌面原型需要落到真实数据，并避免配置更新导致范围扩大、隐式升级或旧任务配置变化。

## What Changes

- 按原型 v2 实现 Agent、Skill、Access Bundle、群聊四类桌面配置与生效预览。
- 添加不可变 Skill 版本和配置元数据，复用现有 Agent 定义、Binding、Bundle 与 IM 群聊。
- 固定引用并明确升级；区分成员全部/子集/无资源，解析语言与逐连接身份及范围。
- 根任务和协作子任务固定完整生效配置，区分配置修订与执行资格撤销。
- 提供服务端保存、读回与并发冲突处理，以及数据库、接口和真实浏览器验收。
- MCP/域名/GitHub 支持配置管理和快照，连接执行仍需既有 adapter 准入，不由页面保存隐式创建授权。桌面和本地计算机为本轮范围，手机端、云执行和权限议题暂缓。

## Capabilities

### New Capabilities

- `configuration-workbench`: 真实对象管理、不可变发布、固定引用及桌面编辑流程。
- `configuration-resolution`: 配置来源解析、成员资源模式与任务生效快照。

### Modified Capabilities

无。主规格目录尚无已同步能力；保持已完成任务执行 change 的身份、授权和数据流契约。

## Impact

涉及 `SettingsView`、桌面配置组件、`/tasks` 配置 API、TaskService/PlanService/ExecutionService，以及向前数据库迁移。复用现有 Agent/群聊创建、成员管理及本地计算机接口，不改变既有迁移 checksum。设计与验收基线位于 `docs/prototypes/configuration-workbench-v2/`。
