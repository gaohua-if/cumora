# task-artifact-delivery Specification

## Purpose

提供不可变内容交接和证据关联，在原 Task 与 Channel 完成受控交付并使用现有实时消息机制展示，确保引用、外部位置和模型完成声明不能代替内容验证或发布资格。

## Requirements

### Requirement: Immutable handoff
系统 SHALL 使用固定内容版本并使验证证据绑定准确被测版本；浮动分支和本地路径不足以证明交接。

#### Scenario: Wrong version
- **WHEN** 接收方取得不同 hash
- **THEN** 拒绝验证完成

#### Scenario: Local verification
- **WHEN** 云端产物交本地主机验证
- **THEN** 测试结果关联原产物 version ID

### Requirement: Authorized publication and read
系统 SHALL 发布前检查当前来源和受众，交付与消息/outbox 原子保存，读取实时授权。

#### Scenario: Concurrent revocation
- **WHEN** 发布与授权撤回并发
- **THEN** 有明确顺序且无过期授权发布

#### Scenario: Redis down
- **WHEN** 交付写库后 Redis 不可用
- **THEN** 恢复后展示且不重复接单

### Requirement: Group audience compatibility
系统 SHALL 群组仅导入获准向全 Channel 分享的资料；成员新增前验证历史受众。

#### Scenario: Personal restricted report
- **WHEN** 发起者可读但频道不可共享
- **THEN** 导入前拒绝，日志和模型不含受限正文

#### Scenario: New member
- **WHEN** 新成员不在现有来源可分享范围
- **THEN** 历史开放前阻止成员变更

### Requirement: Distinct completion facts
系统 SHALL 以当前范围的有效交付判定 Task 完成，执行结束或模型声明不能替代交付。

#### Scenario: Turn done
- **WHEN** 执行器声明 done 但缺少要求证据
- **THEN** Task 不进入已交付

#### Scenario: Revised scope
- **WHEN** 已交付 Task 扩大合法范围
- **THEN** 旧 Delivery 不满足新范围
