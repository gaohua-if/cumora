# channel-agent-knowledge Specification

## Purpose

分别保存 Channel 共享事实与 Agent 身份经验，保留知识来源、受众及事实状态，使置顶、摘要或归属变更不会自动扩大范围，并通过有权主体明确发布实现受控复用。

## Requirements

### Requirement: Source retaining memory
系统 SHALL 保留全部来源限制，未知来源和原始推测不自动进入全局长期记忆。

#### Scenario: Pinned note
- **WHEN** 频道来源记忆被置顶
- **THEN** 跨频道仍不可用

#### Scenario: Source lookup failure
- **WHEN** 候选提取时来源不可确定
- **THEN** 保留待确认，不降级全局

### Requirement: Explicit experience publication
系统 SHALL 由具备全部来源分享权的主体发布选定知识版本到明确范围，不转授原材料或连接。

#### Scenario: Approved publication
- **WHEN** 有权用户将选定经验发布到另一频道
- **THEN** 仅该版本按批准范围可检索

#### Scenario: Insufficient sharing right
- **WHEN** 发布者缺少一项来源分享权
- **THEN** 拒绝发布

### Requirement: Derived access invalidation
系统 SHALL 来源撤回后对条目、发布、索引、缓存和原始读取重新授权。

#### Scenario: Revoked source
- **WHEN** 来源授权被撤回
- **THEN** 相关经验不继续绕过限制被返回
