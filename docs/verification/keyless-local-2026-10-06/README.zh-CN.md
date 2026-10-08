# 无 Key 本地运行验收

2026-10-06，OpenSpec 变更 `enable-keyless-local-aida`。已在 http://192.168.28.113:5181 的 gaohua chen 工作区完成真实浏览器与本机 Codex 验收。运行中的服务端没有模型 Key，schema 为 **22**；保留原业务数据。

## 实现行为

- `OPENAI_API_KEY` 缺省、空值或空白时自动进入本地模式；`CUMORA_LOCAL_ONLY=true` 可屏蔽既有租户 Key。服务器在凭证查询前拒绝推理，不向主机索取登录凭证。
- 普通群聊工作交给默认 Aida；精确 ID/名称/Binding 别名、人类引用和 `@all` 按确定性规则投递。Aida 负责需求理解、分工和汇总。
- 接收者随消息落库，scheduler 与重连 inbox 共用；在 SQL LIMIT 前过滤，超过 200 条其他成员消息也不会遮住指定工作。
- Agent 回复引用只保留上下文，明确 `@成员` 才表示委派。Aida 引用结果的完成消息无工作接收者，避免再次触发成员。此修复追加在 migration 22；已应用的 migration 21 SQL 未修改。
- 本地 Codex-login Task 的 context 和授权请求共用实际 Agent/账户模型选择；保留准入、许可、请求哈希和回执验证。无 Key 时阻止需要服务器模型的 Runtime。
- 配置页显示本地模式和登录要求；头像生成返回 `503 SERVER_MODEL_UNAVAILABLE`，embedding 跳过，记忆保留置顶/近期读取。

## 已通过的验证

**34 项自动化测试**：28 项启动、迁移与本地模型默认测试；5 项 PostgreSQL/Redis 集成测试；1 项既有本地模型许可回归。前后端类型检查、26 个相关 TS 文件与浏览器脚本的 Biome lint、三项模型/引擎 guard、生产镜像构建、OpenSpec 严格校验及 `git diff --check` 均通过。数据库测试使用独立 `cumora_task_test`，没有在生产库运行清表。

**8 项浏览器/真实模型场景**：

| 编号 | 场景 | 实际结果 |
| --- | --- | --- |
| K01 | 无 Key 能力 API 和桌面配置 | `local-only`；显示本地计算机登录要求 |
| K02 | 配置页创建仅 Aida / 多 Agent 群聊 | Aida 自动加入并成为默认成员 |
| K03 | 仅 Aida 普通消息 | `KEYLESS_SOLO_OK 42` |
| K04 | 多成员普通消息 | 只投递 Aida；`KEYLESS_MULTI_OK 42` |
| K05 | 点名本地成员 | 只投递该成员；`KEYLESS_DIRECT_OK 42` |
| K06 | Aida 实际委派与汇总 | 成员 `KEYLESS_WORKER_OK 42`，Aida `KEYLESS_TEAM_OK 42` |
| K07 | 服务器生成头像 | 503，明确能力不可用 |
| K08 | 实际模型记录与浏览器异常 | `byoa-codex`，没有服务器模型路由调用，浏览器异常为空 |

K06 的最后消息引用实际成员结果，其 `work_recipient_ids=[]`。随后读回确认：成员 inbox 没有该完成消息，也没有后续成员回复。最终 **6 次真实模型运行全部 completed**，模型均为 `gpt-6-sol`，6 条使用记录均来自 `byoa-codex` 且状态 ok。验收会话已删除。

保留的验收群聊：

- 仅 Aida：`g-99c1fb29` — 无 Key · 仅 Aida 1791277142428
- 多 Agent：`g-066e6498` — 无 Key · 多 Agent 1791277142428

## 证据与复跑

- [浏览器验收与消息接收者](acceptance.json)
- [最终模型回执和无重复投递读回](settlement.json)
- [自动化测试及检查](checks.json)
- [部署镜像、21 个运行源码与 10 个前端产物哈希](deployment.json)
- [配置页截图](screenshots/01-local-mode.png)、[仅 Aida 回复](screenshots/03-solo-aida-reply.png)、[真实协作截图](screenshots/06-aida-cooperation.png)
- [运行说明](../../KEYLESS_LOCAL.zh-CN.md)

镜像：`sha256:0ee393e14ba86b7eb4aa8ddb4f7d6a5cc2ddfe21017d98dcbd06903350a3ee84`。已核对容器运行源码与工作区相同；概念数据流文档 SHA-256 仍为 `809a9c159f46f50ab7b47b3fd03095430ccbf4a65ff65e82e6eb3ebf5afd6d11`。

```bash
node scripts/verify-keyless-local.mjs
openspec validate enable-keyless-local-aida --strict
```

浏览器脚本默认使用当前配对环境，并通过 `WORKBENCH_URL`、`WORKBENCH_COMPANY`、`WORKBENCH_USER`、`WORKBENCH_CONTAINER` 覆盖目标。它使用临时登录会话，创建验收群聊并发送真实消息，不保存凭证到报告。

本次真实部署聊天保持 **LEGACY**；Task 的账户模型选择、无服务器模型派发与受控许可在真实数据库套件验证，未宣称当前工作区已切到 TASK 或完成实际 Task 沙箱运行。外部 MCP/GitHub 适配器准入仍使用原有状态。无服务端 Key 仍需要本机在线、Codex/Claude 登录态和供应商网络。
