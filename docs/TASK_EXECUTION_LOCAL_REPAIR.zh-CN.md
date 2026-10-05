# 本地 Task 修复与真实浏览器验收

后续用户指出普通工作区缺少独立配置入口和默认 Aida。本报告中的配置验收使用预先准备的独立工作区，未覆盖普通群聊初始化；该缺口已单独修复并在 5181 的 `gaohua chen's workspace` 复验，见[群聊默认 Aida 与配置入口验收](TASK_EXECUTION_GROUP_DEFAULTS.zh-CN.md)。下文镜像、测试数量和机器记录保留为此前阶段的历史证据。

2026-10-04，Asia/Shanghai。**本次授权范围验收通过**：修复原 R1 的本地模型连接、R2 配置页面、R3 局域网 HTTP 操作，以及 R5 取消状态显示。云服务场景和 R4「创建 Agent 时 computerId:null 与接口契约不一致」按用户要求排除；R4 未修改，原服务器模型 Key 的 401 也不标记为解决。

OpenSpec：`introduce-channel-task-execution`。当前概念数据流文档未修改，SHA-256 保持 `809a9c159f46f50ab7b47b3fd03095430ccbf4a65ff65e82e6eb3ebf5afd6d11`。根任务、子任务和交付仍属于原 Channel；Definition/Binding 固定版本，WORK → VERIFY → Aida 使用不可变产物交接，只有根任务发布频道交付。

机器记录：[task-execution-local-repair-2026-10-04.json](verification/task-execution-local-repair-2026-10-04.json)。操作说明：[TASK_EXECUTION.zh-CN.md](TASK_EXECUTION.zh-CN.md)。首次失败记录保留在[原浏览器报告](TASK_EXECUTION_BROWSER_E2E.zh-CN.md)，不覆盖历史结果。

## 实现与部署

- 工作区设置和桌面/手机频道新增同一套 Task 配置界面；LEGACY 时可进入。可发布 Definition 新版本、选择频道 Agent、创建/保存 Binding、原子切换默认负责人、查看 placement/readiness、导入真实本地准入证明，以及准备、启用、暂停和恢复聊天模式。自定义的已有角色在版本编辑时正确回显。
- HTTP 请求合并自定义 header 时保留认证头；任务请求使用兼容 LAN HTTP 的稳定 ID，产物下载使用不依赖 Web Crypto 的 SHA-256。刷新后选择器仅列根任务，取消状态不显示历史阻塞原因。
- 本地 Aida 可在沙箱停止后通过 `task-plan.json` 提交一层计划；子任务、已规划根任务不能重复委派。根任务最终交付自动关联当前 VERIFY 证据。
- 按用户选择使用本机 Codex ChatGPT 登录态代理：受信 supervisor 读取主机私有凭证，服务端先颁发 Task/claim 许可，模型回执和实测用量落账后才返回沙箱。主机凭证不进入 Task HOME、文件、进程环境或服务端；没有替换服务器 Key。模型推理仍是远程服务，不能称为离线本地推理。
- 服务位于 [192.168.28.113:5181](http://192.168.28.113:5181)，最终镜像 `sha256:fe9566c2b6c870ef6643a063dc9163ddb7c2007ddc304ae1c14c1875878822d9`，健康检查通过，schema 19。本轮没有新迁移、清空业务库或修改其他业务工作区。

真实任务执行使用前一修复镜像 `sha256:0483ff52612dbf7eef038cdc6b99cbbbef08785239113068dd4521d50f6cd512`；最终镜像仅追加已有角色回显和登录态准入命令提示。部署最终镜像后重新打开配置页面、核对数据和这两项修正，并通过页面停止及恢复聊天模式。服务端执行代码相同；没有把前一镜像上的完整工作流冒称为最终镜像的新运行。

## 实际浏览器场景

实际 Headless Chrome 151/CDP，桌面 1440×1000、手机 390×844，直接操作 LAN HTTP 部署服务。该地址下 `crypto.randomUUID` 和 `crypto.subtle` 不可用；没有 API 或模型 mock。

使用独立验收工作区 `co-f5327e77-3`，复用首次实测的 Aida、Worker、Verifier。通过现有浏览器会话的正式 API 配对一台新的本地测试计算机 `comp-d1980bac-53a`，运行仓库真实 `AgentRunner` 和原生 Codex 0.158.0/bubblewrap。没有改动现有主机计算机配置。配对属于 API 辅助准备，不宣称配对页面通过；继续执行/取消用的未派发 Task 同样通过正式 API 准备。

| 场景 | 实际结果与证据 |
|---|---|
| 只有 Aida 的频道 | 浏览器发送 `17 + 25`；Task `573e7c53-37bc-44ba-bbc3-c4051dc1b44e` 实际回复 `42`，DELIVERED，执行已停止；[截图](verification/browser-local-repair-20261004/local-aida-delivery.png) |
| 多 Agent 频道 | 根 Task `c1033df0-f9ea-414a-820e-024a0793fab7` 提交 WORK → VERIFY 计划；Worker `37fe5734-a211-43ad-8847-33de3089450c` 生成恰好 11 字节、无换行的 `hello world`；Verifier `8ac77d5e-377e-47e0-93b1-f309f288d4a7` 读取准确交接版本并生成 PASS 报告，Aida 汇总并附两个 VERIFY 证据版本；三个 Task 均 DELIVERED，四次派发均实际停止；[截图](verification/browser-local-repair-20261004/multi-agent-delivery.png) |
| 配置发布与持久化 | 从 LEGACY 开始准备；导入本机真实准入记录；发布 Aida v2；保存单/多 Agent 频道 Binding；把默认负责人先切至 Verifier 再切回 Aida，始终唯一；readiness 通过后从页面启用 TASK；[绑定](verification/browser-local-repair-20261004/multi-agent-bindings.png)、[准入](verification/browser-local-repair-20261004/local-admission.png) |
| 相关配置入口 | 工作区 Task 设置、频道 Task 设置、手机 Task 设置均读取同一已保存配置；既有 Aida 编辑页正确显示本地计算机/Codex，保存后 placement 保留；[工作区](verification/browser-local-repair-20261004/workspace-task-settings.png)、[Agent](verification/browser-local-repair-20261004/aida-local-agent-settings.png)、[手机](verification/browser-local-repair-20261004/mobile-task-settings.png) |
| LAN 继续执行 | 点击「继续执行」派发 Task `139794b3-3416-43ea-9e88-74c6fc32dcd6`；原生 Codex 计算 `2 + 3`，实际回复 `5` 并交付；[截图](verification/browser-local-repair-20261004/lan-drive.png) |
| 桌面/手机下载 | 点击任务面板和消息中的产物链接；实际下载版本 `4acc7be0-bf83-4874-a8c1-d4ea0b8d022a`，文件内容 `42`、hash 匹配。同版本重复下载覆盖同一文件，记录保留最终字节；[手机截图](verification/browser-local-repair-20261004/mobile-aida-delivery.png) |
| 手机取消与根任务选择 | Task `eea26563-599a-4e1f-a472-94be2cbd8a58` 从 OPEN 取消为 CANCELLED；已有历史失败 Task 取消后不显示阻塞原因；多 Agent 下拉框不列 WORK/VERIFY 子任务；[取消截图](verification/browser-local-repair-20261004/mobile-cancel.png) |
| 最终镜像与清理 | 最终版本能回显已有 AIDA 角色并显示 codex-login 准入命令；停止临时本地运行进程后，从页面恢复测试工作区 LEGACY，全部任务/产物事实保留；退出测试登录并关闭浏览器；[配置](verification/browser-local-repair-20261004/final-config-compatibility.png)、[恢复](verification/browser-local-repair-20261004/cleanup-legacy.png) |

实际模型请求共 **18 次**，Aida/Worker/Verifier 均有 `local-codex-login` 实测用量记录，全部成功且许可回执 SETTLED。Worker 的内容版本为 `1b4d74f7-8595-4270-a0e2-65a164dbab23`，SHA-256 `b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9`。Verifier 的新工作目录没有 Worker 的原文件，通过准确产物版本完成验证；这是预期隔离行为。

浏览器没有应用 Runtime 异常。辅助测试代码曾把创建 Task 字段写成 `conversationId/grants`，正式接口正确返回 400；改为文档中的 `channelId/grantIds` 后成功。CDP 的异步加载等待和现有 AgentEditor 定位也作了修正；这些脚本修正保留在机器记录的限制说明中，不算产品错误。

## 自动化回归

**264 项断言通过，0 失败、0 跳过；另有 6 项静态检查通过。** PostgreSQL/Redis 测试使用独立 `cumora_task_test` 数据库和测试 Redis，与浏览器验收工作区的数据不混用。

| 范围 | 通过数 | 边界 |
|---|---:|---|
| 单元测试 | 200 | 原相关回归 196 项，加 HTTP SHA-256、错误 hash、Codex SSE 完成/失败 4 项 |
| PostgreSQL/Redis 集成 | 52 | Task 契约及新增配置/原子默认/模型许可 26 项，入口 8、治理 1、日历 4、runtime 辅助接口 10、Convene 3 |
| 原生 Codex | 5 | 实际边界 3，原混合执行回归和全部本地执行各 1；工作流模型响应是确定性服务，独立于上述真实浏览器调用 |
| Chrome 交互回归 | 7 | 歧义发送回滚、共同选择、稳定重试、阻塞状态、继续/取消、鉴权/hash 下载、撤权下载拒绝；关闭 randomUUID/subtle 后运行 |
| 静态检查 | 6 | OpenSpec strict、服务端/前端 typecheck、big-brain/llm-tracked/engine-registry guard |

本机准入证明另由相同的三项原生边界测试产生，避免重复累计为额外覆盖。首次检查发现新增跨端下载回归缺少 DOM 类型声明，已在该测试中显式声明并重新通过全部静态检查。构建仅有既有 chunk 大小与动态/静态导入提示，无构建失败。

测试进程和浏览器已停止，测试工作区恢复 LEGACY，不会在后台继续消费模型额度。要在实际工作区使用此能力，更新本地运行端、按操作说明验证并导入准入，再从配置页启用 TASK。没有归档 OpenSpec、提交或推送代码。
