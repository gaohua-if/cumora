# 配置工作台原型 v2

2026-10-05。依据[已确认的交互决策](../configuration-workbench-v1/DECISIONS.zh-CN.md)，修复 v1 桌面交互问题，并补齐 Agent/Skill 固定版本与任务快照演示。

- [打开新版原型](http://192.168.28.113:5182/configuration-workbench-v2.html)
- [单文件 HTML](../configuration-workbench-v2.html)
- [设计文档](DESIGN.zh-CN.md)
- [验收文档](ACCEPTANCE.zh-CN.md)
- [浏览器验收证据](acceptance.json)

Agent、Access Bundles、群聊、Skill 库使用三栏桌面布局。Agent 配置职责、提示词、固定版本 Skills、语言偏好及本地计算机；Bundle 配置 MCP、域名、GitHub、默认身份及使用说明；群聊配置自身规则、默认负责人、成员配置、固定资源包版本与生效预览。

成员访问显式分为继承全部、选择部分、不使用外部资源。子集删空仍为空。Agent、Skill、Bundle 发布新版后，旧引用保持原版本，用户明确升级。语言按成员、群聊、Agent、工作区的具体值解析；资源预览逐项展示实际身份及范围。

“任务快照演示”只生成静态示例，方便比较升级前后的配置；不发起模型请求或工具执行。数据使用独立浏览器存储 `cumora.configuration.prototype.v2`，可通过恢复示例配置重置。v1 原型、截图和评审记录保留。

本轮验收范围为桌面浏览器；手机端导航、云执行和权限议题不在本轮范围。正式实现另外使用服务端持久化、现有 Agent/Binding/Task 标识和服务端统一解析，不能把示例配置或浏览器存储当成真实业务数据。

正式 React 实现与 5181 部署的结果见[正式验收记录](../../verification/configuration-workbench-2026-10-05/README.zh-CN.md)。
