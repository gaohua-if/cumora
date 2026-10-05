# Agent、Access Bundle 与群聊配置原型 v1

2026-10-04。设计范围：参考 Claude Tag 的配置方式，形成可审查、可实际操作的 Cumora 配置原型。

预览：[打开原型](http://192.168.28.113:5182/configuration-workbench-v1.html)。单文件：[configuration-workbench-v1.html](../configuration-workbench-v1.html)，下载后可直接用浏览器打开。原型使用示例数据，仅通过独立 localStorage key 保存到当前浏览器；5181 现有业务服务、真实 Agent 和群聊配置不受这些编辑影响。5182 只提供静态文件，不调用 API 或外部 MCP/GitHub。

## 配置对象与页面

布局使用左侧配置导航、中间对象列表、右侧详情。手机端变为顶部分类与可横向选择的对象列表。提示词和规则使用较大的 Markdown 编辑区；Skills 与 Bundle 通过多选列表添加，并以标签/版本展示。保存与撤销在固定底栏。切换对象前处理未保存编辑，Cmd/Ctrl+S 保存，Esc 关闭弹窗。

| 对象 | 页面 | 可以配置的内容 |
|---|---|---|
| Agent | 概览、提示词、Skills、运行配置 | 名称、职责、简介、基础提示词、Skill 选择、语言/模型偏好、本地计算机、引擎 |
| Skill 库 | 概览、SKILL.md | 使用场景、标识、内容编辑与 Markdown 导入；查看引用该 Skill 的 Agent |
| Access Bundle | 概览、MCP、Domains、GitHub、使用说明 | 按用途命名的访问资源包，服务身份、各类访问项和资源使用约定 |
| 群聊 | 通用、Agent 成员、Access Bundles、生效配置 | 群聊共同规则、默认负责人、响应/模型/语言/输出偏好、并行数量、记忆范围、成员局部配置、资源包引用 |

Agent 的 Skill 是工作方法；MCP、域名和 GitHub 是访问资源，两者在不同页面配置。Agent 可以加入多个群聊，群聊中的成员配置对应现有 Binding。Channel 直接复用现有 IM 群聊，不再引入另一套独立频道。

MCP 编辑连接名称、HTTPS 地址、服务身份与工具清单；Domains 编辑精确或通配域名、端口与用途，访问不附带登录凭证；GitHub 编辑仓库、分支、路径、服务身份，以及读取代码、创建分支、创建 PR 等工作方式。示例身份和服务地址用于讨论页面，不代表已经连接。

## 主要交互路径

1. **配置 Agent**：选择 Aida → 编辑提示词 → Skills 中添加「任务规划」「文档写作」等技能 → 选择本地计算机与引擎 → 保存。
2. **建立资源包**：Access Bundles → 新建 → 按用途命名 → 添加 MCP、Domains、GitHub 配置 → 编辑随资源携带的使用说明 → 保存。
3. **配置群聊**：选择「产品研发」→ 设置共同规则、默认负责人和回复偏好 → 选择一个或多个资源包 → 添加专业 Agent。
4. **调整成员**：群聊 Agent 成员 → 补充 Bram 的要求、修改群内别名或模型偏好 → 为本群添加/禁用 Skill → 选择该群资源包中的一部分。不会反向修改 Bram 的基础配置。
5. **检查结果**：点击「预览配置」→ 在侧栏选择群聊和 Agent → 查看各层提示词来源、Skill、资源包版本、服务身份、普通设置与执行位置。
6. **更新资源包**：修改资源项 → 保存产生新版本 → 群聊仍显示原版本和「新版」提示 → 点击升级并确认 → 新配置用于后续新任务。

原型内置「Everyone」「产品研发」「我的 Aida」三个群聊，覆盖普通群聊、多 Agent 和仅 Aida 场景。新建群聊默认包含 Aida；成员选择不能移除默认 Aida，但默认负责人可明确选择其他已加入的 Agent。

## 配置组合

基础职责、群聊共同规则、已选资源包使用说明、成员补充要求分别展示来源，并共同构成当前群的工作指令。资源包说明属于访问资源的业务约定，不改变资源操作范围。自由文本不能自动判定全部语义矛盾，预览不承诺消除自然语言冲突。

普通设置按「成员显式值 → 群聊默认 → Agent 默认 → 系统默认」解析。成员 Skills 默认继承 Agent，可以在本群增加或禁用。资源访问只来自当前群聊有效引用的 Bundle；成员选择其中一部分用于收敛范围。原型允许简单组合，实际执行还需既有 Grant、成员资格及 Runtime 支持校验，Bundle 引用本身不创造授权。保持现有概念文档的数据流。

保存 Bundle 会保留旧版本内容；群聊引用固定版本，升级需要明确动作。正式实现需继续固定 Task 创建时的定义、Binding 和授权版本，旧任务不得随配置编辑自动变化。原型预览的是当前草稿，不是某个正在执行的 Task 上下文。

## 与现有架构的衔接

| 原型对象 / 操作 | 现有基础 | 后续实现需要补齐 |
|---|---|---|
| Agent 提示词、职责 | participant 身份、agent_definition_versions | 把可复用的定义编辑与身份/运行位置编辑组织到统一详情页 |
| Skill 库与 Agent Skills | 概念文档的能力需求与固定定义版本 | Skill 版本、引用、受控加载、Runtime 准入；目前定义 API 只接受 name/role/instructions，不能直接发送新字段 |
| 群聊成员局部要求 | channel_agent_bindings、instructions override | 群内 Skill/普通设置解析；当前 Binding 只有部分字段，需追加正式契约 |
| Bundle 引用与版本 | access_bundle_versions、channel_access_refs、access_grants | 可读的资源包元数据、版本编辑、引用列表、升级/移除及适用性校验 |
| MCP、Domains、GitHub | access_connections 与 adapter 契约 | 当前已准入外部 adapter 仅第一方 channel；这些新资源仍需真正的 adapter、连接生命周期和逐动作执行校验 |
| 群聊自身配置 | conversations、默认 Binding | 共同规则、响应/模型/协作/记忆偏好及配置版本；复用原 ID |
| 生效预览 | 固定 Task context 与现有配置投影 | 提供统一解析投影和来源信息，避免前后端各自推导不同结果 |

这份原型不意味着 MCP 或 GitHub 已在生产接入，也没有把云执行场景加入此次设计范围。本地执行位置继续独立于模型连接和资料访问身份。现有工作区准备、readiness、启用/暂停操作可保留在单独的「工作区执行」页面，日常对象详情集中呈现用户能理解的配置。

后续 OpenSpec 可按配置模型与读投影、Agent/Skill 管理、Bundle/adapter 管理、群聊与 Binding、统一生效预览五部分形成新 change；本次不改写已完成 change 或生产任务契约。

## 参考资料与验证

用户提供的视频：[Claude Tag 介绍，从 1:27 开始](https://www.youtube.com/watch?v=JhipXUs1Y98&t=87s)。当前环境的视频页面返回加载错误，未声称观看了该片段。已核对以下第一方资料：

- [What is Claude Tag?](https://support.claude.com/en/articles/15594475-what-is-claude-tag)：群聊中交办工作的产品入口。
- [Give Claude access to your tools](https://claude.com/docs/claude-tag/admins/add-connections)：按用途组织 Bundle，以及资源包内的连接、域名、仓库与使用说明。
- [Configure per-channel access](https://claude.com/docs/claude-tag/admins/attach-to-scope)：群聊配置与资源引用。
- [Use skills in Claude](https://support.claude.com/en/articles/12512180-use-skills-in-claude)：可复用工作方法的管理方式。

这是根据 Cumora 现有模型制定的设计，不是对 Claude Tag 页面和权限继承规则的逐项复刻。

真实 Headless Chrome/CDP 已检查：Skill 添加与保存、MCP 添加、域名格式拒绝、Bundle 固定旧版本与明确升级、成员补充要求/Skill/资源子集、未保存切换、基础 Agent 保持原值、刷新读回、手机资源包选择、新建群聊默认 Aida及 Hash 导航。发现 Hash 变化最初未同步页面，补充监听后复测通过。脚本语法和 git diff 空白检查通过；没有执行业务数据库测试或调用外部工具。详细结果见 [review.json](review.json)。

| 代表页面 | 截图 |
|---|---|
| Agent 提示词与 Skills | [提示词](screenshots/02-agent-prompt.png)、[Skills](screenshots/03-agent-skills.png)、[选择器](screenshots/04-skill-selector.png) |
| Bundle 与资源配置 | [概览](screenshots/05-bundle-overview.png)、[MCP](screenshots/06-bundle-mcp.png)、[Domains](screenshots/07-bundle-domains.png)、[GitHub](screenshots/08-bundle-github.png)、[仓库编辑](screenshots/09-github-editor.png) |
| 群聊自己的配置 | [通用](screenshots/10-channel-general.png)、[成员](screenshots/13-channel-members.png)、[资源包](screenshots/11-channel-access.png) |
| 生效配置 | [预览](screenshots/12-effective-preview.png) |
| 手机 | [成员](screenshots/14-mobile-members.png)、[资源包](screenshots/15-mobile-access.png)、[选择器](screenshots/16-mobile-bundle-selector.png)、[单 Aida](screenshots/17-mobile-solo.png) |

截图包含检查过程中保存的示例编辑；全新浏览器首次打开使用文件内初始示例。
