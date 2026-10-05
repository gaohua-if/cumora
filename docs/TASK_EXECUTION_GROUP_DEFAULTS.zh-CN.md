# 群聊默认 Aida 与配置入口验收

2026-10-04，Asia/Shanghai。已在 [5181 部署服务](http://192.168.28.113:5181) 的 `gaohua chen's workspace`（`co-a09a2bc0-f`）完成修复与实际浏览器复验。此前配置表单位于弹窗，Aida 只在独立验收工作区预先准备，未覆盖用户的普通群聊流程；本次补齐这两处缺口。

桌面左侧齿轮「配置」和手机「我 → 群聊与 Agent 配置」打开独立页面。群聊中的「群聊配置」打开同一页面并选中当前群。Channel 继续使用现有 IM 群聊的 conversation ID；没有新增另一套频道，也没有改变概念文档中的任务数据流。

正常创建群聊会自动选中工作区 Aida，可以仅保留自己与 Aida，也可以加入多个专业 Agent。创建或打开群聊时服务端初始化缺失的 Agent Binding；已有明确默认负责人、Task 定义快照和其他群的局部配置保留。Aida 安装遵循原配额并优先选择本地 Codex 设备；无匹配设备时保持未分配。当前实际 Aida 为 `aida-lnn7`，计算机为本地 `gh`（`comp-11c2fc72-048`），引擎 Codex。原 Atlas、Bram、Iris、Nova 的计算机与 Claude 引擎没有改动。

## 普通浏览器操作

使用真实 Headless Chrome 151/CDP，通过 LAN HTTP 操作桌面 1440×1000 和手机 390×844。临时验收会话由服务端正常会话机制签发，未修改用户密码；配置、群聊创建、成员选择和保存全部通过界面，没有手工调用 API 预建群聊、Definition 或 Binding。验收结束已退出该临时会话并关闭浏览器。

| 场景 | 实际结果 | 截图 |
|---|---|---|
| 桌面配置入口 | 独立页面显示实际工作区与配置表单 | [配置页](verification/group-default-aida-20261004/desktop-settings.png) |
| 打开原 Everyone 群聊 | 默认 Aida 自动加入；6 名成员，5 个有效 Agent Binding，默认 Aida | [原群绑定](verification/group-default-aida-20261004/existing-group-bindings.png) |
| 普通创建仅 Aida 的群聊 | `g-00874670`：2 名成员，1 个默认 Aida Binding | [自动选中](verification/group-default-aida-20261004/create-solo-default.png)、[群聊](verification/group-default-aida-20261004/solo-group.png) |
| 普通创建多个 Agent 的群聊 | `g-a220941a`：自己、Aida、Atlas、Bram，共 4 名成员；3 个 Binding | [成员选择](verification/group-default-aida-20261004/create-multi-default.png)、[群聊](verification/group-default-aida-20261004/multi-group.png)、[配置](verification/group-default-aida-20261004/multi-group-bindings.png) |
| 手机配置入口与保存 | 「我」可进入配置，显示 3 个 Binding，保存成功，无横向溢出 | [入口](verification/group-default-aida-20261004/mobile-entry.png)、[配置](verification/group-default-aida-20261004/mobile-settings.png)、[保存](verification/group-default-aida-20261004/mobile-save.png) |
| 新浏览器重新读取 | 3 个 Binding、默认 Aida 及别名保持；数据库对应 Aida Binding 版本为 2 | [重新读取](verification/group-default-aida-20261004/reloaded-persistence.png) |

两个带「验证」前缀的群聊保留供用户查看。原群仍使用原 ID 和消息历史；Aida 加入提示走现有成员/outbox 流程。刷新验证第一次脚本在频道选项加载完成前设置值而等待超时，随后改为等待目标选项出现，在新浏览器完成断言；不将脚本等待问题算成应用异常。最终读取会话捕获的应用异常与失败 API 响应均为零。

## 当前校验与边界

新增真实 PostgreSQL/HTTP 集成测试 3/3，通过并发创建/重复初始化、专业成员 Binding、管理员自定义默认与旧 Task 快照保留、配额、成员资格和 schema 14 兼容检查。已有 Chrome 桌面/移动交互回归 7/7，零跳过、取消；strict OpenSpec、前后端类型与三个 guard 共 6 项通过。首次新增测试因私聊 fixture 的 title 为 NULL 违反现有非空约束，修正 fixture 后 3 项全部通过。测试库与业务库分离。本轮未重跑此前 264 项全套断言，不把历史结果计入此次 10 项测试/交互断言。

服务健康检查通过，运行镜像 `sha256:a04681e5e28c81948f680711a461c00187499d35d90b6b5e788969d5c0a1f20c`。本次没有新迁移或清空业务数据。概念文档 SHA-256 仍为 `809a9c159f46f50ab7b47b3fd03095430ccbf4a65ff65e82e6eb3ebf5afd6d11`。OpenSpec `introduce-channel-task-execution` 的第 10 节对应本次变更。

实际工作区仍是 LEGACY 聊天模式，自动补齐群聊成员不启用 Task；其他尚未打开的群聊默认与本地执行准入仍须在配置页处理，readiness 通过后由管理员明确启用。此次没有在该业务工作区发送模型任务，不声称单/多 Agent 的真实模型执行被再次验证；此前本地真实模型证据见[本地 Task 修复报告](TASK_EXECUTION_LOCAL_REPAIR.zh-CN.md)。云服务和 R4「创建 Agent 时 computerId:null」仍按用户要求排除。

持久机器记录与源码/截图 hash：[task-execution-group-defaults-2026-10-04.json](verification/task-execution-group-defaults-2026-10-04.json)。操作说明：[TASK_EXECUTION.zh-CN.md](TASK_EXECUTION.zh-CN.md)。
