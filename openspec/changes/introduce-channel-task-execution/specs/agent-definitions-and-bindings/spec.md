# Spec Delta

## Purpose

提供可复用版本化的工作角色，并将其与 Workspace 内稳定 Agent 身份、Channel 有效成员关系和局部能力配置区分，保证定义复用不会共享私有身份和数据。

## ADDED Requirements

### Requirement: Definition identity separation
系统 SHALL 将定义版本、租户 Agent 身份和频道 Binding 分开识别。

#### Scenario: Same definition
- **WHEN** 两个 Workspace 安装同一版本
- **THEN** 私有记忆和连接不互通

#### Scenario: Fixed version
- **WHEN** 作者发布新定义版本
- **THEN** 已有 Task 保持固定版本且不自动扩权

### Requirement: Live binding eligibility
系统 SHALL 只向当前有效成员 Binding 派发任务，并保留失效 Binding 的历史责任记录。

#### Scenario: Member removed
- **WHEN** Agent 退出频道
- **THEN** 后续派发和受保护操作拒绝，历史 Task 保留

#### Scenario: Rejoined member
- **WHEN** 同一 Agent 重新加入
- **THEN** 旧 Binding/context 不恢复资格


### Requirement: Reviewable configuration pages
系统 SHALL 提供定义版本、当前频道绑定和默认负责人的可持久化配置页面，默认负责人切换保持原子性，已有 Task 的定义快照保持不变。

#### Scenario: Change default binding
- **WHEN** 管理员将当前频道的另一个有效 Agent 设为默认负责人
- **THEN** 保存后仅有一个默认 Binding，新任务使用它，已有 Task 不变

### Requirement: Workspace Aida as an IM group member
系统 SHALL 为新 IM 群聊自动加入当前 Workspace 的默认 Aida 并初始化 Binding；已有群聊打开时幂等补齐缺失默认，复用身份并遵守当前成员、正常配额、来源与本地 placement 约束。

#### Scenario: New ordinary group
- **WHEN** 用户从群聊创建页面仅输入标题，或选取多个专业 Agent
- **THEN** 群聊中可见 Aida，有唯一默认 Binding，重复初始化不增加身份或绑定

#### Scenario: Existing group with a configured default
- **WHEN** 用户打开已有群聊
- **THEN** 缺失 Aida 可按成员加入规则补齐，用户已指定的默认负责人及历史 Task 快照保持不变
