---
title: AOSP 源码阅读环境配置：Android Studio 跳转 + VSCode clangd 双工具链
category: client
platform: android
tags: ["AOSP", "Android Studio", "VSCode", "clangd", "源码"]
readTime: 20分钟
featured: true
date: 2026-07-28
---

AOSP 全量源码 200 万个文件，光 `frameworks/base` 一个目录就几十万行 Java，`frameworks/native` 又是几十万行 C++。指望一个 IDE 把 Java、Kotlin、C++、aidl 全部索引到位，目前没有工具能做到。

实战中配两套环境才说得通：

- **Android Studio（AS）**：读 Java/Kotlin 源码，主要看 `frameworks/base`、`packages/apps/*`、SystemUI 这种上层逻辑
- **VSCode + clangd**：读 C/C++ 源码，主要看 `frameworks/native`、`art/`、`system/` 这种底层实现

为什么要分两套？因为 JNI 代码经常是 Java 声明一个 `native` 方法，实现在某个 `.cpp` 里。AS 看到 `native void foo()` 就跳不动了，得切到 VSCode 用 clangd 跳到对应 C++ 函数。两个工具各管一半，配合着用才读得顺。

下面把配置全流程走一遍，每一步把会踩的坑都标出来。

## Part 1：先理清分工

| 工具 | 管什么 | 不管什么 |
|------|--------|----------|
| Android Studio | Java / Kotlin 跳转、符号查找 | C/C++（跳不动） |
| VSCode + clangd | C/C++ 跳转、头文件、宏展开 | Java（不是它的活） |

JNI 链路典型场景：在 AS 里读到 `ActivityManagerService` 调了个 native 方法，比如 `android.os.Binder.execTransact`，Java 这边到 `android_util_Binder.cpp` 的注册函数就断了。这时复制方法名到 VSCode 全局搜，用 clangd 接着跳 C++ 实现。

两套环境互不干扰，配置文件也分开（AS 的 `.iml` 在源码根，clangd 的 `compile_commands.json` 也在源码根，但用途完全不同）。

## Part 2：Android Studio 配置（Java/Kotlin 跳转）

### 2.1 idegen 生成项目文件

AOSP 自带一个工具叫 `idegen`，专门给 IntelliJ/AS 生成项目描述文件。

在编译过的 AOSP 树里（注意：**必须先编译过**，至少 `m` 跑过一次，否则 idegen 会缺依赖报错）执行：

```bash
# 进编译环境
source build/envsetup.sh
lunch sdk_gphone64_x86_64-trunk_staging-userdebug

# 单编 idegen
m idegen

# 生成 IDE 项目文件
development/tools/idegen/idegen.sh
```

跑完会在 AOSP 根目录生成两个文件：

- `android.ipr` —— IntelliJ 项目文件，AS 用它打开项目
- `android.iml` —— 模块定义，里面列了 7352 个 `sourceFolder` 和 1003 个 `module-library`（依赖 jar）

这俩文件是 AS 索引 200 万文件的依据。少了任何一个，AS 都只会扫到一小撮文件。

**坑：直接跑 `idegen.sh` 报 ClassNotFoundException**

原因：没先 `m idegen`。idegen.sh 调的是 `java -classpath out/target/.../idegen.jar`，这个 jar 是 `m idegen` 产物，没编就没有。先 `m idegen` 再跑脚本。

### 2.2 用 android.ipr 打开项目（不是 open 目录）

AS 打开项目有两种方式，**一定用第一种**：

- 正确：`File → Open → 选 android.ipr 文件`
- 错误：`File → Open → 选 AOSP 根目录`

为什么不能直接 open 目录？因为 AS 直接 open 一个目录时，会用自带的项目向导重新生成一个空壳 `.iml`（通常叫 `aosp-r4.iml` 或目录名），里面 sourceFolder 一个都没有，扫出来就 4 万个文件，跳转全废。

用 `android.ipr` 打开，AS 会读 `android.iml` 里那 7352 个 sourceFolder，把整个源码树纳入索引。

打开后 AS 开始扫描 200 万文件，**首次索引要几小时**（看机器，M3 Pro 大概 2~3 小时）。进度条在右下角，期间 CPU 拉满，别关 AS。

### 2.3 关键配置坑（两个必须改）

这俩坑不踩，跳转永远坏。挨个讲透。

#### 坑一：modules.xml 必须指向 android.iml

AS 用 `.idea/modules.xml` 记录项目包含哪些模块。idegen 不会生成这个文件，AS 第一次打开 `.ipr` 时会自己创建一个，但创建出来的内容是这样的：

```xml
<!-- .idea/modules.xml（错误示范）-->
<project version="4">
  <component name="ProjectModuleManager">
    <modules>
      <module fileurl="file://$PROJECT_DIR$/aosp-r4.iml" filepath="$PROJECT_DIR$/aosp-r4.iml" />
    </modules>
  </component>
</project>
```

这个 `aosp-r4.iml` 是 AS 现造的空壳，0 个 sourceFolder。结果就是 AS 只扫到 4 万个文件（AOSP 根目录直接可见的那点），`frameworks/base` 下的类全跳不动。

**正确做法**：手动把 `modules.xml` 改成指向 idegen 生成的 `android.iml`：

```xml
<!-- .idea/modules.xml（正确）-->
<project version="4">
  <component name="ProjectModuleManager">
    <modules>
      <module fileurl="file://$PROJECT_DIR$/android.iml" filepath="$PROJECT_DIR$/android.iml" />
    </modules>
  </component>
</project>
```

改完重启 AS，让它重新加载模块。

#### 坑二：项目 SDK 必须设 No SDK

`File → Project Structure → Project → SDK`，**一定要选 No SDK**，不要选 Android API 36 Platform。

为什么？AOSP 源码是自包含的，`frameworks/base/core/java/android/app/ActivityManagerService.java` 就是真实实现，源码就在树里。如果项目 SDK 设成 Android API 36，AS 解析符号时会优先走 SDK 的 `android.jar`——而这个 jar 只是 API stub，只有方法签名没有实现。跳转就会跳到 `.class` 文件（反编译的签名），而不是 `.java` 源码。

设成 No SDK 之后，AS 找不到 SDK 就只能从项目源码里找，跳转就准确了。

#### 怎么排查这两个坑

不确定配没配对，看 AS 的日志：

```
Help → Show Log in Finder
```

打开 `idea.log`，搜 `scanned files` 或者 `indexing`。正常应该看到接近 **200 万**文件的统计。如果只看到 4 万左右，就是 modules.xml 没指对；如果数字够但跳转跳到 `.class`，就是 SDK 没设 No SDK。

### 2.4 AS 内存配置

AOSP 源码量大，AS 默认 2g 堆内存根本不够，索引一半就 OOM。

改 `Android Studio.app/Contents/bin/studio.vmoptions`（或者 `Help → Edit Custom VM Options`）：

```
-Xms2g
-Xmx12g
-XX:ReservedCodeCacheSize=1g
```

为什么不直接给 16g？实测 AS 索引 AOSP 时实际峰值用到 7g 左右，给 12g 已经有 5g 余量。再往上加，AS 不会用，反而占着内存不让别的程序用（比如同时开着的 VSCode clangd）。12g 是性价比最高的值。

改完完全退出 AS（Cmd+Q，不是关窗口）再开。

### 2.5 验证跳转

打开 `frameworks/base/services/core/java/com/android/server/am/ActivityManagerService.java`，光标放到任意一个引用的其他类上（比如 `ActivityManagerService` 里用到的 `ProcessList`），按 **Cmd+B**（或 Cmd+点击）。

- 跳到 `.java` 源码 → 配置成功
- 跳到 `.class`（反编译窗口，左侧没行号或者显示 `// $FF: synthetic`）→ SDK 没设 No SDK，回 2.3 坑二改
- 直接提示 `Cannot find declaration` → 大概率 modules.xml 没指对，scanned files 不够，回 2.3 坑一

## Part 3：VSCode + clangd 配置（C/C++ 跳转）

### 3.1 生成 compile_commands.json

clangd 干活的依据是 `compile_commands.json`——里面记录每个 `.cpp` 文件用什么编译参数、什么 include 路径编译的。有了它 clangd 才能跳转。

AOSP 用 ninja 构建，ninja 自带导出 compdb 的命令。在编译过的 AOSP 树里：

```bash
# 进编译环境
source build/envsetup.sh
lunch sdk_gphone64_x86_64-trunk_staging-userdebug

# 找到 build.ninja 的位置（一般在 out 下）
ninja -C out -t compdb cc cxx > compile_commands.json
```

`-t compdb` 后面的 `cc cxx` 是要导出的规则名（C 和 C++ 编译规则）。导出的文件 **1.2GB，10 万条记录**，直接用 clangd 会卡死。

### 3.2 compdb 优化（必须做，不然 clangd 起不来）

原始 compdb 有两个问题，挨个修。

#### 问题一：directory 路径是 Docker 容器路径

如果在 Docker 里编译（Apple Silicon 上常见做法），compdb 里的 `directory` 字段全是 `/aosp`（容器内路径），但本机 VSCode 看到的路径是 `/Users/soycodetrail/aosp-r4`。clangd 拿着 `/aosp` 路径找不到文件，跳转全废。

写个脚本批量替换：

```python
#!/usr/bin/env python3
# fix_compdb.py
import json

with open('compile_commands.json') as f:
    data = json.load(f)

for entry in data:
    # 容器路径 → 本机路径
    entry['directory'] = entry['directory'].replace('/aosp', '/Users/soycodetrail/aosp-r4')
    entry['file'] = entry['file'].replace('/aosp', '/Users/soycodetrail/aosp-r4')
    # command 里的路径也要换
    entry['command'] = entry['command'].replace('/aosp', '/Users/soycodetrail/aosp-r4')

with open('compile_commands.json', 'w') as f:
    json.dump(data, f)

print(f'fixed {len(data)} entries')
```

```bash
python3 fix_compdb.py
```

#### 问题二：10 万条记录对 clangd 太重

原始 compdb 里大部分是 `out/`（编译中间产物）和 `external/`（第三方库，比如 chromium、llvm）的条目。读 AOSP 源码用不到这些，但 clangd 会一股脑全索引，导致启动卡几分钟，跳转延迟好几秒。

按路径过滤，只留关心的目录：

```python
#!/usr/bin/env python3
# filter_compdb.py
import json

KEEP_PREFIXES = (
    '/Users/soycodetrail/aosp-r4/frameworks/',
    '/Users/soycodetrail/aosp-r4/system/',
    '/Users/soycodetrail/aosp-r4/art/',
    '/Users/soycodetrail/aosp-r4/libnativehelper/',
)

with open('compile_commands.json') as f:
    data = json.load(f)

filtered = [e for e in data if e['file'].startswith(KEEP_PREFIXES)]

with open('compile_commands.json', 'w') as f:
    json.dump(filtered, f)

print(f'{len(data)} → {len(filtered)} entries')
```

```bash
python3 filter_compdb.py
```

10 万条压到 1 万条，文件从 1.2GB 缩到 100MB 出头，clangd 索引快很多。关心的目录按需往 `KEEP_PREFIXES` 里加。

### 3.3 用树内 prebuilt clangd

系统装的 clangd（`brew install llvm` 装的那个）**不要用**。

原因：AOSP 编译用的是树内自带的 clang（`prebuilts/clang/host/darwin-x86/clang-r563880c`），编译时的内置宏、target 三元组、内置 include 路径都和这个 clang 版本绑定。系统 clangd 版本不一致，解析时会报一堆「找不到头文件」「宏未定义」的错。

用树内那个：

```bash
# clangd 在 prebuilts 下，路径形如
PREBUILT_CLANGD=/Users/soycodetrail/aosp-r4/prebuilts/clang/host/darwin-x86/clang-r563880c/bin/clangd

# 验证能跑
$PREBUILT_CLANGD --version
```

具体目录名 `clang-r563880c` 会随 AOSP 版本变，用 `ls prebuilts/clang/host/darwin-x86/` 看实际名字。

### 3.4 .clangd 和 VSCode 配置

在 AOSP 根目录建 `.clangd` 文件，告诉 clangd 编译数据库在哪：

```yaml
# /Users/soycodetrail/aosp-r4/.clangd
CompileFlags:
  CompilationDatabase: /Users/soycodetrail/aosp-r4

# clangd 启动参数
  Add: [-Wall, -Wno-unknown-warning-option]

# 跳过这些目录的文件（避免误索引）
  Remove: [-fsanitize=*]

Index:
  Background: Build

Diagnostics:
  ClangTidy:
    Remove: [*]   # 关掉 clang-tidy 检查，只留跳转，性能好很多

Hover:
  ShowAKA: true

InlayHints:
  Enabled: Yes
```

关键是 `Diagnostics.ClangTidy.Remove: [*]`——读源码不需要 lint，关掉能省一半 CPU。

VSCode 配置（`.vscode/settings.json`，放 AOSP 根目录）：

```json
{
  "clangd.path": "/Users/soycodetrail/aosp-r4/prebuilts/clang/host/darwin-x86/clang-r563880c/bin/clangd",
  "clangd.arguments": [
    "--background-index",
    "--compile-commands-dir=/Users/soycodetrail/aosp-r4",
    "--clang-tidy=false",
    "--header-insertion=never",
    "-j=8"
  ],
  "clangd.checkUpdates": false,
  "C_Cpp.intelliSenseEngine": "disabled",
  "files.exclude": {
    "**/.git": true,
    "**/out": true
  }
}
```

几个要点：

- `clangd.path` 写死成树内 clangd 绝对路径
- `--clang-tidy=false` 关 lint，省 CPU
- `--header-insertion=never` 防止 clangd 自动改代码
- `C_Cpp.intelliSenseEngine: disabled` 必须，否则微软的 C/C++ 插件会和 clangd 打架，占两份内存
- `files.exclude` 把 `out/` 隐藏掉，全局搜索时少一堆噪音

装 VSCode 的 `clangd` 扩展（llvm 出的那个，不是 C/C++ IntelliSense），打开任意 `.cpp`，右下角会显示 clangd 索引进度。

### 3.5 验证 clangd

打开 `frameworks/native/libs/binder/Parcel.cpp`，光标放到某个函数调用上，Cmd+点击。

- 跳到声明 / 定义 → 成功
- 顶上飘红 `Include errors` 或 `file not found` → compdb 路径没修对，回 3.2 问题一
- clangd 一直 `Indexing...` 不结束 → 条目太多没过滤，回 3.2 问题二

## Part 4：常见问题速查

| 现象 | 原因 | 解决 |
|------|------|------|
| AS 跳转全失效，提示找不到声明 | modules.xml 指了空壳 iml，scanned files 只有 4 万 | 改 modules.xml 指向 android.iml（Part 2.3 坑一）|
| AS 跳转跳到 `.class` 反编译窗口 | 项目 SDK 设成了 Android API 36 | Project Structure 里改 No SDK（Part 2.3 坑二）|
| AS 首次打开索引几小时没完 | 正常，200 万文件首次就这么久 | 等，别关 AS；之后再开就快了 |
| AS 频繁 OOM、卡死 | 堆内存太小 | studio.vmoptions 改 -Xmx12g（Part 2.4）|
| clangd 一直 Indexing 不结束 | compdb 条目太多（10 万）| 跑 filter_compdb.py 过滤到 1 万（Part 3.2 问题二）|
| clangd 满屏「file not found」 | compdb 里 directory 是容器路径 | 跑 fix_compdb.py 修路径（Part 3.2 问题一）|
| clangd 报宏未定义、头文件找不到 | 用了系统 clangd，版本不匹配 | 改用树内 prebuilt clangd（Part 3.3）|
| 部分类在 AS 里爆红（比如 `IXxx` 接口）| aidl 生成的 Stub 不在本地，因为没全量编译 | 爆红不影响跳转主体，用全局搜索（Cmd+Shift+F）找定义代替 |
| JNI 链路 Java 跳到一半断掉 | native 方法 AS 跳不动 | 复制方法名切 VSCode 用 clangd 接着跳（Part 1）|

最后那类「aidl Stub 爆红」很常见：比如读 SystemUI 时看到 `IStatusBarService` 报红，因为它是 `IStatusBarService.aidl` 生成的接口，只有全量 `m` 编译过才会生成对应 `.java`。没全量编译就爆红，但不影响读其他代码，遇到时直接全局搜 `IStatusBarService` 找声明位置就行。
