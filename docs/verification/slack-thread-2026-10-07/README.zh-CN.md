# Slack 风格频道与 thread 验收

2026-10-07，在 gaohua chen 工作区，通过真实桌面 Chrome 和本机 Codex ChatGPT 登录态验证。地址：http://192.168.28.113:5181；验收群聊：`Slack thread 验收 1791363942652`（`g-2b347dee`）。七项浏览器验收通过。

| 编号 | 场景 | 结果 |
| --- | --- | --- |
| T01 | 配置页可创建默认 Aida 与两个本地 Claude 成员的群聊 | 通过 |
| S01 | 频道主流只显示根，thread 中显示真实 Aida 汇总 | 通过 |
| S02 | 引用子回复仍在同一 thread，发送者根计数一致 | 通过 |
| S03 | 真实纯附件上传续接待补充任务，Aida 读取文件并保留 session | 通过 |
| S04 | 延迟 HTTP 确认后不抢回已切换的频道 | 通过 |
| S05 | 延迟 HTTP 确认不覆盖用户打开的成员面板 | 通过 |
| S06 | 刷新后按根分页，线程回复仍可查看 | 通过 |

[完整验收证据](acceptance.json) 包含消息、任务、输入 provenance、context、session、模型调用和交付 ID；[检查记录](checks.json) 包含18项单元/实际 store 行为测试、7项 thread 集成和3项既有 TASK 回归（按聚焦运行累计）。类型检查、构建、三个架构 guard、lint 均通过；不是全仓库测试声明。

频道只显示四条根消息，子回复均未进入频道主流；打开 thread 可查看原始输入、嵌套引用、实际结果与任务状态。嵌套回复引用的是 Aida 子回复，但消息 thread_id 和入口始终归根，根回复数与数据库计数一致。

[最终频道与文件结果截图](screenshots/07-refreshed-channel-and-file-thread.png) 展示实际读取文本后的 `SLACK_FILE_READ 42` 与文件口令；[成员面板保留截图](screenshots/06-delayed-send-profile.png) 展示延迟发送确认后用户选择的 Aida 面板。S04/S05 使用 Chrome CDP 暂停真实 POST 的 HTTP 响应，再通过 UI 切换频道或打开成员资料，之后释放响应验证界面没有被抢占。HTTP/WS先后顺序、未知根确认迁移、失败撤销/重试与切走再返回另有实际 store 行为测试。

文件输入用真实 file input 上传 source.txt，正文含19和23以及口令 HARBOR_FILE_782，发送正文为空。第1轮缺文件为 awaiting_input；早期第2轮已正确续接，但暴露出受控模型没有通用下载命令，故真实报告无法读取。补齐 `thread attachment <消息ID>` 后，再次纯附件上传创建第3轮并实际读取正文，完成计算和口令验证。第1和第3轮 session 均为 `01a1159e-030e-7433-82ce-5daf0482a8de`。早期阻塞记录保留在同一 thread，未删除或伪造成功记录。

受控读取当前仅支持当前 thread 的本地 UTF-8 文本附件，最大1MiB，返回最多50000字符并标记截断。图片/PDF与非本地存储明确返回不可读取；本轮验证附件元数据和新鲜 URL 可见，不声称已实现图片/PDF解析。Agent 应使用已配置的其他合法能力或明确待补充。

服务端 LOCAL_ONLY=true，服务端模型 API Key 均未设置；模型调用均为 byoa-codex，所有验收 Agent run 最终 completed 且 error 为空。数据库保持 schema 23，未新增迁移。原概念与数据流文档 SHA-256 仍为 `809a9c159f46f50ab7b47b3fd03095430ccbf4a65ff65e82e6eb3ebf5afd6d11`。

[部署校验](deployment.json) 记录容器镜像、健康、systemd状态、工作区/容器服务端源码一致性及容器/HTTP前端资源一致性。代码在5181生效，本机 daemon 使用仓库入口。

复现：`node scripts/verify-slack-thread.mjs`。创建单独验收群聊并调用真实本机模型；`--resume` 继续未完成项并刷新最终证据，已通过的模型场景不重复执行。脚本结束后清理测试登录会话与临时浏览器目录；证据不含登录凭证。

交互参考 [Slack 官方 thread 说明](https://slack.com/help/articles/115000769927-Use-threads-to-organize-discussions-)。本次范围为桌面原生 task thread 的默认频道呈现；显式“也发送到频道”、Slack全套订阅通知和手机新交互未新增。
