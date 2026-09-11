# 参与 Cumora 贡献

感谢你对 Cumora 的关注。本指南涵盖如何搭建环境、你的改动需要通过哪些检查,以及几条在 CI 中强制执行的架构不变量——免得你意外踩坑。

参与贡献即表示你同意你的贡献以项目的 [MIT 许可证](LICENSE) 授权。

> 本文件是 [CONTRIBUTING.md](CONTRIBUTING.md) 的简体中文翻译;如与英文原文有出入,以英文原文为准。

## 环境搭建

你需要 **Node ≥ 22**(CI 运行在 Node 24),并让 **Postgres** 和 **Redis** 在本地运行。Node 18 和 20 已无法安装依赖树——`@capacitor/cli` 要求 `node >= 22`,`@aws-sdk/client-s3` 要求 `node >= 20`。

```bash
createdb -h localhost cumora
export OPENAI_API_KEY=sk-...        # 唯一硬性必需的环境变量

npm run setup                       # 根目录 + Email Worker 依赖
npm run dev:all                     # Vite 渲染层 :5180 + API 服务器 :5181
```

请用 `npm run setup` 而不是只在根目录 `npm install`:根目录的测试命令还会运行 `workers/email-gate` 的测试,而后者的依赖放在 Worker 自己单独的 `package.json` 里。

打开 http://localhost:5180 使用 Web 应用,或运行 `npm run electron:dev` 启动桌面外壳。数据库迁移通过 `npm run migrate` 执行(`dev:all` 与 `electron:dev` 会自动运行),并在启动时播种一支初始团队。其余一切(OAuth 登录、邮件、存储、推送、sub2api LLM 网关)在对应环境变量未设置时软性禁用——见 [`.env.example`](.env.example)。

组件相关的搭建说明在 [`docs/`](docs/):`BYOA.zh-CN.md`(本地引擎守护进程)、`MOBILE_IOS.zh-CN.md`、`PUSH_NOTIFICATIONS.zh-CN.md`、`email.zh-CN.md`。

## 提 PR 之前

运行与 CI 相同的门禁。以下全部必须通过:

```bash
npm run lint                   # Biome lint(可用 `npm run lint:fix` 自动修复)
npm run typecheck              # 前端类型
npm run server:typecheck       # 服务器类型
npm test                       # 单元测试(node:test):server + workers + 前端库
npm run test:integration       # 集成测试套件,见下方环境变量说明
npm run guard:big-brain        # 架构守卫,见下文
npm run guard:llm-tracked      # 架构守卫,见下文
npm run guard:engine-registry  # 架构守卫,见下文
```

`npm run test:integration` 需要一个**专用**数据库;没有 `INTEGRATION_DATABASE_URL` 时它什么都不做——只打印 `[integration] skipped` 并以 0 退出,看起来和通过一模一样。该套件会 `TRUNCATE` 每张表,所以请把它指向一个一次性的数据库:

```bash
createdb -h localhost cumora_test
INTEGRATION_DATABASE_URL=postgres://$USER@localhost:5432/cumora_test \
  npm run test:integration
```

Biome 在本仓库(`biome.json`)中被配置为**纯 linter**——它不是格式化工具,所以不会重排现有代码。规则集是 Biome 推荐规则的一个务实子集:正确性与真实缺陷类规则开启;噪音大或针对刻意写法的风格类规则关闭;可访问性(a11y)规则渐进启用(useButtonType、ARIA 角色/属性,以及核心可访问性规则已生效)。

两个 TypeScript 项目都是 `strict`。测试分布在四个位置,`npm test` 运行其中第一、三、四处:`tests/`(前端库单元)、`server/src/__integration__`(集成,需通过上述环境变量启用)、`server/src/__tests__`(服务器单元),以及 `workers/email-gate/src`(Worker 单元——这正是你应该用 `npm run setup` 而不是裸 `npm install` 的原因)。

## 三条架构不变量(在 CI 中强制执行)

这些不是风格偏好——它们是这个产品的核心成本模型,一旦破坏,守卫脚本会让你的构建失败:

1. **只有智能体回合可以使用大模型。** 便宜的"小脑"模型负责分诊、分类、摘要以及所有其他工具性调用;昂贵模型保留给真正的智能体推理回合。如果你新增一次 LLM 调用,请路由到正确的档位。`npm run guard:big-brain` 检查这一条。
2. **每一次 LLM 调用都必须记入成本台账。** 未被追踪的开销在这里是正确性缺陷,而不只是疏忽。`npm run guard:llm-tracked` 检查这一条。
3. **一个 BYOA 引擎要么接入它的全部注册表,要么一个都不接。** 接了一半的引擎不会报错——`normalizeByoaSource()` 会把任何未知值映射到 `byoa-claude`,于是它的运行会悄悄记到错误的引擎头上。`npm run guard:engine-registry` 检查这一条。

多智能体协作模型(N 个智能体如何共享一个房间而不冲突,以及为什么提示词被刻意保持极简)记录在 [`docs/COORDINATION.zh-CN.md`](docs/COORDINATION.zh-CN.md)——在动智能体回合循环、分诊门控或守护进程之前,先读它。

## 编码约定

- 与你正在编辑的文件风格保持一致。这个代码库依赖那些解释**为什么**的注释——约束、取舍,以及某个非显而易见的选择背后的历史——而不是下一行代码在做什么。如果你的改动推翻了某条注释所记录的决策,请同步更新该注释。
- 保持协作类提示词(`glance-protocol.ts`、守护进程常驻提示词)停留在"形态"层面且极简。为修复一个已观察到的 bug 而往提示词里堆场景示例,是这里代价最高的一类改动——见 `docs/COORDINATION.zh-CN.md` 中的反模式。
- 优先写无 `any`、类型完备的代码;两个 tsconfig 都是 strict,自有其原因。

## 报告缺陷与安全问题

- **安全漏洞**:**不要**发公开 issue——遵循 [`SECURITY.zh-CN.md`](SECURITY.zh-CN.md)。
- **缺陷与功能**:开一个 GitHub issue,写清复现步骤以及你期望发生的行为。

## 提交与 PR 卫生

- 写聚焦的提交,提交信息讲清**为什么**,而不只是做了什么。
- 一个 PR 只包含一个逻辑改动;越小的 PR 被评审得越快。
- 请求评审之前,确保上面整张检查清单都是绿的。
