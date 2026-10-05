# Spec Delta

## Purpose

使每次执行只接收当前 Task 合法且相关的输入，隔离不同任务的模型历史、session、文件和缓存，并防止已有宽范围接口或跨任务插话绕过输入检查。

## ADDED Requirements

### Requirement: Single task context
系统 SHALL 每个执行上下文只处理一个 Task，所有输入从批准清单和当前来源权限解析。

#### Scenario: Two channels
- **WHEN** 同一 Agent 先后处理两个频道
- **THEN** 第二任务不获得第一任务输入或 session

#### Scenario: Raw memory read
- **WHEN** 任务尝试绕过检索读取全局记忆文件
- **THEN** 读取被拒绝

### Requirement: Task scoped steering
系统 SHALL 只向当前任务注入合法驱动者的同任务补充，范围扩大必须经过授权修订。

#### Scenario: Other direct message
- **WHEN** 另一个私聊在执行中到达
- **THEN** 独立排队且不注入当前 session

#### Scenario: Expanded objective
- **WHEN** 补充要求超出现有范围
- **THEN** 授权修订前不执行新增动作

### Requirement: No legacy bypass
系统 SHALL 在任务模式拒绝模型执行者使用旧 inbox/history/CLI/全量文件或宽权限凭证路径。

#### Scenario: Old runtime token
- **WHEN** 任务进程尝试旧全量文件接口
- **THEN** 不能读取任务外资料

#### Scenario: Unavailable policy
- **WHEN** 授权服务不可用
- **THEN** 受保护动作拒绝，不回退旧路径

