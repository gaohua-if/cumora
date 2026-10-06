# Aida 本地 Codex 模型兼容性修复

2026-10-05，用户反馈默认 Aida 在本地 Codex 运行失败。本轮复用实际工作区 `co-a09a2bc0-f` 的 Aida `aida-lnn7`、本地计算机 `gh` / `comp-11c2fc72-048`，保持 LEGACY 聊天模式。

## 原因与修复

失败日志明确返回 `The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.`。Aida 没有明确的模型设置，计算机也没有模型默认值；本机 `~/.codex/config.toml` 配置 `gpt-6.1-sol`。安装的 Codex 0.158.0 账户目录包含 `gpt-6-sol`、`gpt-6-luna` 等模型，没有 `gpt-6.1-sol`。省略模型导致本地配置或恢复的线程继续选择不可用模型。

通过现有 Agent API 将 Aida 主模型设置为 `gpt-6-sol`，辅助模型设置为 `gpt-6-luna`；不修改主机全局 Codex 设置，不升级二进制或改变其他 Agent 的明确模型选择。

服务端为没有明确模型的 Codex Agent 选择实际协议目录的默认模型，保留 Agent → 计算机 → 部署的明确设置优先级。旧 daemon 将 `gpt-5.4-mini` 预设混入协议目录时，未明确设置的辅助模型优先采用已报告的 `gpt-6-luna`。新版本地模型探测直接使用 `model/list` 的真实返回，不再用供应商预设扩大成功获取的账户目录。

模型是否可用与账户、客户端和发布范围有关，不能把此账户的错误解释为所有 ChatGPT 账户都不支持该模型：[OpenAI 官方模型说明](https://learn.chatgpt.com/docs/models)。

## 实测结果

- 新镜像部署于 `http://192.168.28.113:5181`，健康检查正常。
- 验证群聊 `g-225aafa5`，仅 Aida；发送 `17 + 25` 测试后，真实消息 `m-e160d4bf-c2cb-4f2f-9819-c550655219ce` 回复 **LOCAL_CODEX_OK 42**。
- Run `run-a160cfc4-d2e6-402c-bfe4-6209f2f50f44`：`completed`，模型 `gpt-6-sol`，无错误。
- 实测调用记录：`byoa-codex` / `agent-turn` / `ok`，5789 输入 token、250 输出 token。未使用模型 mock。
- 模型选择回归测试 28 项通过；服务端类型检查、相关源码 lint、构建及 diff 检查通过。
- 临时验证登录会话撤销；主机原有运行端继续提供服务。

完整消息、运行、用量、镜像 ID 与源码 hash 见 [acceptance.json](acceptance.json)。这是在配置工作台验收之后的独立修复记录；先前的配置工作台截图和镜像证据保持原时间点。

## 复现

```bash
node --import tsx --test \
  server/src/__tests__/agents-computer-codex-model-defaults.test.ts \
  server/src/__tests__/agents-computer-model-catalog.test.ts \
  server/src/__tests__/agents-computer-engine-model.test.ts
npm run server:typecheck
node scripts/verify-aida-local-codex.mjs
```

浏览器工作台验证记录提供默认测试群聊。该脚本使用实际 Docker 服务创建临时登录会话，向现有验证群聊发送消息并核对真实运行和模型记录，完成后撤销会话。可用 `AIDA_TEST_CHANNEL` 指定测试群聊；`AIDA_TEST_MESSAGE` 核对已有测试消息而不重复发送。凭证不进入记录。
