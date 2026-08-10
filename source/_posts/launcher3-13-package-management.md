---
title: Launcher3 源码精读（13）：包管理与安装
category: client
platform: android
tags: ["AOSP", "Launcher3", "源码", "Framework"]
readTime: 21分钟
featured: true
date: 2026-08-02
---

# Launcher3 包管理与安装机制源码精读

桌面 Launcher 不是一座孤岛，它的图标库必须随系统包状态实时变化：装上 App 要出现图标，卸载要消失，更新要刷新，多用户要隔离。Launcher3 把这套"包管理"逻辑收敛在 `com.android.launcher3.pm` 包与若干 `ModelUpdateTask` 中，形成一条"事件来源 → 事件转换 → 模型任务 → 数据库/绑定刷新"的单向流水线。

事件来源有三条：`LauncherApps.Callback`（包增删改、多用户隔离）、`PackageInstaller.SessionCallback`（安装过程进度）、`SessionCommitReceiver`（安装会话提交，提前显示"承诺图标"）。它们都被翻译成统一的 `ModelUpdateTask`，由 `LauncherModel` 在后台线程串行执行，避免 UI 线程并发改库。本文按这条流水线逐层拆解 pm/ 下的真实代码。

---

## 整体架构：三层事件流水线

包管理在 Launcher3 里是一条三段式管道，理解它就理解了全部设计意图。

```java
// 第一层：事件来源（Source）—— 三个独立入口，互不重叠
LauncherApps.Callback          // 监听已安装包的增/删/改/挂起/可用  —— 多用户感知
PackageInstaller.SessionCallback // 监听正在安装的会话进度          —— 安装中
SessionCommitReceiver          // 监听安装会话"提交"瞬间           —— 提前显示图标

// 第二层：事件转换（Adapter）—— ModelLauncherCallbacks 把异构事件归一化
class ModelLauncherCallbacks : LauncherApps.Callback(), InstallSessionTracker.Callback {
    override fun onPackageAdded(packageName: String, user: UserHandle) {
        taskExecutor.accept(PackageUpdatedTask(OP_ADD, user, packageName)) // 转成统一任务
    }
}

// 第三层：模型任务（ModelUpdateTask）—— 后台串行执行，改库 + 触发绑定
class PackageUpdatedTask implements ModelUpdateTask {
    public void execute(ModelTaskController taskController, BgDataModel dataModel, AllAppsList apps) {
        // 真正干活：刷新图标缓存、更新 AllAppsList、删无效快捷方式、绑定回 UI
    }
}
```

为什么要分三层而不是直接在回调里改库？因为回调来自多个线程、多个来源（系统 `LauncherApps` 服务在 binder 线程触发、`PackageInstaller` 在另一组线程触发），如果直接改库会出现竞态。第二层只做"翻译"，把异构事件变成统一的 `ModelUpdateTask` 对象丢进 `LauncherModel` 的任务队列；第三层由 `MODEL_EXECUTOR` 单线程串行消费，天然串行化，无需加锁也能保证一致性。这是典型的"生产者-消费者 + 命令模式"。

`ModelInitializer.initialize()` 是这套管道的装配点，它在 Launcher 进程启动时把三个入口全部挂上：

```kotlin
// ModelInitializer.kt —— 装配事件管道
fun initialize(model: LauncherModel) {
    val modelCallbacks = model.newModelCallbacks()                      // 第二层适配器
    val launcherApps = context.getSystemService(LauncherApps::class.java)!!
    launcherApps.registerCallback(modelCallbacks, MODEL_EXECUTOR.handler) // 注册包回调（第一层入口1）
    lifeCycle.addCloseable { launcherApps.unregisterCallback(modelCallbacks) }

    lifeCycle.addCloseable(installSessionHelper.registerInstallTracker(modelCallbacks)) // 第一层入口2
    // SessionCommitReceiver 是清单注册的广播接收器，独立存在 —— 第一层入口3
}
```

注意 `registerCallback` 第二个参数传的是 `MODEL_EXECUTOR.handler`，意味着 `LauncherApps` 的回调会被投递到模型后台线程，而不是 binder 线程或 UI 线程。这是减少线程跳转的优化，但 `ModelLauncherCallbacks` 内部依然把事件转成 `ModelUpdateTask` 再入队，没有直接在这个 handler 里改库——因为回调可能并发到达，而任务队列是严格 FIFO 的。

### 面试深问

**Q1：为什么 `LauncherApps.Callback` 替代了旧的 `ACTION_PACKAGE_ADDED` 广播？**
旧广播无法区分用户（多用户/工作资料下会泄漏），且系统对所有接收者一视同仁广播，开销大。`LauncherApps` 是专门为 Launcher 设计的 API，回调里直接带 `UserHandle`，天然支持多用户隔离；同时它在系统服务侧聚合，比广播高效。

**Q2：三个事件来源有重叠吗？例如安装完成时 `onPackageAdded` 和 `SessionCallback.onFinished` 会同时触发吗？**
会。`onFinished`（会话结束）先到，它把图标状态置为"已安装/失败"；紧接着 `onPackageAdded`（包真正注册）到，负责把承诺图标转成正式图标、补全 AllAppsList。两者分工不同：前者管"安装会话"的生命周期，后者管"包"的生命周期。`PackageInstallStateChangedTask` 在检测到 `STATUS_INSTALLED` 时直接 return，就是为了把活让给 `onPackageAdded`。

**Q3：任务队列为什么不直接用锁，而要用单线程串行？**
单线程串行是"无锁并发"的一种实现：所有改库操作都在 `MODEL_EXECUTOR` 这一个线程上，天然互斥，不需要 `synchronized`，也就没有死锁、没有锁竞争开销。锁的方案需要每个任务自己管理临界区，容易遗漏；单线程方案把并发控制收敛到调度器一处，对业务代码透明。

---

## App 安装监听：LauncherApps.Callback

### 回调注册与线程模型

Launcher3 不再使用 `PackageInstalledReceiver`（监听 `ACTION_PACKAGE_ADDED/CHANGED/REMOVED` 的 BroadcastReceiver），而是改用 `LauncherApps.Callback`。这是 Android 5.0 引入的、专门给 Launcher 用的 API，核心区别是回调里携带 `UserHandle`，天然感知多用户。

```kotlin
// ModelInitializer.kt —— 注册回调，指定回调线程为模型后台线程
launcherApps.registerCallback(modelCallbacks, MODEL_EXECUTOR.handler)
```

`ModelLauncherCallbacks` 继承自 `LauncherApps.Callback` 并同时实现 `InstallSessionTracker.Callback`，一个类身兼两职，把包事件和安装会话事件都接住：

```kotlin
// ModelLauncherCallbacks.kt —— 包事件适配器
class ModelLauncherCallbacks(private var taskExecutor: Consumer<ModelUpdateTask>) :
    LauncherApps.Callback(), InstallSessionTracker.Callback {

    override fun onPackageAdded(packageName: String, user: UserHandle) {
        FileLog.d(TAG, "onPackageAdded triggered for packageName=$packageName, user=$user")
        taskExecutor.accept(PackageUpdatedTask(OP_ADD, user, packageName))  // 新装：OP_ADD
    }

    override fun onPackageChanged(packageName: String, user: UserHandle) {
        taskExecutor.accept(PackageUpdatedTask(OP_UPDATE, user, packageName)) // 更新：OP_UPDATE
    }

    override fun onPackageRemoved(packageName: String, user: UserHandle) {
        FileLog.d(TAG, "onPackageRemoved triggered for packageName=$packageName, user=$user")
        taskExecutor.accept(PackageTaskFactory.appsRemoved(user, setOf(packageName))) // 卸载
    }

    override fun onPackagesAvailable(vararg packageNames: String, user: UserHandle, replacing: Boolean) {
        taskExecutor.accept(PackageUpdatedTask(OP_UPDATE, user, *packageNames)) // SD卡插回/可用
    }

    override fun onPackagesUnavailable(packageNames: Array<String>, user: UserHandle, replacing: Boolean) {
        if (!replacing) {  // 不是替换（升级）才标不可用；升级中保留图标
            taskExecutor.accept(PackageTaskFactory.appsUnavailable(user, packageNames.toSet()))
        }
    }

    override fun onPackagesSuspended(vararg packageNames: String, user: UserHandle) {
        taskExecutor.accept(PackageTaskFactory.appsSuspended(user, packageNames.toSet())) // 挂起变灰
    }

    override fun onPackagesUnsuspended(vararg packageNames: String, user: UserHandle) {
        taskExecutor.accept(PackageTaskFactory.appsUnsuspended(user, packageNames.toSet())) // 解除挂起
    }
}
```

注意 `onPackagesUnavailable` 里对 `replacing` 的判断：当 App 正在更新时，系统会先发 unavailable 再发 available，`replacing=true`。Launcher 此时不应把图标标灰，因为马上就会回来，避免图标闪烁。只有真正不可用（如 SD 卡拔出）且 `replacing=false` 才置 `FLAG_DISABLED_NOT_AVAILABLE`。这是一个用户体验细节，但体现了对系统广播语义的精确理解。

### 装上/卸载后怎么触发数据刷新

`taskExecutor` 实际上是 `LauncherModel::enqueueModelUpdateTask` 的引用。任务进队后由 `MODEL_EXECUTOR` 串行执行，每个任务在 `execute()` 里干两件事：改 `BgDataModel`（内存数据模型）+ 改数据库，最后调 `taskController.bindXxx()` 触发 UI 绑定。这就是所谓的"Model reload"——不是整库重载，而是增量更新。

以卸载为例，`PackageTaskFactory.appsRemoved` 生成的任务做了完整的清理链：

```kotlin
// PackageTaskFactory.kt —— 卸载任务的完整清理
fun appsRemoved(user: UserHandle, packages: Set<String>) =
    ModelUpdateTask { taskController, dataModel, apps ->
        packages.forEach {
            taskController.iconCache.removeIconsForPkg(it, user)  // 1. 清图标缓存
            apps.removePackage(it, user)                          // 2. 从 AllAppsList 删
        }
        taskController.bindApplicationsIfNeeded()                 // 3. 绑定 AllApps 刷新

        val matcher = ItemInfoMatcher.ofPackages(packages, user)
        // Web UI 快捷方式即使 App 卸载也保留（FLAG_SUPPORTS_WEB_UI）
        val forceKeepShortcuts = synchronized(dataModel) {
            dataModel.itemsIdMap.filter {
                matcher.test(it) && it is WorkspaceItemInfo
                    && it.hasStatusFlag(FLAG_SUPPORTS_WEB_UI)
            }
        }
        val removeMatch = matcher.and(ItemInfoMatcher.ofItems(forceKeepShortcuts).negate())
        taskController.deleteAndBindComponentsRemoved(removeMatch, "removed because ...") // 4. 删桌面项
        ItemInstallQueue.INSTANCE[taskController.context].removeFromInstallQueue(packages, user) // 5. 清安装队列
    }
```

五步清理覆盖了图标缓存、应用列表、桌面项、待安装队列，保证卸载后无残留。其中第 4 步 `deleteAndBindComponentsRemoved` 会从数据库 `Favorites` 表删除对应行并触发 UI 移除动画。

### 面试深问

**Q1：`onPackageAdded` 和 `onPackagesAvailable` 有什么区别？什么时候触发哪个？**
`onPackageAdded` 是新安装（包首次对该用户可见）触发一次；`onPackagesAvailable` 是已安装的包重新变得可用，典型场景是 SD 卡插回、工作资料从禁用恢复。前者是"新增"，后者是"复活"，所以前者用 `OP_ADD`（可能要往桌面加图标），后者用 `OP_UPDATE`（只是刷新已有图标状态）。

**Q2：为什么用 `taskExecutor: Consumer<ModelUpdateTask>` 而不直接持有 `LauncherModel` 引用？**
解耦 + 可测试性。`ModelLauncherCallbacks` 只依赖一个函数式接口 `Consumer`，测试时可以传一个假实现收集任务，不用拉起整个 `LauncherModel`。这是依赖倒置，把"任务往哪送"的决定权交给调用方。

**Q3：多用户场景下，工作资料装的 App，主用户的 Launcher 会收到回调吗？**
不会直接收到 `onPackageAdded`，因为 `LauncherApps` 只回调"当前 Launcher 进程所属用户 + 其可见 profile"的包变化。工作资料的包要进入主用户 Launcher，是通过 profile 概念在 `LauncherApps.getActivityList(pkg, workUser)` 主动查询的。`UserCache` 维护用户列表，`UserHandle` 贯穿整个回调链，保证不会串号。

---

## 多用户与 Profile：UserCache 与 UserManagerState

### 为什么需要用户缓存

`LauncherApps` 的所有 API 都要带 `UserHandle`，而 Launcher 在渲染图标时频繁需要"用户序列号 ↔ UserHandle"互转、判断是否工作资料、是否解锁、是否静音模式。这些信息每次都跨 binder 查 `UserManager` 太慢，于是 `UserCache` 在进程内缓存一份快照。

```kotlin
// UserCache.kt —— 用户信息缓存单例
@LauncherAppSingleton
class UserCache @Inject constructor(
    @ApplicationContext private val context: Context, tracker: DaggerSingletonTracker
) {
    private val userManager = context.getSystemService(UserManager::class.java)!!
    private var _userInfoMap: UserManagerState? = null

    val userManagerState: UserManagerState
        get() = _userInfoMap ?: rebuildUserCache()  // 懒加载，首次访问才构建

    init {
        // 监听用户/profile 变化广播，自动重建缓存
        val userChangeReceiver = SimpleBroadcastReceiver(
            context = context, executor = MODEL_EXECUTOR
        ) { onUsersChanged(it) }
        userChangeReceiver.register(actionsFilter(
            Intent.ACTION_MANAGED_PROFILE_AVAILABLE,      // 工作资料可用
            Intent.ACTION_MANAGED_PROFILE_UNAVAILABLE,    // 工作资料不可用
            Intent.ACTION_MANAGED_PROFILE_REMOVED,        // 工作资料删除
            ACTION_PROFILE_ADDED, ACTION_PROFILE_REMOVED, // profile 增删（Android U+）
            ACTION_PROFILE_UNLOCKED, ACTION_PROFILE_LOCKED, // profile 解锁/锁定
            ACTION_PROFILE_AVAILABLE, ACTION_PROFILE_UNAVAILABLE,
        )) { rebuildUserCache() }
    }
}
```

`UserCache` 监听一长串用户状态广播，任何一条到来都触发 `rebuildUserCache()` 重建快照，并通过 `userEventListeners` 通知监听者（`LauncherModel.onUserEvent`）。注意广播按版本号做了兼容：Android U 之前用 `ACTION_MANAGED_PROFILE_*`，U 及之后用 `ACTION_PROFILE_*`，这是 AOSP 应对 API 演进的常见写法。

### 用户类型映射

`buildCachedUserInfo` 把系统 `userType` 字符串翻译成 Launcher 内部的 `UserIconInfo.type`，决定图标的角标样式（工作=公文包、私密=锁、克隆=复制）：

```kotlin
// UserCache.kt —— userType 到内部类型的映射
val userType: String? = it.userType
CachedUserInfo(
    iconInfo = UserIconInfo(
        user = user,
        type = when (userType) {
            null -> UserIconInfo.TYPE_MAIN                       // 主用户
            USER_TYPE_PROFILE_MANAGED -> UserIconInfo.TYPE_WORK  // 工作资料
            USER_TYPE_PROFILE_CLONE -> UserIconInfo.TYPE_CLONED  // 克隆资料
            USER_TYPE_PROFILE_PRIVATE -> UserIconInfo.TYPE_PRIVATE // 私密空间
            else -> UserIconInfo.TYPE_MAIN
        },
        userSerial = it.userSerialNumber.toLong(),
    ),
    isUnlocked = fetchSafe(false) { isUserUnlocked(user) },     // 是否解锁（密钥未加密）
    isQuietModeEnabled = fetchSafe(false) { isQuietModeEnabled(user) }, // 是否静音模式
    preInstallApps = launcherApps.getPreInstalledSystemPackages(user).toSet(), // 预装系统包
)
```

`isUnlocked` 极其关键：工作资料在锁屏状态下是加密锁定的，此时无法读取其应用图标和快捷方式。`UserLockStateChangedTask` 据此给深快捷方式图标打 `FLAG_DISABLED_LOCKED_USER`，解锁后再清除。`fetchSafe` 包了 `try-catch SecurityException`，因为查询其他用户信息可能因权限不足抛异常。

### UserManagerState：不可变快照

`UserManagerState` 是一个纯数据快照类，用 `Map<UserHandle, CachedUserInfo>` 构造，提供各种查询。它的不可变性是设计意图：`UserCache` 持有它的引用作为快照，重建时整体替换 `_userInfoMap`，读者永远看到一致的状态，不需要锁。

```kotlin
// UserManagerState.kt —— 用户状态只读快照
class UserManagerState(private val userMap: Map<UserHandle, CachedUserInfo>) {
    private val userSerialMap = userMap.mapKeys { it.value.iconInfo.userSerial } // 反向索引

    fun isUserQuiet(serialNo: Long): Boolean = userSerialMap[serialNo]?.isQuietModeEnabled ?: false
    fun getUser(serialNo: Long): UserHandle =
        userSerialMap[serialNo]?.iconInfo?.user ?: Process.myUserHandle() // 找不到回落到主用户
    fun isUserUnlocked(user: UserHandle) = userMap[user]?.isUnlocked ?: true // 找不到默认解锁（乐观）
    val isAnyProfileQuietModeEnabled: Boolean
        get() = userMap.any { it.value.isQuietModeEnabled } // 任一 profile 静音
}
```

`isUserUnlocked` 找不到用户时默认返回 `true`（乐观），这是为了避免在用户信息还没建好时误把图标标灰；`getUser` 找不到序列号时回落到 `Process.myUserHandle()`，保证不返回 null。

### 面试深问

**Q1：为什么 `UserCache` 要缓存 `preInstallApps`（预装系统包列表）？**
私密空间/克隆资料创建时，只有部分系统包对它们可见。Loader 加载时需要判断"这个包对该 profile 是否预装"，以决定是否显示。直接查 `LauncherApps.getPreInstalledSystemPackages` 每次都跨 binder，缓存在 `UserCache` 里随 profile 变化重建，既快又一致。

**Q2：`UserManagerState` 为什么做成不可变快照而不是可变 Map？**
读写一致性。用户状态变化频率低（创建/删除 profile 才变），但读取频率极高（每个图标渲染都要查）。不可变快照 + 整体替换 = 读不加锁、写时复制，是"Copy-on-Write"思想，避免读写锁的开销。

**Q3：`onUserEvent` 里为什么 `ACTION_MANAGED_PROFILE_REMOVED` 要 `forceReload` 而不是增量更新？**
工作资料删除意味着该用户的所有图标、快捷方式、widget 全部失效，增量清理容易遗漏（比如 widget provider、collection 里的项）。全量 reload 虽然重，但保证彻底干净。这是"正确性优先于性能"的取舍——profile 删除是低频事件。

---

## 包状态变化：更新、禁用、挂起

### App 更新（OP_UPDATE）

App 更新走 `PackageUpdatedTask`，这是最复杂的任务之一，因为它要处理"图标变了、组件名变了、快捷方式失效、widget provider 变了"等多种情况。

```java
// PackageUpdatedTask.java —— 更新/新增的核心执行体
public void execute(ModelTaskController taskController, BgDataModel dataModel, AllAppsList appsList) {
    final FlagOp flagOp = FlagOp.NO_OP.removeFlag(FLAG_DISABLED_NOT_AVAILABLE); // 清"不可用"标记
    final HashSet<ComponentName> removedComponents = new HashSet<>();            // 收集被删的组件
    final HashMap<String, List<LauncherActivityInfo>> activitiesLists = new HashMap<>();

    for (String packageName : mPackages) {
        iconCache.updateIconsForPkg(packageName, mUser);  // 1. 刷新图标缓存（图标可能变了）
        activitiesLists.put(packageName,
            appsList.updatePackage(context, packageName, mUser, removedComponents)); // 2. 更新 AllAppsList，收集被删组件
    }
    taskController.bindApplicationsIfNeeded(); // 3. 绑定 AllApps 刷新
    // ... 接下来遍历桌面项，处理承诺图标、被删组件、归档状态
}
```

第 2 步 `appsList.updatePackage` 返回该包的新活动列表，同时把"老版本有、新版本没有"的 `ComponentName` 塞进 `removedComponents`。后续用这个集合清理指向已删组件的桌面快捷方式。这是处理"App 更新后某个 Activity 被移除"的情况。

承诺图标（promise icon）的转正也在这里完成。当 App 在 Launcher 后台时安装完成，桌面上的承诺图标还没转成正式图标，`OP_UPDATE` 会检查并转正：

```java
// PackageUpdatedTask.java —— 承诺图标转正逻辑（节选自 updateAndCollectWorkspaceItemInfos 回调）
if (itemInfo.isPromise()) {
    boolean isTargetValid = !cn.getClassName().equals(IconCache.EMPTY_CLASS_NAME);
    // ... 校验目标 Activity 是否还存在
    if (!isTargetValid && (itemInfo.hasStatusFlag(FLAG_RESTORED_ICON | FLAG_AUTOINSTALL_ICON)
            || itemInfo.isArchived())) {
        if (updateWorkspaceItemIntent(context, itemInfo, packageName)) { // 尝试修正 intent
            infoUpdated = true;
        } else if (shouldRemoveRestoredShortcut(itemInfo)) {
            removedShortcuts.add(itemInfo.id);  // 修正失败且不该保留 → 删除
            return false;
        }
    } else if (!isTargetValid) {
        removedShortcuts.add(itemInfo.id);  // 目标彻底失效 → 删除
        return false;
    } else {
        itemInfo.status = WorkspaceItemInfo.DEFAULT;  // 转正：清掉 promise 标记
        infoUpdated = true;
    }
}
```

更新场景还会清理"被禁用的包"——如果 `OP_UPDATE` 发现某包 `isPackageEnabled` 返回 false（被用户禁用），就把它当卸载处理：

```java
// PackageUpdatedTask.java —— 更新时清理被禁用的包
if (mIsUpdate) {
    final LauncherApps launcherApps = context.getSystemService(LauncherApps.class);
    for (String packageName : mPackages) {
        if (!launcherApps.isPackageEnabled(packageName, mUser)) {
            removedPackages.add(packageName);  // 禁用 → 视为移除
        }
    }
}
if (!removedPackages.isEmpty() || !removedComponents.isEmpty()) {
    Predicate<ItemInfo> removeMatch = ItemInfoMatcher.ofPackages(removedPackages, mUser)
        .or(ItemInfoMatcher.ofComponents(removedComponents, mUser))
        .and(ItemInfoMatcher.ofItemIds(forceKeepShortcuts).negate());
    taskController.deleteAndBindComponentsRemoved(removeMatch, "removed because ...");
    ItemInstallQueue.INSTANCE.get(context).removeFromInstallQueue(removedPackages, mUser);
}
```

### App 禁用/挂起（图标变灰）

禁用和挂起是两种不同的"不可用"状态，用不同的运行时标志位区分。`PackageTaskFactory` 用工厂方法生成对应的轻量任务：

```kotlin
// PackageTaskFactory.kt —— 不可用（SD卡拔出、替换中）
fun appsUnavailable(user: UserHandle, packages: Set<String>) =
    ModelUpdateTask { taskController, dataModel, apps ->
        packages.forEach { apps.removePackage(it, user) }  // 从 AllAppsList 移除（临时）
        taskController.bindApplicationsIfNeeded()
        updateRuntimeStatus(taskController, dataModel, user, packages,
            FlagOp.NO_OP.addFlag(FLAG_DISABLED_NOT_AVAILABLE)) // 打"不可用"灰标
    }

// 挂起（系统挂起，如家长控制、设备策略）
fun appsSuspended(user: UserHandle, packages: Set<String>) =
    ModelUpdateTask { taskController, dataModel, apps ->
        val flagOp = FlagOp.NO_OP.addFlag(FLAG_DISABLED_SUSPENDED)
        apps.updateDisabledFlags(ItemInfoMatcher.ofPackages(packages, user), flagOp)
        taskController.bindApplicationsIfNeeded()
        updateRuntimeStatus(taskController, dataModel, user, packages, flagOp)
    }
```

两者的区别：`appsUnavailable` 会从 `AllAppsList` 删掉（应用抽屉里消失），只保留桌面图标打灰；`appsSuspended` 保留在 AllAppsList，只是图标变灰（系统挂起通常允许显示）。`updateRuntimeStatus` 遍历桌面项，用 `FlagOp` 增删 `runtimeStatusFlags` 里的对应位，然后绑定刷新。`FlagOp` 是个函数式对象，`addFlag/removeFlag` 返回新 `FlagOp`，统一了"加位/删位"的操作模型。

### 面试深问

**Q1：`FLAG_DISABLED_NOT_AVAILABLE` 和 `FLAG_DISABLED_SUSPENDED` 的业务区别是什么？**
前者表示"包暂时不可用"（SD 卡拔出、正在替换），后者表示"系统主动挂起"（家长控制、设备策略）。UI 上两者都变灰，但前者会从应用抽屉消失（因为 `AllAppsList` 删了），后者保留在抽屉里。这种区分让用户能理解"App 还在，只是被限制了"vs"App 暂时找不到了"。

**Q2：App 更新时，为什么 `updatePackage` 要收集 `removedComponents`？**
App 新版本可能删了某个 Activity（比如把 `SplashActivity` 改名了）。桌面上的快捷方式指向旧的 `ComponentName`，如果不清理就变成死链。`removedComponents` 收集这些被删组件，后续 `deleteAndBindComponentsRemoved` 把指向它们的桌面项一并清掉，避免死链。

**Q3：`forceKeepShortcuts` 为什么要保留 `FLAG_SUPPORTS_WEB_UI` 的快捷方式？**
Web UI 快捷方式不依赖本地 App 组件（指向网页），即使 App 卸载，这些快捷方式仍然可用（打开网页）。所以即使包被删，带 `FLAG_SUPPORTS_WEB_UI` 的项也要保留。这是为了支持 PWA / 网页应用场景。

---

## 安装会话：PackageInstaller.Session 的使用

### 为什么用 Session 而不是直接调 install

`PackageInstaller.Session` 是 Android 5.0 引入的安装框架，核心价值有三：

1. **进度可见**：安装是大文件流式写入，Session 提供 `getProgress()` 让 Launcher 实时显示下载/安装进度。
2. **原子性**：一个 Session 对应一次完整安装，要么成功（`commit`）要么失败（`abandon`），不会出现"装了一半"的中间态。
3. **来源标识**：Session 带 `getInstallerPackageName()`（Play Store、adb、其他商店）和 `getInstallReason()`（用户主动、系统更新、设备恢复），Launcher 据此决定是否提前显示"承诺图标"。

Launcher3 不直接调 `PackageInstaller.install`（它不负责安装），而是**监听**系统里所有安装会话的状态变化，据此在桌面显示"正在安装"的承诺图标。

### InstallSessionHelper：会话查询与信任校验

`InstallSessionHelper` 是 Launcher 访问 `PackageInstaller` 的统一入口，核心职责是查询活跃会话并做"信任校验"——只信任系统签名的安装器（Play Store、系统应用）发出的会话，避免恶意 App 伪造会话骗图标。

```java
// InstallSessionHelper.java —— 信任校验，决定是否相信一个会话
private SessionInfo verify(SessionInfo sessionInfo) {
    if (sessionInfo == null
            || sessionInfo.getInstallerPackageName() == null          // 必须有安装器包名
            || TextUtils.isEmpty(sessionInfo.getAppPackageName())) {  // 必须有目标包名
        return null;
    }
    return isTrustedPackage(sessionInfo.getInstallerPackageName(), getUserHandle(sessionInfo))
            ? sessionInfo : null;  // 安装器不可信 → 丢弃
}

public boolean isTrustedPackage(String pkg, UserHandle user) {
    synchronized (mSessionVerifiedMap) {
        if (!mSessionVerifiedMap.containsKey(pkg)) {
            boolean hasSystemFlag = DEBUG || mAppContext.getPackageName().equals(pkg) // Launcher 自己
                    || new ApplicationInfoWrapper(mAppContext, pkg, user).isSystem();  // 或系统应用
            mSessionVerifiedMap.put(pkg, hasSystemFlag);  // 缓存校验结果
        }
    }
    return mSessionVerifiedMap.get(pkg);
}
```

`mSessionVerifiedMap` 缓存校验结果避免重复查 `ApplicationInfo.flags`。信任标准是"安装器是系统应用或 Launcher 自己"。这一步防的是：恶意 App 通过 `PackageInstaller` 创建一个假会话，声称"我正在安装微信"，骗 Launcher 在桌面显示假图标诱导用户点击。

`getAllVerifiedSessions` 拉取所有会话并过滤掉不可信的：

```java
// InstallSessionHelper.java —— 拉取所有可信会话
public List<SessionInfo> getAllVerifiedSessions() {
    List<SessionInfo> list = new ArrayList<>(
        Objects.requireNonNull(mLauncherApps).getAllPackageInstallerSessions()); // 系统 API
    Iterator<SessionInfo> it = list.iterator();
    while (it.hasNext()) {
        if (verify(it.next()) == null) {
            it.remove();  // 不可信的会话剔除
        }
    }
    return list;
}
```

注意它用的是 `LauncherApps.getAllPackageInstallerSessions()` 而不是 `PackageInstaller.getMySessions()`，前者返回系统中所有会话（Launcher 有权限），后者只返回自己创建的。Launcher 要观察全局安装，所以用前者。

### InstallSessionTracker：会话生命周期回调

`InstallSessionTracker` 继承 `PackageInstaller.SessionCallback`，把会话事件翻译成 `PackageInstallInfo` 推给 `ModelLauncherCallbacks`。它持的是 `WeakReference`，避免内存泄漏：

```java
// InstallSessionTracker.java —— 会话回调（节选）
@Override
public void onCreated(int sessionId) {
    InstallSessionHelper helper = mWeakHelper.get();
    Callback callback = mWeakCallback.get();
    if (callback == null || helper == null) return;  // 弱引用已回收，直接返回
    SessionInfo sessionInfo = pushSessionDisplayToLauncher(sessionId, helper, callback);
    if (sessionInfo != null) {
        callback.onInstallSessionCreated(PackageInstallInfo.fromInstallingState(sessionInfo));
    }
    helper.tryQueuePromiseAppIcon(sessionInfo);  // 尝试添加承诺图标
    // ... 归档应用恢复时额外发 onPackageStateChanged
}

@Override
public void onFinished(int sessionId, boolean success) {
    // 会话结束时无法再获取 SessionInfo，用本地缓存的 packageName
    SparseArray<PackageUserKey> activeSessions = getActiveSessionMap(helper);
    PackageUserKey key = activeSessions.get(sessionId);
    activeSessions.remove(sessionId);
    if (key != null && key.mPackageName != null) {
        PackageInstallInfo info = PackageInstallInfo.fromState(
                success ? STATUS_INSTALLED : STATUS_FAILED,  // 成功=已安装，失败=失败
                packageName, key.mUser);
        callback.onPackageStateChanged(info);
        if (!success && helper.promiseIconAddedForId(sessionId)) {
            callback.onSessionFailure(packageName, key.mUser);  // 失败 → 删承诺图标
            helper.removePromiseIconId(sessionId);
        }
    }
}
```

`onFinished` 里有个细节：会话结束后 `getSessionInfo` 返回 null，所以它用本地 `mActiveSessions` 缓存（`SparseArray<sessionId, PackageUserKey>`）反查包名。这个缓存在 `pushSessionDisplayToLauncher` 时填充，懒加载。失败时调 `onSessionFailure`，最终走 `SessionFailureTask` 删掉桌面上对应的承诺图标。

注册回调分版本：Android Q 之前用 `PackageInstaller.registerSessionCallback`，Q 及之后用 `LauncherApps.registerPackageInstallerSessionCallback`（多用户感知）：

```java
// InstallSessionTracker.java —— 版本兼容的注册
void register() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        mInstaller.registerSessionCallback(this, MODEL_EXECUTOR.getHandler());
    } else {
        Objects.requireNonNull(mLauncherApps).registerPackageInstallerSessionCallback(
                MODEL_EXECUTOR, this);  // Q+ 用 LauncherApps，支持多用户
    }
}
```

### PackageInstallInfo：安装状态数据载体

`PackageInstallInfo` 是个 Kotlin data class，把会话状态归一成四个常量，是会话事件和模型任务之间的数据契约：

```kotlin
// PackageInstallInfo.kt —— 安装状态数据类
data class PackageInstallInfo(
    @JvmField val packageName: String,
    @JvmField val state: Int,        // 状态常量
    @JvmField val progress: Int,     // 0-100 进度
    @JvmField val user: UserHandle,
) {
    companion object {
        const val STATUS_INSTALLED: Int = 0              // 已安装
        const val STATUS_INSTALLING: Int = 1             // 安装中
        const val STATUS_INSTALLED_DOWNLOADING: Int = 2  // 已安装但增量下载中
        const val STATUS_FAILED: Int = 3                 // 失败

        fun fromInstallingState(info: SessionInfo) = PackageInstallInfo(
            packageName = info.getAppPackageName()!!,
            state = STATUS_INSTALLING,
            progress = (info.getProgress() * 100f).toInt(),  // 会话进度转 0-100
            user = InstallSessionHelper.getUserHandle(info),
        )
    }
}
```

`fromInstallingState` 把 `SessionInfo` 的浮点进度（0.0-1.0）转成整数百分比。四种状态覆盖了安装的全生命周期：下载中→已安装（成功）→增量更新中，或失败。

### 面试深问

**Q1：为什么 `InstallSessionTracker` 持 `WeakReference` 而不是强引用？**
防止循环引用导致内存泄漏。`InstallSessionHelper`（单例，生命周期=进程）持有 `InstallSessionTracker`，Tracker 又持有 Helper 和 Callback 的引用。如果都是强引用，Callback（Activity/Model）永远释放不了。WeakReference 让 Callback 销毁后 Tracker 自动失效（`mWeakCallback.get()` 返回 null 就直接 return）。

**Q2：`verify` 为什么要缓存校验结果到 `mSessionVerifiedMap`？**
`isSystem` 查询要构造 `ApplicationInfoWrapper`，跨 binder 读 `PackageManager`，开销不小。同一个安装器包名（如 Play Store）的会话会频繁到达，缓存后只查一次。这是典型的"读多写少"缓存场景，用 Map 以包名为 key 缓存布尔结果。

**Q3：`onFinished` 失败时为什么要调 `onSessionFailure` 单独处理，不能复用 `onPackageRemoved` 吗？**
`onPackageRemoved` 是"包已安装后被卸载"，会走全量清理（AllAppsList、桌面项、widget）。而会话失败时包从未真正安装，AllAppsList 里根本没有它，只需要删掉桌面的承诺图标。两者的清理范围不同，`SessionFailureTask` 只删 `hasPromiseIconUi()` 的项，更精准，避免误删。

---

## SessionCommitReceiver：提前显示承诺图标

### 安装会话提交瞬间的回调

`SessionCommitReceiver` 监听 `android.content.pm.action.SESSION_COMMITTED` 广播——这是系统在安装会话 `commit()`（写入完成、即将注册到 PackageManager）时发出的。Launcher 借此在 App "正式出现"前就把图标摆上桌面，用户能更早看到。

```xml
<!-- AndroidManifest-common.xml —— 清单注册 -->
<receiver android:name="com.android.launcher3.SessionCommitReceiver" android:exported="true">
    <intent-filter>
        <action android:name="android.content.pm.action.SESSION_COMMITTED" />
    </intent-filter>
</receiver>
```

注意它是 `exported="true"`（系统广播必须导出）且在清单静态注册（进程没启动也能收到，触发 Launcher 进程拉起）。这与 `LauncherApps.Callback`（运行时动态注册）是两套机制，互补关系：Callback 管"已安装包的变化"，Receiver 管"安装会话的提交"。

### 处理逻辑：是否要加图标

收到广播后，`SessionCommitReceiver.processIntent` 决定是否往安装队列里塞这个包。判定逻辑严格，因为承诺图标是"提前显示"，加错了反而干扰：

```java
// SessionCommitReceiver.java —— 会话提交处理
private static void processIntent(Context context, Intent intent) {
    UserHandle user = intent.getParcelableExtra(Intent.EXTRA_USER);
    if (!isEnabled(context, user)) {
        return;  // 用户关闭了"自动添加图标到主屏"开关 → 不加
    }
    SessionInfo info = intent.getParcelableExtra(PackageInstaller.EXTRA_SESSION);
    if (!PackageInstaller.ACTION_SESSION_COMMITTED.equals(intent.getAction())
            || info == null || user == null) {
        return;  // 无效 Intent → 不加
    }
    if (info.getSessionId() == -1) return;  // 无效会话 → 不加

    InstallSessionHelper packageInstallerCompat = InstallSessionHelper.INSTANCE.get(context);
    boolean alreadyAddedPromiseIcon = packageInstallerCompat.promiseIconAddedForId(info.getSessionId());
    if (TextUtils.isEmpty(info.getAppPackageName())
            || info.getInstallReason() != PackageManager.INSTALL_REASON_USER  // 必须是用户主动安装
            || alreadyAddedPromiseIcon) {                                    // 已经加过承诺图标
        packageInstallerCompat.removePromiseIconId(info.getSessionId());  // 清理残留记录
        return;
    }
    ItemInstallQueue.INSTANCE.get(context).queueItem(info.getAppPackageName(), user); // 入队
}
```

四个拒绝条件逐一把关：开关关闭、Intent 无效、会话无效、非用户主动安装（系统更新、恢复安装不打图标，避免静默装一堆）。只有用户在 Play Store 主动点的"安装"，才会触发承诺图标。`INSTALL_REASON_USER` 是关键过滤——它排除了 `INSTALL_REASON_DEVICE_RESTORE`（恢复）、`INSTALL_REASON_DEVICE_SETUP`（开机向导预装）等静默场景。

### 用户偏好：自动添加桌面图标开关

`isEnabled` 检查两个条件：私密空间禁用 + 用户设置开关：

```java
// SessionCommitReceiver.java —— 是否允许自动加图标
public static boolean isEnabled(Context context, UserHandle user) {
    if (Flags.privateSpaceRestrictItemDrag() && user != null
            && UserCache.getInstance(context).getUserInfo(user).isPrivate()) {
        return false;  // 私密空间不允许自动加图标（隐私考虑）
    }
    return LauncherPrefs.getPrefs(context).getBoolean(ADD_ICON_PREFERENCE_KEY, true); // 用户开关，默认开
}
```

`ADD_ICON_PREFERENCE_KEY = "pref_add_icon_to_home"` 对应 Launcher 设置里的"添加图标到主屏幕"开关，默认 true。私密空间（Private Space，Android V+）强制关闭自动添加，避免私密 App 图标意外暴露在主屏。这个开关在 `res/xml/launcher_preferences.xml` 里定义，用户可在设置里切换。

### 面试深问

**Q1：`SESSION_COMMITTED` 和 `onPackageAdded` 哪个先到？为什么要两个？**
`SESSION_COMMITTED` 先到（会话写入完成、即将注册），`onPackageAdded` 后到（包已注册到 PackageManager，可查询）。两者时序上只差几十毫秒，但承诺图标要尽早出现，所以用 `SESSION_COMMITTED`。如果只用 `onPackageAdded`，图标会比 Play Store 的安装动画晚出现，体验割裂。承诺图标机制是"乐观提前显示"，万一失败再用 `SessionFailureTask` 回滚。

**Q2：为什么非用户主动安装（`INSTALL_REASON_USER` 之外）不加承诺图标？**
系统更新、设备恢复、开机预装会静默装大量 App，如果都加图标，桌面瞬间被塞满，用户体验灾难。只有用户在商店主动点的"安装"，才认为用户"期望"这个图标出现在桌面。这是"显式意图 vs 隐式事件"的区分原则。

**Q3：`SessionCommitReceiver` 是静态广播接收器，会不会拖慢开机？**
会有一点影响，但系统对静态接收器有调度优化（广播排队、延迟投递）。且 `onReceive` 里只做 `Executors.MODEL_EXECUTOR.execute(...)` 把活转后台，不在主线程阻塞。静态注册的必要性在于：安装会话可能在 Launcher 进程没运行时提交（比如商店后台安装），静态接收器能拉起进程处理。

---

## 承诺图标（Promise Icon）机制

### 何时创建承诺图标

承诺图标是"App 还在安装中就先显示在桌面的占位图标"，带进度条。创建时机在 `InstallSessionHelper.tryQueuePromiseAppIcon`，由 `InstallSessionTracker.onCreated` 和 `onBadgingChanged` 触发：

```java
// InstallSessionHelper.java —— 尝试加入承诺图标
void tryQueuePromiseAppIcon(PackageInstaller.SessionInfo sessionInfo) {
    if (sessionInfo != null
            && SessionCommitReceiver.isEnabled(mAppContext, getUserHandle(sessionInfo)) // 开关开着
            && verifySessionInfo(sessionInfo)                                          // 会话可信且符合条件
            && !promiseIconAddedForId(sessionInfo.getSessionId())) {                   // 没加过
        // 归档应用恢复时不重复加（图标可能已在桌面）
        if (!Flags.enableSupportForArchiving() || !sessionInfo.isUnarchival()) {
            ItemInstallQueue.INSTANCE.get(mAppContext)
                    .queueItem(sessionInfo.getAppPackageName(), getUserHandle(sessionInfo)); // 入安装队列
        }
        getPromiseIconIds().add(sessionInfo.getSessionId());  // 记录 sessionId，防重复
        updatePromiseIconPrefs();                              // 持久化到 SharedPreferences
    }
}
```

`verifySessionInfo` 是核心门禁，五条全满足才放行：

```java
// InstallSessionHelper.java —— 承诺图标五条件
public boolean verifySessionInfo(PackageInstaller.SessionInfo sessionInfo) {
    if (Flags.enableSupportForArchiving() && sessionInfo != null
            && sessionInfo.isUnarchival()) {
        return true;  // 归档恢复特例：总是允许（图标可能已在桌面）
    }
    return verify(sessionInfo) != null                                    // 1. 会话可信
            && sessionInfo.getInstallReason() == PackageManager.INSTALL_REASON_USER  // 2. 用户主动装
            && sessionInfo.getAppIcon() != null                           // 3. 有图标（没图标没法显示）
            && !TextUtils.isEmpty(sessionInfo.getAppLabel())              // 4. 有标签（没名字没法显示）
            && !new ApplicationInfoWrapper(mAppContext, sessionInfo.getAppPackageName(),
                    getUserHandle(sessionInfo)).isInstalled();            // 5. 还没装好
}
```

第 3、4 条很重要：有些 App 在安装早期还没把图标和名字传给系统（比如没有 launcher Activity 的纯服务 App），这种就跳过承诺图标，等装完再说。第 5 条防止"已安装的包重复加承诺图标"。

### 承诺图标的持久化与防重

承诺图标的 `sessionId` 列表持久化在 `LauncherPrefs`，键名 `PROMISE_ICON_IDS`，值是 sessionId 拼接字符串。Launcher 重启后会校验这些 id 是否还对应活跃会话，失效的清掉：

```java
// InstallSessionHelper.java —— 加载承诺图标 id 并清理失效的
private IntSet getPromiseIconIds() {
    Preconditions.assertWorkerThread();
    if (mPromiseIconIds != null) return mPromiseIconIds;
    mPromiseIconIds = IntSet.wrap(IntArray.fromConcatString(
            LauncherPrefs.get(mAppContext).get(LauncherPrefs.PROMISE_ICON_IDS))); // 从 prefs 读

    IntArray existingIds = new IntArray();
    for (SessionInfo info : getActiveSessions().values()) {
        existingIds.add(info.getSessionId());  // 收集当前活跃会话 id
    }
    IntArray idsToRemove = new IntArray();
    for (int i = mPromiseIconIds.size() - 1; i >= 0; --i) {
        if (!existingIds.contains(mPromiseIconIds.getArray().get(i))) {
            idsToRemove.add(mPromiseIconIds.getArray().get(i));  // 会话已不存在 → 待删
        }
    }
    // 删除失效 id ...
    return mPromiseIconIds;
}
```

这步防的是：用户关机、会话被系统清理，重启后 prefs 里残留的 sessionId 指向不存在的会话，导致承诺图标永远转不了正。校验后只保留仍活跃的，干净。

### 承诺图标的 UI 状态

承诺图标在 `WorkspaceItemInfo` 里用 `status` 字段标记，核心是 `FLAG_AUTOINSTALL_ICON`：

```java
// WorkspaceItemInfo.java —— 承诺图标相关标志位
public static final int FLAG_RESTORED_ICON = 1;        // 备份恢复的占位图标
public static final int FLAG_AUTOINSTALL_ICON = 1 << 1; // 安装会话产生的承诺图标

public final boolean isPromise() {
    return hasStatusFlag(FLAG_RESTORED_ICON | FLAG_AUTOINSTALL_ICON)
            || isArchived();  // 归档应用也算 promise
}

public boolean hasPromiseIconUi() {
    return isPromise() && !hasStatusFlag(FLAG_SUPPORTS_WEB_UI);  // Web UI 不显示 promise UI
}
```

`isPromise()` 判断是否是占位图标（恢复的或安装中的），`hasPromiseIconUi()` 进一步排除 Web UI（PWA 不需要进度条）。UI 层根据这两个方法决定是否画进度环、是否可点击跳转商店。

`AddWorkspaceItemsTask` 在真正落库前还会做最后一道校验：检查承诺图标的会话是否还活跃、App 是否已装好：

```java
// AddWorkspaceItemsTask.java —— 承诺图标落库前的校验
if (item instanceof WorkspaceItemInfo && ((WorkspaceItemInfo) item).isPromise()) {
    WorkspaceItemInfo workspaceInfo = (WorkspaceItemInfo) item;
    String packageName = item.getTargetComponent() != null
            ? item.getTargetComponent().getPackageName() : null;
    SessionInfo sessionInfo = packageInstaller.getActiveSessionInfo(item.user, packageName);

    if (!packageInstaller.verifySessionInfo(sessionInfo)) {
        continue;  // 会话不可信 → 跳过
    }
    List<LauncherActivityInfo> activities = launcherApps.getActivityList(packageName, item.user);
    boolean hasActivity = activities != null && !activities.isEmpty();

    if (sessionInfo == null) {
        if (!hasActivity) continue;  // 会话取消且 App 没装 → 不加
    } else {
        workspaceInfo.setProgressLevel(
                (int) (sessionInfo.getProgress() * 100),
                PackageInstallInfo.STATUS_INSTALLING);  // 设置进度
    }
    if (hasActivity) {
        // App 已装好（可能 Launcher 在后台时安装完成）→ 转成正式图标
        itemInfo = new AppInfo(context, activities.get(0), item.user).makeWorkspaceItem(context);
    }
}
```

这道校验处理了竞态：承诺图标入队后、落库前，App 可能已经装完或会话被取消。装完就转正式图标，取消就跳过，保证桌面状态正确。

### 面试深问

**Q1：承诺图标为什么要持久化 sessionId 到 SharedPreferences？**
因为安装会话可能跨进程重启。Launcher 进程被杀重启后，`InstallSessionTracker` 重新注册，需要知道"哪些会话已经加过承诺图标"，避免重复添加。sessionId 是会话的唯一标识，持久化后重启能恢复防重状态。

**Q2：承诺图标失败后（安装失败），桌面怎么清理？**
`InstallSessionTracker.onFinished(success=false)` → `callback.onSessionFailure` → `SessionFailureTask`。该任务遍历桌面项，找出 `hasPromiseIconUi()` 且包名匹配的 `WorkspaceItemInfo`，调 `deleteAndBindComponentsRemoved` 删除并触发移除动画。归档应用特例：只刷新图标不删除（因为归档图标要保留）。

**Q3：为什么 `FLAG_AUTOINSTALL_ICON` 既表示"安装会话承诺图标"又表示"默认布局自动安装"？**
历史遗留 + 语义复用。两者本质都是"图标先于 App 真正可用出现"：默认布局解析时（OEM 预设桌面）标记的图标也是占位，等对应 App 装上才可用。`isPromise()` 把两者统一处理，UI 层都显示进度/占位样式。虽然语义有点混，但减少了状态枚举，代码更简单。

---

## ItemInstallQueue：桌面项安装队列

### 队列的设计意图

`ItemInstallQueue` 是"待添加到桌面的项目"的缓冲队列。它的存在解决三个时序问题：

1. **Launcher 还没加载完**：会话提交时 Launcher 进程可能还没启动，`Launcher.ACTIVITY_TRACKER.getCreatedContext()` 返回 null，此时把包名存队列，等 Launcher 起来再 flush。
2. **拖拽中**：用户正在拖拽图标，此时往桌面插新图标会打乱布局，先排队等拖拽结束。
3. **Activity 暂停**：Launcher 不在前台，批量插入效率低，攒着一起加。

```java
// ItemInstallQueue.java —— 队列暂停/恢复的三种 flag
public static final int FLAG_ACTIVITY_PAUSED = 1;   // Launcher 不在前台
public static final int FLAG_LOADER_RUNNING = 2;    // Loader 还在加载数据
public static final int FLAG_DRAG_AND_DROP = 4;     // 拖拽中

public void pauseModelPush(int flag) {
    mInstallQueueDisabledFlags |= flag;  // 置位 → 暂停 flush
}

public void resumeModelPush(int flag) {
    mInstallQueueDisabledFlags &= ~flag; // 清位
    flushInstallQueue();                 // 尝试 flush
}

private void flushInstallQueue() {
    if (mInstallQueueDisabledFlags != 0) return; // 任一 flag 置位 → 不 flush
    MODEL_EXECUTOR.post(this::flushQueueInBackground);
}
```

三个 flag 用位运算组合，任一位置位就暂停。只有全部清零（`mInstallQueueDisabledFlags == 0`）才真正 flush。这种"多原因暂停"用位掩码是经典手法，避免维护多个 boolean。

调用点分散在 `Launcher` 和 `LauncherModel` 生命周期里：

```java
// LauncherModel.kt —— Loader 运行时暂停，加载完恢复
fun startLoader() {
    installQueue.pauseModelPush(ItemInstallQueue.FLAG_LOADER_RUNNING)  // 开始加载：暂停
    // ... 启动 LoaderTask
    MODEL_EXECUTOR.execute {
        // LoaderTask 完成后
        installQueue.resumeModelPush(FLAG_LOADER_RUNNING)             // 加载完：恢复并 flush
    }
}

// Launcher.java —— Activity 生命周期控制队列
@Override
protected void onResume() {
    ItemInstallQueue.INSTANCE.get(this).resumeModelPush(FLAG_ACTIVITY_PAUSED); // 回前台：恢复
}
@Override
protected void onPause() {
    ItemInstallQueue.INSTANCE.get(this).pauseModelPush(FLAG_ACTIVITY_PAUSED);  // 退后台：暂停
}
// 拖拽开始/结束
ItemInstallQueue.INSTANCE.get(this).pauseModelPush(FLAG_DRAG_AND_DROP);   // 拖拽中：暂停
ItemInstallQueue.INSTANCE.get(this).resumeModelPush(FLAG_DRAG_AND_DROP);  // 拖拽完：恢复
```

### 队列项的三种类型

`PendingInstallShortcutInfo` 是队列项，支持三种桌面项：应用图标、深快捷方式、widget。`itemType` 字段区分：

```java
// ItemInstallQueue.java —— 三种队列项构造器
public static class PendingInstallShortcutInfo extends ItemInfo {
    // 应用图标（承诺图标或自动添加）
    public PendingInstallShortcutInfo(String packageName, UserHandle userHandle) {
        itemType = Favorites.ITEM_TYPE_APPLICATION;
        intent = new Intent().setPackage(packageName);
        user = userHandle;
    }
    // 深快捷方式（ShortcutManager 的 pinned shortcut）
    public PendingInstallShortcutInfo(ShortcutInfo info) {
        itemType = Favorites.ITEM_TYPE_DEEP_SHORTCUT;
        intent = ShortcutKey.makeIntent(info);
        user = info.getUserHandle();
        shortcutInfo = info;
    }
    // Widget
    public PendingInstallShortcutInfo(AppWidgetProviderInfo info, int widgetId) {
        itemType = Favorites.ITEM_TYPE_APPWIDGET;
        intent = new Intent().setComponent(info.provider)
                .putExtra(EXTRA_APPWIDGET_ID, widgetId);
        user = info.getProfile();
        providerInfo = info;
    }
}
```

三种类型共用一套队列机制，但 `getItemInfo` 转换成具体 `ItemInfo` 时分派。应用图标场景下，如果包还没装好（`laiList.isEmpty()`），用包名+空组件造一个 `FLAG_AUTOINSTALL_ICON` 的承诺图标：

```java
// ItemInstallQueue.java —— 应用图标转 ItemInfo
case ITEM_TYPE_APPLICATION: {
    String packageName = intent.getPackage();
    List<LauncherActivityInfo> laiList = context.getSystemService(LauncherApps.class)
            .getActivityList(packageName, user);
    boolean usePackageIcon = laiList.isEmpty();  // 没有 Activity → 用包图标
    if (usePackageIcon) {
        si.intent = makeLaunchIntent(new ComponentName(packageName, "")).setPackage(packageName);
        si.status |= WorkspaceItemInfo.FLAG_AUTOINSTALL_ICON;  // 标记承诺图标
    } else {
        lai = laiList.get(0);
        si.intent = makeLaunchIntent(lai);  // 有 Activity → 正式图标
    }
    LauncherAppState.getInstance(context).getIconCache()
            .getTitleAndIcon(si, () -> lai, DESKTOP_ICON_FLAG.withUsePackageIcon(usePackageIcon));
    return Pair.create(si, null);
}
```

### flush 与持久化

队列内容持久化到磁盘文件（`PersistedItemArray`，文件名 `APPS_PENDING_INSTALL = "apps_to_install"`），防止进程被杀丢队列。flush 时读出、转 ItemInfo、批量加桌面、清空文件：

```java
// ItemInstallQueue.java —— 后台 flush 队列
private void flushQueueInBackground() {
    Launcher launcher = Launcher.ACTIVITY_TRACKER.getCreatedContext();
    if (launcher == null) return;  // Launcher 没起来 → 留在队列
    ensureQueueLoaded();
    if (mItems.isEmpty()) return;

    List<Pair<ItemInfo, Object>> installQueue = mItems.stream()
            .map(info -> info.getItemInfo(mContext))
            .collect(Collectors.toList());
    if (!installQueue.isEmpty()) {
        MAIN_EXECUTOR.execute(() -> commitInstallQueue(launcher, installQueue)); // 主线程提交
    }
    mItems.clear();
    mStorage.getFile(mContext).delete();  // 清空持久化文件
}

private void commitInstallQueue(Launcher launcher, List<Pair<ItemInfo, Object>> itemList) {
    launcher.getModelWriter().commitDelete();  // 先完成待撤销的删除
    // 关闭 undo snackbar，确保空屏幕被清理
    AbstractFloatingView snackbar = AbstractFloatingView.getOpenView(launcher, TYPE_SNACKBAR);
    if (snackbar != null) snackbar.close(true);
    launcher.getModel().enqueueModelUpdateTask(
            new AddWorkspaceItemsTask(itemList, mSpaceFinderProvider.get())); // 真正落库
}
```

`commitInstallQueue` 在主线程执行，因为要访问 `Launcher` 实例（UI 对象）。它先 `commitDelete` 关掉 undo snackbar——这是为了避免"撤销删除"和"添加新项"竞态：如果用户刚删了图标还没撤销超时，又来新图标，先把删除落实（撤销窗口关闭），再加新项，顺序清晰。

### 面试深问

**Q1：为什么队列要持久化到磁盘，而不是只存内存？**
安装会话提交广播可能在 Launcher 进程被杀后到达（静态接收器拉起进程），此时内存队列是空的。如果不持久化，进程重启后丢失"待添加"的包，承诺图标就漏了。磁盘文件作为"未完成事务日志"，保证最终一致。`LauncherModel.startLoader` 加载完会 resume flush，把磁盘队列读出来补加。

**Q2：`FLAG_LOADER_RUNNING`、`FLAG_ACTIVITY_PAUSED`、`FLAG_DRAG_AND_DROP` 三个 flag 为什么用位掩码而不是三个 boolean？**
位掩码支持"多原因叠加暂停"。如果用三个 boolean，`pause(A)` 然后 `resume(A)` 时不知道 B、C 是否还暂停，需要计数或引用计数。位掩码 `flags |= A; flags &= ~A` 天然支持叠加，`flags != 0` 一眼判断是否全清零，代码简洁且无歧义。

**Q3：`AddWorkspaceItemsTask` 里 `shortcutExists` 为什么要同时比较"带包名"和"不带包名"两种 intent URI？**
同一个图标的 intent 可能写成 `Intent(package=com.x, component=com.x/.Main)` 或 `Intent(component=com.x/.Main)`（包名隐含在 component 里），两者启动效果一样但 URI 不同。承诺图标入队时只有包名没有 component，正式图标有 component，比较时两个形式都要试，避免误判"不存在"导致重复添加。这是 intent 匹配的历史包袱。

---

## 快捷方式安装：Pin 机制与 AddItemActivity

### 从 ACTION_INSTALL_SHORTCUT 到 PinItemRequest 的演进

老 Android（< 8.0）用 `ACTION_INSTALL_SHORTCUT` 广播让 App 往桌面加快捷方式，Launcher3 旧版有 `InstallShortcutReceiver` 接收它。这种方式有两个问题：任何 App 都能滥发广播塞满桌面，且广播无法交互确认。Android 8.0 引入 `LauncherApps.PinItemRequest` + `ShortcutManager`，改为"App 发起请求 → 系统弹确认 → Launcher 拿到确认后的请求 pin 到桌面"，安全且可交互。

现代 Launcher3 的 `ItemInstallQueue` 类里仍保留着 `TAG = "InstallShortcutReceiver"` 这个历史名字，但实际逻辑已完全基于 Pin 机制。`PinRequestHelper` 是这套机制的封装：

```java
// PinRequestHelper.java —— 从 PinItemRequest 创建桌面项
public static WorkspaceItemInfo createWorkspaceItemFromPinItemRequest(
        Context context, final PinItemRequest request, final long acceptDelay) {
    if (request != null && request.getRequestType() == PinItemRequest.REQUEST_TYPE_SHORTCUT
            && request.isValid()) {

        if (acceptDelay <= 0) {
            if (!request.accept()) return null;  // 立即 accept（在系统进程注册快捷方式）
        } else {
            // 延迟 accept，等拖拽动画完成
            MODEL_EXECUTOR.execute(() -> {
                SystemClock.sleep(acceptDelay);
                if (request.isValid()) request.accept();
            });
        }

        ShortcutInfo si = request.getShortcutInfo();
        WorkspaceItemInfo info = new WorkspaceItemInfo(si, context);
        // 先用缓存图标同步显示，真正图标异步加载
        info.bitmap = CacheableShortcutCachingLogic.INSTANCE.loadIcon(
                context, app.getIconCache(), new CacheableShortcutInfo(si, context));
        app.getModel().updateAndBindWorkspaceItem(info, si);
        return info;
    }
    return null;
}
```

`request.accept()` 是关键调用——它让系统进程把快捷方式标记为"已 pin"，之后即使发起方 App 被卸载，快捷方式仍保留（因为是 Launcher pin 的）。注释里的时序说明很重要：

```java
// PinRequestHelper.java 注释 —— accept 的四步时序
// request.accept() 触发：
//   (a) 跳转到系统进程处理
//   (b) binder 线程回调到 Launcher UI 线程
//   (c) post 到 worker 线程
//   (d) 更新 model，unpin 任何不在 model 里的快捷方式
// 如果 (d) 发生在 model 更新前，系统会错误地 unpin 刚 pin 的快捷方式
// 调用方必须立即把新建的 WorkspaceItemInfo 加入 model，保证 (d) 在 model 更新后
```

这段注释解释了为什么 `acceptDelay` 存在：拖拽放下时，动画要播一会，如果立即 `accept`，系统回调 (d) 可能在动画结束、图标入库前到达，导致系统以为"这个快捷方式 Launcher 没要"而 unpin 它。延迟 `accept` 到动画结束，保证入库先于回调。

### AddItemActivity：确认界面与拖拽

`AddItemActivity` 是清单注册的 Activity，响应 `CONFIRM_PIN_SHORTCUT` 和 `CONFIRM_PIN_APPWIDGET`。当 App 调用 `LauncherApps.pinShortcut` 等接口时，系统启动这个 Activity 让用户确认：

```xml
<!-- AndroidManifest-common.xml —— AddItemActivity 注册 -->
<activity android:name="com.android.launcher3.dragndrop.AddItemActivity"
    android:theme="@style/AddItemActivityTheme"
    android:excludeFromRecents="true"
    android:autoRemoveFromRecents="true"
    android:exported="true">
    <intent-filter>
        <action android:name="android.content.pm.action.CONFIRM_PIN_SHORTCUT" />
        <action android:name="android.content.pm.action.CONFIRM_PIN_APPWIDGET" />
    </intent-filter>
</activity>
```

`excludeFromRecents` 和 `autoRemoveFromRecents` 确保这个确认界面不污染最近任务列表。Activity 提供两种放置方式：拖拽（`onLongClick` 启动系统 drag-and-drop，跨进程拖到 Launcher）或自动放置（`onPlaceAutomaticallyClick` 直接入队）：

```java
// AddItemActivity.java —— 自动放置快捷方式
public void onPlaceAutomaticallyClick(View v) {
    if (mRequest.getRequestType() == PinItemRequest.REQUEST_TYPE_SHORTCUT) {
        ShortcutInfo shortcutInfo = mRequest.getShortcutInfo();
        ItemInstallQueue.INSTANCE.get(this).queueItem(shortcutInfo);  // 入队，等 Loader flush
        logCommand(LAUNCHER_ADD_EXTERNAL_ITEM_PLACED_AUTOMATICALLY);
        mRequest.accept();  // 系统侧确认 pin
        // ... 无障碍播报
        mSlideInView.close(true);
        return;
    }
    // widget 分支：分配 widgetId、bindAppWidgetIdIfAllowed、可能弹绑定确认
    mPendingBindWidgetId = mAppWidgetHolder.allocateAppWidgetId();
    boolean success = mAppWidgetManager.bindAppWidgetIdIfAllowed(
            mPendingBindWidgetId, widgetProviderInfo, mWidgetOptions);
    if (success) {
        acceptWidget(mPendingBindWidgetId);
    } else {
        mAppWidgetHolder.startBindFlow(this, mPendingBindWidgetId, ...); // 请求绑定权限
    }
}
```

拖拽分支（`onLongClick`）更复杂：启动系统 `View.startDragAndDrop`（带 `DRAG_FLAG_GLOBAL` 跨进程），同时启动 Home Intent 回到桌面，注册 `PinItemDragListener` 等桌面接收 drop。drop 后走 `PinShortcutRequestActivityInfo.createWorkspaceItemInfo` → `PinRequestHelper.createWorkspaceItemFromPinItemRequest`，带延迟 accept。

### PinShortcutRequestActivityInfo：快捷方式信息包装

这是 `ShortcutConfigActivityInfo` 的子类，专门包装 `PinItemRequest` 里的快捷方式，供拖拽流程使用。它用一个"永远不存在的类名"作为 component 占位：

```java
// PinShortcutRequestActivityInfo.java —— 快捷方式请求包装
public class PinShortcutRequestActivityInfo extends ShortcutConfigActivityInfo {
    private static final String STUB_COMPONENT_CLASS = "pinned-shortcut"; // 占位类名

    public PinShortcutRequestActivityInfo(
            ShortcutInfo si, Supplier<PinItemRequest> requestSupplier, Context context) {
        super(new ComponentName(si.getPackage(), STUB_COMPONENT_CLASS), // 占位 component
                si.getUserHandle(), context);
        mRequestSupplier = requestSupplier;
        mInfo = si;
    }

    @Override
    public WorkspaceItemInfo createWorkspaceItemInfo() {
        long transitionDuration = ...;  // 计算动画时长
        long duration = ... + SPRING_LOADED_EXIT_DELAY + transitionDuration;
        // 延迟 accept 到动画结束
        return PinRequestHelper.createWorkspaceItemFromPinItemRequest(
                mContext, mRequestSupplier.get(), duration);
    }

    @Override
    public boolean isPersistable() {
        return false;  // Pin 请求的图标不直接持久化（accept 后由系统管）
    }
}
```

`STUB_COMPONENT_CLASS = "pinned-shortcut"` 是个约定字符串，保证不会匹配真实类。深快捷方式的实际启动靠 `ShortcutKey`（包名+shortcutId），不依赖 component 类名。`isPersistable` 返回 false 因为 pin 请求的图标在 accept 前不属于 Launcher，不能存库。

### 面试深问

**Q1：为什么用 `PinItemRequest` 替代 `ACTION_INSTALL_SHORTCUT` 广播？**
广播机制下任何 App 能滥发，且无法用户确认，恶意 App 可塞满桌面。Pin 机制要求 App 通过 `ShortcutManager` 创建 shortcut，再由系统调起 Launcher 的确认界面（`CONFIRM_PIN_SHORTCUT`），用户可见可控；且 pin 操作在系统进程注册，独立于发起方 App 生命周期，更可靠。

**Q2：`acceptDelay` 延迟 accept 的根本原因是什么？**
系统 `accept` 回调里有一步"unpin 不在 Launcher model 里的快捷方式"。如果 accept 在图标入库前完成，系统会发现"model 里没这个 shortcut"而误 unpin。延迟到动画结束（图标已入库）再 accept，保证回调时的 unpin 检查不会误杀刚 pin 的项。这是分布式时序问题的典型解法。

**Q3：`STUB_COMPONENT_CLASS` 用 "pinned-shortcut" 这种占位类名有什么风险？**
理论上如果某个 App 真有个类叫 `pinned-shortcut`，会冲突。但类名不允许连字符（Java 标识符规则），所以这个字符串永远不会是真实类，安全。这是利用语言规范的"不可能值"做占位标记的技巧。

---

## 安装状态变化的模型任务

### PackageInstallStateChangedTask：进度更新

`InstallSessionTracker.onProgressChanged` 把会话进度推给 `PackageInstallStateChangedTask`，它更新承诺图标的进度环：

```java
// PackageInstallStateChangedTask.java —— 安装进度更新
public void execute(ModelTaskController taskController, BgDataModel dataModel, AllAppsList apps) {
    if (mInstallInfo.state == PackageInstallInfo.STATUS_INSTALLED) {
        // 已安装状态交给 onPackageAdded 处理（instant app 特例除外）
        try {
            ApplicationInfo ai = context.getPackageManager()
                    .getApplicationInfo(mInstallInfo.packageName, 0);
            if (InstantAppResolver.newInstance(context).isInstantApp(ai)) {
                // Instant App 不触发 onPackageAdded，手动调
                taskController.getModel().newModelCallbacks()
                        .onPackageAdded(ai.packageName, mInstallInfo.user);
            }
        } catch (PackageManager.NameNotFoundException e) { }
        return;  // 正常已安装事件由 onPackageAdded 处理，这里直接返回
    }

    synchronized (apps) {
        taskController.bindIncrementalUpdates(
                apps.updatePromiseInstallInfo(mInstallInfo, FlagOp.NO_OP)); // 更新 AllApps 进度
    }
    synchronized (dataModel) {
        final List<ItemInfo> updates = dataModel.updateAndCollectWorkspaceItemInfos(
                mInstallInfo.user,
                si -> {
                    if (si.hasPromiseIconUi()                                       // 是承诺图标
                            && mInstallInfo.packageName.equals(si.getTargetPackage())) {
                        si.setProgressLevel(mInstallInfo);  // 更新进度环
                        return true;
                    }
                    return false;
                },
                widget -> { ... });  // widget 也更新 installProgress
        if (!updates.isEmpty()) taskController.bindUpdatedWorkspaceItems(updates);
    }
}
```

Instant App 特例处理：Instant App（免安装体验）不触发 `onPackageAdded`（它没真正"安装"），所以这里手动调 `onPackageAdded` 让它走新增流程。正常已安装事件直接 return，避免和即将到来的 `onPackageAdded` 重复处理。

### PackageIncrementalDownloadUpdatedTask：增量下载

Android 11+ 的增量安装（Incremental Install）边下边用，`onPackageLoadingProgressChanged` 回调触发此任务，更新进度但清除"会话激活"标记：

```kotlin
// PackageIncrementalDownloadUpdatedTask.kt —— 增量下载进度
class PackageIncrementalDownloadUpdatedTask(packageName, user, progress) : ModelUpdateTask {
    init {
        mProgress = 1 - progress > 0.001 ? (int) (100 * progress) : 100  // 浮点转 int，接近完成算 100
    }
    override fun execute(taskController, dataModel, appsList) {
        PackageInstallInfo downloadInfo = PackageInstallInfo(
            mPackageName, PackageInstallInfo.STATUS_INSTALLED_DOWNLOADING, mProgress, mUser)

        synchronized (apps) {
            taskController.bindIncrementalUpdates(appsList.updatePromiseInstallInfo(
                downloadInfo, FlagOp.NO_OP.removeFlag(FLAG_INSTALL_SESSION_ACTIVE))) // 清激活标记
        }
        synchronized (dataModel) {
            updatedWorkspaceItems = dataModel.updateAndCollectWorkspaceItemInfos(mUser) { si ->
                if (mPackageName.equals(si.getTargetPackage())) {
                    si.runtimeStatusFlags &= ~FLAG_INSTALL_SESSION_ACTIVE  // 清激活标记
                    si.setProgressLevel(downloadInfo)
                    true
                } else false
            }
        }
        taskController.bindUpdatedWorkspaceItems(updatedWorkspaceItems)
    }
}
```

`STATUS_INSTALLED_DOWNLOADING` 表示"已安装但还在增量下载剩余数据"，与 `STATUS_INSTALLING`（会话安装中）区分。`FLAG_INSTALL_SESSION_ACTIVE` 被清除表示会话阶段结束，进入增量下载阶段。

### SessionFailureTask：安装失败回滚

会话失败时（`onFinished(success=false)`），`SessionFailureTask` 处理承诺图标的回滚。分两种情况：

```kotlin
// SessionFailureTask.kt —— 安装失败清理
class SessionFailureTask(val packageName: String, val user: UserHandle) : ModelUpdateTask {
    override fun execute(taskController, dataModel, apps) {
        val iconCache = taskController.iconCache
        val isAppArchived = ApplicationInfoWrapper(taskController.context, packageName, user).isArchived()
        synchronized(dataModel) {
            if (isAppArchived) {
                // 归档应用恢复失败：只刷新图标，不删除（归档图标要保留）
                iconCache.remove(ComponentName(packageName, packageName + EMPTY_CLASS_NAME), user)
                val updatedItems = dataModel.updateAndCollectWorkspaceItemInfos(user) { info ->
                    if (info.isArchived) {
                        iconCache.getTitleAndIcon(info, info.matchingLookupFlag)  // 重读图标
                        true
                    } else false
                }
                if (updatedItems.isNotEmpty()) taskController.bindUpdatedWorkspaceItems(updatedItems)
                apps.updateIconsAndLabels(hashSetOf(packageName), user)
                taskController.bindApplicationsIfNeeded()
            } else {
                // 普通安装失败：删掉承诺图标
                val removedItems = dataModel.itemsIdMap.filter { info ->
                    (info is WorkspaceItemInfo && info.hasPromiseIconUi()) &&
                        user == info.user &&
                        TextUtils.equals(packageName, info.intent.getPackage())
                }
                if (removedItems.isNotEmpty()) {
                    taskController.deleteAndBindComponentsRemoved(
                        ItemInfoMatcher.ofItems(removedItems), "removed because install session failed")
                }
            }
        }
    }
}
```

归档应用（Archived App，Android V+）的恢复失败不删图标，因为归档图标本身要长期保留（用户可能稍后再恢复）。普通安装失败则果断删承诺图标——失败了就别占桌面位置。

### 面试深问

**Q1：`PackageInstallStateChangedTask` 收到 `STATUS_INSTALLED` 为什么直接 return？**
因为"安装完成"的权威事件是 `onPackageAdded`（包已注册），会随后到达并做完整处理（转正承诺图标、补 AllAppsList）。如果这里也处理会重复。只有 Instant App（不触发 `onPackageAdded`）需要手动补调。这是事件去重，避免重复处理。

**Q2：增量下载（`STATUS_INSTALLED_DOWNLOADING`）和会话安装（`STATUS_INSTALLING`）UI 上有什么区别？**
会话安装时图标是承诺图标（带下载进度环、可能灰显），因为 App 还不能完整启动；增量下载时 App 已经能启动（核心数据已装），图标正常显示，只是后台还在拉剩余资源。所以前者用 `FLAG_INSTALL_SESSION_ACTIVE`，后者清除它。

**Q3：归档应用恢复失败为什么不删图标，而普通安装失败要删？**
归档应用的图标是"长期占位"，代表一个已归档但用户可能想恢复的 App。恢复失败只是这次操作没成，图标要保留让用户下次重试。普通安装失败则没有"保留价值"——用户没装上，承诺图标就是垃圾，删掉干净。两者的"图标语义"不同导致清理策略不同。

---

## Widget 的恢复机制：AppWidgetsRestoredReceiver

### 备份恢复时的 widget id 重映射

`AppWidgetsRestoredReceiver` 处理设备备份恢复后 widget id 的重新绑定。备份时 widget 的 `appWidgetId` 会变，系统通过这个广播把"旧 id → 新 id"的映射发给 Launcher：

```java
// AppWidgetsRestoredReceiver.java —— widget id 恢复
public class AppWidgetsRestoredReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (AppWidgetManager.ACTION_APPWIDGET_HOST_RESTORED.equals(intent.getAction())) {
            int hostId = intent.getIntExtra(AppWidgetManager.EXTRA_HOST_ID, 0);
            if (hostId != LauncherWidgetHolder.APPWIDGET_HOST_ID) {
                // 不是 Launcher 的 host，忽略（系统里有多个 widget host）
                return;
            }
            final int[] oldIds = intent.getIntArrayExtra(AppWidgetManager.EXTRA_APPWIDGET_OLD_IDS);
            final int[] newIds = intent.getIntArrayExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS);
            if (oldIds != null && newIds != null && oldIds.length == newIds.length) {
                // 持久化新旧 id 映射，等 Loader 用它更新数据库
                LauncherPrefs.get(context).putSync(
                    OLD_APP_WIDGET_IDS.to(IntArray.wrap(oldIds).toConcatString()),
                    APP_WIDGET_IDS.to(IntArray.wrap(newIds).toConcatString()));
                if (!RestoreDbTask.isPending(context)) {
                    // 数据库恢复还没 pending，警告（可能时序错乱）
                }
            }
        }
    }
}
```

它只做一件事：把新旧 id 映射存进 `LauncherPrefs`。真正的数据库更新在 `LoaderTask` 加载时根据这些映射完成（`LauncherAppWidgetInfo` 的 `appWidgetId` 字段被批量更新）。`hostId` 校验确保只处理自己的 widget host（避免误处理其他 host 的恢复事件）。

### 与 PackageUpdatedTask 的协作

widget 的"provider 就绪"状态由 `PackageUpdatedTask` 处理。当 widget provider 的 App 安装/更新时，原本 `FLAG_PROVIDER_NOT_READY` 的 widget 会被标记为可绑定：

```java
// PackageUpdatedTask.java —— widget provider 就绪处理（节选自 widget 回调）
widget -> {
    if (widget.hasRestoreFlag(FLAG_PROVIDER_NOT_READY)
            && mPackages.contains(widget.providerName.getPackageName())) {
        widget.restoreStatus &= ~FLAG_PROVIDER_NOT_READY & ~FLAG_RESTORE_STARTED;
        // 标记 UI 未就绪，绑定时会显示"点击设置"
        widget.restoreStatus |= LauncherAppWidgetInfo.FLAG_UI_NOT_READY;
        widget.installProgress = 100;
        taskController.getModelWriter().updateItemInDatabase(widget);
        return true;
    }
    return false;
}
```

`FLAG_PROVIDER_NOT_READY` 表示 widget 的 App 装了但 provider 还没准备好（比如刚恢复备份）。App 更新后 provider 可用了，清掉这个标记，但加 `FLAG_UI_NOT_READY`——绑定时会判断如果有配置 Activity 就弹"点击设置"，否则直接标记为已恢复。

### 面试深问

**Q1：为什么 widget id 在备份恢复后会变？**
`appWidgetId` 是 `AppWidgetHost.allocateAppWidgetId()` 分配的运行时序号，新设备从 0 开始重新分配，和旧设备的 id 必然不同。系统通过 `APPWIDGET_HOST_RESTORED` 广播把"旧 id 数组 → 新 id 数组"的映射告诉 host，host 据此更新数据库里存的 id，否则 widget 绑定会失效。

**Q2：`hostId` 校验为什么重要？**
一台设备可能有多个 widget host（Launcher、锁屏、其他 App）。恢复广播会发给所有 host，每个广播带自己的 `hostId`。Launcher 只处理 `APPWIDGET_HOST_ID`（自己的常量）匹配的，避免把别的 host 的 id 映射写进自己的 prefs，导致数据库错乱。

**Q3：`FLAG_PROVIDER_NOT_READY` 和 `FLAG_UI_NOT_READY` 有什么区别？**
前者表示 provider（App 的 `AppWidgetProvider`）还没准备好（App 没装、没启动）；后者表示 provider 就绪了但 UI 还没渲染（需要用户点击配置或系统绑定）。恢复流程是：`NOT_READY`（provider 缺）→ provider 来了 → 清 `NOT_READY`、加 `UI_NOT_READY` → 绑定成功 → 清 `UI_NOT_READY`。两阶段保证状态清晰。

---

## ShortcutConfigActivityInfo：老的创建快捷方式 Activity

### 兼容 legacy 快捷方式配置

虽然 Android 8.0+ 推荐 `PinItemRequest`，但仍有 App 通过 `ACTION_CREATE_SHORTCUT` Intent 暴露配置 Activity（老的快捷方式创建机制）。`ShortcutConfigActivityInfo` 包装这类 Activity 信息：

```java
// ShortcutConfigActivityInfo.java —— 配置 Activity 信息包装
public abstract class ShortcutConfigActivityInfo implements CachedObject {
    public boolean startConfigActivity(Activity activity, int requestCode) {
        Intent intent = new Intent(Intent.ACTION_CREATE_SHORTCUT).setComponent(getComponent());
        try {
            activity.startActivityForResult(intent, requestCode);  // 启动 App 的配置界面
            return true;
        } catch (ActivityNotFoundException e) {
            Toast.makeText(activity, R.string.activity_not_found, Toast.LENGTH_SHORT).show();
        } catch (SecurityException e) {
            // exported 配置错误提示
        }
        return false;
    }

    // 查询所有支持快捷方式配置的 Activity
    public static List<ShortcutConfigActivityInfo> queryList(
            Context context, @Nullable PackageUserKey packageUser) {
        List<ShortcutConfigActivityInfo> result = new ArrayList<>();
        // ... 遍历用户
        for (LauncherActivityInfo activityInfo :
                launcherApps.getShortcutConfigActivityList(packageName, user)) {
            if (activityInfo.getApplicationInfo().targetSdkVersion >= Build.VERSION_CODES.O) {
                result.add(new ShortcutConfigActivityInfoVO(activityInfo));  // O+ 才支持
            }
        }
        return result;
    }
}
```

`targetSdkVersion >= O` 的过滤很关键：只有 targetSdk 26+ 的 App 才被允许用新机制，老 App 仍走广播。这保证兼容性的同时推动新机制普及。`ShortcutConfigActivityInfoVO` 是 O+ 的实现，多用户场景用 `LauncherApps.getShortcutConfigActivityIntent` 跨用户启动配置 Activity。

### 面试深问

**Q1：`ACTION_CREATE_SHORTCUT` 和 `CONFIRM_PIN_SHORTCUT` 什么时候分别用？**
前者是老机制：Launcher 主动查 App 有没有配置 Activity，用户在 Launcher 的"添加快捷方式"列表里选，App 返回一个 shortcut Intent。后者是新机制：App 主动调 `ShortcutManager` 创建 shortcut，系统弹确认。老机制 Launcher 主导，新机制 App 主导，用户体验上新机制更安全可控。

**Q2：为什么 `targetSdkVersion < O` 的 App 不进 `queryList` 结果？**
Android O 之前 `ShortcutConfigActivity` 的语义和权限模型不同，混用会出错。Google 强制要求 targetSdk 升级到 O 才能用这套 API，既保证一致性又推动生态升级。这是通过 API 门禁倒逼 targetSdk 提升。

**Q3：多用户场景下 `startConfigActivity` 为什么要分主用户和其他用户两个分支？**
主用户直接 `startActivityForResult`（同进程）；其他用户（工作资料）要跨用户启动，用 `LauncherApps.getShortcutConfigActivityIntent` 拿 `IntentSender` 再 `startIntentSenderForResult`，带 `allowBGLaunch` 的 ActivityOptions。跨用户 Intent 必须走系统中介，不能直接启动。

---

## 完整时序：一次应用安装的全链路

把前面的机制串起来，看一次 Play Store 安装 App 在 Launcher 侧的完整时序：

```
用户点 Play Store "安装"
    ↓
Play Store 创建 PackageInstaller.Session，开始下载
    ↓
InstallSessionTracker.onCreated(sessionId)              [会话创建]
    ├─ pushSessionDisplayToLauncher → onUpdateSessionDisplay（更新图标缓存）
    └─ tryQueuePromiseAppIcon → verifySessionInfo 五条件
        └─ ItemInstallQueue.queueItem(packageName, user)  [承诺图标入队]
            └─ 若 Loader 未完成 → FLAG_LOADER_RUNNING 暂停，存磁盘
            └─ 若 Loader 完成 → flush → AddWorkspaceItemsTask [承诺图标上桌面]
    ↓
下载中 onProgressChanged(sessionId, progress)
    └─ PackageInstallStateChangedTask → 更新承诺图标进度环
    ↓
Play Store 调 session.commit()                          [会话提交]
    ↓
系统发 ACTION_SESSION_COMMITTED 广播
    └─ SessionCommitReceiver.processIntent
        ├─ isEnabled?（开关 + 私密空间）
        ├─ INSTALL_REASON_USER?
        └─ queueItem → ItemInstallQueue（可能重复，去重）
    ↓
包注册到 PackageManager
    └─ LauncherApps.Callback.onPackageAdded(packageName, user)
        └─ PackageUpdatedTask(OP_ADD)
            ├─ 承诺图标转正（status = DEFAULT，补 intent）
            ├─ AllAppsList 补条目
            └─ bindApplicationsIfNeeded（应用抽屉出现）
    ↓
InstallSessionTracker.onFinished(sessionId, success=true)
    └─ PackageInstallStateChangedTask(STATUS_INSTALLED) → 直接 return（onPackageAdded 已处理）
```

这条链路横跨三个事件源（SessionCallback、BroadcastReceiver、LauncherApps.Callback）、两个后台任务队列（InstallSessionTracker 的回调、LauncherModel 的任务队列）、一次磁盘持久化（ItemInstallQueue 的 `apps_to_install` 文件）。任何一个环节的设计（信任校验、五条件门禁、暂停 flag、转正逻辑）都是为了保证"承诺图标最终与真实安装状态一致"。

### 面试深问

**Q1：如果安装过程中 Launcher 进程被杀，重启后承诺图标还能恢复吗？**
能。承诺图标的 sessionId 持久化在 `LauncherPrefs.PROMISE_ICON_IDS`，队列项持久化在 `apps_to_install` 文件。重启后 `getPromiseIconIds` 校验 sessionId 是否仍对应活跃会话，`ItemInstallQueue.flushQueueInBackground` 在 Loader 完成后从磁盘读队列补加。整个链路设计成幂等且可恢复的。

**Q2：`SESSION_COMMITTED` 和 `onPackageAdded` 几乎同时到，`queueItem` 会调两次，会重复加图标吗？**
不会。`PendingInstallShortcutInfo.equals` 基于包名+用户+intent 比对，`addToQueue` 里 `if (!mItems.contains(info))` 去重。且 `AddWorkspaceItemsTask.shortcutExists` 落库前再查一次桌面是否已有同 intent 项。多重去重保证幂等。

**Q3：承诺图标转正失败（App 装了但 Activity 找不到）会怎样？**
`PackageUpdatedTask` 里 `if (!isTargetValid)` 分支：如果是 `FLAG_RESTORED_ICON|FLAG_AUTOINSTALL_ICON` 且能修正 intent 就修，否则 `removedShortcuts.add(id)` 删除。保证桌面不留死链图标。这是"防御式编程"——即使中间状态异常，最终也能自洽。

---

## 设计意图总结

把全文的设计决策归纳为五条原则：

1. **事件归一化**：三个异构事件源（`LauncherApps.Callback`、`SessionCallback`、`BroadcastReceiver`）统一翻译成 `ModelUpdateTask`，单线程串行执行，避免并发改库。这是"命令模式 + 单消费者"的并发控制。

2. **信任边界**：`InstallSessionHelper.verify` 只信系统签名的安装器，`SessionCommitReceiver` 只处理用户主动安装（`INSTALL_REASON_USER`），双重过滤防止恶意 App 伪造安装骗图标。

3. **乐观提前显示**：承诺图标在 App 真正安装前就上桌面，失败再回滚。用"可能错误但快速"换体验，配合完善的回滚（`SessionFailureTask`）兜底。

4. **多原因暂停的位掩码**：`ItemInstallQueue` 用三个 bit 控制 flush 时机，覆盖 Loader/Activity/拖拽三种生命周期，磁盘持久化保证跨进程重启不丢。

5. **多用户隔离贯穿始终**：所有事件、任务、数据结构都带 `UserHandle`，`UserCache` 缓存用户状态，`LauncherApps` API 天然按用户查询，私密空间/工作资料/克隆资料各有独立类型和可见性规则。

这套机制让 Launcher3 在面对"装上万个 App、多用户、静默安装、增量下载、归档恢复"等复杂场景时，仍能保持桌面图标与系统真实包状态的一致性。
