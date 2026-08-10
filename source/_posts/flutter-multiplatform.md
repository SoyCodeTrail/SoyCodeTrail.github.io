---
title: Flutter 多端开发实战：一套代码怎么编译发布到 Android / iOS / macOS / Windows / Linux / Web
category: client
platform: flutter
tags: ["Flutter", "多平台", "编译", "发布", "CI/CD"]
readTime: 18分钟
featured: true
date: 2026-07-28
---

## 业界全平台 App 怎么做的

先说个现实：微信、飞书、Notion、Telegram 这些"全平台 App"，**不是用一种技术覆盖所有平台**，而是分层的：

| 平台 | 业界主流技术 | 为什么 |
|------|------------|--------|
| Android | 原生 Kotlin/Java 或 Flutter 或 React Native | 性能和生态 |
| iOS | 原生 Swift 或 Flutter 或 React Native | Apple 生态封闭 |
| Windows | 原生 C#（WinUI/WPF）或 Electron 或 Flutter | Win32 API |
| macOS | 原生 Swift 或 Electron 或 Flutter | Apple 生态 |
| Linux | 原生 C++（GTK/Qt）或 Electron 或 Flutter | 开源生态 |

### "一套代码全平台"的三条路

| 技术 | 能覆盖哪些平台 | 谁在用 |
|------|-------------|--------|
| **Flutter** | Android/iOS/macOS/Windows/Linux/Web（6 端） | 阿里闲鱼、字节抖音部分模块、Google Ads |
| **React Native** | Android/iOS/Web（3 端） | Facebook、Instagram、Discord 移动端 |
| **Electron** | Windows/macOS/Linux（3 端桌面） | VSCode、Discord 桌面端、飞书桌面端 |

**没有一种技术真正覆盖全部 6 端且体验都好**。Flutter 理论上 6 端通吃，但 iOS 需要签名、Windows 需要 Windows 机器。Electron 只做桌面端。RN 只做移动端 + Web。

### 大厂实际做法：混合架构

大多数大厂是**混合方案**——移动端一套、桌面端一套、Web 一套，各自用最优技术：

| 厂商 | 移动端 | 桌面端 | Web 端 |
|------|--------|--------|--------|
| 飞书 | Flutter / RN | Electron | Vue |
| 微信 | 原生（C++核心） | 原生 C++ | 原生 |
| Discord | React Native | Electron | React |
| Notion | React Native | Electron | React |

个人开发者没必要这么复杂。Flutter 一个人写一套就能覆盖 Android + Web + macOS，够用了。

### Release 页面怎么做到全平台的

你在 GitHub 上看到的那种"每个平台都有安装包"的 Release 页，**确实是在对应系统上编译出来的**。没有跨平台交叉编译。

业界标准流程是 **GitHub Actions CI/CD**：

```
开发者打 tag（如 v1.5.0）推到 GitHub
           ↓
GitHub Actions 自动触发（3 台云服务器并行）
    ┌─────────────────────────────┐
    │ ubuntu-latest              │ → Android APK + Linux + Web
    │ macos-latest               │ → iOS + macOS
    │ windows-latest             │ → Windows
    └─────────────────────────────┘
           ↓
5 个平台的安装包自动上传到 Release 页面
```

**公开仓库完全免费**，私有仓库每月 2000 分钟免费额度。每次构建约 15 分钟 × 5 平台 = 75 分钟，每月能构建 26 次。

## Flutter 凭什么一套代码跑六端

Flutter 写一份 Dart 代码，编译出 6 个平台的原生产物。靠的是每个平台有一个嵌入层（embedding layer），负责把 Flutter 引擎和 UI 代码跑在对应平台上。

| 平台 | 编译产物 | 用户怎么装 |
|------|---------|-----------|
| Android | .apk | 直接安装 |
| iOS | .ipa | Xcode 签名 / TestFlight |
| macOS | .app | 拖入应用程序文件夹 |
| Windows | .exe + .dll | 双击安装 |
| Linux | 可执行文件 | 解压运行 |
| Web | JS + HTML | 部署到 Nginx |

不需要改一行代码，6 个平台都能跑。但——**不是所有平台都能在一台 Mac 上编译**。

## 哪些平台能在 Mac 上编译

每个平台需要对应的系统环境和工具链。Mac 上没有 Windows SDK，也没有 Linux 的 GTK 库。

| 平台 | Mac 能编译吗 | 额外需要什么 |
|------|------------|------------|
| Android | 能 | Android SDK + JDK |
| iOS | 能 | Xcode + CocoaPods |
| macOS | 能 | Xcode |
| Web | 能 | Flutter SDK 自带 |
| Windows | 不能 | 需要 Windows + Visual Studio |
| Linux | 不能 | 需要 Linux + GTK/CMake |

Mac 覆盖 4 个平台。剩下两个得在对应系统上编译——或者用 GitHub Actions 云端编译。

## 各平台编译命令

### Android

```bash
# 调试版（体积大，带日志）
flutter build apk --debug

# 发布版（体积小，需签名）
flutter build apk --release

# Google Play 上架用的 AAB
flutter build appbundle --release
```

产物在 `build/app/outputs/flutter-apk/app-release.apk`。

### iOS

```bash
# 不签名（只能模拟器跑）
flutter build ios --release --no-codesign

# 完整签名（需要 Apple Developer 账号 $99/年）
flutter build ipa --release
```

没签名证书，编出来的包装不到真机上。这是 Apple 的生态封闭决定的，绕不过去。

### macOS

```bash
flutter build macos --release
```

产物在 `build/macos/Build/Products/Release/你的App名.app`。

### Web

```bash
flutter build web --release
```

产物在 `build/web/`，整个目录上传到任意 Web 服务器就能访问。

### Windows（在 Windows 机器上）

```cmd
flutter build windows --release
```

### Linux（在 Linux 机器上）

```bash
flutter build linux --release
```

## 怎么安装到设备上

### Android 手机

USB 连接手机，打开 USB 调试：

```bash
adb devices                    # 确认连上了
adb install -r app-release.apk # 安装
```

### iOS 手机

两条路：
- **Xcode 直接装**：数据线连 Xcode → 选设备 → Run（要 Developer 账号）
- **TestFlight**：打包上传 App Store Connect → 邀请测试用户

### macOS 电脑

把 `.app` 拖入 `/Applications`。第一次打开可能提示"无法验证开发者"，去 **系统设置 → 隐私与安全性 → 仍要打开**。

### Web 部署

把 `build/web/` 上传到 Nginx：

```bash
scp -r build/web/* server:/var/www/myapp/
```

Nginx 加一行 SPA 路由兜底：

```nginx
location / {
    try_files $uri $uri/ /index.html;
}
```

## 怎么发布让用户下载

### 手动发布

本地编译完，用 gh CLI 上传到 GitHub Release：

```bash
gh release create v1.0.0 \
  build/app/outputs/flutter-apk/app-release.apk \
  --title "v1.0.0" --notes "更新说明"
```

### 自动发布（GitHub Actions）

这是业界标准做法。配一个 `.github/workflows/release.yml`，打 tag 就自动在云端编译 5 个平台。

GitHub 提供 Ubuntu/Mac/Windows 三种云服务器，代码 push 后并行编译，产物自动上传到 Release。

以后发版只需要：

```bash
git tag v1.5.0
git push origin v1.5.0
# GitHub 自动编译 5 个平台，产物自动上传到 Release
```

公开仓库完全免费。

## 编译踩坑实录

### IconData tree-shake 报错

如果代码里用 Map 查找 IconData（比如按科目名动态取图标），Flutter Web/macOS 编译会报 `Avoid non-constant invocations of IconData`。

加一个参数解决：

```bash
flutter build apk --release --no-tree-shake-icons
flutter build web --release --no-tree-shake-icons
```

### pub get 网络失败

代理冲突。清除代理变量：

```bash
env -u http_proxy -u https_proxy -u all_proxy flutter pub get
```

### Android release 签名失败

需要生成 keystore：

```bash
keytool -genkey -v -keystore ~/keystore.jks \
  -keyalg RSA -keysize 2048 -validity 10000 -alias release
```

配到 `android/key.properties` + `android/app/build.gradle`。

### iOS 编译需要 CocoaPods

Mac 上没装会报错：

```bash
sudo gem install cocoapods
```

## 版本号怎么管

`pubspec.yaml` 里 `version: 1.4.0+2`：
- `1.4.0` 是用户看到的版本名
- `+2` 是内部构建号，每次发布递增

语义化版本：加功能升中间段（1.4→1.5），修 Bug 升最后段（1.4.0→1.4.1），大改升第一段（1.x→2.0）。

## 个人开发者最省钱的发布路径

| 平台 | 免费方案 |
|------|---------|
| Android | APK 放 GitHub Release / 自己的网站 |
| Web | 部署到自己的 Nginx |
| macOS | .app 打 zip 放 GitHub Release |
| Windows | 找台 Windows 编完放 GitHub Release |
| iOS | $99/年 Apple Developer，绕不过去 |

不花一分上架费，GitHub Release + 自己的服务器就够了。
