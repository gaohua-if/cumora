# 无服务端模型 Key 的本地运行

省略或清空 `OPENAI_API_KEY` 即自动启用本地模式。设置 `CUMORA_LOCAL_ONLY=true` 也可以屏蔽已有服务端/租户模型凭证。服务端保留数据库、IM、配置、配对与本地任务接口；不查询租户 Key、不发送服务端模型请求、不接收主机模型登录凭证。

本机需要在线的配对 daemon，以及已经登录的 Codex 或 Claude。本地模型仍使用供应商网络服务。主机登录不能替代 API Key 注入服务端。配置页显示本地模式；生成头像、服务端推理和 embedding 不可用，现有头像保留，记忆按置顶和近期内容读取。

## 群聊投递

普通请求只交给有效默认 Binding，通常是 Aida。精确 `@ID`、`@名称`、`@Binding别名` 或人类引用 Agent 回复直接投递相应成员；`@all` 明确广播。邮件中的 `@`、较长 ID 的前缀不匹配。没有默认 Binding 时使用群聊中 Aida，或唯一 Agent；多人群聊没有默认和 Aida 时不自动广播。

Aida 负责理解、分工、协作和汇总。Agent 回复携带的引用只保留上下文，不单独触发再次委派；需要成员继续执行时由 Aida 明确 @ 该成员。LEGACY 聊天可由 Aida 明确 @ 当前成员交办，成员无目标回复交给默认负责人；Aida 自己的无目标完成消息不会重新唤醒全组。TASK 模式继续使用已有受控计划/子任务，显式多负责人入口仍需选定唯一负责 Binding。

消息接收者与消息事务一同保存，实时唤醒和重连 inbox 使用同一集合。该集合只决定工作投递，不改变群聊展示和历史可见性；当前成员、静音、系统离组通知仍检查。配置默认负责人改变只影响后续消息。

## Task 准入

本地 TASK 执行需要已验证的 Codex 隔离环境和 `modelProvider: codex-login` 准入。模型从 Agent、计算机配置和实际账户目录解析，context 与模型许可使用同一模型；请求正文不能覆盖选择。无已配置或可发现模型时提示 `LOCAL_MODEL_NOT_CONFIGURED`。

需要服务器模型的 Runtime 会被 `SERVER_MODEL_UNAVAILABLE` 阻止。既有工作区不自动切换 TASK；当前聊天仍可按 LEGACY 模式使用 Aida。配置外部资源不自动建立连接或准入。

## 部署与验证

```bash
# 在 gitignored .env.docker 中删除 OPENAI_API_KEY，或设置为空。
# 不用填写任何占位 Key；可额外设置 CUMORA_LOCAL_ONLY=true。
CUMORA_ENV_FILE=.env.docker docker compose build server
CUMORA_ENV_FILE=.env.docker docker compose run --rm migrate
CUMORA_ENV_FILE=.env.docker docker compose up -d --no-deps server
curl -f http://127.0.0.1:5181/api/livez
node --import tsx --test server/src/__tests__/keyless-local-runtime.test.ts
openspec validate enable-keyless-local-aida --strict
```

本版本要求 schema 22；迁移只追加，历史账本不修改。回滚应用必须支持 schema 22。浏览器/真实模型验收使用 `node scripts/verify-keyless-local.mjs`；结果、截图和镜像身份见 [验收报告](verification/keyless-local-2026-10-06/README.zh-CN.md)。测试数据库套件会清表，必须使用独立数据库。
