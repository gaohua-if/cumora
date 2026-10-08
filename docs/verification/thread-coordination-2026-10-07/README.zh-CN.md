# Thread 协作验收记录

2026-10-07，在 gaohua chen 工作区通过桌面 Chrome 操作与本机真实模型完成验收。访问地址：http://192.168.28.113:5181；验收群聊：`Thread 协作验收 1791306551617`（`g-78cada87`）。结果：八项端到端验收全部通过。

| 编号 | 场景 | 结果 |
| --- | --- | --- |
| T01 | 配置页可创建默认 Aida 与两个本地 Claude 成员的群聊 | 通过 |
| T02 | 新任务自动建立 thread，Aida 独自完成并在右侧展示状态 | 通过 |
| T03 | 两个真实成员结果归集，正文 @ 同事仍由 Aida 汇总且没有循环 | 通过 |
| T04 | 完成与缺资料混合仍能汇总，并明确待补充 | 通过 |
| T05 | 同一 Aida 两条交错 thread 使用独立 session 与 context | 通过 |
| T06 | 同 thread 追问创建新 Task 轮次并恢复原 session | 通过 |
| T07 | 刷新可恢复 thread 回复、成员状态与最终汇总 | 通过 |
| T08 | systemd 重启后真实恢复同 thread 的 Codex session | 通过 |

完整消息、Task、ExecutionContext、Session、Artifact、Delivery 和执行记录见 [acceptance.json](acceptance.json)；截图在 [screenshots](screenshots)。[刷新后的汇总](screenshots/07-refresh-thread.png) 和 [重启后的追问](screenshots/08-restart-session.png) 已核对最终完成状态。

多成员任务中 Aida 先提交计划，Atlas 与 Bram 使用各自 Claude session 交付，Aida 再恢复自己的 Codex session 汇总。Bram 正文提及 Atlas 没有新增工作。缺资料任务中 Atlas 为 blocked、Bram 为 completed，Aida 仍输出已有结果与缺口，thread 状态为 awaiting_input。

ALPHA 与 BETA 的 Aida session 不同；ALPHA 第 1、2、3 轮 Task 不同，但 session 始终为 `01a11232-e19d-7a33-8d17-895365d95a87`。重启用户级 `cumora.service` 后，第 3 轮真实回复为 `THREAD_RESTART_OK ALPHA_83_HARBOR`，未混入另一条 thread 的口令。所有验收 thread 对应的 Agent run 最终为 completed，错误为空。

服务端 LOCAL_ONLY 为 true，未注入服务端模型 API Key。Aida 使用本机 Codex ChatGPT 登录态，Atlas 与 Bram 使用本机已有 Claude provider 配置；本验收不声称 Claude provider 无需其自身凭证。推理记录仅为 byoa-codex / byoa-claude。

[checks.json](checks.json) 记录本轮已完成的聚焦检查：59 项单元测试、4 项 thread 集成测试、31 项现有 TASK/无 Key 路由回归检查，以及类型检查、生产构建、三个架构 guard 和 lint。旧回归套件的 schema-14 断言按当前最低 schema 23 修正后单独重跑通过；没有把这次检查表述为整个仓库全量测试。

[deployment.json](deployment.json) 记录 schema 23、容器镜像、健康状态、systemd 进程，以及服务端源码与实际提供的前端资源校验值。宿主本地 build 与 Docker build 的 JS 文件名受构建环境影响，因此前端以容器产物和 HTTP 实际资源一致为证据。

原始概念数据流文件 `doc/multi-agent-concepts-and-data-flow.md` 保持不变，SHA-256 为 `809a9c159f46f50ab7b47b3fd03095430ccbf4a65ff65e82e6eb3ebf5afd6d11`。本地 CHAT 适配器继续关联 Binding → Task → ExecutionContext → Artifact → Delivery；受保护 TASK 模式继续执行原准入规则。

复现：`node scripts/verify-thread-coordination.mjs`。脚本会创建独立验收群聊并调用真实本地模型；`--resume` 使用已有证据继续未完成项或更新最终截图，不重复已通过的模型任务。运行需要 Chrome、Docker 和上述工作区拥有者账号及本机 Agent 服务。测试登录会话与临时浏览器目录在结束后清理；凭证不会写入证据。

本轮早期定位时曾发现不可变 context 更新、旧 daemon 自动拉起和共享 IPC 的问题，已修复并重跑。最终证据使用通过的验收群聊；其他调试群聊保留便于追溯，未删除业务数据。范围不包含云端执行、手机端或权限产品设计。
