# Design

## Context

见 proposal.md。env 强制 Key；embedding 在模块顶层构造客户端；scheduler 进行服务端语义路由，而本地 daemon 还会自行轮询未读 inbox。Task Codex-login 已有受控许可/回执，却仍使用服务端全局模型名。主工作区目前为 LEGACY。

## Goals / Non-Goals

**Goals:** 在未配置服务端 Key 时直接启动；服务端不触碰租户模型凭证；LEGACY 群聊和 TASK 本地模型选择均按 Aida 职责工作。

**Non-Goals:** 离线模型、手机端改版、云执行扩展、外部适配器准入、历史 Task 自动恢复、变更概念数据流。

## Decisions

1. `OPENAI_API_KEY` 可空，`CUMORA_LOCAL_ONLY` 未指定时按 Key 是否为空决定。显式 true 可以屏蔽既存凭证。模型入口在任何租户查询前抛出 `SERVER_MODEL_UNAVAILABLE`；HTTP 返回 503。拒绝采用假 Key，因为它只会把启动错误延迟到 401。
2. 追加 migration 21/22，保存 `messages.work_recipient_ids`。数据库插入触发器按当前有效成员、Binding 默认值、精确 ID/名称/alias、人类 quote 和 @all 得到接收者。所有消息写入路径统一，不因 WebSocket、CLI 或 Agent 回复漏算。历史普通消息只补接收者，不创建工作。scheduler 只读持久接收者，inbox 在 LIMIT 前过滤，避免被大量其他成员消息饿死。系统消息保留原来的专属通知逻辑。
3. 默认负责人优先有效默认 Binding，其次当前名为 Aida 的成员，再次唯一 Agent；多人无默认时不广播，配置缺失可定位。Agent 引用只携带对话上下文，明确 @ 才表示再次委派；Agent 的无目标发言仅通知默认负责人；Aida 自己的无目标发言无工作接收者。展示消息和工作投递分离。
4. local-only 模型客户端禁止联网；embedding 懒创建并跳过回填。其他辅助调用使用已有确定性保底或明确拒绝；managed wake 和需要服务器模型的 Task 在派发前阻止。通过工作台 API 返回非敏感 capability，UI 说明本机登录态要求。
5. Task 本地模型解析重用 registry 的账户目录/Agent 优先级，context 与 authorize 使用同一选择；保留已有准入、工具限制、输入边界和回执。

## Risks / Trade-offs

- 路由变更会减少旁观 Agent 自动参与 → 通过 @all、直接 @ 和 Aida 委派表达明确需求，真实多成员验收验证。
- 只缩小 wake 不能保证重连行为 → 持久接收者在 inbox SQL 的 LIMIT 前检查。
- CLI 模型目录随账户变化 → 只使用实际目录默认，明确配置仍优先，缺失模型则提示配置。
- Keyless 仍依赖本机在线、登录态和模型网络 → 配置页和验收报告明确表述。

## Migration Plan

追加不可变 schema 22 并校验 checksum；在隔离数据库验证 trigger/inbox/Task，然后构建并部署 5181。删除部署 env 的服务端模型 Key，不输出凭证；读回容器中的凭证是否存在仅报告 boolean。实际浏览器创建仅 Aida/多成员群聊，发送普通和指定消息，验证真实 Codex 回复及无 message-routing/embedding 服务端调用。保留原数据，不要求清库。应用回滚仅使用兼容 schema 22 的版本。

真实协作验证发现回复工具自动添加引用，故追加 schema 22 限制引用定向仅作用于人类消息；已应用的 schema 21 保持不可变。Agent 显式 @ 仍正常委派，Aida 引用成员结果的完成消息无工作接收者。
