# 推送通知(iOS APNs + Android FCM)

当应用处于后台或被杀死时,Cumora 的移动客户端会投递聊天消息通知——iOS 走 APNs,Android 走 FCM。应用在前台时,则改由应用内的 `NotificationToasts` 栈负责呈现——见 `src/components/NotificationToasts.tsx`。

本文覆盖代码库之外所需的**手工搭建**:Apple Developer Portal / Firebase 配置,以及服务器真正发推送所需的环境变量。其余一切(Capacitor 插件安装、AppDelegate 转发、entitlements 文件、数据库表、注册/注销路由、APNs + FCM 发送器、WS 桥、客户端接线、尊重静音、收件人计算)都已经在仓库里。

> 本文件是 [PUSH_NOTIFICATIONS.md](PUSH_NOTIFICATIONS.md) 的简体中文翻译;如与英文原文有出入,以英文原文为准。

## 代码库里已有什么

| 界面 | 位置 |
| --- | --- |
| `@capacitor/push-notifications` 插件 | `package.json` + `ios/App/CapApp-SPM/Package.swift`(由 `npx cap sync ios` 同步) |
| AppDelegate APNs 回调 → Capacitor 桥 | `ios/App/App/AppDelegate.swift` |
| `aps-environment` entitlement | `ios/App/App/App.Debug.entitlements`(开发)+ `ios/App/App/App.Release.entitlements`(生产)——由 Xcode 构建配置自动选择 |
| `push_devices` 表 | `server/src/db/migrate.ts` |
| `POST /push/register` / `POST /push/unregister` | `server/src/api/router.ts`(靠近文件底部) |
| APNs 发送器(HTTP/2 + ES256 JWT,无第三方库) | `server/src/push.ts` |
| FCM 发送器(HTTP v1,服务账号 JWT) | `server/src/fcm.ts` |
| 收件人过滤(跳过作者、当前在线用户、已静音会话) | `server/src/push.ts` 中的 `computeMessageRecipients` |
| 新消息的出站派发 | `server/src/push.ts` 中的 `dispatchMessagePush`,从 **两个** 位置调用:POST `/conversations/:id/messages`(`server/src/api/router.ts`)与 `cmdReply`(`server/src/agents/cli.ts`)——智能体的回复只走第二条路径 |
| 客户端生命周期(请求权限、注册、深链、登出) | `src/lib/push.ts` + `src/mobile/MobileApp.tsx` + `src/mobile/MobileMe.tsx` |
| 用户偏好 `notify.push`(应用内总开关) | `src/mobile/MobileMe.tsx` 中的 `TOGGLE_PREFS` |

缺少 APNs / FCM 凭据时,服务器软性禁用推送:`/push/register` 仍然接受 token(这样设备侧持续可用,等你日后配置好凭据),但每次发送都是空操作,只在启动时记一次日志。

## 你还需要做的事(Apple Developer Portal)

1. **在该 bundle id 上启用推送通知。**
   - developer.apple.com → Certificates, IDs & Profiles → Identifiers
   - 选中 `io.cumora.app` → 在 Capabilities 下勾选 **Push Notifications** → **Save**。
2. **签发一把 APNs Auth Key(`.p8`)。**
   - developer.apple.com → Keys → **+** → 命名为 "Cumora APNs" → 勾选 **Apple Push Notifications service (APNs)** → Continue → Register。
   - **只此一次下载 `.p8`**。Apple 不会允许你再次下载。
   - 记下密钥列表中显示的 **Key ID**(10 位字符串)。
3. **找到你的 Team ID。**
   - developer.apple.com → Membership → Team ID(10 位字符串)。

## 服务器环境变量

把 `.p8` 放在服务器进程可读的位置(**不要**放进仓库),并把环境变量指向它。

### 本地开发(`.env`)

```sh
APNS_KEY_PATH=/Users/<you>/.cumora-secrets/AuthKey_<KEY_ID>.p8
APNS_KEY_ID=<KEY_ID>                # 10 位 Key ID
APNS_TEAM_ID=<TEAM_ID>              # 10 位 Team ID
APNS_TOPIC=io.cumora.app            # 与 bundle id 一致
APNS_ENV=development                # Debug 构建走 sandbox 端点
```

### 生产(GKE——部署模板见 `server/k8s/cumora-server.gke.yaml`)

两个 Secret:

1. **`cumora`**——已存在。向其中追加四个 APNs 标量:
   ```sh
   kubectl get secret cumora -o json \
     | jq '.data["APNS_KEY_ID"]   |= "'$(echo -n "<KEY_ID>"   | base64)'"
         | .data["APNS_TEAM_ID"]  |= "'$(echo -n "<TEAM_ID>" | base64)'"
         | .data["APNS_TOPIC"]    |= "'$(echo -n "io.cumora.app" | base64)'"
         | .data["APNS_ENV"]      |= "'$(echo -n "production"  | base64)'"' \
     | kubectl apply -f -
   ```
   或者交互式操作:`kubectl edit secret cumora`,添加四个 base64 编码的键。

2. **`cumora-apns-key`**——新建,只存放 `.p8` 文件。创建命令:
   ```sh
   kubectl create secret generic cumora-apns-key \
     --from-file=AuthKey_<KEY_ID>.p8=/path/to/AuthKey_<KEY_ID>.p8
   ```
   `server/k8s/cumora-server.gke.yaml` **尚未**声明这个卷——它只接线了 `envFrom: secretRef: {name: cumora}`。请自行添加该卷并挂载到 `/var/run/secrets/cumora-apns/`,并把 `APNS_KEY_PATH` 指向挂载出的文件。把卷标记为 `optional: true`,这样 secret 缺失时 Pod 仍能启动——推送路径会自行软性禁用。

3. **应用 deployment** 以获得新的卷挂载:
   ```sh
   kubectl apply -f <your-deployment>.yaml
   kubectl rollout restart deployment/cumora-server
   ```

如果日后更换了 Key ID,请把 deployment 清单中的 `APNS_KEY_PATH` 更新为 secret 里新的文件名。

### 开发 ↔ 生产的 entitlement 匹配

dev / prod 的区分很重要:**环境与 entitlement 不匹配时,所有推送都会无声地 400。** 这部分已通过两个随 Xcode 构建配置切换的 entitlements 文件自动接线:

| Xcode 配置 | Entitlements 文件                     | aps-environment | APNS_ENV      |
| ------------ | ------------------------------- | --------------- | ------------ |
| Debug        | `ios/App/App/App.Debug.entitlements`   | `development`  | `development` |
| Release      | `ios/App/App/App.Release.entitlements` | `production`   | `production`  |

模拟器 / 真机连接开发用 Debug 构建;TestFlight + App Store 用 Release。上面创建的那把 APNs Auth Key(作用域:"Sandbox & Production")对两个端点都有效——App Store 提交时不需要额外的 key。

## Android(FCM)

Android 路径与 iOS 镜像,只是发送器不同:同一个 `@capacitor/push-notifications` 插件注册一个 FCM token(`push_devices` 中 `platform='android'`),服务器经 FCM HTTP v1 API(`server/src/fcm.ts`)发送,用一个 Firebase 服务账号鉴权——设置 `FCM_SERVICE_ACCOUNT_JSON`(内联 JSON)或 `FCM_SERVICE_ACCOUNT_PATH`。Android 客户端构建还需要你自己的 `android/app/google-services.json`——复制 `android/app/google-services.json.example` 并填入你 Firebase 项目的值。凭据缺失时,FCM 发送会像 APNs 一样软性禁用。

## 端到端测试

1. `npm run server:dev`——环境变量缺失时,服务器日志会打一次 `[push] APNs credentials not configured`;一切正常时 happy path 上什么都不打。
2. `npm run mobile:ios:run`——在模拟器中启动应用。iOS 模拟器**无法接收 APNs 推送**,除非你在 Xcode 14+ 上使用模拟器推送 API;真正的端到端请用 debug 构建的真机。
3. 在设备上登录后,iOS 会提示一次通知权限。允许它。设备会出现在 `push_devices` 中:
   ```sql
   SELECT id, user_id, platform, last_seen_at, disabled_at FROM push_devices;
   ```
4. 从另一台设备 / 账号给该用户发一条消息。推送应在约 1 秒内到达。点它 → 应用打开对应会话。

## 推送没有触发时

| 症状 | 可能原因 |
| --- | --- |
| 权限弹窗从不出现 | Capacitor 的 `Push Notifications` 插件没同步——重跑 `npx cap sync ios` |
| `register()` 被拒绝,没有 device-token 行 | `aps-environment` entitlement 缺失或不匹配(Debug ↔ development) |
| 服务器日志 "APNs credentials not configured" | 环境变量未设置;`/push/register` 仍可用,但发送是空操作 |
| APNs 返回 403(DeviceTokenNotForTopic) | `APNS_TOPIC` 与 bundle id 不一致 |
| 410 / 设备被禁用 | 符合预期;`push_devices.disabled_at` 已被设置。重装应用或重新登录以再次注册 |
| 前台应用显示系统横幅而不是应用内 toast | 仅当应用在后台时才应出现系统横幅。前台投递会落到 `NotificationToasts`。 |
| 用户正盯着聊天,推送还是响了 | 该用户的 `participants.status` 不是 `'avail'`——检查 WS 连接。服务器只对标记为 `'avail'` 的用户抑制推送 |
| 打开了 `notify.push` 但什么都没到 | 这个开关只写偏好。注销/注册发生在下一次 `initPushNotifications` 调用时——在 You → Push status 里点 **Re-register**,或把应用切后台再切回前台(`src/lib/push.ts` 的 `installVisibilityHook` 会在没有 token 时重试)。无需重启应用 |

## 遗留事项(刻意的)

- **文档提及推送 / 日历提醒推送。** 两者都已有 WS 事件(`doc.mention`、`calendar.reminder`);把它们接进 `notifyMessage` 风格的发送器是后续工作。
