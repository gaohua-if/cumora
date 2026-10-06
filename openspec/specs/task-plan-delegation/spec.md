# task-plan-delegation Specification

## Purpose

允许 Aida 根据目标提出有界任务计划并组织已有频道成员协作，使计划依赖、独立负责者、授权收敛、预期产物和交接资格在子任务开始前得到验证。

## Requirements

### Requirement: Validated bounded plan
系统 SHALL 校验计划无环、成员有效、输入输出可交接及工作量上限，第一版最多一层委派。

#### Scenario: Cycle
- **WHEN** 计划节点依赖成环
- **THEN** 拒绝计划且不派发子任务

#### Scenario: Excess work
- **WHEN** 计划超过 8 个子任务或 4 个并发成员
- **THEN** 拒绝超限计划或限制到配置上限

### Requirement: Same channel attenuated child
系统 SHALL 子任务继承父 Channel，权限收敛到根与父范围，子任务不得递归委派。

#### Scenario: Cross channel target
- **WHEN** 目标没有当前 Channel Binding
- **THEN** 拒绝委派

#### Scenario: Recursive delegation
- **WHEN** 子任务请求继续委派
- **THEN** 拒绝请求

### Requirement: Evidence based handoff
系统 SHALL 委派前验证验收证据可向负责者交接，父负责人只接收有权查看的结果。

#### Scenario: Unreadable evidence
- **WHEN** 预计验证结果不能合法交给 Aida
- **THEN** 委派阻塞而不以完成声明替代证据


### Requirement: Local coordinator equivalence
系统 SHALL 使本地 Aida 通过受控计划文件获得相同的一层同频道委派和准确版本验证能力，计划提交后等待子任务而不提前交付。

#### Scenario: Local Aida and local members
- **WHEN** 本地根任务产生合法计划，WORK 和独立 VERIFY 均在经准入的本地计算机执行
- **THEN** 服务端检查计划并交接固定版本，停止旧执行后派发子任务，Aida 归集当前验证证据后交付

#### Scenario: Local child attempts to delegate
- **WHEN** 本地子任务提交计划文件
- **THEN** 服务端拒绝递归委派且不派发新的子任务
