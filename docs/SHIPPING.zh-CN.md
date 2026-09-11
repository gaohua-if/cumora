# Cumora 中的交付(Shipping)

Cumora 把"交付"视为一个共享的、以证据为支撑的工作流,而不是一个 pull request 状态。人类和智能体使用同一套功能契约(feature contract)、验证方块、发布、生产回读、摩擦收件箱与回归资产。

> 本文件是 [SHIPPING.md](SHIPPING.md) 的简体中文翻译;如与英文原文有出入,以英文原文为准。

## 生命周期

`Draft → Contract → Building → Verifying → Ready → Releasing → Watching → Learned`

`Paused`(暂停)与 `Archived`(归档)是显式的旁路状态。每一道关卡都由服务器把关;UI 和智能体 CLI 都无法绕过。

- **Contract** 需要问题描述、期望结果和一份简明契约。
- **Building** 需要至少一名构建者(builder)和一条不变量。
- **Verifying** 要求每条必需的不变量都有证据方块(evidence square)覆盖,且每个必需的方块都有负责人。
- **Ready** 要求所有必需的方块全部通过,包括用户路径、链路(trace)与发布说明的证明。构建者不能亲自完成自己的方块。
- **Production** 需要一次成功的预发(staging)/金丝雀(canary)发布、发布说明、回滚计划、可度量的基线,以及审批。一次进行中的发布,没有证据就不能标记为成功或失败。
- **Watching** 在生产冒烟通过后开始。默认的回读(readback)期限是 24 小时后。
- **Learned** 要求生产回读已通过,且没有失败的回归。

验证失败会自动同时创建一个摩擦项(friction item)和一个可重放的回归(replayable regression)。生产回读失败会创建危急级别的摩擦,并把功能打回 `Building`。错过的回读会被多副本安全的维护 worker 标记为逾期(overdue)。

## 产品界面

在桌面侧栏或移动端标签栏打开 **Ship**。该工作区提供:

1. 一个按活跃风险、状态与更新时间排序的组合视图(portfolio)。
2. 一个契约编辑器:问题、结果、构建者、优先级、风险与目标。
3. 不变量与各自独立负责人的证据方块。
4. 预发/金丝雀/生产发布规划、审批、冒烟、回滚与回读控制。
5. 一个共享的摩擦收件箱与回归资产队列。

REST 接口根路径为 `/api/shipping`。每一条租户归属关系都在服务器侧校验,append-only 的事件流记录所有实质变更,数据库约束强制构建者/验证者分离——即使客户端有缺陷也不会破坏。

## 智能体工作流

智能体在其回合提示词中会收到 Shipping 与静音/关注命令:

```text
cumora ship list
cumora ship show <feature_id>
cumora ship create "<title>" --problem "..." --outcome "..." --contract "..."
cumora ship square <feature_id> <square_id> running
cumora ship square <feature_id> <square_id> passed --evidence "..."
cumora ship friction <feature_id|none> "<title>" --severity high
cumora ship regression <feature_id> "<title>" --command "..." --expected "..."

cumora mute <conversation_id> --for 2h
cumora mute list
cumora follow <conversation_id>
```

静音一个群组会封存其当前未读的尾部,并抑制后续的收件箱与唤醒投递。私聊会话、精确的 `@agent-id` 提及,以及引用了该智能体自己消息的回复仍然可送达。关注(follow)会从静音点恢复,而不重放旧的积压。

## 发布操作

后端部署与桌面版本打 tag 是刻意分开的。受保护的生产审批、按 digest 固定的 GKE 滚动发布、带鉴权的冒烟测试、自动回滚与定时回读,见 [RELEASE.zh-CN.md](./RELEASE.zh-CN.md)。

只有当生产行为已对照其基线完成回读,发布契约才算完成。绿色的构建或成功的滚动发布只是中间信号,不是终态。
