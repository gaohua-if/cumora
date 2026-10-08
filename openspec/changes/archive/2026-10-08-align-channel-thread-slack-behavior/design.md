# Design

## Context

动机见 proposal.md。已有 thread_id 区别引用和工作边界，但 store 的乐观路径仍以 quotedMessageId 计数，ThreadDrawer 的已取回复没有合并进公共 store，频道按全部消息分页，ThreadService 输入没有附件。

## Goals / Non-Goals

Goals：修正四项评审问题并建立原生 task thread 的频道主流投影。Non-Goals：显式回复广播、Slack 全量通知体系、普通引用迁移与 mobile 新交互。

## Decisions

1. messages API 增加可选 view=channel，在 LIMIT 前排除 thread_id 非自身的消息；默认全历史 API 保持。客户端主消息 store 使用该页，实时 thread 回复仍存入公共 store，桌面展示仅投影根。Virtuoso 的 prepend 数按可见根计算，避免隐藏回复改变锚点。没有选择仅前端过滤，因为回复占满一页后找不到根。
2. 共用根解析函数：threadId 优先；未存在时解析已加载引用及当前同频道 drawer 根。乐观消息提前携带 threadId；确认时根据 authoritative threadId 转移先前计数；重复事件不加数；撤销使用同一根。Drawer 拉取的成员回复合并进公共 store，便于引用子消息。点击子入口归根；drawer 切换清空旧快照并防止旧请求覆盖。
3. channel 的跳转到隐藏子回复改为打开其根 thread；thread 保留引用卡片及全部回复。未加载根可按单消息 GET 获取，避免长历史引用导致空 drawer。
4. 发送开始记录当前导航快照，并订阅频道、视图和互斥面板状态变化；确认后只有期间未发生导航变化且频道仍匹配才自动打开。订阅在 finally 清理。没有只比较最终字段，因为用户切走再返回仍是主动导航。
5. ThreadService.ingress 的有效内容为文字或附件，为纯附件生成目标描述；Task 仍通过原消息引用创建和补充。thread CLI 读取 attachment 并调用既有 freshenAttachmentUrl，与其他消息读取保持一致；本机受控工具没有通用下载命令，因此补充 thread attachment <消息ID> 读取当前 thread 的本地 UTF-8 文本，按存储 key 验证路径，限制1MiB和50000字符并显式标记截断；PDF/图片及非本地存储返回明确不可读取。存储 key 是来源身份，刷新 URL 不写回数据库。纯附件任务输入不再为空文本，可保留附件说明到 task_inputs，不在不可变 context 中补写。

## Risks / Trade-offs

- 根分页与 realtime 混合 → cursor 使用可见根，滚动索引只按根计数；保留 API 默认历史。
- 线程输入刷新链接失败 → 保留元数据和已有 URL，按既有存储约定处理，不虚假声明已读取内容。
- 现有脚本假设主流含回复 → 新验收明确查 drawer；保留之前验收证据。

## Migration Plan

无需迁移。先聚焦 store/附件/HTTP 验证与类型检查构建，然后重建 5181 服务并重启仓库 daemon。通过浏览器验证嵌套回复、导航竞态、纯附件续轮、长线程根分页；回滚使用上一容器及仓库入口版本，原数据保持。
