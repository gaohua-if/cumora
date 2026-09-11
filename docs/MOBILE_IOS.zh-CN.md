# Cumora Mobile——iOS 构建与 App Store 提交

本文档完整走一遍通过 Capacitor 构建、测试并提交 Cumora iOS 应用的端到端流程。它假设一台干净的 macOS 机器,装有 Xcode 15+。没有 Podfile,也没有 CocoaPods 步骤——原生依赖是 Swift Package Manager 包,由 `npx cap sync ios` 解析进 `ios/App/CapApp-SPM/Package.swift`。

> 本文件是 [MOBILE_IOS.md](MOBILE_IOS.md) 的简体中文翻译;如与英文原文有出入,以英文原文为准。

## 架构概要

- **渲染层**:与 Electron 中发布的同一份 Vite/React bundle(`src/`)。移动版还是桌面版由 `src/lib/utils.ts` 中的 `useIsMobile()` 决定。在 iOS/Android 上,Capacitor 的原生桥会把 `window.Capacitor.isNativePlatform()` 置为 `true`,从而强制移动外壳,与视口尺寸无关(以此处理 iPad 分屏)。
- **原生外壳**:Capacitor 8.x。配置在 `capacitor.config.ts`。插件经 `src/lib/native.ts` 接线:状态栏、启动屏、键盘、app(返回键)、触感反馈。
- **后端**:与桌面应用相同的 API——仓库内提交的 `.env.production` 设置了 `VITE_CUMORA_API_BASE=https://api.cumora.ai`,所以打包出的 WKWebView 直连生产环境。自托管时请指向你自己的部署。

## 一次性搭建

```bash
# 安装 package.json 中声明的 Capacitor 插件包。
npm install

# 原生 iOS 工程(./ios/App)已经提交在仓库里——不要在全新
# checkout 上运行 `npx cap add ios`。

# 从 build/icon.png 生成应用图标 + 启动屏资源。
# 只有这个脚本需要 `sharp`——临时安装即可。
npm install --no-save sharp
node scripts-gen-ios-assets.mjs

# 构建 web bundle,然后拷贝资源并解析原生插件。
# `mobile:sync` 就是 `npm run build && npx cap sync`——不带平台
# 参数,所以 ios/ 和 android/ 两边都会同步。
npm run mobile:sync
```

## 日常开发

```bash
# 在模拟器里对着实时 web bundle 迭代。Capacitor 会从打包好的
# dist/ 加载 index.html——要热重载,就把 server.url 指向你
# 笔记本的局域网 IP(不要提交进仓库)。
npm run mobile:ios:run
```

要对着一个远程开发 API 运行,可以临时在 capacitor.config.ts 里**加上**一个 `server.url`(提交进仓库的配置刻意不含它——不要提交一个),或者在 WebView 内的 devtools 里通过 localStorage 设置 `cumora.serverUrl`。

## 面向 App Store / TestFlight 的发布构建

1. **检查生产 API 端点**——仓库内提交的 `.env.production` 必须把 `VITE_CUMORA_API_BASE` 指向这次构建要对话的 API。

2. **提升版本号。** `Info.plist` 读取 `$(MARKETING_VERSION)` / `$(CURRENT_PROJECT_VERSION)`,所以要在 `ios/App/App.xcodeproj/project.pbxproj` 中提升这两项设置——它们各自同时出现在 Debug 与 Release 配置块里。每一次 App Store Connect 上传都需要一个唯一的 (version, build) 组合;Apple 会拒绝重复。

3. **构建并同步**:

   ```bash
   npm run mobile:sync
   ```

4. **在 Xcode 中打开**:

   ```bash
   npx cap open ios
   ```

5. 在 Xcode 中:
   - 选中 **App** target → **Signing & Capabilities**:选择你的 Apple Developer 团队。Bundle identifier 应为 `io.cumora.app`(与 `capacitor.config.ts` 一致)。注意:提交在仓库里的 Release 配置用的是**手动签名**,配一个预先创建好的分发证书 + 描述文件;在你的 fork 上,把 Release 配置切换到你自己的团队即可(首次构建用自动签名也没问题)。
   - 确认 App Icon set 是 `AppIcon`,launch storyboard 使用生成的 Splash 图。
   - **Product → Archive**。Organizer 打开后,选择 **Distribute App → App Store Connect** → **Upload**。

6. 在 App Store Connect 中,把构建附加到一个新版本,填写隐私/加密问答,附上下文所述的截图,然后提交审核。

## 必需的 Info.plist 键

`ios/App/App/Info.plist` 已经声明了 App Review 需要的四个键:

```xml
<key>NSCameraUsageDescription</key>
<string>Cumora uses the camera to share photos in conversations.</string>
<key>NSPhotoLibraryUsageDescription</key>
<string>Cumora needs access to your photo library to attach images to messages.</string>
<key>NSMicrophoneUsageDescription</key>
<string>Cumora can record short voice notes for your conversations.</string>
<key>ITSAppUsesNonExemptEncryption</key>
<false/>
```

唯一**没有**的键是 `NSUserTrackingUsageDescription`。只有当应用真的调用 App Tracking Transparency 时才添加它——今天它并不调用,而且声明一个你不使用的权限本身就是一种被拒理由:

```xml
<key>NSUserTrackingUsageDescription</key>
<string>Cumora does not track you across other apps and websites.</string>
```

同样,如果相机/照片/麦克风功能停止随版本发布,就删掉对应文案。

## App Store 截图——必需尺寸

Apple 目前要求:

| 设备类别                     | 像素           | 备注                               |
|------------------------------|----------------|------------------------------------|
| 6.9" iPhone (15/16 Pro Max)  | 1290 × 2796    | 所有仅 iPhone 应用必需             |
| 6.5" iPhone (XS Max)         | 1284 × 2778    | 已有 6.9" 时可选的回退             |
| 12.9" iPad Pro (3 代+)       | 2048 × 2732    | 应用支持 iPad 时必需               |

使用 iOS 模拟器:Device → 16 Pro Max,然后在应用的每个主标签页里 Cmd+S 截图,每个界面一张。存在任何方便的地方(仓库不追踪它们),经 App Store Connect 上传。

## 隐私——App Privacy 问卷

Cumora 收集以下每用户数据(回答问卷时请如实):

| 类别                  | 条目                   | 关联到用户 | 追踪 | 用途               |
|-----------------------|------------------------|----------------|----------|--------------------|
| Contact Info          | 姓名、邮箱             | 是             | 否       | 账号               |
| User Content          | 消息、附件             | 是             | 否       | 应用功能           |
| Identifiers           | 用户 ID                | 是             | 否       | 账号               |
| Usage Data            | 产品交互               | 是             | 否       | 分析(PostHog)    |
| Diagnostics           | 崩溃数据               | 否             | 否       | 应用功能           |

PostHog 是唯一的第三方 SDK,依赖 `VITE_PUBLIC_POSTHOG_KEY` 环境变量。如果构建时省略该 key,PostHog 不会初始化——在 App Store 列表里把它申报为条件性的。

## 已知的移动端缺口(作为后续工作追踪)

- **Convene 标签页**:在 workspace 级 active-sessions 端点落地之前,展示一个刻意的空状态。从会话头部发起 Convene 仍然可用。
- **MobileMe → Status**:已移除,等待后端 presence API。等 `setSelfStatus` 在服务器侧存在后,以一个 Status 行重新呈现。
- **语音 / 相机采集**:composer 的附件选择器用的是通用文件输入。要拿到原生面板,需添加 `@capacitor/camera`,并在选择器中按 `isNativePlatform()` 分支。

推送通知曾在此清单上,如今已端到端发布——见 [PUSH_NOTIFICATIONS.zh-CN.md](./PUSH_NOTIFICATIONS.zh-CN.md)。

## 上传前验证构建

```bash
# 对 .ipa 内打包的 web bundle 做完整性检查。
npm run typecheck
npm run build

# Capacitor doctor——校验插件版本与原生配置。
npx cap doctor ios
```

如果 `cap doctor` 标记了未解析的原生依赖,重跑 `npx cap sync ios`,并让 Xcode 解析 Swift 包(File → Packages → Resolve Package Versions)。本项目没有 `pod install` 步骤。
