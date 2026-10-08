# task-runtime-dispatch Specification

## Purpose

使任务派发可持久化、可独占认领并能跨重连取回，要求 Runtime 实际能力与任务限制匹配，同时对结果未知和旧进程未停止的情况保留事实而不重复执行。

## Requirements

### Requirement: Durable exclusive dispatch
系统 SHALL 对每次派发独占认领，同 Agent 同时执行一个任务，重复通知不重复执行。

#### Scenario: Repeated wake
- **WHEN** 多个副本处理相同通知
- **THEN** 只有一个有效执行认领

#### Scenario: Redis unavailable
- **WHEN** 派发落库后通知丢失
- **THEN** runner 重连查询未处理派发

### Requirement: Runtime admission
系统 SHALL 验证协议、隔离、设备分配和三类位置；不合格引擎不得降级执行。

#### Scenario: Old daemon
- **WHEN** 设备不支持 Task 协议
- **THEN** 任务阻塞且不进入旧 inbox 回合

#### Scenario: Local tools cloud inference
- **WHEN** 本地执行使用云模型
- **THEN** 内容目的地经过明确许可且不宣称全本地

### Requirement: Unknown outcome preservation
系统 SHALL 将未知外部动作和未确认停止的执行保留为未知，不自动重放或迁移。

#### Scenario: Expired claim
- **WHEN** 旧进程停止未确认且 lease 到期
- **THEN** 不启动第二执行

#### Scenario: Timed out write
- **WHEN** 外部写入后连接中断
- **THEN** 先对账而不重复写入

### Requirement: Local account model selection
The system SHALL use an explicitly configured local Agent model or a verified local account catalog default for admitted Codex-login Task inference, and SHALL use the same resolved model for context and authorized requests.

#### Scenario: Server default unavailable locally
- **WHEN** the server model default is unsupported by the paired computer's account
- **THEN** local Task inference uses the resolved local Agent or account model instead

### Requirement: Keyless runtime admission
The system SHALL prevent server-model dispatch in local-only mode and allow qualified local Codex-login execution through the existing Task context and receipt paths.

#### Scenario: Server model runtime
- **WHEN** a local-only Task attempts a runtime that requires server inference
- **THEN** it reports a model connection requirement before attempting provider inference
