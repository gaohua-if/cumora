# Spec Delta

## Purpose

让普通 Channel Task 与现有看板治理按明确映射协作，复用不可变产物、授权和预算机制，同时保留卡片审核与最终验收语义，避免任务完成触发未经审核的业务交付。

## ADDED Requirements

### Requirement: Independent domain states
系统 SHALL 分别保留 Task 交付、Agent 执行和看板审核事实，治理动作满足原 Mandate 与审核条件。

#### Scenario: Delivered card task
- **WHEN** Task 已交付但卡片审核未通过
- **THEN** 看板不自动 Done

#### Scenario: Missing mandate
- **WHEN** 任务授权允许但治理 Mandate 无效
- **THEN** 治理动作仍拒绝

### Requirement: Version preserving artifact bridge
系统 SHALL 通过唯一映射关联原治理产物与通用产物，不改写历史内容或审核。

#### Scenario: Repeated import
- **WHEN** 同一治理产物版本重复映射
- **THEN** 得到同一通用版本且 hash 一致

