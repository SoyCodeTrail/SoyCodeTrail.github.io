---
title: Android 16 源码获取与 SystemUI 编译全流程
category: client
platform: android
tags: ["AOSP", "编译", "SystemUI", "Docker"]
readTime: 18分钟
featured: true
date: 2026-07-28
---

## 背景

在 Apple M3 Max (arm64) 上编译 AOSP SystemUI，目标版本 android-16.0.0_r4，目标设备为模拟器。记录从源码获取到编译成功的完整流程。

## 源码获取

### 用清华镜像（国内直连，75 MB/s）

```bash
mkdir ~/aosp-r4 && cd ~/aosp-r4
repo init -u https://aosp.tuna.tsinghua.edu.cn/platform/manifest -b android-16.0.0_r4
repo sync -c -j8
```

完整源码约 **196GB**，清华镜像比走代理快 10 倍。

### 为什么选 r4

android-16.0.0_r4 是稳定 tag，对应开发版代号 Baklava。不要用 main 分支（不稳定，模块经常缺失）。

## 编译环境（Docker 方案）

Apple Silicon 上不能直接编译 AOSP——需要 Docker + Rosetta 翻译 x86。

### Docker 镜像构建

```dockerfile
FROM ubuntu:22.04
# AOSP 编译依赖 + 清华 apt 镜像
RUN apt-get update && apt-get install -y \
    git gnupg flex bison build-base zip curl \
    libncurses-dev libssl-dev
```

### 关键配置

| 项 | 值 |
|----|-----|
| Docker 镜像 | x86 + Rosetta（arm64 容器缺工具链）|
| Docker VM 内存 | **32GB**（默认 7.6GB 必崩）|
| 文件系统 | ext4（Docker 卷，解决 APFS 大小写不敏感）|
| fd 限制 | `kern.maxfiles=1048576` |

## SystemUI 编译

### 编译命令

```bash
# 进 Docker 容器
source build/envsetup.sh
lunch sdk_gphone64_x86_64-trunk_staging-userdebug
m SystemUI
```

### 编译结果

- 耗时：**59 分钟**（零错误）
- 产物：`SystemUI.apk`（166MB）
- 版本：16/36

### 遇到的坑

| 问题 | 解决方案 |
|------|---------|
| gblsigntool 模块缺失 | 修改 Android.bp 删除测试模块 |
| VNDK v30 缺失 | 修改 gsi_release.mk 删除 v30 要求 |
| Docker VM 内存不足 | settings-store.json 改 memoryMiB=32768 |

## Android Studio 阅读源码

### idegen 生成项目文件

```bash
m idegen
development/tools/idegen/idegen.sh
```

生成 `android.ipr`（IntelliJ 项目）和 `android.iml`（模块定义）。

### AS 配置要点

| 配置项 | 值 | 原因 |
|--------|-----|------|
| modules.xml | 指向 `android.iml` | AS 默认创建空壳 iml |
| 项目 SDK | **No SDK** | 避免跳转到 SDK stub |
| 内存 | -Xmx12g | AOSP 源码量大 |
| content.dat | 清缓存要连全局 | 防止索引过滤 |

### 为什么项目 SDK 设 No SDK

AOSP 源码是自包含的——`frameworks/base/core/java/` 就是真实实现。
如果设成 Android API 36 Platform，符号解析走 SDK 的 `android.jar`（只有签名的 stub），跳转会到 `.class` 而非源码。

## VSCode + clangd 阅读 C++ 源码

### compile_commands.json 生成

```bash
# ninja 导出 compdb
ninja -C out/soong/.intermediates -t compdb > compile_commands.json
```

### 关键修复

原始 compdb 的 directory 字段是 Docker 容器路径 `/aosp`，本机路径是 `/Users/xxx/aosp-r4`。需要修正：

```python
for entry in data:
    if entry['directory'] == '/aosp':
        entry['directory'] = '/Users/soycodetrail/aosp-r4'
```

同时过滤掉 `out/`（生成文件）和 `external/`（第三方库），从 10 万条压缩到 1 万条。

### .clangd 配置

```yaml
CompileFlags:
  CompilationDatabase: /Users/soycodetrail/aosp-r4
```

用树内 prebuilt clangd（`prebuilts/clang/host/darwin-x86/clang-r563880c`），版本与 compdb 匹配。
