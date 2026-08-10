---
title: 在 macOS 上获取 Android 16 源码：从零到 196GB 完整拉取
category: client
platform: android
tags: ["AOSP", "源码", "repo", "清华镜像"]
readTime: 12分钟
featured: true
date: 2026-07-28
---

搞 Android 的迟早会碰到这一步：光看 SDK 文档不够用了，得翻 Framework 源码才能搞清楚一个 `Activity` 到底是怎么 start 起来的，或者想自己编一个 SystemUI 看看改完啥效果。这时候就得把整个 AOSP（Android Open Source Project）源码拉下来。

这篇记一下在 macOS Apple Silicon（M1/M2/M3）上把 Android 16 完整源码搞到本地的全过程，包括踩过的坑。最终拉下来的体积是 **196GB**，别被这个数字吓到，下面一步一步来。

## 为什么非得要源码

Android SDK 给的是编译好的 jar 和 API，看不到实现。遇到下面这些场景就只能上源码：

- **读 Framework 源码**：比如 `ActivityManagerService` 怎么调度 Activity、`WindowManager` 怎么算窗口层级，SDK 里全是 stub，源码才是真相。
- **编译 SystemUI / Launcher3**：想改状态栏样式、加个快捷开关，得整个 `packages/apps/` 目录自己编译。
- **改系统行为**：魔改开机动画、调整权限策略、给某台设备做定制 ROM。
- **排查诡异崩溃**：有些栈帧直接进到 Framework 内部，没源码断点都打不进去。

简单说，做应用层够不着底层，做系统层没源码等于瞎子摸象。

## 环境要求（先把这些备齐）

### 磁盘空间：留足 200G 以上

这是最容易翻车的一点。源码本身拉下来约 196GB，这还没算编译产物。一旦执行 `m` 全量编译，`out/` 目录还会再吃掉 100G+。所以**给 AOSP 单独准备一个至少 350G 空闲的盘**，不然拉到一半磁盘满了，前功尽弃。

建议放外接 SSD，速度还比机械盘快不少。

### 网络：国内必须走镜像

AOSP 源码托管在 Google 的服务器上（`android.googlesource.com`），国内直连基本是死的，挂代理也不稳定，几百个 git 仓库同时拉，代理随时挂。

正解是走**清华 TUNA 镜像**（`aosp.tuna.tsinghua.edu.cn`），教育网和大部分宽带都能跑到 75MB/s 左右，全程不用代理。

### repo 工具

AOSP 不是单个 git 仓库，是几百个 git 仓库组成的"超级仓库"，需要一个叫 `repo` 的工具来统一管理。这个工具本身是个 Python 脚本，安装见下一节。

## 装 repo 工具

### 通过清华镜像装 repo

macOS 上推荐直接用 Homebrew，但 brew 装的 repo 有时候版本偏旧、还会去连 Google。手动装更可控：

```bash
# 建 bin 目录
mkdir -p ~/bin

# 从清华镜像下 repo 脚本
curl https://mirrors.tuna.tsinghua.edu.cn/git/git-repo > ~/bin/repo

# 加可执行权限
chmod a+x ~/bin/repo
```

把 `~/bin` 加到 PATH。zsh 用户编辑 `~/.zshrc`：

```bash
export PATH=~/bin:$PATH
```

然后 `source ~/.zshrc` 生效。验证一下：

```bash
repo version
# 应该能看到 repo 版本号
```

### 配置 repo 走清华源

repo 默认会去 `gerrit.googlesource.com` 拉它自己的更新，国内访问不到。在 `~/.zshrc` 里加一行环境变量强制走清华：

```bash
export REPO_URL='https://mirrors.tuna.tsinghua.edu.cn/git/git-repo/'
```

忘了配这个，repo 一启动就会卡在 "Get repo self update" 半天，最后超时报错。

### 配置 git

repo 底层就是调 git，git 没配用户名邮箱会报 warning，建议先设好：

```bash
git config --global user.name "你的名字"
git config --global user.email "你的邮箱"
```

再设一个默认分支名，省得每次提示：

```bash
git config --global init.defaultBranch main
```

大仓库拉取容易超时，把 git 的 buffer 调大、超时拉长：

```bash
git config --global http.postBuffer 524288000
git config --global http.lowSpeedLimit 0
git config --global http.lowSpeedTime 999999
```

这几个配置不改，拉大仓库经常 `RPC failed; curl 56 OpenSSL SSL_read` 报错。

## 选版本：为什么用 android-16.0.0_r4

AOSP 有几千个 tag，每个对应一个发布版本。别上来就拉 `main` 分支。

### 为什么不用 main 分支

`main` 分支是开发主线，三个坑：

1. **不稳定**：主线代码随时在变，可能今天能编明天就编不过。
2. **模块缺失**：很多预编译产物还没上传，编译时各种 `file not found`。
3. **依赖飘**：某个仓库今天指向 A commit，明天 rebase 了，二次 sync 行为都变了。

学习和稳定编译，认准**发布 tag**。

### android-16.0.0_r4

这是个稳定的 Android 16 release tag，对应的版本号查得到，编出来的东西和 Pixel 上跑的一致。

### 怎么查可用 tag 列表

官方有个页面 `source.android.com/docs/setup/reference/build-numbers`，上面列了所有 codename、版本号、tag 对应关系。或者直接列远端 tag：

```bash
# 初始化一个空仓库后用 git 查
cd .repo/manifests.git 2>/dev/null
git tag | grep android-16
```

挑 tag 的小窍门：编号越靠后（_r4、_r5）一般修的 bug 越多，尽量选同一系列里最新的那个。

## 拉源码（核心步骤）

下面是真正干活的部分。先建好工作目录：

```bash
mkdir -p ~/aosp/android-16
cd ~/aosp/android-16
```

### repo init：初始化

```bash
repo init -u https://aosp.tuna.tsinghua.edu.cn/platform/manifest -b android-16.0.0_r4
```

参数解释：

- `-u`：manifest 仓库地址，**这个 URL 必须是清华的**，换成 Google 的就废了。
- `-b`：分支/tag，这里用 `android-16.0.0_r4`。

这一步会下载 manifest（一个 XML，描述了几百个子仓库的位置），几秒到十几秒完成。完成后目录下会出现一个 `.repo/`。

如果提示要选颜色、登录信息，按提示随便填，不影响。

### repo sync：真正拉代码

```bash
repo sync -c -j8
```

参数解释：

- `-c`：只拉当前分支，不拉其他分支的冗余数据，**能省一大半流量**。这个不加上，几百个仓库全分支都拉一遍，磁盘和网络双爆。
- `-j8`：8 个并发，相当于同时开 8 条线拉。Apple Silicon 上 `-j8` 到 `-j16` 都行，看网络和 CPU。

### 实测速度和耗时

清华镜像国内直连，挂校园网或千兆宽带能稳定跑到 **75MB/s** 左右。196GB 的量，理想情况算下来 45 分钟左右，实际因为小文件多、有些仓库冷门，**1～2 小时**比较常见。挂着别管它，去喝杯咖啡。

中途看不到进度别慌，repo 输出不太友好，可以通过 `.repo/` 目录的大小增长来判断在动。

## 拉取过程中常见的坑

### 网络断了

最常见。家里网络抖一下、笔记本合盖睡眠、Wi-Fi 切换，repo sync 就中断了。

**好消息**：repo sync 支持断点续传。直接重跑一遍就行：

```bash
repo sync -c -j8
```

它会跳过已经拉完的仓库，只继续没拉完的。不用清缓存、不用删东西。

### 某个项目损坏：unsupported checkout state

报错大概长这样：

```
error: in sync -c -j8
fatal: unsupported checkout state
```

通常是某个子仓库被中断时 git 状态乱了。处理方法：

```bash
# 进到出问题的那个项目目录（repo 会告诉你哪个）
cd 出问题的项目路径

# 重置干净
git checkout .
git clean -fdx

# 或者更狠的，直接删掉整个目录，让 repo 重新拉
cd ..
rm -rf 出问题的项目目录

# 重新 sync
repo sync -c -j8 项目名
```

最后那条命令可以只 sync 指定项目，不用整棵树重来。

### repo: fatal: Cannot fetch ... (SecurityHook)

偶尔会撞到 git 的安全钩子。临时放开：

```bash
git config --global --add safe.directory '*'
```

### macOS 文件系统大小写不敏感

这个坑比较隐蔽。macOS 默认的 APFS 是**大小写不敏感**（case-insensitive），而 AOSP 里有些文件名只在大小写上有区别（比如 `Utils.java` 和 `utils.java`）。在 Linux 上没事，在 macOS 上 checkout 时一个会覆盖另一个，编译就出怪问题。

**解决方案**：建一个大小写敏感的稀疏磁盘映像，把 AOSP 放里面。

用磁盘工具（Disk Utility）建：

1. 选 "APFS（区分大小写）" 格式
2. 大小给 400GB 起
3. 挂载到 `/Volumes/AOSP`

或者命令行：

```bash
# 创建一个稀疏 bundle，大小写敏感 APFS
hdiutil create -size 400g -type SPARSEBUNDLE -fs "Case-sensitive APFS" -volname AOSP ~/aosp.sparsebundle

# 挂载
hdiutil attach ~/aosp.sparsebundle

# 之后源码都拉到 /Volumes/AOSP 下
```

注意：稀疏映像是按需扩展的，建 400G 不会立刻占满 400G，但随着写入会持续长大，**别让它撑爆宿主盘**。

### 耗时太久、卡住不动

如果是某个仓库卡半天，可以单独跳过它继续拉别的：

```bash
# 跳过失败项继续
repo sync -c -j8 --fail-fast=no
```

或者降低并发，避开网络拥塞：

```bash
repo sync -c -j4
```

并发不是越高越好，太高反而触发服务器限流。

## 拉完后的目录结构

sync 完，进到根目录 `ls` 一下，大概长这样：

```
art/       build/     cts/       dalvik/    developers/
development/  device/   external/  frameworks/  hardware/
libcore/   libnativehelper/  packages/  pdk/      platform_testing/
prebuilts/ sdk/       system/    test/      toolchain/
out/       .repo/
```

几个重点目录：

### frameworks/base

**Framework 源码**，整个 Android 最核心的代码就在这。`Activity`、`Service`、`WindowManager`、`PackageManager` 这些类的实现全在这。读源码、改系统行为，基本都在这个目录里转。Java + native 混合，子目录按 `core/java`、`services`、`base` 这样分。

### packages/apps/Launcher3

**系统应用源码**。`packages/apps/` 下都是出厂自带 App：`Launcher3`（桌面）、`Settings`（设置）、`SystemUI`（状态栏、通知中心）、`Camera2` 等。想自己编译定制系统应用，改的就是这些。

### out/

**编译产物目录**。刚拉完是空的（或不存在），等执行 `m` 编译后才会生成。里面是 `out/target/product/`，最终生成 `system.img`、`boot.img` 这些刷机镜像。前面说的 100G+ 编译产物就堆在这。

**别手动改 out/ 下的东西**，`m clean` 一键清空重建比手动删安全。

### .repo/

**repo 元数据**。包括 manifest、所有子仓库的 git 对象库（git fetch 先拉到这，再 checkout 到工作区）、repo 自身。这个目录是断点续传的基础，删了就得从头再来，**务必保留**。

### 其他常见目录

- `system/`：底层核心服务、`init`、`vold`、`SurfaceFlinger` 的源码。
- `hardware/`：HAL 层，硬件抽象接口。
- `external/`：第三方开源依赖，比如 OpenSSL、SQLite、Skia。
- `prebuilts/`：预编译好的工具链（JDK、clang 等），编译时直接用。

## 拉完之后

源码到手只是第一步。下一步通常是配编译环境（装 OpenJDK、设 `lunch` 选 target），然后 `m` 全量编译。那又是另一个大坑，Apple Silicon 上编 AOSP 还得用 `arm64` 的 target，x86 的 target 跑不动，这些留到下一篇再写。

现在先把源码稳稳拉下来，能 grep、能看、能跳转，已经够啃好一阵子了。
