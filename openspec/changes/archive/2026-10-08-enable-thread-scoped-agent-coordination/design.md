# Design

## Context

见 proposal.md。现有 ThreadDrawer 仅匹配 quoted_message_id 的直接回复；LEGACY 模型以一个 Agent 全局 session 执行；Task 模式具备完整领域记录但当前本地执行器只支持经准入 Codex 沙箱，不能直接承接 Claude 原生 CLI。已应用 schema 21/22 不修改。

## Goals / Non-Goals

**Goals:** 本地聊天适配器与受保护 Task 执行器共用领域记录，模型负责语义路由，服务端负责有界计划、状态、幂等归集。thread 组织对话，新的工作轮次关联新的根 Task。

**Non-Goals:** 自动切换全工作区到 TASK、云执行、手机设计、重新定义权限体系、迁移全部历史聊天。

## Decisions

1. schema 23 新增 conversation_threads、thread_work（每轮参与 Agent 与 Task/Context 关联）、thread_reads 与 messages.thread_id。Thread.id 使用根消息 ID，但与 quoted_message_id 独立；消息触发器继承被引用消息所属 thread，普通新任务由入口事务创建。channel_tasks 增加 execution_kind，原生记录为 CHAT；legacy guard 只隔离原有 TASK 消息，避免吞掉原生 thread 工作。
2. 默认 Aida 入口在消息事务中创建 thread 与根 Task。一条 thread 可有多轮：已收尾 thread 收到人类补充时创建新根 Task，保留模型会话；未收尾补充关联当前轮次。不猜最近活跃 Task。
3. Aida 调用 `thread delegate <JSON members>` 原子提交整个计划。成员调用 `thread result completed|blocked|failed <text>`，Aida 调用 `thread summary <text>`；普通 reply 是进度。工具明确给出当前 thread、轮次、成员、结果与使用说明。只允许当前轮次的参与者操作，锁定 thread 后检查状态，重复提交同内容幂等，冲突或迟到拒绝。
4. 原生适配器通过 TaskService 创建根子任务及配置快照，生成现有 ExecutionContext；结果形成 immutable Artifact 与 Delivery，summary 记录成员 Artifact 引用。阻塞成员也能结束归集。所有结果按 task 关系返回；中间成员结果不直接唤醒 Aida，全部结束生成持久化归集消息。超时默认 15 分钟，runtime 取工作时做可恢复扫尾；失败结束调用补记失败，成功但缺少结果补记阻塞，避免无限悬挂。
5. daemon 保留每 Agent 串行运行，按最早待处理 thread 选择工作。运行前停止旧 engine transport、flush session pointer，切换到哈希命名的 thread 工作目录和 session 文件；不同 engine/provider/persona 配置不共用指针。runtime JWT 带 thread 与轮次，服务端限制 inbox/history/回帖及已读到该 thread；旧轮次 token 不能写新轮次。执行状态跳过闲聊 triage，汇总不会再被 cerebellum 消耗。
6. 桌面实时、历史和 replies API 均携带 threadId，drawer 按 threadId 收集嵌套回复，显示状态与成员进度。根消息提供 thread 入口，发送任务后自动打开。quoted 保持展示引用功能。

执行上下文保持不可变；已展示输入的位置写入 thread_reads。每次 engine transport 使用新的私有 IPC 目录，切换 thread/轮次时先停止旧 transport 和 broker，再恢复 session；旧 IPC 请求无法进入新工作。部署时将本机 systemd 服务绑定仓库代码，避免自动重启到旧安装版。

## Risks / Trade-offs

- 原生聊天不等同受保护沙箱 → execution_kind 明确区分，TASK 路由与 guard 保持原状。
- 模型忘记结果工具 → turn finish 记录 blocked 并归集，用户可补充重试；不会把进度自动当成功。
- 计算机离线 → 持久化截止时间，其他 Agent 轮询时恢复收尾，不依赖进程内计时器。
- 同一 Agent 串行降低吞吐 → 优先保证 session 与已读隔离；成员仍可由计算机现有全局并发限制执行。
- 工具调用重复或旧轮次迟到 → 事务锁、轮次 token 和结果摘要校验；归集消息与 Delivery 唯一键去重。

## Migration Plan

追加 schema 23，隔离测试库运行真实 PostgreSQL 回归，再构建部署 5181 服务；更新本机 daemon 到仓库代码并验证本地登录态无 API Key。保留业务数据，历史引用 thread 仍可查看。回滚应用需要匹配 schema 的前向修复版本，不倒改已应用 SQL。
