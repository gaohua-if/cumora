# Spec Delta

## Purpose

为本地原生 Agent 协作提供明确的 thread 边界、持续但隔离的模型会话和可靠的成员结果归集，让用户在同一任务对话中看到进度、最终汇总以及需要补充的资料，而不是依赖正文提及或全局聊天历史协调工作。

## ADDED Requirements

### Requirement: Automatic durable task thread
系统 SHALL 在 LEGACY 工作区将发给默认 Aida 的新文本任务自动创建 thread；thread 内追问和嵌套引用保持该 thread，thread 可以关联多轮 Task，引用标识不承担任务路由。

#### Scenario: New task and nested reply
- **WHEN** 用户向 Aida 发新任务，随后在其 thread 引用成员回复
- **THEN** 首条消息是唯一根，所有追问与成员结果拥有同一 thread 标识

#### Scenario: Two independent requests
- **WHEN** 同一频道连续发起两个新请求
- **THEN** 创建两个 thread，任何一轮的已读与工作输入不吞掉另一轮消息

### Requirement: Local thread session continuity
系统 SHALL 为每个 workspace/channel/thread/Agent/engine/provider 配置建立独立 session 和工作目录；同一 thread 的追问与正常重启复用 session，其他 thread 的消息不得注入正在运行的模型会话。

#### Scenario: Interleaved threads
- **WHEN** 同一 Agent 交错执行两个 thread 后回到第一个
- **THEN** 第一个恢复自己的 session，第二个使用不同 session，执行可串行排队

### Requirement: Bounded semantic delegation
Aida SHALL 通过模型选择合法频道成员和目标，服务端 SHALL 持久化最多一层、最多 8 个成员任务的计划；成员正文提及同事不得产生递归委派。

#### Scenario: Result refers to a peer
- **WHEN** 成员结果正文含另一个 Agent 的 @
- **THEN** 结果归入原任务并交给 Aida，不改成同事的新任务

#### Scenario: Invalid member or recursive plan
- **WHEN** 计划目标不属于当前频道，或子任务请求委派
- **THEN** 拒绝计划且不产生部分派发

### Requirement: Deterministic aggregation and blocker reporting
系统 SHALL 记录成员完成、阻塞、失败和超时；全部成员结束后唤醒 Aida 汇总。汇总包含已有结果、缺口和下一步，存在阻塞时标记待补充，不宣称任务全部完成。

#### Scenario: Mixed terminal outcomes
- **WHEN** 一位成员完成、一位缺资料或运行失败
- **THEN** Aida 收到两个状态并输出一次有证据的汇总，thread 标记待补充

#### Scenario: Late or duplicate result
- **WHEN** 同一成员重复提交结果、超时后旧执行返回或服务重启
- **THEN** 不重复创建成员任务或最终交付，也不让旧结果覆盖新一轮状态

### Requirement: Native execution records and desktop visibility
系统 SHALL 将本地 thread 工作关联现有 Binding、Task、ExecutionContext、Artifact、Delivery，并在桌面 thread 展示完整回复、任务状态和成员状态；现有受保护 TASK 模式继续拒绝旧宽范围执行路径。

#### Scenario: Browser refresh after summary
- **WHEN** 用户刷新桌面并重新打开任务 thread
- **THEN** 所有嵌套回复、成员结果、最终汇总及状态均可恢复

#### Scenario: Protected workspace
- **WHEN** 工作区已处于受保护 TASK 模式
- **THEN** 原准入和沙箱执行规则保持有效，不退回原生聊天适配器
