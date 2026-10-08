# channel-task-routing Specification

## Purpose

保证用户和自动化入口发起的工作有唯一频道、明确负责者与输入关联，并使任务驱动资格独立于普通发言资格，避免并发工作中猜测任务或重复接单。

## Requirements

### Requirement: Valid channel ownership
系统 SHALL 在任何工作执行前解析唯一有效 Channel 与负责 Binding；父子任务保持相同 Workspace 和 Channel。

#### Scenario: Missing channel
- **WHEN** 入口没有合法频道
- **THEN** 工作被阻塞且不调用执行器

#### Scenario: Direct agent request
- **WHEN** 用户直接调用有效专业 Agent
- **THEN** 该 Binding 负责，Aida 不自动接单

### Requirement: Unambiguous supplements
系统 SHALL 只将已授权补充关联到明确 Task，不按最近活跃工作静默猜测。

#### Scenario: Two active tasks
- **WHEN** 补充可对应两个任务
- **THEN** 返回任务选择要求

#### Scenario: Unauthorized driver
- **WHEN** 普通成员请求取消他人任务且无驱动授权
- **THEN** 请求被拒绝且任务范围不变

### Requirement: Exactly one work ingress
系统 SHALL 让消息、定时、看板、API 和后台工作经过唯一 Task 路径；展示交付不再次触发接单。

#### Scenario: Repeated event
- **WHEN** 同一入口事件重复投递
- **THEN** 只产生一个任务和派发

#### Scenario: Published delivery
- **WHEN** 任务交付消息被广播
- **THEN** 只更新展示而不创建或唤醒新工作


### Requirement: Browser actions on LAN HTTP
系统 SHALL 在局域网 HTTP 下支持任务继续、取消和内容 hash 校验下载，任务选择只展示根任务，已取消 Task 不展示历史阻塞原因。

#### Scenario: Insecure browser origin
- **WHEN** 页面运行于不提供 randomUUID 或 subtle 的 HTTP 来源
- **THEN** 任务动作可执行，产物仍校验 SHA-256 后才下载

### Requirement: Discoverable group configuration
系统 SHALL 从桌面导航和手机页面提供独立配置页面，群聊直接复用现有 IM 会话而不要求另建 Channel。

#### Scenario: Workspace without test setup
- **WHEN** 用户进入普通 Workspace 并从导航打开配置或创建群聊
- **THEN** 配置页面可发现，默认 Aida 成员和 Binding 由产品流程初始化，不依赖人工 API 测试准备

### Requirement: Aida owns semantic coordination
The system SHALL deliver unaddressed group work to its default responsible Agent, normally Aida. Exact mentions by member ID, name or binding alias and human quotes of Agent replies SHALL address those members directly; only explicit @all SHALL broadcast. Aida SHALL decide its own work, delegation and synthesis without a separate server model router.

#### Scenario: Multiple agents without mentions
- **WHEN** a human sends ordinary work to an Aida and specialist group
- **THEN** only its default Agent receives initial work and can ask eligible peers to cooperate

#### Scenario: Direct specialist
- **WHEN** a human exactly mentions a specialist or quotes its reply
- **THEN** that specialist receives the work and Aida does not automatically take it over

#### Scenario: Explicit broadcast
- **WHEN** a member uses @all
- **THEN** eligible group Agents receive the broadcast without a server classifier

### Requirement: Durable message recipients
The system SHALL persist work recipients with each ordinary message and use them for both wakes and unread inbox recovery. Membership, mute exceptions and durable system notices SHALL retain their existing checks.

Agent-authored quotes SHALL preserve reply context without independently addressing a peer; explicit mentions SHALL still delegate.

#### Scenario: Coordinator quotes completed work
- **WHEN** Aida posts an unmentioned completion quoting a specialist result
- **THEN** no Agent receives new work from that completion

#### Scenario: Reconnect without wake
- **WHEN** a specialist reconnects after unaddressed group messages and a subsequent targeted message
- **THEN** its inbox offers the targeted work without offering the default Agent's unrelated work

#### Scenario: Coordinator completes
- **WHEN** Aida posts an unaddressed completion message
- **THEN** the message remains visible to the group without waking Aida or all specialists again
