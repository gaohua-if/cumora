# 本地任务 thread 与 Aida 汇总

群聊中向默认 Aida 发送新任务时自动创建 thread。后续在右侧 thread 中补充；另一条频道新消息创建独立 thread。引用成员回复只提供引用上下文，不改变工作归属。

直接 @ 专业成员的消息仍由该成员接收。协作请求的正文需要包含其他成员 @ 时，可同时 @Aida 明确协调者，由 Aida 通过计划工具选择实际工作成员。

同一 thread 内，每个 Agent 有自己的 Codex/Claude session 和工作目录；追问、跨 thread 切换和正常 daemon 重启恢复该 thread 的 session。一个 Agent 串行处理多个 thread，不把其他任务插入当前模型对话。engine、模型、persona 或 provider 配置变化时采用新 session。

Aida 使用受控工具提交一层计划，所有成员任务及其结果关联现有领域数据流：Channel → Binding → Task → ExecutionContext → Runtime → Artifact → Delivery。原生聊天适配器的 execution_kind 是 CHAT；原有受保护 TASK 模式继续使用准入和沙箱流程。

工具在 daemon 内绑定当前 thread、轮次和 Agent；模型不能指定另一个轮次：

- `thread status`：当前角色、任务与有效频道成员。
- `thread delegate '[{"agentId":"id","objective":"目标"}]'`：Aida 一次提交完整计划，最多 8 位成员；随后等待结果。
- `thread result completed|blocked|failed "结果"`：成员的结构化终态，同时创建产物与交付。
- `thread summary "最终汇总"`：Aida 对全部成员结果归集；存在缺口时自动标记待补充。
- `thread summary --blocked "需要补充的资料"`：Aida 独自执行时明确报告阻塞。
- `reply <channelId> "进度"`：仅发布当前 thread 的进度，不代替结果工具。

成员结果中的 @ 不会创建同事新任务。全部成员结束后，服务端确定性安排 Aida 汇总，跳过闲聊 triage；重复结果和汇总幂等，冲突或旧轮次返回拒绝。成员默认 15 分钟截止，服务端每 30 秒扫描；失败或没有提交结果的执行标记失败/待补充，不会永久悬挂。补充到已收尾 thread 会创建新一轮 Task，同时保留该 thread 的模型会话。

桌面右侧显示任务轮次、整体状态和成员状态。刷新后状态、嵌套回复、结果与汇总从数据库恢复。未明确完成的任务显示待补充。

本次 5181 部署使用用户级 systemd 服务 `cumora.service`；仓库入口通过 `~/.config/systemd/user/cumora.service.d/10-workspace.conf` 覆盖，正常重启不会切回已安装的旧版。私有 thread IPC 每次 transport 都重新分配，模型 session 指针仍保留。更新代码后用 `systemctl --user restart cumora` 加载。

验收必须覆盖：只有 Aida；两位成员，其中一位结果 @ 同事；完成与阻塞混合；重复/迟到结果；计算机重启后的恢复；同 Agent 两条交错 thread；同 thread 追问复用 session。真实登录态验收证据在 docs/verification/thread-coordination-* 中记录。

桌面频道默认只展示原生 task thread 的根消息和回复入口，成员进度、结果与 Aida 汇总留在线程内。嵌套引用继续使用同一根；回复数按根计算。发送后若已切换频道或右侧面板，确认消息不会自动抢回原线程。

thread 支持纯附件补充：已完成或待补充的任务会创建下一轮 Task，session 继续复用。brief、inbox、messages 都携带附件名称、类型、mime、大小、存储 key 与即时刷新后的 URL。附件描述只说明来源，Agent 仍须实际读取内容，无法读取时明确报告阻塞。

受控模型可用 `thread attachment <消息ID>` 读取当前 thread 中本地存储的 UTF-8 文本附件（最大 1MiB，返回最多 50000 字符并标记截断）。命令不会读取其他 thread 文件。图片、PDF、远程存储或不支持的编码明确返回不可读取，Agent 应报告待补充或使用已配置的其他合法能力。
