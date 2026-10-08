# Proposal

## Why

本地 Aida 协作已有持久化 thread，但频道混入全部回复，嵌套引用计数错误，纯附件和附件上下文丢失，异步发送抢占右侧面板。此次修正使桌面频道与 thread 的职责明确，并保证用户补充资料后任务继续。

## What Changes

- 频道默认只展示原生 thread 根消息；回复保留在同一 thread，根入口显示真实回复数。按根消息分页，避免活跃线程挤掉所有根。
- 乐观发送、HTTP/WS 确认、失败撤销和重试统一使用根 thread 计数；点击成员回复的线程入口也回到根。
- 纯附件消息可创建/续接本地任务；scoped brief/inbox/messages 返回附件名称、类型、存储 key 和新鲜访问 URL。
- 受控本地模型可读取当前 thread 的 UTF-8 文本附件；不支持的图片/PDF 明确报告能力限制。
- 自动打开新 thread 仅限发送时的频道及面板仍有效；切换频道或打开其他面板优先保留用户选择。
- 补充聚焦自动化及真实浏览器验收，不改变既有任务与产物数据流。

## Capabilities

### New Capabilities

- `channel-thread-presentation`: 桌面频道根消息、thread 回复、根计数、分页与导航竞态。
- `thread-attachment-input`: 本地 thread 的附件补充与模型输入元数据。

### Modified Capabilities

无。此前 thread-agent-coordination 尚未同步主规格；本变更增加其桌面交互与输入保证，保留其协作语义。

## Impact

messages store、ChatPane、ThreadDrawer、Message、messages API、ThreadService；不新增数据库迁移或依赖。范围限桌面原生 task thread，现有普通引用/邮件不转换成任务。Slack 的显式“也发送到频道”、订阅通知、手机端和云端不在此次范围。
