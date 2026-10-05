# 前端原型审查

2026-10-04。结论：Agent、Access Bundle、群聊和 Skill 库的分区可以保留，但当前版本有 2 项 P1、5 项 P2，应先修正配置一致性再作为实现基线。

范围是 `configuration-workbench-v1.html` 的产品配置关系、浏览器交互和响应式布局。使用独立 Headless Chrome/CDP 会话，实际操作 UI，检查 DOM 与原型 localStorage。审查未修改原型源码、业务配置或已有正常路径验收记录。机器证据：[review-findings/evidence.json](review-findings/evidence.json)。P1 表示下一版优先处理；P2 表示后续实施前需要修正。以下问题均已复现。

## R1 · P1：删除资源包会把成员的子集选择变成全部

位置：[取消引用逻辑](../configuration-workbench-v1.html)（第 158 行）、[生效资源解析](../configuration-workbench-v1.html)（第 104 行）。资源包选择弹窗提交同样存在这一问题，见第 133 行。

复现：在「产品研发」将 Bram 的访问范围设为仅「工程开发」，保存；随后取消群聊对「工程开发」的引用。原先 `bundles: ['engineering']` 被过滤成空数组，空数组又代表「群聊全部资源包」，于是 Bram 的预览中出现原本未选择的「资料研究」和团队知识库。

影响：移除配置反而扩大成员生效资源集合，违背“选择群聊资源包中的一部分”的含义。

建议：显式区分继承全部、选择子集、不使用外部资源三种状态。子集删空应保留空集或提示需要重新配置，不能自动切换为继承全部。

证据：[子集变成全部](review-findings/01-subset-becomes-all.png)。

## R2 · P1：撤销新建对象后仍显示失效详情，再编辑触发异常

位置：[撤销操作](../configuration-workbench-v1.html)（第 149 行）、[详情渲染](../configuration-workbench-v1.html)（第 80 行）、[输入处理](../configuration-workbench-v1.html)（第 177 行）。

复现：新建一个 Agent → 不保存 → 点击底栏「撤销更改」。对象从数据与列表中消失，但 `selected` 仍指向已删除的 ID，右侧保留旧详情，状态显示已保存。继续修改名称时，浏览器捕获 `TypeError: Cannot set properties of undefined (setting 'name')`。

影响：常见的新建/撤销流程留下无法正常编辑的详情状态；其他类型的新建对象也使用同一处理路径。

建议：撤销后校验当前选择，回到仍存在的对象或明确的空状态；同步标题、Hash 与表单，输入处理也应检查对象存在。

证据：[已撤销对象仍可编辑](review-findings/02-discarded-object-stale.png)。

## R3 · P2：资源包选择弹窗显示新版本，但确定后仍保留旧版本

位置：[选择器渲染](../configuration-workbench-v1.html)（第 112 行）、[选择器提交](../configuration-workbench-v1.html)（第 133 行）。

复现：修改「工程开发」使用说明并保存为 v3；「产品研发」仍引用 v2。打开群聊「选择资源包」，已选工程开发显示 v3。点击确定，实际引用仍是 v2。

影响：用户不能从选择器判断当前生效的版本，容易误以为已经选择新版。保留固定旧版本本身是正确行为，错误是选择器展示的版本与实际引用不一致。

建议：已引用项显示「当前 v2，最新 v3」，保留旧版的明确状态；升级通过版本选择或现有独立升级动作完成。

证据：[选择器显示 v3，实际引用 v2](review-findings/04-bundle-picker-wrong-version.png)。

## R4 · P2：从成员 Skill 选择器导入时丢失配置上下文

位置：[导入入口](../configuration-workbench-v1.html)（第 169 行）、[导入完成](../configuration-workbench-v1.html)（第 140 行）。

复现：「产品研发 → Bram → 调整 Skills」中先勾选文档写作，再点击导入新 SKILL.md；填写新 Skill 名称与内容并导入。新 Skill 加入工作区库，但未加入 Bram 的群内配置，之前勾选的文档写作也消失。

影响：嵌套操作不保留尚未确认的选择，导入完成后直接退回成员页，用户需要重新找到并配置新 Skill。

建议：保留选择器的 Agent/Binding 上下文和临时选择；导入后返回原选择器并选中新 Skill，再由用户确认整个选择。

证据：[导入后缺少新增 Skill 与之前选择](review-findings/05-import-loses-member-selection.png)。

## R5 · P2：语言设置允许循环继承，预览没有解析出实际值

位置：[Agent 语言选项](../configuration-workbench-v1.html)（第 90 行）、[群聊语言选项](../configuration-workbench-v1.html)（第 97 行）、[生效设置解析](../configuration-workbench-v1.html)（第 104 行）。

复现：Bram 的 Agent 默认语言为「继承群聊」；将产品研发群聊语言设为「跟随 Agent」，保存。Bram 的生效语言显示「继承群聊」，而非具体语言或未解决状态。

影响：预览不能履行解释最终配置的目的，后续前后端实现也缺少确定的回退契约。

建议：用统一的继承标记与有终点的解析顺序，循环或未指定时回退到明确系统默认；预览显示最终语言和来源。无需自动推断自由文本提示词里的所有矛盾。

证据：[生效语言仍是继承标记](review-findings/03-inheritance-not-resolved.png)。

## R6 · P2：生效资源预览省略实际身份与操作范围

位置：[访问资源预览](../configuration-workbench-v1.html)（第 104 行）。

复现：把工程开发 Bundle 的访问身份改成「专用项目账号」，保存并在群聊升级引用。包内 MCP 仍各自配置「Cumora 服务账号」，GitHub 仍配置「Cumora GitHub App」。预览只显示包身份和资源名字，未显示这些逐资源身份；GitHub 的分支、路径、读取/创建 PR 等工作方式也不展示。

影响：用户无法从所谓生效预览判断某个 Agent 在实际连接中使用哪个身份、能对哪个仓库范围做什么，包默认值与连接显式值的区别不清楚。

建议：按资源展示类型、来源包/版本、连接实际身份、MCP 工具、域名端口、仓库分支/路径与动作。明确包身份是默认值还是描述信息；连接显式值需要单独展示。

证据：[资源预览缺少逐项身份和范围](review-findings/06-preview-missing-resource-scope.png)。

## R7 · P2：窄屏导航被裁切，之前的溢出检查未覆盖此情形

位置：[手机导航 CSS](../configuration-workbench-v1.html)（第 15 行）、[应用 overflow](../configuration-workbench-v1.html)（第 11 行）。

复现：在 320×740 下，配置导航右边界约 361.2px，Skill 库文字被裁掉；360px 下右边界也略超出屏幕。390px 下正常。由于外层设置 `overflow: hidden`，document.scrollWidth 仍等于视口宽度，上一轮“没有文档横向溢出”的断言无法发现控件被裁切。

建议：窄屏配置分类使用可横向滚动的区域或菜单，不继续缩小字体；验证各入口在可视区域内或可以滚动触达。

证据：[320px 导航裁切](review-findings/07-mobile-320-overflow.png)。

## 设计建议

保留当前四类对象的组织方式、群聊即 Channel 的概念、提示词来源展示，以及 Bundle 固定版本/明确升级流程。下一版先解决 R1/R2，再统一生效配置解析，把资源预览作为核对入口，而不是仅列名称的摘要。

还需要在后续 OpenSpec 明确 Agent 定义与 Skill 的发布/引用版本。当前 Agent 与群内 Skill 引用仅保存 ID，编辑 Skill 会直接改变所有引用处显示的版本；这项尚未形成与 Bundle 相同的可见版本选择流程。正式实现应与现有固定 Definition/Binding/Task 配置契约一致，不能只依赖展示名称或最新内容。这是设计待明确项，不计入以上已复现的七项问题。

本次没有检查真实外部连接、权限攻击或云执行，也没有把静态原型问题推断成生产服务漏洞。以前的 `review.json` 保留为正常路径检查快照，本报告补充变更、撤销、组合与窄屏场景。
