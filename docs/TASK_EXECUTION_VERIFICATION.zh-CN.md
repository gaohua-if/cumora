# Channel Task P0–P4 验收记录

最新追加修复：[普通工作区的配置入口与群聊默认 Aida](TASK_EXECUTION_GROUP_DEFAULTS.zh-CN.md)。该报告记录新部署及用户实际工作区的普通浏览器操作；本文件和原机器记录保留为此前验收快照。

日期：2026-10-04（Asia/Shanghai）。OpenSpec change：`introduce-channel-task-execution`。P0–P4 实现及下述确定性测试验收完成。实施基线：[multi-agent-implementation-design.md](../doc/multi-agent-implementation-design.md) v0.2；操作与复测入口：[TASK_EXECUTION.zh-CN.md](TASK_EXECUTION.zh-CN.md)。

后续首次部署的[真实浏览器实测](TASK_EXECUTION_BROWSER_E2E.zh-CN.md)曾未通过：真实模型请求返回 401，Task 配置表单缺失，局域网 HTTP 继续执行和无计算机的 Agent 创建存在错误。随后按用户要求排除云服务与第 4 个问题，完成[本地修复与真实复验](TASK_EXECUTION_LOCAL_REPAIR.zh-CN.md)：264 项自动化断言和 6 项静态检查通过，本地单 Aida、Aida/Worker/Verifier 真实模型协作及配置/LAN/手机交互通过。下述记录及原机器 receipt 保留为首次确定性验收快照，当前修复版本以新报告的结果和源码 hash 为准。

## 执行证据与边界

本阶段验收使用独立 PostgreSQL 16（15432）与 Redis 7（16379），数据库实际迁移至 19；该阶段没有迁移业务数据库或部署服务。随后按用户要求完成部署与业务库迁移，见[部署记录](verification/task-execution-deployment-2026-10-04.json)。Node 24.11.1；原生执行使用真实 Linux x86_64、bubblewrap 和 Codex 0.158.0，二进制 SHA-256：`167c0148a849d2444f1b5a7fb5f8bb2de1de5ae13a2a504b833fc765980f5cd9`。

| 检查 | 最终结果 |
|---|---|
| 单元与相关回归，19 个文件 | 196/196；零跳过、取消 |
| Task、入口、既有治理/日历/运行时授权与 Convene 集成 | 完整回归 45/45，最终流程复测 12/12，回滚专项 1/1；9 项重叠，共 49 个不同场景，零跳过、取消 |
| 实际原生进程边界及跨环境 HTTP 工作流 | 4/4；零跳过、取消 |
| Chrome 桌面与移动布局交互 | 7/7；零跳过，API 无 500 |
| strict OpenSpec、前后端类型与 3 个 guard | 6 项通过 |

本次最终报告保留为 [task-execution-verification.json](verification/task-execution-verification.json)，记录命令、时间、实际测试名称/数量、日志 hash、源码 hash、迁移账本与逐文件结果。共 256 项不同测试/交互检查，含复测执行 265 次，另有 6 项类型/规格/guard 检查。临时详细日志路径也保留于 JSON；持久证据不依赖临时日志仍存在。执行脚本是 [verify-channel-tasks.mjs](../scripts/verify-channel-tasks.mjs)，拒绝缺少专用 DB/Redis、零断言和必需测试跳过；DB 清理套件顺序执行。

PostgreSQL、Redis 断开/恢复、HTTP/JWT、真实 WS ticket/转发、Codex 子进程、文件/环境/网络/session 和 Chrome 均为实际边界。模型答复来自确定性 adapter；云端默认 OpenAI SDK 的协议、tracked 调用与本地代理仍实际执行。外部写入未知结果使用可计数的受信 effect，验证写后超时只执行一次及人工对账；未向真实第三方写入，未调用付费模型。旧回归 fixture 中有共享 Redis 未连接的 warning；Task Redis 恢复与 WS 帧检查使用实际连接的专用测试客户端，均已通过。

准入覆盖托管云 worker 和 Linux/Codex/bubblewrap。macOS、Windows、其他引擎、Git/SSH/任意 MCP 未准入，明确拒绝。知识使用来源受限的数据库检索；未获准 embedding 不发请求，没有声称已验收独立向量/embedding 服务。完整流程中的“修复”是确定性补丁内容与实际 CLI 写文件，验证关注执行、授权、内容版本及证据链，不评价模型修复质量。

## 测试索引

下面编号按文件中 `test(...)` 的顺序映射，便于从验收定位到实际断言。

| 编号 | 文件及场景 |
|---|---|
| T01–T23 | [channel-task-execution.test.ts](../server/src/__integration__/channel-task-execution.test.ts)：依次为 schema/租户约束、成员重入、定义固定与协调者操作、入口幂等/控制权、claim 独占、来源撤回、产物不可变、云端隔离、私有草稿/发布、知识分享/失效、切换回滚、REST 歧义/重试/并发、防越界 steer、范围修订、修复验证汇总及新范围重规划、schema 14、普通看板、设备/GC、发布撤权竞争、外部 UNKNOWN、离职、Bundle/自动化、治理/硬预算 |
| E01–E08 | [task-entrypoints.test.ts](../server/src/__integration__/task-entrypoints.test.ts)：日历、scheduler/WS 文档提及/保留删除/旧 Convene 门控、默认 SDK/真实 Redis 恢复、成员移除与发布竞争、新增成员历史门控及读取/引用撤权、Code/Aida 点名、错误 hash 与撤权交接、执行中私聊 Task 独立排队 |
| C01–C07 | [task-contracts.test.ts](../server/src/__tests__/task-contracts.test.ts)：关联权限组合、子授权收敛、无效字段、当前授权、来源/目的地、DAG 边界、本地工具类型 |
| L01–L03 | [task-local-boundary.test.ts](../server/src/__runtime__/task-local-boundary.test.ts)：文件/凭证/PID/网络/session、实际取消及子进程退出、只读输入/symlink 拒绝 |
| N01 | [task-local-workflow.test.ts](../server/src/__runtime__/task-local-workflow.test.ts)：云端 COORDINATOR → HTTP 鉴权本地 WORK → 云端独立 VERIFY → 根任务汇总，准确字节与版本，伪 claim 拒绝及调用账本 |
| U01–U07 | [test-task-chat-ui.mjs](../scripts/test-task-chat-ui.mjs)：歧义发送回滚、桌面/移动共同选择、重试选定 Task、阻塞状态、继续/取消、鉴权/hash 下载、撤权后下载拒绝；任何 API 500 使检查失败 |
| 兼容回归 | [organizational-governance.test.ts](../server/src/__integration__/organizational-governance.test.ts)、[calendar-scheduler.test.ts](../server/src/__integration__/calendar-scheduler.test.ts)、[runtime-aux-authorization.test.ts](../server/src/__integration__/runtime-aux-authorization.test.ts)、[convene-concurrency.test.ts](../server/src/__integration__/convene-concurrency.test.ts)：原审核闭环、日历重现、运行时授权并发、Convene 成员变更 |

## I01–I12

| 不变量 | 实现与验证 |
|---|---|
| I01 单一 Channel/租户 | FK、Task scope、同频道 plan/handoff；T01、T06、T15、C06、N01 |
| I02 有效 Binding | 固定 definition、当前成员/placement/generation；T02、T03、T18、E06 |
| I03 不创造授权 | 实际主体、可验证 Connection、关联 Grant、准入引擎；C01–C04、T12、T22、L01、N01 |
| I04 子授权收敛/协调与动作分开 | attenuation、角色门控、一层 plan；C02、C06、T03、T15、N01 |
| I05 单 Task 上下文 | Task 专用 loop/manifest/session，不读 inbox、全局文件；T08、T13、L01–L03、N01 |
| I06 派生保留来源 | version/hash 与递归 provenance，显式知识 publication；C05、T10、E07 |
| I07 当前授权 | protected action、history、download、knowledge 和设备撤回均复核；T06、T09、T18–T21、E04–E05、U07 |
| I08 发布才进消息/outbox | 当前受众及来源验证，同事务消息/Delivery/outbox；T09、T19、E03–E05 |
| I09 不可变交接/完成证据 | 固定 artifact bytes/version、handoff、独立 VERIFY；T07、T15、E07、N01 |
| I10 入口唯一/不退回旧执行 | TASK/PREPARING 门控、durable dispatch、稳定阻塞原因；T08、T11、T16–T17、T22、E01–E02、N01 |
| I11 数据目的地 | Grant/输入/知识/动作/本地代理复核 destination；C02、C05、T10、L01、N01 |
| I12 三类完成事实独立 | run/dispatch stop、Task Delivery、治理审核分开；T14–T15、T23、N01 |

## A01–A30

| 场景 | 验收证据与结果含义 |
|---|---|
| A01 全部入口 | T12、T17、T22、E01–E02、N01；缺 Channel/自动化 authority 拒绝，不建隐式 DM |
| A02 点名归属 | E06；Code/Aida 各自的 Binding，协调者不接管 Code |
| A03 补充歧义 | T12、U01–U03；409 回滚，明确选定后按原稳定 key 重试 |
| A04 重复入口/wake/重连 | T04–T05、T08、T12、E01、E03；一个 Task/有效 claim，Delivery 不重新接单 |
| A05 到期未停止 | T05、T11、T18；UNKNOWN 不代表实际停止，不启动第二执行 |
| A06 顺序 Task 隔离 | T08、T13、L01；另一频道输入/全局记忆不进模型，新 HOME/session/目录 |
| A07 执行中其他任务输入 | E08、T05、T06、T13、L01；实际私聊 Task 在群任务执行中到达，只独立排队，停止前不注入/启动，停止后仅消费自身输入 |
| A08 发言与驱动权 | T04、T12–T14；成员可提交合法补充，creator/controller 才能 drive/cancel/scope/steer |
| A09 只读协调与合法工作 | T03、N01；COORDINATOR 自行写资源拒绝，WORK 在独立目录写产物，依原计划交接 |
| A10 放大权限/二层委派 | C02、C06、T15；资源/身份/动作/目的地不得扩大，真实子 Task 再提 plan 拒绝 |
| A11 跨 Workspace | T01–T02、C05、N01；租户 FK/当前主体/claim 拒绝交叉引用 |
| A12 复制 Bundle | T22；引用和复制不能使用另一 Channel 的原 Grant |
| A13 关联组合 | C01–C03；不通过独立 resource/action/identity 集合产生交叉权限 |
| A14 途中撤权/Binding/设备变化 | T02、T06、T09、T18、T21、E04；旧 context 失效，UNKNOWN 不迁移或重放 |
| A15 旧宽接口与主机凭证 | T08、E02、L01–L03、N01；旧 CLI/inbox/memory/HTTP 拒绝，实际 shell 仅见隔离文件、环境、网络 |
| A16 群组受限资料 | C05、T06、T22、E04；私有个人 audience 与未知来源在获准输入/模型使用前拒绝 |
| A17 新成员历史 | E05；当前合法全频道来源允许成员加入，无 workspace 资格或来源撤回返回 409，成员/提示/outbox 原子回滚 |
| A18 发布并发 | T19、E04–E05；与 Grant 撤回/成员变更共用锁，结果有明确先后，后续读取实时拒绝 |
| A19 记忆跨 Channel | C05、T08、T10；置顶/旧原始记忆不扩大权限，owner 显式发布后只批准 Channel 可检索 |
| A20 失效后索引/缓存/原始文件 | T08、T10、E05、L01、N01；新检索及已有 context 失效，Task 详情/消息搜索/回复/WS 引用不返回撤权正文，旧 memory/fs 入口被封闭 |
| A21 未准入提供方 | C05、T10、C07、N01；不批准 embedding 不检索发送，模型/tool destination 当前检查 |
| A22 错误产物版本 | T07、T15、E07、N01；错误字节/hash 不发布，VERIFY 输入与证据绑定准确版本 |
| A23 无法交给协调者 | E07；子产物来源撤回后 handoff 拒绝，无 handoff/消息，根任务保持阻塞 |
| A24 Redis 断开 | E03；真实客户端断开，失败 outbox 保留，恢复后一次展示、再次 drain 为零，不创建派发 |
| A25 写后未知 | T20；实际可计数 effect 写后抛错，重复 key 不再写，停止及观测证据后只记录对账 |
| A26 未准入执行 | T18、E02、L01–L03；协议/能力/hash 不符阻塞，不退回原收件箱或无隔离执行 |
| A27 三类状态 | T23、N01；执行已停止及子 Task 已交付不改变治理卡片原审核状态 |
| A28 升级与回滚 | schema migration/boot 单元、T11、T16、E08；历史 checksum 不改，14 准备不建表，19 才激活 TASK，回滚须停止；保留 Task 消息不进入旧 wake/inbox/context/CLI，新 LEGACY 消息仍可处理 |
| A29 保留与 GC | T18、T21、E02；有效引用/治理/未过保留期产物保留，闭合无引用版本可 GC，含保留事实的租户删除拒绝 |
| A30 完整协作 | T15、N01、T10；同 Channel 一层 DAG、准确补丁→独立 VERIFY→根交付，经验来源保留；新 scope 重新规划且旧证据不复用 |

## 数据流与兼容审查

概念文档 v0.4 未修改，本次文件 SHA-256 为 `809a9c159f46f50ab7b47b3fd03095430ccbf4a65ff65e82e6eb3ebf5afd6d11`。用户输入仍在原 Channel，Task/Binding 只明确执行归属；Grant 限制来源/身份/目的地；WORK/VERIFY 使用固定产物交接；根 Task 发布原频道；知识归属与来源权限分开。D1 使用 SERVICE/PERSONAL 明确身份，D2 依来源和显式 publication，D3 不创建群内部分成员可见的任务正文/产物。

实现追加 migrations 15–19，既有 1–14 未改。服务支持 schema 14..19；TASK 要求 19，启动只检查不迁移。Task 创建固定 Definition/configuration；新 Binding 版本只影响新 Task。旧会话/participant/message/card ID 与治理审核保持原规则。原有 README、探索文档及其他工作区修改保留。

已检查新增 Task 服务、公共/运行时入口、旧执行与回滚门控、桌面/移动共用组件、迁移、测试、脚本和 OpenSpec artifacts；`git diff --check` 通过。所有实现及必需验收项均通过，任务记录见 [tasks.md](../openspec/changes/introduce-channel-task-execution/tasks.md)。完成状态不会自动发布、提交或归档。
