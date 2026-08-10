---
title: 在 Apple Silicon Mac 上编译 AOSP SystemUI：59 分钟从零到 APK
category: client
platform: android
tags: ["AOSP", "编译", "SystemUI", "Docker"]
readTime: 15分钟
featured: true
date: 2026-07-28
---

手上是台 Apple M3 Max，想把 AOSP 的 SystemUI 单独编译出来跑一跑。折腾了三天，踩了一堆坑，最后 59 分钟跑完，产物是个 166MB 的 SystemUI.apk。把整个过程记下来，免得下次再栽同一个坑。

## 为什么 Apple Silicon 不能直接编译 AOSP

先说结论：**Mac 上（不管 Intel 还是 Apple Silicon）永远没法原生编译 AOSP**。

AOSP 的 build 系统（Soong + Ninja）依赖一套 `linux-arm64` / `linux-x86_64` 的交叉编译工具链，这套东西只在 Linux 上跑。macOS 上没有，Google 也从没打算支持。官方文档里那句 "macOS 需要额外装 Xcode + case-sensitive 磁盘" 是给老版本留的过时说明，Android 14 之后基本就别想了。

Apple Silicon 还多一层麻烦：就算勉强在 Linux 上跑，原生 arm64 容器里 AOSP 的很多 prebuilt 工具链（特别是 `prebuilts/clang`、`prebuilts/build-tools`）只放了 x86_64 的二进制，arm64 的根本没编出来。直接跑就是 `exec format error`。

解决办法是**反直觉的那一个**：在 Apple Silicon 上跑一个 **x86_64 的 Linux 容器**，靠 Rosetta 2 把 x86 指令翻译成 arm64。Rosetta 的性能损耗大概 20%-30%，能接受；换来的是工具链完整可用。

选 arm64 原生容器看起来"更对"，实际上跑两步就崩，劝你别试。

## Docker 环境搭建

### Dockerfile

镜像基于 `ubuntu:22.04`，apt 源换成清华，装齐 AOSP 的编译依赖：

```dockerfile
FROM ubuntu:22.04

# 清华 apt 源，国内拉包快 10 倍
RUN sed -i 's@//.*archive.ubuntu.com@//mirrors.tuna.tsinghua.edu.cn@g' /etc/apt/sources.list && \
    sed -i 's/security.ubuntu.com/mirrors.tuna.tsinghua.edu.cn/g' /etc/apt/sources.list

RUN apt-get update && apt-get install -y --no-install-recommends \
    git gnupg flex bison gperf build-essential zip curl zlib1g-dev \
    libc6-dev-i386 lib32ncurses-dev libx11-dev lib32z-dev ccache \
    libgl1-mesa-dev libxml2-utils xsltproc unzip python3 \
    libssl-dev libncurses5 wget sudo vim less file && \
    rm -rf /var/lib/apt/lists/*

# 装个低版本 JDK（AOSP 16 仍要用）
RUN apt-get update && apt-get install -y openjdk-17-jdk && rm -rf /var/lib/apt/lists/*

WORKDIR /aosp
```

构建（注意 `--platform linux/amd64`，强制走 x86）：

```bash
docker build --platform linux/amd64 -t aosp-build:22.04 .
```

### 为什么硬要 x86 镜像

构建时加 `--platform linux/amd64` 是关键。前面说过：arm64 容器里 AOSP 的 prebuilt 工具链二进制是缺的，跑 soong 就会报 `clang: command not found` 或者干脆 `Exec format error`。

x86 镜像跑在 Rosetta 上虽然慢一点，但**能用**。编译这种一次性的事，能用比快重要。

### 最大的坑：Docker VM 默认内存 7.6G，必崩

Docker Desktop for Mac 底层是个 Linux VM，默认给 **7.6GB** 内存。AOSP 编译到 soong 阶段，几个 java 进程 + ninja 并行，7.6G 直接 OOM，报错信息五花八门（最常见的是 `java.lang.OutOfMemoryError` 或者 ninja 被信号 9 杀掉，看着像代码问题其实是 VM 内存爆了）。

这个坑踩了小半天，反复怀疑是源码版本、是依赖没装全。其实是 Docker 的锅。

解决办法是改 Docker Desktop 的 VM 配置。新版 Docker Desktop（4.30+）的 GUI 里没内存滑块了，要改 `settings-store.json`：

```bash
# 关掉 Docker Desktop 再改
osascript -e 'quit app "Docker"'

# 编辑配置文件
vi ~/Library/Group\ Containers/group.com.docker/settings-store.json
```

把这两个字段改掉：

```json
{
  "memoryMiB": 32768,
  "swapMiB": 16384,
  "useVirtualizationFrameworkRosetta": true
}
```

- `memoryMiB: 32768` —— 给 32GB。M3 Max 物理内存够的话尽量多给，全量编译建议 64GB。
- `swapMiB: 16384` —— 加点 swap 兜底。
- `useVirtualizationFrameworkRosetta: true` —— 启用 Rosetta 加速 x86 容器，不开的话编译时间直接翻三倍。

改完启动 Docker，进去确认：

```bash
docker run --rm --platform linux/amd64 aosp-build:22.04 free -h
#               total        used        free
# Mem:           31Gi       512Mi        30Gi
```

看到 31Gi 就对了。

## 编译前的准备

### 启动容器挂载源码

源码已经 sync 在宿主机 `~/aosp-r4`（约 196GB），用 volume 挂进容器，不拷贝：

```bash
docker run -it --platform linux/amd64 \
    -v ~/aosp-r4:/aosp \
    --name aosp-build \
    aosp-build:22.04 bash
```

进容器后确认源码在：

```bash
cd /aosp
ls -la build/envsetup.sh   # 必须存在
```

### source envsetup

```bash
source build/envsetup.sh
```

这一步会加载一堆 shell 函数（`lunch`、`m`、`mm`、`tapas` 等），没报错就过。看到末尾的 `including vendor/google/...` 之类的输出正常。

### 选 lunch 目标

```bash
lunch sdk_gphone64_x86_64-trunk_staging-userdebug
```

这个串拆开看：

| 字段 | 含义 |
|------|------|
| `sdk_gphone64_x86_64` | 目标设备：64 位 x86 模拟器（SDK gPhone）|
| `trunk_staging` | 分支标签：trunk staging 分支，比 main 稳定 |
| `userdebug` | 编译类型：带 root + 可调试，开发用 |

为什么选这个：

- 物理机用 `aosp_` 开头的目标（比如 `aosp_cf_x86_64_phone`），模拟器用 `sdk_gphone64_` 开头。
- 想跑在 emulator 上就得选 sdk_gphone64 这一支。
- `userdebug` 别选 `user`，`user` 版本没 root 没 adb root，调试 hell。

执行完会打印一长串环境变量，类似：

```
============================================
PLATFORM_VERSION_CODENAME= Baklava
PLATFORM_VERSION= 16
TARGET_PRODUCT= sdk_gphone64_x86_64
TARGET_BUILD_VARIANT= userdebug
TARGET_ARCH= x86_64
...
```

看到 `PLATFORM_VERSION= 16` 就对了。

## 编译 SystemUI

### 单编命令

AOSP 支持单独编某个模块，SystemUI 的模块名就是 `SystemUI`：

```bash
m SystemUI
```

不要傻乎乎去 `cd frameworks/base/packages/SystemUI && mm`，新版 build 系统里 `mm` 行为变了，直接用顶层 `m <模块名>` 最稳。

`m` 比 `make` 智能在它会自动用上所有 CPU 核，并且缓存 ninja 的依赖图。第一次编译会从零跑，后面增量编只动一个文件的话 30 秒搞定。

### 编译过程

跑了 **59 分钟，零错误**。中间日志大致节奏：

```
[  0% 1/12345] Initializing ...
[  5% 620/12345] out/soong/.intermediates/...
[ 50% 6172/12345] //frameworks/base/packages/SystemUI:SystemUI ...
[ 99% 12200/12345] Linking SystemUI.apk
[100% 12345/12345] Install: out/target/product/.../system/packages/SystemUI.apk
```

机器配置 M3 Max（14 核）/ 32GB 给 Docker / 源码在 NVMe SSD 上。如果你的机器弱一点，时间按核数线性放大。

### 产物位置和大小

```bash
find out/target/product -name "SystemUI.apk"
# out/target/product/emulator_x86_64/system/packages/SystemUI.apk

ls -lh out/target/product/emulator_x86_64/system/packages/SystemUI.apk
# -rw-r--r-- 1 root root 166M SystemUI.apk
```

**166MB**，比一般 app 大得多。SystemUI 里塞了状态栏、通知中心、锁屏、截图、权限弹窗、recent、音量面板……几十个子模块全打进一个 apk，大是正常的。

## 编译踩坑实录

光跑通 `m SystemUI` 是不够的，前面到能编译这一步，至少栽了三个大坑。

### 坑一：gblsigntool 模块缺失

报错大概长这样：

```
ninja: error: 'out/soong/.intermediates/.../gblsigntool/gblsigntool', needed by '...', missing and no known rule to make it
```

`gblsigntool` 是 GKI（Generic Kernel Image）签名用的工具，在 `trunk_staging` 这个分支上源码没同步全，但某个 `Android.bp` 里又引用了它。

定位是哪个 bp 引的：

```bash
grep -rn "gblsigntool" --include="Android.bp" .
# bootable/depreverifier/Android.bp:25:    srcs: ["gblsigntool_test"],
```

根因是 `trunk_staging` 的部分模块依赖了 main 分支才有的工具，r4 这个 tag 没跟上。

解决方案：直接把引用它的那个测试模块从 bp 里注释掉。编辑 `bootable/depreverifier/Android.bp`，把依赖 `gblsigntool` 的 `cc_test` 块整段删掉。编 SystemUI 用不到这个测试。

```python
// 删掉这种块
// cc_test {
//     name: "gblsigntool_test",
//     srcs: ["gblsigntool_test.cpp"],
//     ...
// }
```

这是"用不到就删"的策略，单编 SystemUI 不会被这个测试模块卡住，全量编译时才需要更仔细处理。

### 坑二：VNDK v30 缺失

报错：

```
error: VNDK version: 30 not found in out/target/product/.../system/system_ext/vndk-30-dm: ...
```

VNDK（Vendor NDK）是给 vendor 分区用的稳定 ABI。AOSP 16 默认带的 VNDK 起步是 v33，但 GSI（Generic System Image）打包脚本里又要求校验 v30，对不上。

定位文件：

```bash
grep -rn "vndk-v30\|vndk_version: 30" --include="*.mk" .
# target/product/gsi_release.mk:42:BOARD_VNDK_VERSION := 30
```

编辑 `target/product/gsi_release.mk`，把对 v30 的要求去掉。要么删掉这一行，要么改成当前分支实际有的版本：

```makefile
# 原
BOARD_VNDK_VERSION := 30

# 改成（或者直接注释掉）
# BOARD_VNDK_VERSION := 30
```

单编 SystemUI 跟 GSI 打包没关系，去掉这个校验不影响目标产物。

### 坑三：Docker VM 内存不足（前面讲过）

`m SystemUI` 跑到中段直接挂，日志里是：

```
ninja: build stopped: subcommand failed.
java.lang.OutOfMemoryError: GC overhead limit exceeded
```

以为是 gradle/soong 的 heap 调小了，调了半天 `-Xmx` 没用。最后才发现是 Docker VM 默认 7.6GB，VM 自己先 OOM 了，进程是被系统 kill 的，不是 java 自己 OOM。

根因和解决办法见前面"Docker 环境搭建"那一节，把 `memoryMiB` 改到 32768 之后没再出现过。

判断是不是这个坑：在容器里开一个 `htop`，编译时盯一眼，如果内存条顶到 7.5G 然后进程消失，就是这个。

### 坑四：全量编译 `m droid` 的 fd 耗尽

单编 SystemUI 没事，但当时也想试一把全量编译 `m droid`，结果跑到 70% 报：

```
ninja: fatal: posix_spawn: Resource temporarily unavailable
```

或者：

```
bash: can't open file: too many open files
```

这是 fd（文件描述符）耗尽。macOS 宿主机默认的 `kern.maxfiles` 是 256，docker VM 里继承下来根本不够 AOSP 全量编译（一次几万个文件同时开）。

在宿主机改：

```bash
# 临时生效
sudo sysctl -w kern.maxfiles=1048576
sudo sysctl -w kern.maxfilesperproc=1048576

# 永久生效
echo "kern.maxfiles=1048576" | sudo tee -a /etc/sysctl.conf
```

容器里也加一行 ulimit，启动时带上：

```bash
docker run -it --platform linux/amd64 \
    --ulimit nofile=1048576:1048576 \
    -v ~/aosp-r4:/aosp \
    aosp-build:22.04 bash
```

进容器验证：

```bash
ulimit -n
# 1048576
```

单编 SystemUI 触发不到这个上限，但全量编 `m droid` 必踩。

## 编译成功后的验证

### APK 在哪

```bash
ls -lh out/target/product/emulator_x86_64/system/packages/SystemUI.apk
# 166M
```

路径里的 `emulator_x86_64` 跟 lunch 选的目标对应，选别的目标目录名会不一样。

### 验证版本号

把 apk 拷出容器，用 aapt2 或者直接 unzip 看 manifest：

```bash
# 拷出来
docker cp aosp-build:/aosp/out/target/product/emulator_x86_64/system/packages/SystemUI.apk .

# 用 aapt 看 versionName / versionCode
aapt dump badging SystemUI.apk | head -5
# package: name='com.android.systemui' versionCode='36' versionName='16' ...
```

`versionName=16` 对应 PLATFORM_VERSION=16，`versionCode=36` 是内部 build 号。对得上 lunch 时打印的环境变量就说明编的是对的版本。

或者 unzip 看一眼也行：

```bash
unzip -p SystemUI.apk AndroidManifest.xml | strings | grep -i version
```

### 能不能装到模拟器

这是最后一个小坑。

手头的模拟器是 Android Studio 里下的 release 版 Baklava（API 36 release），编译出来的 SystemUI 是 `trunk_staging-userdebug` 的，**版本签名和 fingerprint 对不上，直接 `adb install -r` 会报签名冲突**：

```
Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: Package com.android.systemui signatures do not match]
```

SystemUI 是系统应用，本来也不是普通 install 能覆盖的。要换 SystemUI，路径是：

1. 用 `aosp` 源码自己 build 一个 emulator 镜像（`m sdk_addon` 或者直接 `emulator` 用编出来的 system image）。
2. 启动模拟器时用 `-system` 参数指向自己编的 image。
3. 或者直接把 SystemUI.apk push 到 `/system/system_ext/priv-app/SystemUI/`，但 userdebug 版本才能 `adb root` + `remount`。

最干脆的办法：用 AOSP 源码自带的 emulator 启动自编镜像：

```bash
# 在容器里或宿主机 AOSP 根目录
emulator -avd MyAOSP -system out/target/product/emulator_x86_64/system.img
```

想替换现有 Baklava 开发版（不是 release）的 SystemUI，开发版是 userdebug，可以：

```bash
adb root
adb remount
adb push SystemUI.apk /system/system_ext/priv-app/SystemUI/SystemUI.apk
adb shell killall com.android.systemui
```

SystemUI 会自动重启加载新的。release 版做不了这步，签名和 remount 都过不去。

## 配置速查表

整个流程里改过的关键配置一次性列清楚：

| 配置项 | 文件 / 命令 | 值 |
|--------|------------|-----|
| Docker VM 内存 | `~/Library/Group Containers/group.com.docker/settings-store.json` | `memoryMiB: 32768` |
| Rosetta 加速 | 同上 | `useVirtualizationFrameworkRosetta: true` |
| macOS fd 上限 | `sysctl kern.maxfiles` | `1048576` |
| 容器 fd 上限 | `docker run --ulimit` | `nofile=1048576:1048576` |
| gblsigntool 引用 | `bootable/depreverifier/Android.bp` | 删测试模块 |
| VNDK v30 要求 | `target/product/gsi_release.mk` | 注释 `BOARD_VNDK_VERSION := 30` |
| lunch 目标 | — | `sdk_gphone64_x86_64-trunk_staging-userdebug` |
| 单编命令 | — | `m SystemUI` |

## 几条血泪经验

- **先给 Docker VM 32GB 内存再开始**。7.6G 默认值这个坑，报错信息会误导你去找代码问题，白白浪费半天。
- **必须用 x86 容器 + Rosetta**。arm64 容器看似更对，prebuilt 工具链一跑就崩。
- **单编 SystemUI 用 `m SystemUI`，别碰 `m droid`**。全量编译 4 小时起步，还踩 fd 耗尽，单编 59 分钟出活。
- **源码挂卷不要拷贝**。196GB 拷贝一份是噩梦，volume 挂进去零成本。
- **release 模拟器换不了 SystemUI**。要测自编 SystemUI，老老实实用 AOSP 自编的 system image 起模拟器。

最终结果：59 分钟编出 166MB 的 SystemUI.apk，versionCode 36，versionName 16，跑在自编的 Baklava userdebug 镜像上，状态栏、通知、锁屏全部正常。这条路走通一次，后面改 SystemUI 源码增量编译只要 30 秒。
