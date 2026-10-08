# channel-thread-presentation Specification

## Purpose

为桌面频道提供明确的根消息和回复入口，将同一任务的回复留在独立 thread 中，保证分页、实时计数和用户导航一致，减少群聊主流中的协作噪音。

## Requirements

### Requirement: Channel roots and flat thread replies
系统 SHALL 在桌面频道主流默认只展示原生 task thread 根消息；thread 内的所有嵌套引用回复按同一根展示，子回复的线程入口也指向根。旧普通引用和邮件行为保持。

#### Scenario: Member replies and channel refresh
- **WHEN** Aida 和成员在 thread 中发布多个回复，用户刷新频道
- **THEN** 频道只显示根入口，打开该入口可查看全部成员结果及最终汇总

#### Scenario: Reply-heavy pagination
- **WHEN** 最近一个 thread 有超过一页回复
- **THEN** 频道分页仍返回根消息，用户可向前加载其他根并保持滚动锚点

### Requirement: Consistent root reply count
系统 SHALL 将引用子回复的乐观计数、确认、失败撤销和重试统一归到根 thread；HTTP 与实时确认无论何种顺序不得重复计数或给子回复增加计数。

#### Scenario: Nested reply and reversed acknowledgement order
- **WHEN** 用户引用成员回复，HTTP 或实时事件先确认
- **THEN** 根回复数恰好加一，子回复数不增加

#### Scenario: Discard and retry
- **WHEN** 用户撤销失败的嵌套回复后重试
- **THEN** 撤销在根减一，重试在根加一，最终计数与消息数一致

### Requirement: Respect current navigation after send
系统 SHALL 仅在发送时的频道与右侧面板仍有效时自动打开新任务 thread；期间切换频道、视图、打开或关闭其他面板都优先保留用户选择。

#### Scenario: Navigation before acknowledgement
- **WHEN** 新任务请求未返回时用户切换频道或打开成员/文档面板
- **THEN** 消息正常确认，当前界面保持用户选择，不自动打开旧频道 thread
