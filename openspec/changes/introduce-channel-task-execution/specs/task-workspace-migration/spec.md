# Spec Delta

## Purpose

支持从既有聊天式协作迁移到统一任务模式，保持已有身份和数据引用，要求显式兼容 schema、前置能力验证与旧入口封闭，并在回滚时保留任务和未知操作事实。

## ADDED Requirements

### Requirement: Explicit workspace cutover
系统 SHALL 在准备完成后以 Workspace 切换任务模式，不让同一身份混用宽权限旧执行。

#### Scenario: Preparation incomplete
- **WHEN** 合法连接或执行隔离缺失
- **THEN** 不得切换 TASK

#### Scenario: Old execution active
- **WHEN** 旧进程或未知操作未处理
- **THEN** 切换阻塞

### Requirement: Compatible schema deployment
系统 SHALL 只追加不可变迁移并声明支持范围；旧版本不能在不兼容 schema 上运行。

#### Scenario: Applied checksum changed
- **WHEN** 历史 migration 内容变更
- **THEN** 迁移或启动校验拒绝

#### Scenario: Rollback
- **WHEN** 应用需要回滚
- **THEN** 只回到支持当前 schema 的版本，不删除 Task 事实

### Requirement: Retention and legacy provenance
系统 SHALL 保留现有 ID 和历史状态，未知来源旧记忆不自动发布，GC 和删除识别新数据归属。

#### Scenario: Legacy memory
- **WHEN** 无法确认来源的旧记忆存在
- **THEN** 存储保留但不注入新任务

#### Scenario: Referenced artifact GC
- **WHEN** 新任务引用有效产物
- **THEN** 对象不被当孤儿删除

