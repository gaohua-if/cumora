# 已部署服务的浏览器端到端实测

本文件保留首次部署验收的历史失败事实。按用户要求排除云服务和第 4 个问题后的修复及真实本地复验已通过，见[本地 Task 修复验收](TASK_EXECUTION_LOCAL_REPAIR.zh-CN.md)；下述失败结论属于原镜像，不代表修复镜像当前的本地结果。

2026-10-04，Asia/Shanghai。结论：**完整业务端到端验收未通过**。真实 Chrome 已操作单 Aida、多 Agent、任务选择与操作、Agent 配置、工作区设置和频道详情；实际模型返回 401，定义/Binding/切换配置缺少 UI 表单，局域网 HTTP 的继续执行存在运行错误。此结论不能用此前确定性 adapter 的自动化测试通过结果替代。

## 环境与准备

- 使用已部署镜像 `sha256:c1e838f5b19a1d6a2261bc0d018b08894352efb8e66bb17ec17c9ec6ab3fc8c4`，schema 19；测试目标为 localhost:5181 和实际公布的 [局域网地址](http://192.168.28.113:5181)。
- 实际 Headless Chrome 151，通过 CDP 点击、输入、保存、发送和切换窗口；桌面 1440×1000，移动端 390×844。
- 在浏览器注册独立账号 `task-browser-e2e-20261004@example.test`；测试工作区 `co-f5327e77-3`。没有使用现有业务工作区，没有 TRUNCATE，没有模拟 API 或模型响应。
- 按“暂时不考虑权限问题”的范围，未进行越权/撤权场景验证。仅临时把新测试账号设为 max，绕开套餐/首次配对引导；没有改动权限检查代码或其他账号。
- Agent 创建页面在缺少计算机时返回 400。为继续其他测试，通过当前登录会话调用现有 Agent API，省略 `computerId` 准备 Aida、Worker、Verifier。
- 因配置表单缺失，通过当前登录会话调用正式 Task API，创建定义和 Binding，为两个群和三个自动创建的私聊设置默认 Binding，readiness 无 failures 后激活**这个测试工作区**。这些是 API 辅助准备，不计为配置页面通过。

机器记录：[task-execution-browser-e2e-2026-10-04.json](verification/task-execution-browser-e2e-2026-10-04.json)。

## 场景结果

| 场景 | 实际结果 |
|---|---|
| 浏览器注册、会话及进入应用 | 通过，注册 201 |
| 创建“E2E · 只有 Aida” | 通过，成员为测试用户和 Aida |
| 创建“E2E · 多 Agent 协作” | 通过，成员为测试用户、Aida、Worker、Verifier |
| 单 Aida 消息入口 | 通过；“17 + 25”消息创建根 Task，绑定本频道 Aida |
| 单 Aida 实际答复、产物及交付 | 阻塞；真实 agent-turn 请求 401，Task 显示 TASK_EXECUTION_FAILED |
| 多 Agent 消息入口 | 通过；“Worker 编写、Verifier 检查、Aida 汇总”创建由 Aida 负责的根 Task |
| Aida 实际计划、子任务、交接、验证与汇总 | 阻塞；协调者模型请求 401，数据库 plan=0、Delivery=0 |
| localhost 继续执行 | 通过派发和重试；新的真实模型调用仍返回 401，不计为任务执行成功 |
| 显式创建第二个独立 Task | 通过，频道存在两个未完成根任务 |
| 多任务歧义、选择后重试 | 通过；未选择时 409，界面显示发送失败；选择原始 Task 后重试成功，补充消息仅一条，input_revision=2 |
| 桌面与移动端取消 | 通过，状态进入 CANCELLED |
| Agent 简介编辑、保存、再次打开 | 通过，测试简介持久化 |
| 移动端 Task 选择和状态 | 通过，显示同一 Task 与取消状态 |
| 局域网 HTTP 继续执行 | 失败，crypto.randomUUID is not a function |
| 无计算机的 Agent 创建表单 | 失败，computerId must be a string (400) |
| Task 的工作区、频道和 Agent 配置表单 | 未通过，定义/Binding/默认协调者/模式切换的表单不存在 |

## 待解决问题

### R1：真实模型凭据拒绝（阻塞真实执行）

两种频道的 `agent_runs` 都进入 failed，Task/dispatch 进入 BLOCKED；`llm_calls` 的真实 `agent-turn` 请求记录均为 HTTP 401。这次验证确认故障影响主执行模型，不仅是启动时的 embedding。需要为部署配置有效模型连接，再复测单 Agent 的答复和多人协作的完整计划/交付。当前没有真实产物，所以下载及真实交付后展示没有执行，不能标为通过。

证据：[多 Agent 阻塞界面](verification/browser-e2e-20261004/multi-blocked.png)。

### R2：公布的 HTTP 局域网地址不能继续执行（阻塞用户操作）

在 `http://192.168.28.113:5181` 选择阻塞 Task，点击“继续执行”，页面显示 `crypto.randomUUID is not a function`。浏览器实际 `isSecureContext=false`，`crypto.randomUUID` 和 `crypto.subtle` 都未提供；localhost 下此操作可派发。

[TaskContextPanel.tsx:50](../src/components/TaskContextPanel.tsx#L50) 直接调用 randomUUID。应提供适合当前部署方式的请求 key 生成方案，或把公布的服务部署为 HTTPS，再验证实际地址。下载在 [同文件第 58 行](../src/components/TaskContextPanel.tsx#L58) 也依赖 crypto.subtle；这是源码确认的后续风险，本轮未拿到真实产物，未宣称已复现下载失败。

证据：[LAN 继续执行错误](verification/browser-e2e-20261004/lan-crypto-error.png)。

### R3：Task 配置页面缺失（阻塞纯 UI 配置闭环）

工作区设置只有成员、邀请和删除。Agent 编辑只有身份/提示词、模型、运行位置和头像。频道详情只有成员、话题、静音和旧召集入口。均没有 Definition 版本、频道 Binding、默认 Aida、PREPARING/readiness/TASK 的配置表单。正式 API 可完成准备与激活，但无法仅用当前页面完成新功能的配置闭环。

证据：[工作区设置](verification/browser-e2e-20261004/workspace-settings.png)、[Agent 编辑](verification/browser-e2e-20261004/agent-settings.png)、[频道详情](verification/browser-e2e-20261004/channel-details.png)。

### R4：计算机未选择时的创建契约不一致

在无可选计算机的测试工作区，填写名称和提示词后点击创建，实际 POST /api/agents 返回 400。前端 [AgentEditor.tsx:241](../src/components/AgentEditor.tsx#L241) 发送 computerId=null；服务端 [router.ts:3210](../server/src/api/router.ts#L3210) 只接受省略或字符串。省略该字段的正式 API 请求可创建 Agent。需统一可选字段契约，并明确无运行位置时的界面行为。

证据：[Agent 创建失败](verification/browser-e2e-20261004/agent-create-error.png)。

### R5：取消后的阻塞文案仍保留（展示问题）

取消后 Task 和下拉选项均为 CANCELLED，页面仍显示原来的 TASK_EXECUTION_FAILED 阻塞原因。操作状态正确，但文案需要区分历史失败和当前状态。

## 数据库核对与清理

原始根 Task：单 Aida `af284ee4-1530-4150-9e25-03e0097e71af`；多 Agent `4d86e8e9-dae4-425f-8fee-c20d8df4bac9`；第二个独立任务 `beceb084-36bf-45b1-afc7-9d21147e8ef3`。负责 Agent 均按配置为 Aida，原始协作 Task 的 input_revision 从 1 变为 2。补充消息准确持久化一次；没有计划或交付记录，没有未确认停止的执行器。

结束时三个 Task 全部取消，PENDING/CLAIMED/UNKNOWN dispatch=0。测试工作区通过 stop/readiness/rollback 恢复 LEGACY；测试账号恢复 free 并撤销会话，Chrome 已关闭。保留独立测试工作区和事实记录供复查，没有删除业务数据。本轮没有改动运行代码或重新部署。

截图还包括 [移动端](verification/browser-e2e-20261004/mobile-local.png) 和 [任务选择/取消](verification/browser-e2e-20261004/selection-cancel.png)。
