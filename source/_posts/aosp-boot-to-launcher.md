---
title: 从按下开机键到桌面出现：Android 系统启动全流程深度解析（AOSP android-16.0.0_r4）
category: client
platform: android
tags: ["AOSP", "Android", "系统启动", "init", "Zygote", "SystemServer", "Launcher", "源码"]
readTime: 45分钟
featured: true
date: 2026-08-02
---

# 从按下开机键到桌面出现

你按下手机电源键的那一刻，背后发生了一场精密的多进程接力赛。从 BootROM 里的硬件初始化，到 Linux 内核加载，再到 init 进程拉起整个 Java 世界，最后 Launcher 把图标画到屏幕上——整个过程不到 30 秒，却涉及上百个源码文件、十几个进程、两次关键的进程 fork。

这篇文章基于 **AOSP android-16.0.0_r4** 源码，把整条链路拆成 7 个阶段，每一步都给出源码文件路径和关键代码段。读完你就能回答面试官那个经典问题："从开机到 Launcher 启动，中间发生了什么？"

## 全局视角：一张图看懂 7 个阶段

![Android 系统启动架构图](https://soycodetrail.top/images/aosp-boot/aosp-boot-architecture.png)

上图是整个启动链路的分层架构。从下到上：硬件层（BootROM/Bootloader/Kernel）→ native 层（init/Zygote）→ Java 系统服务层（SystemServer/AMS/PMS/WMS）→ 应用层（Launcher）。层与层之间通过 fork 或 IPC 传递控制权。

下面是完整的调用时序图，配合正文逐步阅读：

![Android 系统启动时序图](https://soycodetrail.top/images/aosp-boot/aosp-boot-sequence.png)

核心类关系图（点击可放大）：

![Android 启动核心类关系图](https://soycodetrail.top/images/aosp-boot/aosp-boot-classes.png)

文字版流程概览：

```
[电源键] → ① BootROM → ② Bootloader → ③ Linux Kernel
                                              ↓
④ init 进程（native，PID=1）
    ├── 解析 init.rc → 启动ServiceManager / SurfaceFlinger / Zygote
    ↓
⑤ Zygote 进程（app_process，Java 运行时）
    ├── 预加载系统类和资源（preload）
    ├── fork 出 system_server
    ↓
⑥ SystemServer（PID=约 400，Java 世界的大管家）
    ├── 启动 AMS / PMS / WMS 等几十个核心服务
    ├── 注册到 ServiceManager
    ├── 通知 AMS："系统启动好了，开桌面"
    ↓
⑦ ActivityTaskManager.startHomeActivity()
    └── Launcher（用户看到的桌面）
```

下面逐阶段展开。

---

## 阶段一：BootROM —— 硬件层面的第一棒

**源码位置**：芯片厂商私有，不开源（高通/联发/海思各自实现）

按下电源键，CPU 上电，硬连逻辑把 PC 寄存器指向一块固化在芯片里的 ROM（BootROM）。这块 ROM 芯片出厂就写死了，干的事很有限：

1. **初始化 CPU 核心**——配置时钟频率、关 MMU、设栈指针
2. **初始化最小内存**——只点亮 RAM 控制器，够用就行
3. **校验并加载 Bootloader**——从 eMMC/UFS 的特定分区（bootloader 分区）把 Bootloader 读进 RAM，跳过去执行

BootROM 阶段通常只有几十毫秒，屏幕还是黑的。如果校验失败（比如 Bootloader 被篡改），芯片不会往下走——这就是" secure boot"链的第一道关卡。

> **面试话术**：BootROM 是固化在 SoC 内部的只读代码，负责硬件最小系统初始化和 Bootloader 加载。它芯片出厂就定了，用户改不了，是安全启动信任链的根。

---

## 阶段二：Bootloader（U-Boot / aboot / LK）—— 选系统、加载内核

**源码位置**：`vendor/qcom/opensource/bootloader/` 或 `device/<oem>/bootloader/`（厂商私有，部分基于 U-Boot / LK 开源）

Bootloader 是 BootROM 加载的第二段代码，运行在 RAM 里。它做的事比 BootROM 多得多：

### 1. 硬件外设初始化

把 BootROM 没初始化的外设全补上：串口（调试用）、USB（fastboot 救砖用）、屏幕（显示启动 logo）、eMMC/UFS 控制器（读系统分区）。

这一步你会看到手机屏幕亮起，显示厂商 logo——比如荣耀显示"HONOR"。这个 logo 不是 Android 画的，是 Bootloader 直接往 framebuffer 写的位图。

### 2. 读取启动参数，决定从哪个分区启动

Android 用 **A/B 分区**（slot A / slot B）。Bootloader 读 misc 分区里的 `boot_control` 标记，决定从哪个 slot 启动。如果上次 OTA 升级后启动失败，下次自动切到旧 slot——这就是"无缝升级"的底层保障。

### 3. 加载 Linux 内核

Bootloader 从 boot 分区把内核镜像（`Image.gz` / `Image.gz-dtb`）和 initramfs（`ramdisk.img`）读进 RAM 的特定地址，然后：

```
// 伪代码：Bootloader 最后干的事
boot_img = read_partition("boot_a")        // 读 boot 分区
decompress_and_load(kernel, 0x80008000)    // 内核加载到物理地址
load_dtb(device_tree_blob)                  // 加载设备树
jump_to(0x80008000)                         // 跳进内核入口
```

跳转的那一瞬间，BootROM → Bootloader → Kernel 的接力完成第一程。控制权交给 Linux。

> **面试话术**：Bootloader 负责硬件外设初始化、启动槽位选择（A/B 分区）、内核和 ramdisk 加载。它最后一条指令就是跳进内核入口地址，从此 CPU 进入 Linux 内核的 `head.S` 汇编。

---

## 阶段三：Linux Kernel —— 老牌 Linux 内核的初始化

**源码位置**：`kernel/common/`（Android 通用内核）+ `kernel/msm-5.15/` 等厂商内核分支

内核启动流程和桌面 Linux 几乎一样，Android 只是在末尾加了点东西：

### 1. 汇编初始化（`head.S`）

CPU 进内核入口后，先跑一段汇编：
- 开 MMU、配页表
- 初始化中断控制器
- 跳到 C 代码 `start_kernel()`

### 2. `start_kernel()`（`init/main.c`）

这是所有 Linux 内核启动的总入口，做硬件子系统初始化：
- 内存管理（`mm_init()`）
- 调度器（`sched_init()`）
- 中断（`init_IRQ()`）
- 设备驱动（`do_initcalls()`，按级别跑所有 `module_init`）
- 挂载 rootfs

### 3. 关键差异：挂载 initramfs 并启动 init

桌面 Linux 这里会挂 ext4 根分区，Android 不一样——内核挂的是 **initramfs**（一个塞在内核镜像尾部的 cpio 压缩包），挂到根目录 `/`。然后内核找 init 可执行文件：

```c
// init/main.c 里的 run_init_process
if (!run_init_process("/system/bin/init"))     // Android 12+ 的 init 路径
    return 0;
if (!run_init_process("/init"))                 // 老版本路径
    return 0;
```

Android 的 init 在 `/system/bin/init`（AOSP 12+ 起从 `/init` 移过来）。内核 fork 出 init 进程（PID=1），从此进入 **Android 用户空间**——这是 Linux 世界到 Android 世界的分水岭。

> **新手理解**：内核启动到 `start_kernel` 末尾会找 init 进程来跑。Android 的 init 是 `/system/bin/init`，它是个 C++ 编译出来的可执行文件，不是脚本。

---

## 阶段四：init 进程 —— Android 的"始祖进程"

**源码位置**：`system/core/init/main.cpp` + `system/core/init/init.cpp`

init 是 Android 用户空间的根。它是 PID=1，所有其他 Android 进程都直接或间接从它 fork。init 干 4 件大事：

### 1. 第一阶段初始化（First Stage Init）

`main.cpp` 的 `main()` 第一次被调用时干这个：

```cpp
// system/core/init/main.cpp
int main(int argc, char** argv) {
    if (argc > 1) {
        if (strcmp(argv[1], "subcontext") == 0) { ... }
        else if (strcmp(argv[1], "selinux_setup") == 0) {
            return SetupSelinux(argv);   // 第三阶段：SELinux
        }
        else if (strcmp(argv[1], "second_stage") == 0) {
            return SecondStageMain(argc, argv);  // 第二阶段
        }
    }
    return FirstStageMain(argc, argv);   // 默认：第一阶段
}
```

FirstStageMain 干硬件相关的事：挂载 `/dev`、`/proc`、`/sys`，创建设备节点。然后它会重新 exec 自己，参数是 `selinux_setup`，配 SELinux 策略，然后再 exec 一次 `second_stage` 进入第二阶段。

这种"自我 exec 多次"的设计是为了 SELinux 域切换——每个阶段在不同的 SELinux 上下文里。

### 2. 第二阶段初始化（Second Stage Init）

`init.cpp` 的 `SecondStageMain()` 是真正的"Android init"：

- **读取 `.rc` 文件**：`/system/etc/init/hw/init.rc` 是主配置，里面定义了"启动哪些服务进程"
- **启动属性服务**：`property_service`（管理 `ro.build.fingerprint` 这些系统属性）
- **执行 Action / 触发 Trigger**：按 oneshot / on boot / on post-fs-data 等时机执行命令

### 3. init.rc —— 用文本声明要启动的服务

`init.rc` 是 init 的"剧本"，语法像这样：

```
# init.rc 片段（简化）
service zygote /system/bin/app_process -Xzygote /system/bin --zygote --start-system-server
    class main
    socket zygote stream 660 root system
    onrestart write /sys/android_power/request_state wake

service surfaceflinger /system/bin/surfaceflinger
    class core
    onrestart restart zygote

service servicemanager /system/bin/servicemanager
    class core
```

init 解析这些行，把每个 `service` 注册成一个待启动的服务，按 `class` 分组（`core` 先启动，`main` 后启动）。

### 4. 关键服务：servicemanager / surfaceflinger / zygote

init 启动的几百个服务里，启动链路最关键的三个：

| 服务 | 源码 | 角色 |
|---|---|---|
| **servicemanager** | `frameworks/native/cmds/servicemanager/` | Binder 名字服务，所有 IPC 都靠它找服务 |
| **surfaceflinger** | `frameworks/native/services/surfaceflinger/` | 图形合成器，把多个 Layer 合成一帧画面 |
| **zygote** | `frameworks/base/core/jni/` | Java 进程孵化器，所有 app 进程从它 fork |

这三个就绪后，init 触发 `zygote-start` trigger，Zygote 开始干活。

> **新手理解**：init 是个"剧本执行器"，读 init.rc 里写的 service 声明，按顺序 fork 出这些服务进程。`app_process` 命令行带 `--zygote` 参数时，跑的就是 ZygoteInit.java。

---

## 阶段五：Zygote 进程 —— Java 世界的孵化器

**源码位置**：`frameworks/base/core/java/com/android/internal/os/ZygoteInit.java`

Zygote 是 Android 性能优化的精髓。它的核心思想：**App 进程预初始化太慢，不如先初始化好一个"母体"进程，每个 App 从母体 fork 出来，瞬间得到完整的 Java 运行时**。

### 1. Zygote 的启动入口

init 启动的 `app_process` 命令：

```
/system/bin/app_process -Xzygote /system/bin --zygote --start-system-server
```

`app_process` 的 `main()`（`frameworks/base/cmds/app_process/app_main.cpp`）看到 `--zygote` 参数，跳到 Java 世界的 `ZygoteInit.main()`。

### 2. ZygoteInit.main() 干 4 件事

```java
// ZygoteInit.java（简化）
public static void main(String[] argv) {
    preload(bootClassPath, appDir);   // ① 预加载
    gcAndFinalize();                   // ② GC
    if (startSystemServer) {
        forkSystemServer(...);          // ③ fork system_server
    }
    runSelectLoop(abiList);             // ④ 进入循环等 fork 请求
}
```

#### ① preload：预加载类和资源

```java
// ZygoteInit.java
static void preload(TimingsTraceLog bootTrace) {
    preloadClasses();      // 加载 preloaded-classes（几千个系统类）
    preloadResources();    // 加载 preloaded-drawable 等
    preloadOpenGL();       // 初始化 OpenGL
    preloadSharedLibs();   // 加载 android.so 等共享库
    preloadTextResources();
}
```

`preloaded-classes` 文件在 `frameworks/base/preloaded-classes`，列了几千个常用类（Activity、View、Context 这些）。这一步耗时 1-3 秒，但**只做一次**——之后 fork 出来的 App 进程直接继承这份内存（COW）。

这是 Android 启动"虽然慢但 App 打开快"的根本原因：fork 是内存复制（页表复制），实际的物理内存页是共享的，直到某一方写才真正复制（Copy-On-Write）。

#### ② forkSystemServer：fork 出大管家

```java
// ZygoteInit.java
private static Runnable forkSystemServer(...) {
    // 用 Zygote.forkSystemServer 系统调用 fork
    int pid = Zygote.forkSystemServer(...);
    if (pid == 0) {
        // 子进程：system_server
        return handleSystemServerProcess(parsedArgs);
    }
    return null;
}
```

`Zygote.forkSystemServer()` 是 native 方法（`frameworks/base/core/jni/com_android_internal_os_Zygote.cpp`），底层调 `fork()`。子进程 return 后跑 `handleSystemServerProcess()`，最终跳到 `SystemServer.main()`。

#### ③ runSelectLoop：等待 fork 请求

```java
// ZygoteInit.java
private static void runSelectLoop(String abiList) {
    while (true) {
        // 监听 Zygote Socket
        int fd = Os.poll(fds, -1);
        if (fd == ZYGOTE_SOCKET) {
            ZygoteConnection conn = acceptCommandPeer(abiList);
            // 读请求：谁要 fork 一个新进程？
            Runnable forkResult = conn.processOneCommand(this);
        }
    }
}
```

Zygote 监听一个 Unix Domain Socket（`/dev/socket/zygote`），AMS 想启动新 App 时，写一个 fork 请求到这个 socket。Zygote 收到就 fork 一个新进程返回 PID。这就是 Zygote 的核心循环，整个手机生命周期都在这里跑。

> **面试话术**：Zygote 预加载了系统类和资源，作为所有 App 进程的"母体"。AMS 通过 Zygote Socket 发 fork 请求，Zygote fork 出新进程，新进程继承预加载的内存（COW），秒级得到完整 Java 运行时。这是 Android 进程启动快的根本原因。

---

## 阶段六：SystemServer —— Java 世界的核心

**源码位置**：`frameworks/base/services/java/com/android/server/SystemServer.java`

SystemServer 是 Android 的"大管家"。它启动几乎所有系统服务（AMS、PMS、WMS、IMS 等），每个 App 都离不开它。它从 Zygote fork 出来，但拥有特殊权限。

### 1. SystemServer.main() 的三阶段

```java
// SystemServer.java
public static void main(String[] args) {
    new SystemServer().run();
}

private void run() {
    // 阶段 1：初始化运行时
    System.loadLibrary("android_servers");          // 加载 native 服务
    Looper.prepareMainLooper();                       // 准备主线程消息队列
    SystemServiceManager ssm = mSystemServiceManager;

    // 阶段 2：启动核心服务
    startBootstrapServices();    // 引导服务（先启动，其他依赖它们）
    startCoreServices();         // 核心服务
    startOtherServices();        // 其他服务（最多最重）

    // 阶段 3：进入主循环
    Looper.loop();               // 永远不返回，处理消息
}
```

### 2. startBootstrapServices：必须最先启动的服务

```java
private void startBootstrapServices() {
    // Installer —— 跟 installd 通信装 App
    Installer installer = mSystemServiceManager.startService(Installer.class);

    // ActivityManagerService —— 大总管
    ActivityTaskManagerService atm = mSystemServiceManager.startService(
        ActivityTaskManagerService.Lifecycle.class).getService();
    mActivityManagerService = mSystemServiceManager.startService(
        ActivityManagerService.Lifecycle.class).getService();

    // PackageManagerService —— 管理所有已安装 App
    mPackageManagerService = mSystemServiceManager.startService(
        PackageManagerService.Lifecycle.class).getService();

    // 把 AMS 注册到 ServiceManager，让 Binder 客户端能找到
    mActivityManagerService.setSystemProcess();
}
```

启动顺序很重要：PMS 必须在 AMS 之前（AMS 要查已安装的 App 信息），WMS 必须在 AMS 之后（AMS 要管理 Activity 栈，栈里的 Activity 要靠 WMS 渲染）。

### 3. startOtherServices：启动几百个服务

```java
private void startOtherServices() {
    // WindowManagerService
    wm = WindowManagerService.main(context, inputManager, ...);
    ServiceManager.addService(Context.WINDOW_SERVICE, wm);

    // InputManagerService —— 触摸/按键事件分发
    inputManager = new InputManagerService(context);

    // PowerManagerService、DisplayManagerService、LocationManagerService...
    // 几十个服务依次注册到 ServiceManager

    // ★★ 关键：所有服务就绪后，调用 AMS 启动 Home（Launcher）
    mActivityManagerService.systemReady(() -> {
        // 所有服务 ready 回调里
    }, bootTimer);
}
```

`systemReady()` 是 SystemServer 启动的关键转折点。它在所有服务就绪后调用，意味着"系统底层全搭好了，可以开桌面了"。

### 4. systemReady() 内部触发 Launcher

```java
// ActivityManagerService.java
public void systemReady(final Runnable goingCallback, TimingsTraceLog traceLog) {
    // ... 各种就绪检查 ...
    startHomeActivityLocked(currentUserId, "systemReady");
    // 上面这行就是启动 Launcher 的入口
}

boolean startHomeActivityLocked(int userId, String reason) {
    // 构造 Launcher 的 Intent
    Intent homeIntent = new Intent(mTopAction, mHomeData != null ? mHomeData.getData() : null);
    homeIntent.addCategory(Intent.CATEGORY_HOME);
    // 通过 ATMS 启动这个 Activity
    mActivityTaskManager.startHomeActivity(homeIntent, ...);
}
```

`Intent.CATEGORY_HOME` 是关键——系统会找到声明了这个 category 的 Activity（就是 Launcher），把它的进程 fork 出来，显示桌面。

> **新手理解**：SystemServer 是个"服务启动器"，依次拉起几十个系统服务并注册到 ServiceManager。最后调 `AMS.systemReady()`，里面调 `startHomeActivityLocked()` 启动 Launcher——这就是用户看到桌面出现的瞬间。

---

## 阶段七：Launcher —— 桌面终于出现

**源码位置**：`packages/apps/Launcher3/src/com/android/launcher3/Launcher.java`

AMS 启动 Launcher 的流程和普通 App 一样：

1. **AMS 通过 Zygote Socket 请求 fork**：AMS 发消息给 Zygote，要 fork 一个新进程
2. **Zygote fork 出 Launcher 进程**：进程名通常叫 `com.android.launcher3`（或厂商定制的名字）
3. **新进程加载 Launcher APK**：ActivityThread 主循环跑起来
4. **Launcher Activity 走 onCreate**：

```java
// Launcher.java
@Override
protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    // 初始化 LauncherModel，加载桌面图标数据
    LauncherAppState app = LauncherAppState.getInstance(this);
    // 创建 Workspace、CellLayout 等核心 View
    setupViews();
    // 显示桌面
    showHome();
}
```

桌面图标数据从 PMS（PackageManagerService）查——PMS 扫描所有已安装 App 的 manifest，找出带 `MAIN` + `LAUNCHER` intent-filter 的 Activity，返回图标列表。Launcher 把它们布局到 Workspace 上，绘制到 SurfaceFlinger 的 Layer 上。

**用户看到桌面图标的那一刻，整个启动流程结束**。从按下开机键到这里，通常 15-30 秒。

---

## 关键时间线汇总

| 阶段 | 典型耗时 | 关键源码 |
|---|---|---|
| BootROM + Bootloader | 2-5 秒 | 厂商私有 |
| Linux Kernel | 1-2 秒 | `kernel/common/init/main.c` |
| init（native） | 1-2 秒 | `system/core/init/main.cpp` |
| Zygote preload | 2-5 秒（最慢） | `ZygoteInit.java` 的 `preload()` |
| SystemServer 启动服务 | 3-8 秒 | `SystemServer.java` |
| Launcher 加载 | 1-2 秒 | `Launcher3/Launcher.java` |
| **总计** | **10-25 秒** | |

---

## 进程关系总览：谁 fork 谁

```
init (PID=1, native)
├── servicemanager     ← init fork
├── surfaceflinger     ← init fork
└── zygote             ← init fork
    └── system_server (PID≈400)     ← zygote fork
        └── （触发）Launcher 进程    ← zygote fork（AMS 转发请求）
            └── （触发）所有 App 进程 ← zygote fork
```

记住一条铁律：**Android 上所有 Java 进程都从 Zygote fork**。init 自己不 fork Java 进程，它只 fork 出 Zygote 这一个"母体"，之后所有 Java 进程都从 Zygote 出来。

---

## 面试高频追问

**Q1：为什么不直接用 fork 启动 App，非要 Zygote？**
fork 本身不慢，慢的是 fork 之后还要初始化 ART 虚拟机、加载系统类、初始化 GUI 框架。Zygote 把这些只做一次，fork 出来的子进程瞬间继承完整的运行时。

**Q2：Zygote fork 用 fork() 还是 vfork()？**
AOSP 早期讨论过，最终用 `fork()`（不是 vfork）。fork 在 Linux 是 COW 的，性能足够；vfork 限制太多（子进程不能 return、不能写内存），不适合 Java 场景。

**Q3：SystemServer 为什么不直接由 init 启动，要从 Zygote fork？**
SystemServer 是 Java 进程，需要 ART 运行时。从 Zygote fork 出来直接就有预加载好的运行时，省几秒。而且 SystemServer 要跟所有 App 进程通过 Binder 通信，Binder 的句柄需要一致——Zygote 预加载的 Binder 服务引用被所有子进程共享。

**Q4：init.rc 里 zygote 那行的 `socket zygote stream` 是干嘛的？**
创建 `/dev/socket/zygote` 这个 Unix Domain Socket 文件。AMS 通过这个 socket 向 Zygote 发 fork 请求。

**Q5：怎么知道启动到哪一步卡住了？**
看 `dmesg`（内核日志）+ `logcat -b system`（系统日志）+ `dmesg | grep init`（init 阶段）。Bootloader 阶段看屏幕（厂商 logo 出现说明 Bootloader 跑过了），或者用串口。

---

## 总结

整条启动链是一条**自底向上的接力**：

1. 硬件（BootROM）→ 引导（Bootloader）→ 内核（Linux Kernel）
2. native 世界（init）拉起三个根服务：servicemanager / surfaceflinger / **zygote**
3. Java 世界的"母体" **Zygote** 预加载系统资源，fork 出 **SystemServer**
4. SystemServer 启动几十个系统服务（AMS/PMS/WMS...），最后调 **AMS.systemReady()**
5. AMS 通过 Zygote Socket 请求 fork **Launcher** 进程，桌面出现

每个阶段的源码位置都标出来了。配合文章配套的**时序图**和**类图**，你可以顺着调用链一步步在 AOSP 源码里跟读。

理解这条链路，不仅是面试必备，也是排查启动慢、开机黑屏、Launcher 崩溃等问题的基础。
