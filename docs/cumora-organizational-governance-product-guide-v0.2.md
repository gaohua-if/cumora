# Cumora 组织治理：产品说明与使用指南 v0.2

> 文档状态：与组织治理 Spec v0.2 及当前 P0 实现配套  
> 面向对象：Workspace 管理员、项目负责人、审核人、Agent 平台接入者和运维人员  
> 规范依据：[cumora-organizational-governance-spec-v0.2.md](./cumora-organizational-governance-spec-v0.2.md)

## 1. 产品简介

Cumora 组织治理是在现有 Board/Card 协作之上，为单张 Card 提供的可选治理层。它适合由 AI Agent 执行、但必须有人类明确负责，并需要预算约束、独立审核、软件交付验证和完整审计记录的工作。

治理不是另一套任务系统。Card 仍然是工作承诺和最终验收的权威来源；Shipping 负责软件候选物的验证与发布状态。二者通过 Card、Artifact 版本、Plan Epoch 和 Shipping Contract Revision 关联，但不互相替代。

典型场景包括：

- 让 Agent 实现一项代码变更，并限制模型调用次数和费用；
- 将产物交给独立人员审核，避免“自己生产、自己批准”；
- 要求候选代码通过指定的 Shipping 验证后才能验收；
- 在组织成员、责任人或计划变更后，使旧授权和旧结果自动失效；
- 为事后审计保留授权、执行、人工干预、审核和验收证据。

不建议为低风险、一次性或不需要审计的普通协作 Card 启用治理。治理一旦启用，P0 不支持降级回普通协作模式。

## 2. 产品价值

| 问题 | 治理机制 |
| --- | --- |
| Agent 是否获得明确授权 | Role、Primary 和 Mandate 共同限定责任、主体、资源与操作 |
| 多个执行者是否会重复工作 | Claim 负责 Card 级协调，Attempt Lease 负责执行实例互斥 |
| 旧计划的工作是否可能误提交 | 每次计划替换递增 Epoch，旧 Epoch 的执行和提交被拒绝 |
| Agent 是否可能无限消耗模型预算 | Budget Account、调用前授权和调用后结算形成闭环 |
| 产物是否会被悄悄替换 | Artifact 使用不可变版本和内容哈希 |
| 生产者是否能审核自己 | Independent Review 和 Final Acceptance 都检查生产者身份 |
| 软件是否真正满足交付条件 | Shipping 对精确候选物、合约修订和 Epoch 执行验证 |
| 为什么完成、由谁完成是否可追溯 | Timeline 和最终 Manifest 保存完整依据 |

## 3. 核心概念

- **Role**：组织责任，例如“支付系统负责人”。Role 声明可以授予的能力范围。
- **Primary**：当前承担该 Role 的人类成员。P0 只支持一个有效 Primary；成员离开 Workspace 后立即失去权限，但历史记录保留。
- **Mandate**：Primary 针对一张 Card 授予某个 Agent 的正式授权，包含精确 Grant、期限、预算和自治策略。
- **Plan / Epoch**：当前执行计划及其世代号。激活新计划会增加 Epoch；旧世代的动作、租约、审核和验证不能用于当前验收。
- **Action**：计划内可执行的工作单元。P0 支持根 Action 和一层子 Action。
- **Attempt / Lease**：Agent 对 Action 的一次执行尝试及其短期租约。心跳维持租约，失联后可以安全重试。
- **Claim**：Card 级的短期协调权，不等于授权，也不能替代 Mandate。
- **Artifact Version**：不可变的正式产物版本，带内容哈希、来源和生产者信息。
- **Submission**：对一组 Artifact Version、DoD、策略和 Shipping 合约修订的冻结提交包。
- **Review**：对 Submission 的独立审核。生产者不能审核自己的提交。
- **Final Acceptance**：当前 Role Primary 的最终验收。只有该操作能把治理 Card 置为 `DONE`。
- **Intervention / Needs You**：Agent 无法继续时发起的人工请求，带截止时间和可审计结果。
- **Manifest**：验收后生成的最终交付清单，汇总目标、产物、审核、验收人与已知限制。

## 4. 端到端流程

```mermaid
flowchart LR
  A[普通 Card] -->|启用治理| B[Governed / Epoch 1]
  B --> C[Mandate + Action]
  C --> D[Attempt / Lease]
  D --> E[Artifact Version]
  E --> F[Shipping 验证]
  F --> G[Submission]
  G --> H[独立审核]
  H --> I[Primary 最终验收]
  I --> J[DONE + Manifest]
```

Card 的治理状态为：

- `READY`：治理已启用，尚未开始正式执行；
- `IN_PROGRESS`：存在进行中的治理工作；
- `IN_REVIEW`：已提交，等待审核或最终验收；
- `PAUSED`：Primary 暂停工作；
- `DONE`：所有门禁通过并完成最终验收；
- `CANCELLED`：治理工作被取消。

## 5. 使用前准备

启用治理前应满足以下条件：

1. 操作者是当前 Workspace 成员，并有权创建 Role 或管理该 Card。
2. Card 尚未完成，且当前仍处于普通协作模式。
3. 已存在一个有效 Role，并为其指定当前人类成员作为 Primary。
4. 已选择一个未离开 Workspace 的 Agent。
5. 已写明可验证的 Definition of Done、截止时间、整数微美元预算和模型调用上限。
6. 需要软件交付门禁时，先创建或选择与该 Card 绑定的 Shipping Feature。
7. Governed Attempt 只允许在 Cumora 管理的付费云运行位置执行；免费层、本地、VPS 和 BYOA 在 P0 中会 fail closed。
8. 运维人员已为实际使用的模型配置可信价格，否则模型调用会被拒绝。

建议先选择一张非生产关键 Card 做试点，并由不同人员分别担任生产者、独立审核人和最终验收人。

## 6. 界面快速使用

当前桌面端 Card Detail 提供启用治理、查看治理摘要、生命周期控制和 Timeline。Action、Attempt、Artifact、Submission 与 Review 的完整编排目前主要由 API 和 Agent Runtime 完成。

### 6.1 创建责任 Role

1. 打开目标 Card 的详情。
2. 在治理面板选择 **Enable governed work**。
3. 如果 Workspace 尚无 Role，使用快速创建功能：输入 Role 名称，并将当前用户设为 Primary。
4. 确认 Role 的责任范围和可授权 Grant 与该 Card 的工作相符。

Primary 不是荣誉标签，而是当前能够暂停、取消、变更授权和最终验收的人类责任人。更换 Primary 会结束旧 Assignment；历史事件不会被改写。

### 6.2 启用治理

在治理面板中：

1. 选择 **Accountable Role**；
2. 选择执行 Agent；
3. 填写 **Definition of Done**；
4. 点击 **Enable governance**。

界面当前使用的默认值为：截止时间 7 天、预算 `1,000,000 microusd`（1 美元）、模型调用上限 100。正式项目应根据任务规模通过集成层传入明确值，不要长期依赖默认值。

启用成功后，Card 显示治理状态、Epoch、责任 Role、Human Sponsor、DoD 和最近 Timeline。普通的列移动和负责人修改会被禁用，删除入口会隐藏；后续状态只能通过治理命令改变。

### 6.3 运行中控制

当前 Primary 可以：

- **Pause**：停止接收新工作，并让运行中的 Attempt 进入停止过程；
- **Resume**：从暂停前的有效状态恢复；
- **Cancel**：终止当前 Epoch 的未完成 Action 和 Attempt；
- **Archive**：仅在 `DONE` 或 `CANCELLED` 且不存在未决外部操作时归档。

取消和归档不是删除。治理证据、事件、Artifact 和 Manifest 按保留策略继续保存。

### 6.4 查看审计记录

Card 详情中的 Timeline 展示最近治理事件。完整记录可调用：

```http
GET /api/governance/cards/{cardId}/timeline
```

Timeline 应用于回答“谁在什么授权下执行了什么、使用了哪个 Epoch、为何暂停或验收”，而不是作为可修改的备注列表。

## 7. API 集成指南

API 前缀为 `/api/governance`。以下示例省略 Cumora 的常规登录 Cookie 或认证头；调用方必须使用正常认证会话。所有修改请求建议发送唯一的 `Idempotency-Key`，升级、提交和最终验收等关键命令会强制要求该头。

### 7.1 创建 Role 并指定 Primary

```http
POST /api/governance/roles
Content-Type: application/json

{
  "name": "支付系统负责人",
  "responsibilityScope": "负责支付服务代码和交付验收",
  "grantableGrants": [
    { "resourceType": "CARD", "resourceId": "card-123", "operation": "card.read" },
    { "resourceType": "CARD", "resourceId": "card-123", "operation": "card.action.create" },
    { "resourceType": "CARD", "resourceId": "card-123", "operation": "artifact.publish" }
  ]
}
```

随后指定 Primary。`expectedVersion` 必须等于最新 Role 版本：

```http
POST /api/governance/roles/{roleId}/assignments
Content-Type: application/json

{
  "humanUserId": "user-123",
  "assignmentType": "PRIMARY",
  "expectedVersion": 1
}
```

Grant 必须是精确三元组，不支持通配符。空 Grant 表示没有权限。P0 常用 operation 包括 `card.read`、`card.comment`、`card.claim`、`card.move`、`card.assign`、`card.rename`、`card.action.create`、`card.action.delegate`、`artifact.read`、`artifact.publish`、`shipping.read` 和 `shipping.verify`。

### 7.2 将 Card 升级为治理模式

```http
POST /api/governance/cards/card-123/upgrade
Idempotency-Key: upgrade-card-123-001
Content-Type: application/json

{
  "accountableRoleId": "role-123",
  "agentId": "agent-123",
  "definitionOfDone": "代码合并候选物通过单元测试与安全检查，并完成独立审核",
  "deadline": "2026-10-01T10:00:00.000Z",
  "budgetLimitMicrousd": 5000000,
  "modelCallLimit": 200,
  "deliveryGate": "CODE_ACCEPTED",
  "shippingFeatureId": "feature-123",
  "expectedVersion": 0,
  "grants": [
    { "resourceType": "CARD", "resourceId": "card-123", "operation": "card.read" },
    { "resourceType": "CARD", "resourceId": "card-123", "operation": "card.action.create" },
    { "resourceType": "CARD", "resourceId": "card-123", "operation": "artifact.publish" }
  ]
}
```

成功响应会返回 `planId`、`planEpoch`、`mandateId` 和事件 ID。`PRODUCTION_READBACK` 不在 P0 范围内；请求该门禁会被拒绝。

### 7.3 创建 Action 和启动 Attempt

完整编排通常由受信任的 Agent Runtime 完成：

```http
POST /api/governance/cards/{cardId}/actions
POST /api/governance/actions/{actionId}/attempts
POST /api/governance/attempts/{attemptId}/heartbeat
POST /api/governance/attempts/{attemptId}/finish
```

调用方需要随命令提供当前 `expectedEpoch`、Mandate 上下文和相应版本字段。Attempt 创建成功后会得到 Lease；运行时必须在租约有效期内发送心跳。租约过期、Mandate 被暂停/撤销、Primary 失效或 Epoch 改变后，旧 Attempt 不再拥有有效执行权。

需要 Card 级互斥协调时使用：

```http
POST /api/governance/cards/{cardId}/claim
POST /api/governance/claims/{claimId}/renew
POST /api/governance/claims/{claimId}/release
```

Claim 只解决协调冲突。即使持有 Claim，调用者仍必须通过 Mandate、Grant、Epoch 和 Lease 校验。

### 7.4 模型预算

每个受治理的主 Agent 模型跳转必须遵循“先授权、后结算”：

```http
POST /api/governance/attempts/{attemptId}/model-calls/authorize
POST /api/governance/attempts/{attemptId}/model-calls/{providerCallId}/settle
```

授权会检查剩余微美元预算和调用次数；结算记录真实 token 与费用。不得通过跳过授权、把调用拆到未受治理的 Agent，或使用未知模型价格绕过预算。

### 7.5 发布 Artifact 并提交

正式产物必须发布为不可变 Artifact Version：

```http
POST /api/governance/artifacts
Content-Type: application/json

{
  "cardId": "card-123",
  "artifactId": "artifact-payment-change",
  "contentHash": "sha256:...",
  "mediaType": "application/vnd.git.commit",
  "byteSize": 1234,
  "kind": "DELIVERABLE",
  "sourceActionId": "action-123",
  "sourceAttemptId": "attempt-123"
}
```

然后冻结提交包：

```http
POST /api/governance/cards/card-123/submissions
Idempotency-Key: submit-card-123-001
Content-Type: application/json

{
  "actionId": "action-123",
  "artifactVersionRefs": ["artifact-version-123"],
  "completionSummary": "候选代码与验证证据已准备完成",
  "expectedVersion": 3,
  "expectedEpoch": 1
}
```

提交后 Card 进入 `IN_REVIEW`。Artifact 内容有任何变化都应发布新版本并创建新 Submission，不能修改旧版本。

### 7.6 独立审核和最终验收

审核人必须不是 Submission 中任一 Artifact 的生产者：

```http
POST /api/governance/submissions/{submissionId}/reviews
Content-Type: application/json

{
  "decision": "ACCEPT",
  "comment": "DoD 和证据均已核对"
}
```

审核决定还可以是 `REQUEST_CHANGES` 或 `REJECT`。只有独立审核为 `ACCEPT` 后，当前 Primary 才能最终验收：

```http
POST /api/governance/cards/card-123/finalize
Idempotency-Key: finalize-card-123-001
Content-Type: application/json

{
  "submissionId": "sub-123",
  "expectedVersion": 4,
  "expectedEpoch": 1,
  "comment": "接受该交付"
}
```

最终验收还会检查：

- Submission 和所有证据属于当前 Epoch；
- 当前 Primary 不是生产者；
- 已存在独立接受审核；
- 当前 Action、Attempt、外部 Operation 和 Intervention 已结清；
- 如果绑定 Shipping Feature，所有必需验证针对完全相同的 Artifact Version 集合、Contract Revision 和 Epoch，且结果为 `PASSED` 或 `WAIVED`；
- Shipping Feature 已到达 `ready`、`releasing`、`watching` 或 `learned`。

通过后 Card 进入 `DONE` 并生成 Manifest。界面拖动 Card 到完成列不能替代 `finalize`。

### 7.7 人工干预

Agent 遇到缺少信息、需要审批或存在高风险决策时，应创建 Intervention，而不是在普通聊天中默默等待：

```http
POST /api/governance/cards/{cardId}/interventions
GET /api/governance/interventions?cardId={cardId}&state=OPEN
POST /api/governance/interventions/{interventionId}/resolve
```

超过截止时间的请求会在查询时转为 `EXPIRED`，并记录 `HUMAN_TIMEOUT`。未解决的 Intervention 会阻止最终验收。

## 8. Shipping 集成

Shipping Feature 是软件验证与发布生命周期的权威对象。可通过 `/api/shipping/features` 创建，并通过 `boardCardId` 绑定 Card；也可在治理升级时传入 `shippingFeatureId`。

对受治理交付，Shipping 验证结果只有在以下条件全部满足时才可用于最终验收：

1. 验证由当前 Epoch 的独立 `VERIFY` Attempt 产生；
2. 验证引用精确的 Artifact Version 集合和候选物 SHA-256；
3. 验证针对当前 Shipping Contract Revision；
4. 必需验证全部 `PASSED` 或经过正式 `WAIVED`；
5. 验证者与产物生产者满足独立性要求。

P0 的交付门禁为 `CODE_ACCEPTED`。它表示代码候选物及验证证据被接受，不表示已自动部署到生产环境。Cumora 不会因为 Card 完成而自动执行生产发布。

## 9. 运维配置

### 9.1 功能开关

```dotenv
GOVERNANCE_UPGRADES_ENABLED=true
```

关闭该开关只会禁止新的 Card 升级；已经处于治理模式的 Card 仍继续执行全部治理约束，不能借此降级或绕过门禁。

### 9.2 模型价格

模型价格必须由运维方配置并视为可信输入。例如：

```dotenv
CUMORA_MODEL_PRICES_JSON={"gpt-5.5":{"inPer1M":2.5,"cachedInPer1M":0.25,"cacheWritePer1M":2.5,"outPer1M":10}}
```

实际价格应按所使用 Provider 的有效合同填写。未配置或无法验证的模型价格会触发 `UNVERIFIED_MODEL_RATE`，不会按零费用继续执行。

### 9.3 数据库与启动

组织治理数据库结构包含在迁移中。部署前先执行迁移，再启动应用：

```bash
npm run migrate
npm run dev:all
```

开发环境默认 Web 为 `http://localhost:5180`，API 为 `http://localhost:5181`。生产部署、认证和存储配置请继续遵循项目的部署文档。

### 9.4 数据保留

正式事件、Manifest、审核记录和 Artifact 元数据默认至少保留 365 天。存在治理引用时，Card、Column、Board 或 Workspace 的删除会被保护性约束阻止。归档不等于销毁；需要执行组织的数据销毁策略时，应通过专用合规流程处理。

## 10. 常见错误与处理

| 错误码 | 含义 | 处理方法 |
| --- | --- | --- |
| `GOVERNANCE_UPGRADES_DISABLED` | 新升级被功能开关关闭 | 运维确认开关；不要修改已有治理记录 |
| `VERSION_CONFLICT` | 对象版本已变化 | 重新读取最新对象，人工合并后重试 |
| `STALE_EPOCH` | 请求属于旧计划 | 停止旧执行，基于当前 Epoch 重新创建 Action/Submission |
| `PRIMARY_REQUIRED` / `MANDATE_INVALID` | 当前人不是有效 Primary，或授权无效 | 检查成员状态、Assignment、Mandate 期限和状态 |
| `GRANT_NOT_ALLOWED` | Mandate 超出 Role 可授权范围 | 收窄 Grant 或由管理员更新 Role 范围 |
| `CLAIM_REQUIRED` / `CLAIM_INVALID` | 缺少或持有过期 Claim | 重新获取 Claim，不要复用旧 ID |
| `LEASE_INVALID` | Attempt Lease 失效 | 获取新 Attempt；不要继续提交旧执行结果 |
| `BUDGET_EXCEEDED` | 预算或调用次数不足 | Primary 评估范围和风险后建立新计划/预算 |
| `UNVERIFIED_MODEL_RATE` | 模型无可信价格 | 运维补充价格配置后重试 |
| `RUNTIME_NOT_GOVERNANCE_CAPABLE` | 运行位置不支持治理 | 将 Agent 放到受支持的付费管理云位置 |
| `REVIEWER_NOT_INDEPENDENT` | 审核人参与过生产 | 更换未参与生产的审核人 |
| `FINAL_REVIEWER_NOT_INDEPENDENT` | Primary 同时是生产者 | 更换有效 Primary 或由独立生产链重新提交 |
| `SHIPPING_GATE_FAILED` | 验证与候选物、修订或 Epoch 不匹配 | 对当前精确候选物重新运行必需验证 |
| `EXECUTION_NOT_SETTLED` | 仍有未结束工作或人工请求 | 结清 Action、Attempt、Operation 和 Intervention |
| `FINALIZE_REQUIRED` | 尝试绕过最终验收完成 Card | 使用正式 Submission、Review 和 `finalize` 流程 |

遇到 `409` 时不要盲目重复原请求。先读取最新版本、Epoch、Timeline 和相关对象，确认这不是并发修改或治理撤销造成的预期拒绝。

## 11. 安全与使用边界

- 不要把 Role 名称当成权限；有效权限来自当前 Assignment、Mandate 和精确 Grant 的共同结果。
- 不要在治理 API 外直接更新 Card 状态、负责人或完成列。
- 不要把普通聊天附件当作正式 Artifact；只有已发布的 Artifact Version 能进入 Submission。
- 不要复用旧 Epoch 的验证、租约、Claim、Submission 或审批。
- 不要让生产者兼任独立审核人或最终验收人。
- 不要把 `CODE_ACCEPTED` 解释为“已上线”或触发自动生产部署。
- 不要在 P0 使用 BYOA、本地或自管 VPS 执行 Governed Attempt。
- 外部副作用操作应使用 Operation 记录预备、派发、结果和未知状态；状态为 `UNKNOWN` 时必须人工核查，不能自动假定成功或失败。

## 12. 当前 P0 范围与限制

当前版本已经支持 Role/Primary、Card 升级、Mandate、Plan/Epoch、Claim、Action/Attempt/Lease、模型预算、Approval、Intervention、Operation、Artifact、Submission、独立审核、Shipping 门禁、最终验收、Manifest 和 Timeline 的服务端闭环。

以下能力仍受 P0 边界限制：

- 界面主要覆盖启用、摘要、暂停/恢复/取消/归档和 Timeline；高级执行链以 API/Runtime 为主；
- 单 Workspace、单 Card 治理，不提供跨 Workspace 授权；
- Action 委派最多一层；
- Role Assignment 只支持 Primary，Backup 属于后续范围；
- 只支持 `CODE_ACCEPTED`，不支持 `PRODUCTION_READBACK`；
- 不支持治理模式降级；
- 不支持 Governed BYOA 执行；
- 不自动部署到生产环境。

## 13. 推荐试点验收清单

- [ ] Role 责任范围和可授权 Grant 已评审；
- [ ] Primary 是当前 Workspace 人类成员；
- [ ] DoD 可测试、可观察，不使用“基本完成”等模糊表述；
- [ ] 截止时间、预算和调用次数合理；
- [ ] Agent 位于支持治理的运行位置；
- [ ] 使用模型均有可信价格；
- [ ] Producer、Independent Reviewer 和 Final Accepter 能满足身份独立性；
- [ ] Shipping Feature 与 Card 正确绑定；
- [ ] 必需验证针对精确 Artifact Version 和当前 Contract Revision；
- [ ] 旧 Epoch 的工作会被拒绝；
- [ ] 暂停、撤销 Mandate、成员离开和租约过期均能 fail closed；
- [ ] 最终只能通过 `finalize` 进入 `DONE`；
- [ ] Timeline 和 Manifest 能完整解释一次交付。

完成一张低风险试点 Card 后，再逐步扩大到更高预算或生产关键工作。
