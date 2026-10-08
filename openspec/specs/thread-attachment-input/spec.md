# thread-attachment-input Specification

## Purpose

保证本地 thread 中用户通过附件提供的资料成为可处理、可追溯的任务输入，支持无需文字的补充并向模型提供完整元数据和当前有效的访问地址。

## Requirements

### Requirement: Attachment-only task input
系统 SHALL 接受 API 支持的纯附件消息作为 thread 新任务或补充；已完成或待补充 thread 创建下一轮 Task 并保留 session，目标描述明确附件名称与类型。

#### Scenario: Provide missing file without text
- **WHEN** 用户在待补充或已完成 thread 仅上传图片/PDF/文件
- **THEN** 该消息关联任务输入并安排下一轮 Aida 工作，而不是只存聊天消息

### Requirement: Fresh attachment metadata in scoped inputs
系统 SHALL 在 thread brief、inbox 和 messages 中包含附件名称、类型、mime、大小、存储 key 与刷新后的访问 URL；读取消息后仍保留可用的附件上下文。

#### Scenario: Expired persisted URL
- **WHEN** 用户附文件发送文字任务，存储 URL 已过期后 Agent 再读取 scoped 输入
- **THEN** 模型获得按存储 key 刷新后的链接与完整元数据，持久化来源不被改写

### Requirement: Controlled local text attachment reading
系统 SHALL 为本地受控模型提供当前 thread 内 UTF-8 文本附件的读取方式，限制文件大小并标记输出截断；跨 thread、非文本格式和不支持的存储类型明确拒绝，不宣称已解析图片或 PDF。

#### Scenario: File-only missing source supplied
- **WHEN** 用户纯附件补充本地文本文件，Agent 无通用网络工具
- **THEN** Agent 可读取实际正文再回答，不能只根据文件名猜测内容

#### Scenario: Different thread or unsupported format
- **WHEN** Agent 请求另一 thread 的附件或不可解析的二进制文件
- **THEN** 明确拒绝读取，任务按阻塞规则报告需要补充的资料
