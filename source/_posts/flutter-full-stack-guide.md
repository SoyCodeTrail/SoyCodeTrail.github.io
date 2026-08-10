---
title: 一套 Flutter 代码发布到全平台：从拍照 App 到多端发布的完整实战
category: client
platform: flutter
tags: ["Flutter", "多平台", "发布", "CI/CD", "实战"]
readTime: 25分钟
featured: true
date: 2026-07-28
---

上一篇讲了个人网站怎么用 Vue3 + Supabase + Nginx 搭起来。这次讲移动端——一套 Flutter 代码，怎么从零做到 Android + Web + macOS 三端发布，全程可以让 AI 帮你干活。

## 你可以直接把下面这段话甩给 AI

```
我要做一个 App，主要实现：拍照采集、AI 识别、分类管理、PDF 打印导出。
参考下面的技术栈和步骤：

Flutter 3.44 + Dart + GLM-4V 视觉识别 + Provider 状态管理

8 个步骤：
环境准备 → 项目创建 → 核心功能开发 → AI 接入 → PDF 导出 → 
编译调试 → 多平台构建 → GitHub Release 发布

仿照以下技术栈：
- 框架：Flutter（一套代码编 Android/iOS/macOS/Windows/Linux/Web）
- AI：智谱 GLM-4V（图片识别）+ GLM-4-Flash（文本解析，免费）
- 存储：shared_preferences（本地 JSON）
- PDF：pdf + printing 包
- 拍照：image_picker
- 状态：Provider
- 发布：GitHub Actions 自动构建 5 个平台
```

## 第一步：环境准备

### 装 Flutter

```bash
# Mac（推荐用 fvm 管理版本）
brew install fvm
fvm install 3.44.4
fvm use 3.44.4

# 或直接下载
# https://docs.flutter.dev/get-started/install
```

### 检查环境

```bash
flutter doctor
```

需要全绿（或至少 Android 和 Web 绿）：
- Flutter SDK ✅
- Android SDK ✅（装 Android Studio 自带）
- Chrome（Web 构建用）✅
- Xcode（iOS/macOS 构建，只 Mac 需要）✅

### 代理问题

国内网络环境下 pub get 可能失败。清除代理：

```bash
env -u http_proxy -u https_proxy -u all_proxy \
  flutter pub get
```

## 第二步：创建项目

```bash
flutter create --org com.yourname --project-name my_app my_app
cd my_app
```

### 核心依赖（pubspec.yaml）

```yaml
dependencies:
  flutter:
    sdk: flutter
  http: ^1.2.0              # 网络（调 AI API）
  image_picker: ^1.1.0      # 拍照/相册
  provider: ^6.1.0          # 状态管理
  shared_preferences: ^2.3.0 # 本地存储
  pdf: ^3.11.0              # PDF 生成
  printing: ^5.14.0         # PDF 打印/分享
  path_provider: ^2.1.0     # 文件路径
  share_plus: ^10.0.0       # 系统分享
```

### 项目结构（推荐）

```
lib/
├── main.dart                 # 入口
├── config.dart               # 常量配置
├── models/                   # 数据模型
│   └── item.dart
├── services/                 # 业务逻辑
│   ├── ai_service.dart       # AI 调用
│   ├── storage_service.dart  # 本地存储
│   └── pdf_service.dart      # PDF 导出
├── providers/                # 状态管理
│   └── item_provider.dart
└── screens/                  # 页面
    ├── home_screen.dart      # 底部导航
    ├── list_screen.dart      # 列表页
    ├── capture_screen.dart   # 拍照页
    ├── detail_screen.dart    # 详情页
    └── settings_screen.dart  # 设置页
```

## 第三步：核心功能开发

### 拍照采集

```dart
import 'package:image_picker/image_picker.dart';

final picker = ImagePicker();
// 拍照
final photo = await picker.pickImage(source: ImageSource.camera, imageQuality: 80);
// 相册选图
final photo = await picker.pickImage(source: ImageSource.gallery, imageQuality: 80);
```

`imageQuality: 80` 压缩图片，避免 base64 编码后太大。

### 本地存储（shared_preferences）

```dart
// 存
final prefs = await SharedPreferences.getInstance();
prefs.setString('my_items', jsonEncode(items.map((e) => e.toJson()).toList()));

// 取
final raw = prefs.getString('my_items');
if (raw != null) {
  final list = jsonDecode(raw) as List;
  items = list.map((e) => Item.fromJson(e)).toList();
}
```

轻量级方案，不需要数据库。数据多了（超过 1000 条）再考虑 SQLite 或 Supabase。

### 状态管理（Provider）

```dart
class ItemProvider extends ChangeNotifier {
  List<Item> _items = [];
  List<Item> get items => _items;

  Future<void> loadItems() async {
    _items = await StorageService.getAllItems();
    notifyListeners();
  }

  Future<void> addItem(Item item) async {
    _items.add(item);
    await StorageService.addItem(item);
    notifyListeners();
  }
}
```

UI 里用 `context.watch<ItemProvider>()` 自动刷新。

## 第四步：AI 接入（双引擎架构）

拍照识别用视觉模型（GLM-4V），文本解析用纯文本模型（GLM-4-Flash 免费）——两个引擎独立配置。

### 图片识别（GLM-4V）

```dart
final base64Image = base64Encode(await File(imagePath).readAsBytes());

final response = await http.post(
  Uri.parse('https://open.bigmodel.cn/api/paas/v4/chat/completions'),
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer $apiKey',
  },
  body: jsonEncode({
    'model': 'glm-4v',
    'messages': [{
      'role': 'user',
      'content': [
        {'type': 'text', 'text': '识别这张图片中的题目，返回JSON：{"question":"","subject":"","difficulty":""}'},
        {'type': 'image_url', 'image_url': {'url': 'data:image/jpeg;base64,$base64Image'}},
      ]
    }]
  }),
);
```

这是 OpenAI 兼容格式——智谱、通义千问、DeepSeek 等国内模型都支持。

### 文本解析（GLM-4-Flash，免费）

```dart
final response = await http.post(
  Uri.parse('https://open.bigmodel.cn/api/paas/v4/chat/completions'),
  headers: {'Authorization': 'Bearer $apiKey'},
  body: jsonEncode({
    'model': 'glm-4-flash',  // 免费，快
    'messages': [{'role': 'user', 'content': '分析这道题：$question'}],
  }),
);
```

### 为什么分离

| 维度 | 图片识别 | 文本解析 |
|------|---------|---------|
| 模型 | GLM-4V（多模态，贵）| GLM-4-Flash（纯文本，免费）|
| 用途 | 拍照时 | 举一反三/搜题 |
| 调用频率 | 每拍一次调一次 | 按需调用 |

两个引擎独立配置 API Key 和 Model，用户在设置页自己选。

## 第五步：PDF 导出

### 中文乱码修复

`pdf` 包默认不支持中文。加载 Noto Sans SC 字体：

```dart
// 三级 fallback
try {
  // 1. printing 包内置的 Google Fonts（有本地缓存）
  final font = await PdfGoogleFonts.notoSansSCRegular();
} catch (_) {
  try {
    // 2. 从 GitHub 下载
    final resp = await http.get(Uri.parse('https://github.com/google/fonts/raw/main/ofl/notosanssc/...'));
    font = pw.Font.ttf(ByteData.sublistView(resp.bodyBytes));
  } catch (_) {
    // 3. 兜底（中文丢失但不崩）
    font = pw.Font.helvetica();
  }
}
```

### 试卷模式

选中多题 → 生成试卷 PDF → 每题留答题空白区：

```dart
// 每题后面加一个 200pt 的空白区域
pw.Container(
  height: 200,
  decoration: pw.BoxDecoration(border: pw.BoxBorder(top: true, bottom: true)),
  child: pw.Center(child: pw.Text('答题区')),
)
```

## 第六步：编译与安装

### Android

```bash
flutter build apk --debug                    # 调试版
flutter build apk --release                  # 发布版
```

安装到手机：

```bash
adb install -r build/app/outputs/flutter-apk/app-release.apk
```

### Web

```bash
flutter build web --release --no-tree-shake-icons
```

产物在 `build/web/`，上传到 Nginx 就能访问。

### macOS

```bash
flutter build macos --release --no-tree-shake-icons
```

产物在 `build/macos/Build/Products/Release/`，拖入应用程序文件夹。

### `--no-tree-shake-icons` 是什么

代码里如果用 Map 动态查找 IconData，Flutter 的图标优化器会报错。加这个参数跳过优化。不影响功能。

## 第七步：多平台自动构建（GitHub Actions）

这是最省事的部分。配一个文件，以后打 tag 就自动编译 5 个平台。

### 配置文件

```yaml
# .github/workflows/release.yml
name: 全平台自动构建
on:
  push:
    tags: ['v*']

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: ubuntu-latest
            target: android
          - os: ubuntu-latest
            target: web
          - os: ubuntu-latest
            target: linux
          - os: macos-latest
            target: macos
          - os: windows-latest
            target: windows

    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: subosito/flutter-action@v2
        with:
          channel: stable
      - run: flutter pub get
      - run: flutter build ${{ matrix.target }} --release --no-tree-shake-icons
      - uses: softprops/action-gh-release@v2
        with:
          files: build/...
```

### 触发构建

```bash
git tag v1.0.0
git push origin v1.0.0
```

GitHub 自动在 3 台云服务器上并行编译，产物自动上传到 Release。公开仓库完全免费。

## 第八步：发布到各渠道

### GitHub Release（最通用）

所有平台的安装包放一个 Release，用户自己选平台下载：

```bash
gh release create v1.0.0 \
  app-android.apk app-web.zip app-macos.zip \
  --title "v1.0.0" --notes "更新说明"
```

### 自己的服务器（APK 直链下载）

```bash
scp app-release.apk server:/var/www/myapp/app.apk
```

用户手机浏览器打开 `https://你的域名/app.apk` 直接下载安装。

### Web 版部署

```bash
scp -r build/web/* server:/var/www/myapp/
```

Nginx 配置 SPA 兜底：

```nginx
location / {
    try_files $uri $uri/ /index.html;
}
```

## 成本估算

| 项目 | 费用 |
|------|------|
| Flutter SDK | 免费 |
| GitHub Actions | 免费（公开仓库）|
| 智谱 GLM-4V | 有免费额度 |
| GLM-4-Flash | 完全免费 |
| Android APK 自分发 | 免费 |
| Web 部署 | 免费（自己服务器）|
| Apple Developer（iOS/macOS 上架）| $99/年 |
| **总计（不上 App Store）** | **0 元** |

## 你可以直接把这段话甩给 AI

```
我要做一个 Flutter App，功能是：拍照采集 + AI 识别 + 分类管理 + PDF 导出。

技术栈：Flutter 3.44 + GLM-4V（图片识别）+ GLM-4-Flash（文本解析）+
Provider + shared_preferences + pdf + image_picker

8 个步骤：
1. 环境准备：flutter doctor 全绿
2. 项目创建：flutter create，配 pubspec.yaml
3. 核心功能：拍照、存储、状态管理、列表、设置
4. AI 接入：双引擎（视觉+文本），用户自填 API Key
5. PDF 导出：中文不乱码，支持试卷模式
6. 编译：--no-tree-shake-icons，build apk/web/macos
7. GitHub Actions：打 tag 自动编译 5 个平台
8. 发布：GitHub Release + 自己的服务器
```

AI 会帮你写出全部代码、配好 CI/CD、编出 APK。你只需要测试和打 tag。
