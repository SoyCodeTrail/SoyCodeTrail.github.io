---
title: Launcher3 源码精读（03）：数据模型
category: client
platform: android
tags: ["AOSP", "Launcher3", "源码", "Framework"]
readTime: 27分钟
featured: true
date: 2026-08-02
---

# Launcher3 数据模型层源码精读

> 源码基线：`aosp-r4`（`packages/apps/Launcher3`）
> 源码路径：`src/com/android/launcher3/model/`、`src/com/android/launcher3/model/data/`、`src/com/android/launcher3/icons/`
> 本篇讲透：**一条 Favorites 表记录 → ItemInfo 内存对象 → 屏幕上的一个图标** 的完整链路，以及增删改的乐观更新、loadId 守卫、Undo 回滚、IconCache 两级缓存与批量加载。
> 关键演进：旧版 `SparseArray<ItemInfo> itemsIdMap` 已重构为 `WorkspaceData` sealed class（可变/不可变双态）；DB 写入由 `LauncherProvider` 下沉到 `ModelDbController`；变更通知在 `Flags.modelRepository()` 下额外 dispatch 给 `HomeScreenRepository`，向响应式架构过渡。

涉及的核心类（13 个）：

| 类 | 语言 | 行数 | 职责 |
|----|------|------|------|
| `BgDataModel.kt` | Kotlin | 456 | 后台线程持有的内存模型，唯一真相来源 |
| `WorkspaceData.kt` | Kotlin | 124 | `itemsIdMap` 的可变/不可变双态 sealed class |
| `ItemInfo.java` | Java | 600 | 桌面项基类（id/container/cell/screen…） |
| `ItemInfoWithIcon.java` | Java | 364 | 带图标的项（bitmap + runtimeStatusFlags） |
| `WorkspaceItemInfo.java` | Java | 274 | 桌面快捷方式/应用/深度快捷 |
| `LauncherAppWidgetInfo.java` | Java | 282 | 桌面小组件 |
| `FolderInfo.java`/`CollectionInfo.kt` | Java/Kotlin | 326/44 | 文件夹与"集合"抽象基类 |
| `AppPairInfo.kt` | Kotlin | 119 | 应用对（分屏启动两个 App） |
| `LoaderTask.java` | Java | 800 | 全量加载 Runnable，五段式有序加载 |
| `LoaderCursor.java` | Java | 673 | Cursor 包装 + 行解析 + 位置校验 |
| `WorkspaceItemProcessor.kt` | Kotlin | 829 | 单行记录的类型分发处理 |
| `IconCache.java`/`BaseIconCache.java` | Java | 662/570 | 图标两级缓存 + 批量加载 |
| `ModelWriter.java` | Java | 550 | 增删改的唯一入口（乐观更新 + Undo） |

---

## 一、架构总览

### 1.1 三层 MVC + 异步加载

Launcher3 数据模型是 **"后台线程 + 内存模型 + 主线程绑定"** 的三段式结构。数据库是持久层，`BgDataModel` 是内存层（后台线程唯一真相来源），`Callbacks` 是 UI 层契约。

```
┌─────────────────────────────────────────────────────────────────┐
│                        SQLite 持久层                             │
│  launcher.db ── Favorites 表（桌面项位置/元信息，每行一个 ItemInfo）│
│  icon_cache.db ── icons 表（图标 BLOB + label + system_state）    │
└───────────────┬─────────────────────────────────┬───────────────┘
                │ LoaderTask 读 Favorites           │ IconCache 读写 icons
                ▼                                   ▼
┌───────────────────────────────────┐  ┌──────────────────────────┐
│      BgDataModel (内存模型)        │  │     IconCache (图标缓存)   │
│  itemsIdMap : WorkspaceData        │  │  内存: Map<ComponentKey,  │
│   (MutableWorkspaceData 内部        │  │         CacheEntry>       │
│    持有 SparseArray<ItemInfo>)     │  │  磁盘: icon_cache.db      │
│  widgetsModel / deepShortcutMap    │  └──────────────────────────┘
│  extraItems / stringCache          │
│  AllAppsList (应用列表，平行结构)   │
└───────────────┬───────────────────┘
                │ BaseLauncherBinder.bindWorkspace() 拷贝不可变快照
                ▼
┌─────────────────────────────────────────────────────────────────┐
│                  UI 层 (Main Thread / Callbacks)                  │
│   bindCompleteModelAsync(itemsIdMap) → 遍历建 BubbleTextView      │
│   bindItemsAdded / bindItemsUpdated / bindWorkspaceComponentsRemoved│
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 三个线程模型

| 线程 | 执行器 | 职责 |
|------|--------|------|
| 后台线程 | `MODEL_EXECUTOR` | 跑 `LoaderTask`、读写 DB、维护 `BgDataModel`、跑 `ModelWriter.ModelTask` |
| 主线程 | `MAIN_EXECUTOR` | 渲染 UI、接收 `Callbacks.bindXxx`、用户交互 |
| IconCache 工作线程 | `workerHandler`（绑定 `MODEL_EXECUTOR.getLooper()`） | 图标加载/生成/缓存，与模型同 Looper |

铁律：`BgDataModel` 的所有字段访问必须 `synchronized(mBgDataModel)`，且实际只在 `MODEL_EXECUTOR` 上写；UI 线程拿到的永远是 `itemsIdMap.copy()` 出来的不可变快照。

### 1.3 LoaderTask 的事务保护

`LoaderTask.run()` 用 `try-with-resources` 包住整个加载过程，`LoaderTransaction` 是一致性边界：进入时 `lastLoadId++` 并置 `mModelLoaded=false`，`commit()` 才置回 `true`。中途被抢占（`stopLocked`）抛 `CancellationException`，整个加载作废，不污染旧模型。

```java
// LoaderTask.java
public void run() {
    synchronized (this) {
        if (mStopped) return;                  // 进来前就被取消，直接退出
    }
    TraceHelper.INSTANCE.beginSection(TAG);
    MODEL_EXECUTOR.elevatePriority(CALLER_LOADER_TASK);   // 抬高优先级，避免被后台任务饿死
    LoaderMemoryLogger memoryLogger = new LoaderMemoryLogger();
    try (LauncherModel.LoaderTransaction transaction = mModel.beginLoader(this)) {
        loadAllSurfacesOrdered(memoryLogger, restoreEventLogger);   // 五段式加载
        transaction.commit();                  // 成功才提交（mModelLoaded=true）
        memoryLogger.clearLogs();
    } catch (CancellationException e) {
        // 被新 LoaderTask 抢占，静默丢弃
        FileLog.w(TAG, "LoaderTask cancelled");
    } catch (Exception e) {
        memoryLogger.printLogs();              // 打印内存日志辅助排查
        throw e;
    }
    MODEL_EXECUTOR.restorePriority(CALLER_LOADER_TASK);
}
```

`beginLoader` 内部校验 `mLoaderTask === task`，不等说明已被抢占，抛 `CancellationException`。这是"同一时刻只有一个 LoaderTask"的硬保证。

```kotlin
// LauncherModel.kt —— LoaderTransaction
inner class LoaderTransaction(task: LoaderTask) : AutoCloseable {
    init {
        synchronized(mLock) {
            if (mLoaderTask !== task) {                 // 抢占检测
                throw CancellationException("Loader already stopped")
            }
            this@LauncherModel.lastLoadId++             // 全局 loadId 自增，ModelWriter 用它做守卫
            mIsLoaderTaskRunning = true
            mModelLoaded = false                        // 加载期间标记未就绪
        }
    }
    fun commit() { synchronized(mLock) { mModelLoaded = true } }
    override fun close() {
        synchronized(mLock) {
            if (mLoaderTask === mTask) mLoaderTask = null
            mIsLoaderTaskRunning = false
        }
    }
}
```

### 面试深问

1. **Q：为什么用 `try-with-resources` 而不是 try/finally？**
   A：`LoaderTransaction` 实现 `AutoCloseable`，`close()` 在 `mLoaderTask === mTask` 时清空引用并复位 `mIsLoaderTaskRunning`。无论正常结束还是异常，必须保证运行标志复位，否则后续 `reloadIfActive` 会误判"仍在加载"导致永远不重载。

2. **Q：两个 LoaderTask 会并发跑吗？**
   A：不会。`startLoader` 在 `synchronized(mLock)` 里 `stopLoader()` 先 `stopLocked()` 旧任务（置 `mStopped=true` 并 `notify`），再 `MODEL_EXECUTOR.post(task)` 新任务。旧任务在 `while(!mStopped && c.moveToNext())` 检查点退出，`beginLoader` 的 `mLoaderTask !== task` 校验是最后一道保险。

3. **Q：`elevatePriority` 抬高优先级有什么用？**
   A：`MODEL_EXECUTOR` 是共享后台线程池，默认与图标缓存、包变更任务竞争。`CALLER_LOADER_TASK` 让 LoaderTask 期间线程优先级临时提升，避免冷启动时被低优先级任务（如图标预生成）拖慢首屏渲染。

---

## 二、BgDataModel：内存模型唯一真相

> 源文件：`model/BgDataModel.kt`
> 注释原文：*"All the data stored in-memory and managed by the LauncherModel. All the static data should be accessed on the background thread. A lock should be acquired on this object when accessing any data from this model."*

`BgDataModel` 由 Dagger 注入（`@LauncherAppSingleton`），全局单例。它只持有"桌面工作区"相关的数据；AllApps 列表在平行的 `AllAppsList` 里。

### 2.1 核心字段

```kotlin
@LauncherAppSingleton                              // Dagger 全局单例
class BgDataModel @Inject constructor(
    @JvmField val widgetsModel: WidgetsModel,       // 可用小组件模型（注入）
    private val repo: Provider<HomeScreenRepository>, // 新响应式 Repository（Flag 控制）
    dumpManager: DumpManager,
    lifeCycle: DaggerSingletonTracker,
) : LauncherDumpable {

    private val mutableWorkspaceData = MutableWorkspaceData()  // 真正持有数据的可变实现

    /** 所有桌面项的 id → ItemInfo 映射（对外暴露为 WorkspaceData 抽象） */
    @JvmField val itemsIdMap: WorkspaceData = mutableWorkspaceData

    /** 额外容器项（已废弃，迁移到独立 repository） */
    @Deprecated("Use independent repository for each extra item")
    @JvmField val extraItems = IntSparseArrayMap<FixedContainerItems>()

    /** 每个 App 对应的 deep shortcut 计数：ComponentKey → 数量 */
    var deepShortcutMap: Map<ComponentKey, Int> = emptyMap()
        private set

    /** 多用户/工作资料场景下的文案缓存 */
    var stringCache = StringCache.EMPTY
        private set

    @JvmField var lastBindId: Int = 0      // 上一次绑定到 UI 的版本号（每次 bindWorkspace 自增）
    @JvmField var lastLoadId: Int = -1     // 上一次成功加载的 loadId（LoaderTransaction 自增）
}
```

字段含义与存储内容：

| 字段 | 类型 | 存什么 | 由谁填充 |
|------|------|--------|----------|
| `itemsIdMap` | `WorkspaceData`（内部 `SparseArray<ItemInfo>`） | 所有桌面项（快捷方式/文件夹/小组件/应用对）按 DB 主键索引 | `LoaderTask.loadWorkspaceImpl` → `dataLoadComplete` |
| `widgetsModel` | `WidgetsModel` | 所有可用 widget provider（按包分组） | `LoaderTask` 第四步 `widgetsModel.update` |
| `deepShortcutMap` | `Map<ComponentKey, Int>` | 每个 Activity 的 deep shortcut 数量（用于角标） | `LoaderTask.loadDeepShortcuts` → `updateDeepShortcutCounts` |
| `extraItems` | `IntSparseArrayMap<FixedContainerItems>` | 固定容器预测项（Hotseat/AllApps 预测） | `ModelDelegate.loadAndAddExtraModelItems` |
| `stringCache` | `StringCache` | 多用户/工作资料场景的本地化文案 | `updateStringCache(context)` |
| `lastBindId` | `Int` | 绑定版本号，`ModelVerifier` 用它判断是否需要 rebind | `BaseLauncherBinder.bindWorkspace` |
| `lastLoadId` | `Int` | 加载周期 id，`ModelTask` 用它丢弃过期任务 | `LoaderTransaction.init` |

### 2.2 itemsIdMap 的真身：WorkspaceData sealed class（重点设计）

旧版 `itemsIdMap` 是裸 `SparseArray<ItemInfo>`，UI 线程直接引用同一对象加锁访问，竞态频发。新版抽象成 `WorkspaceData` sealed class，**可变/不可变双态**，让跨线程快照传递变得安全。

> 源文件：`model/data/WorkspaceData.kt`

```kotlin
sealed class WorkspaceData : Iterable<ItemInfo> {

    /** 收集所有 CONTAINER_DESKTOP 项的 screenId（用于决定要渲染几屏） */
    fun collectWorkspaceScreens(): IntArray {
        val screenSet = IntSet()
        forEach { if (it.container == CONTAINER_DESKTOP) screenSet.add(it.screenId) }
        if (qsbOnFirstScreen() || screenSet.isEmpty) {
            screenSet.add(Workspace.FIRST_SCREEN_ID)   // QSB 屏或空桌面也至少留一屏
        }
        return screenSet.array
    }

    abstract operator fun get(id: Int): ItemInfo?      // 按 id 取项
    abstract val version: Int                            // 一次全量加载周期自增（replaceDataMap 时）
    abstract val modificationId: Int                     // 局部增删改自增
    abstract fun copy(): WorkspaceData                   // 产出不可变快照

    /** 取某个预测容器的预填项 */
    fun getPredictedContents(containerId: Int): List<ItemInfo> =
        get(containerId).let { if (it is PredictedContainerInfo) it.getContents() else null } ?: emptyList()

    /** 可变实现 —— BgDataModel 内部真正持有 */
    class MutableWorkspaceData : WorkspaceData() {
        val itemsIdMap = SparseArray<ItemInfo>()         // 真正的存储
        override var version: Int = VERSION_COUNTER.incrementAndGet()  // 构造即自增
        override var modificationId: Int = 0
        override fun get(id: Int): ItemInfo? = itemsIdMap.get(id)

        /** 全量替换（LoaderTask 加载完一批后调用，version++，modificationId 清零） */
        fun replaceDataMap(items: SparseArray<ItemInfo>) {
            itemsIdMap.clear()
            itemsIdMap.putAll(items)
            version = VERSION_COUNTER.incrementAndGet()
            modificationId = 0
        }

        /** 局部修改（增删改），每次调用 modificationId++，version 不变 */
        inline fun modifyItems(block: SparseArray<ItemInfo>.() -> Unit) {
            block.invoke(itemsIdMap)
            modificationId++
        }

        override fun copy(): WorkspaceData =
            ImmutableWorkspaceData(version, modificationId, itemsIdMap)   // 产出不可变快照
    }

    /** 不可变实现 —— 拷贝给 UI 线程用 */
    class ImmutableWorkspaceData(
        override val version: Int,
        override val modificationId: Int,
        items: SparseArray<ItemInfo>,
    ) : WorkspaceData() {
        private val itemsIdMap = items.clone()           // 浅拷贝 SparseArray（结构独立）
        override fun get(id: Int): ItemInfo? = itemsIdMap.get(id)
        override fun copy(): WorkspaceData = this        // 自身即不可变，直接返回
    }

    companion object {
        private val VERSION_COUNTER = AtomicInteger()    // 全局自增计数器
    }
}
```

设计要点：

- `version` 标识"一次全量加载周期"，`replaceDataMap` 时自增；`modificationId` 标识"周期内的局部修改"，`modifyItems` 时自增。UI 线程据此判断拿到的快照是否过期。
- `copy()` 在 `MutableWorkspaceData` 返回 `ImmutableWorkspaceData`，构造时 `items.clone()` 浅拷贝 SparseArray——**数组结构独立，但 ItemInfo 引用共享**。因此 ItemInfo 字段语义上要当不可变对待（实际通过 `checkItemInfoLocked` 强制引用一致性）。
- `BaseLauncherBinder.bindWorkspace()` 调 `mBgDataModel.itemsIdMap.copy()` 拿不可变快照，丢给主线程 `bindCompleteModelAsync`。

### 2.3 增删改 API

```kotlin
@Synchronized                                     // 所有变更都加锁
fun addItems(context: Context, items: List<ItemInfo>, owner: Any? = null) {
    mutableWorkspaceData.modifyItems { items.forEach { put(it.id, it) } }   // 进 SparseArray，modificationId++
    if (Flags.modelRepository()) {                                           // 新架构：额外 dispatch
        repo.get().dispatchWorkspaceDataChange(mutableWorkspaceData.copy(), AddEvent(items, owner))
    }
    items.filter { it.itemType == ITEM_TYPE_DEEP_SHORTCUT }                  // deep shortcut 同步系统 pin 状态
        .map { it.user }.distinct()
        .forEach { updateShortcutPinnedState(context, it) }
}

@Synchronized
fun removeItem(context: Context, items: Collection<ItemInfo>, owner: Any? = null) {
    if (BuildConfig.IS_STUDIO_BUILD) {                                        // debug 校验：删集合时其子项不能遗漏
        items.asSequence()
            .filter { it.itemType == ITEM_TYPE_FOLDER || it.itemType == ITEM_TYPE_APP_PAIR }
            .forEach { item ->
                itemsIdMap.filter { it.container == item.id && !items.contains(it) }
                    .forEach { Log.e(TAG, "deleting a collection ($item) which still contains item ($info)") }
            }
    }
    mutableWorkspaceData.modifyItems { items.forEach { remove(it.id) } }      // 从 SparseArray 删
    if (Flags.modelRepository()) {
        repo.get().dispatchWorkspaceDataChange(mutableWorkspaceData.copy(), RemoveEvent(ItemInfoMatcher.ofItems(items), owner))
    }
    items.asSequence().map { it.user }.distinct()
        .forEach { updateShortcutPinnedState(context, it) }
}

@Synchronized
fun updateAndDispatchItem(item: ItemInfo, owner: Any?) {                       // 单项更新
    mutableWorkspaceData.modifyItems { put(item.id, item) }
    if (Flags.modelRepository()) {
        repo.get().dispatchWorkspaceDataChange(mutableWorkspaceData.copy(), UpdateEvent(listOf(item), owner))
    }
}

@Synchronized
fun updateItems(items: List<ItemInfo>, owner: Any?) {                          // 批量更新（字段已在对象上改好）
    mutableWorkspaceData.modifyItems {}                                        // 注意：只触发 modificationId++
    if (Flags.modelRepository()) {
        repo.get().dispatchWorkspaceDataChange(mutableWorkspaceData.copy(), UpdateEvent(items, owner))
    }
}

@Synchronized
fun dataLoadComplete(allItems: SparseArray<ItemInfo>) {                        // LoaderTask 全量加载完调用
    mutableWorkspaceData.replaceDataMap(allItems)                              // version++，modificationId=0
    if (Flags.modelRepository()) {
        repo.get().dispatchWorkspaceDataChange(mutableWorkspaceData.copy(), null)  // null event = 全量重置
    }
}
```

API 速查：

| 方法 | 作用 | modificationId | version | 通知 Repository |
|------|------|----------------|---------|-----------------|
| `addItem`/`addItems` | 加入 itemsIdMap | ++ | 不变 | `AddEvent` |
| `removeItem` | 从 itemsIdMap 删 | ++ | 不变 | `RemoveEvent`（用 Predicate） |
| `updateAndDispatchItem` | 替换单项 | ++ | 不变 | `UpdateEvent` |
| `updateItems` | 批量更新（已改字段） | ++ | 不变 | `UpdateEvent` |
| `dataLoadComplete` | 全量替换 | 清零 | ++ | `null`（全量重置） |
| `clear` | 清 deepShortcutMap/extraItems | — | — | 否 |

`WorkspaceChangeEvent` 是变更事件 sealed class，`owner` 用 `WeakReference` 持有，便于客户端过滤"自己触发的变更"：

```kotlin
sealed class WorkspaceChangeEvent(actualOwner: Any?) {
    private val ownerRef = WeakReference(actualOwner)           // 弱引用，避免泄漏 UI 组件
    val owner: Any? get() = ownerRef.get()
    class AddEvent(val items: List<ItemInfo>, owner: Any?) : WorkspaceChangeEvent(owner)
    class UpdateEvent(val items: List<ItemInfo>, owner: Any?) : WorkspaceChangeEvent(owner)
    class RemoveEvent(val items: Predicate<ItemInfo?>, owner: Any?) : WorkspaceChangeEvent(owner)  // 用 Predicate，因为项可能已不存在
}
```

### 2.4 Callbacks 接口（后台 → UI 契约）

`BgDataModel.Callbacks` 定义所有 bind 通道。`Launcher`（通过 `LauncherModel`）实现它。

```kotlin
interface Callbacks {
    @AnyThread
    fun bindCompleteModelAsync(itemIdMap: WorkspaceData, isBindingSync: Boolean) {
        Executors.MAIN_EXECUTOR.execute { bindCompleteModel(itemIdMap, isBindingSync) }   // 默认切主线程
    }
    fun bindCompleteModel(itemIdMap: WorkspaceData, isBindingSync: Boolean) {}
    fun bindItemsAdded(items: List<@JvmSuppressWildcards ItemInfo>) {}           // 增量新增（拖入/新装）
    fun bindItemsUpdated(updates: Set<@JvmSuppressWildcards ItemInfo>) {}        // 增量更新（移动/改大小）
    fun bindWorkspaceComponentsRemoved(matcher: Predicate<ItemInfo?>) {}         // 批量删除（卸载应用）
    fun bindIncrementalDownloadProgressUpdated(app: AppInfo) {}                  // 下载进度
    fun bindAllWidgets(widgets: List<@JvmSuppressWildcards WidgetsListBaseEntry>) {}
    fun bindExtraContainerItems(item: FixedContainerItems) {}
    fun bindAllApplications(apps: Array<AppInfo>, flags: Int, packageUserKeytoUidMap: Map<PackageUserKey, Int>) {}
    fun bindStringCache(cache: StringCache) {}
}
```

`FixedContainerItems` 是"固定容器"的不可变项列表（如预测区）：

```kotlin
class FixedContainerItems(@JvmField val containerId: Int, items: List<ItemInfo>) {
    @JvmField val items: List<ItemInfo> = Collections.unmodifiableList(items)   // 不可变包装
}
```

### 面试深问

1. **Q：`updateItems` 里 `modifyItems {}` 传了空 block，为什么？**
   A：`updateItems` 被调用时，调用方（如 `UpdateItemRunnable`）已经直接修改了 ItemInfo 对象的字段（引用共享），不需要再操作 SparseArray。这里调 `modifyItems {}` 唯一目的是让 `modificationId++`，并触发 `dispatchWorkspaceDataChange` 通知 Repository/UI。

2. **Q：`copy()` 是浅拷贝，ItemInfo 还是共享的，怎么保证 UI 线程安全？**
   A：靠两层约束。一是 `ModelWriter.checkItemInfoLocked` 强制 `itemsIdMap` 里的引用和传入对象是同一引用（`item != modelItem` 直接抛异常），保证改字段即对 UI 可见；二是约定 ItemInfo 字段语义上不可变，需要改时走 `ModelWriter.modifyItemInDatabase` 整体替换。

3. **Q：`removeItem` 为什么用 `Predicate` 而不是直接传 `List<ItemInfo>`？**
   A：`RemoveEvent` 的场景是"匹配某条件的项都被删"（如卸载应用要删该包下所有快捷方式），此时项可能已不在模型里。用 `Predicate<ItemInfo?>` 能表达"匹配即删"的语义，比传具体对象列表更通用。

---

## 三、ItemInfo 继承体系（桌面项数据模型）

所有能放在桌面上的东西都是 `ItemInfo` 子类。

### 3.1 完整继承关系图

```
                          ┌──────────────┐
                          │   ItemInfo    │  基类：id/container/cellX/cellY/screenId/itemType/user/spanX/spanY/rank/title
                          │   (Java)      │  方法：writeToValues/onAddToDatabase/isInHotseat/isPredictedItem/buildProto
                          └──────┬───────┘
                                 │
            ┌────────────────────┼──────────────────────────────┐
            │                    │                               │
   ┌────────┴─────────┐  ┌───────┴────────┐            ┌────────┴─────────────┐
   │ ItemInfoWithIcon  │  │ CollectionInfo │            │ LauncherAppWidgetInfo│
   │ (abstract)        │  │ (abstract kt)  │            │ (直接继承 ItemInfo)   │
   │ +bitmap           │  │ +add/getContents│           │ +appWidgetId         │
   │ +runtimeStatusFlags│ │ +getAppContents │           │ +providerName        │
   │ +mProgressLevel   │  └───────┬────────┘            │ +restoreStatus       │
   └────────┬─────────┘          │                      └──────────────────────┘
            │                    │
   ┌────────┴──────────────┐     │
   │                       │     │
┌──┴──────┐  ┌─────────────┴──┐  ├──────────────────┐
│AppInfo  │  │WorkspaceItemInfo│  │                  │
│(AllApps)│  │(桌面快捷方式/    │  │                  │
└─────────┘  │ 应用/DeepShortcut│  │                  │
             └────────────────┘  │                  │
                                 │                  │
              ┌──────────────────┴─┐  ┌─────────────┴────────┐
              │  FolderInfo        │  │  AppPairInfo          │
              │  (文件夹)          │  │  (应用对，分屏启动)    │
              │  +suggestedFolderNames│ │  +getFirstApp/SecondApp│
              └────────────────────┘  └───────────────────────┘

另有（非桌面主流）：
  PredictedContainerInfo (预测容器，运行时，不入库)
  PredictedItemInfo / PackageItemInfo (包级图标)
  TaskItemInfo (任务栏/最近任务)
  PrivateSpaceInstallAppButtonInfo (私密空间安装按钮)
```

### 3.2 ItemInfo 基类（公共字段）

> 源文件：`model/data/ItemInfo.java`
> 注释：*"Represents an item in the launcher."*

| 字段 | 类型 | 默认值 | 含义 |
|------|------|--------|------|
| `id` | int | `NO_ID=-1` | DB 主键（`Favorites._ID`） |
| `itemType` | int | — | 项类型（见下表） |
| `container` | int | `NO_ID=-1` | 所在容器 id（见下表，**核心**） |
| `screenId` | int | `-1` | 所在屏（DESKTOP 时有意义；HOTSEAT 时是槽位） |
| `cellX`/`cellY` | int | `-1` | 网格坐标 |
| `spanX`/`spanY` | int | `1` | 占据跨度 |
| `minSpanX`/`minSpanY` | int | `1` | 最小跨度 |
| `rank` | int | `0` | 有序列表中的位置（文件夹内/hotseat 内） |
| `title` | CharSequence | null | 显示标题 |
| `appTitle` | CharSequence | null | 进度文案时的原始 app 标题 |
| `contentDescription` | CharSequence | null | 无障碍描述 |
| `user` | UserHandle | 当前用户 | 所属用户（多用户/工作/私密） |
| `animationType` | int | `DEFAULT` | 动画类型（DEFAULT/VIEW_BACKGROUND） |

读写库的核心方法：

```java
// 把字段写进 ContentWriter（持久化），子类 override 时先 super 再追加自己的列
public void writeToValues(@NonNull final ContentWriter writer) {
    writer.put(LauncherSettings.Favorites.ITEM_TYPE, itemType)   // 项类型
            .put(LauncherSettings.Favorites.CONTAINER, container) // 容器
            .put(LauncherSettings.Favorites.SCREEN, screenId)     // 屏号
            .put(LauncherSettings.Favorites.CELLX, cellX)         // 网格 X
            .put(LauncherSettings.Favorites.CELLY, cellY)         // 网格 Y
            .put(LauncherSettings.Favorites.SPANX, spanX)         // 跨度 X
            .put(LauncherSettings.Favorites.SPANY, spanY)         // 跨度 Y
            .put(LauncherSettings.Favorites.RANK, rank);          // 序号
}

// 完整写库前的钩子，校验 + 追加 PROFILE_ID
public void onAddToDatabase(@NonNull final ContentWriter writer) {
    if (Workspace.EXTRA_EMPTY_SCREEN_IDS.contains(screenId)) {
        throw new RuntimeException("Screen id should not be extra empty screen: " + screenId);  // 禁止写 EXTRA_EMPTY_SCREEN
    }
    writeToValues(writer);
    writer.put(LauncherSettings.Favorites.PROFILE_ID, user);      // 所属用户
}
```

容器判断快捷方法（业务高频用）：

```java
public boolean isInHotseat()    { return container == CONTAINER_HOTSEAT || container == CONTAINER_HOTSEAT_PREDICTION; }
public boolean isInAllApps()    { return container == CONTAINER_ALL_APPS || container == CONTAINER_ALL_APPS_PREDICTION; }
public boolean isPredictedItem(){ return container == CONTAINER_HOTSEAT_PREDICTION || container == CONTAINER_ALL_APPS_PREDICTION; }
```

### 3.3 container 字段映射表（核心，常见误区）

`container` 决定一个项"住在哪里"。常量定义于 `LauncherSettings.Favorites`（第 202-220 行）。

| 常量 | 值 | 含义 | 持久化到 DB |
|------|----|------|-------------|
| `CONTAINER_DESKTOP` | **-100** | 桌面工作区 | ✅ |
| `CONTAINER_HOTSEAT` | **-101** | 底部 Dock 栏 | ✅ |
| `CONTAINER_ALL_APPS_PREDICTION` | -102 | AllApps 预测区 | ❌（运行时） |
| `CONTAINER_HOTSEAT_PREDICTION` | -103 | Hotseat 预测区 | ❌ |
| `CONTAINER_ALL_APPS` | -104 | AllApps 列表 | ❌（不入 Favorites） |
| `CONTAINER_WIDGETS_TRAY` | -105 | 小组件选择器托盘 | ❌ |
| `CONTAINER_SHORTCUTS` | -107 | 快捷方式弹出层 | ❌ |
| `CONTAINER_SETTINGS` | -108 | 设置入口 | ❌ |
| `CONTAINER_TASKSWITCHER` | -109 | 任务切换器 | ❌ |
| `CONTAINER_PRIVATESPACE` | -110 | 私密空间 | ❌ |
| `CONTAINER_WIDGETS_PREDICTION` | -111 | 小组件预测 | ❌ |
| `CONTAINER_BOTTOM_WIDGETS_TRAY` | -112 | 底部组件托盘 | ❌ |
| `CONTAINER_PIN_WIDGETS` | -113 | Pin Widget | ❌ |
| `CONTAINER_WALLPAPERS` | -114 | 壁纸入口 | ❌ |
| `CONTAINER_UNKNOWN` | -1 | 未知 | — |
| **文件夹 / 应用对 id** | **> 0** | container 是正数时，该项在 id 等于该正数的文件夹/应用对内 | ✅ |

判断逻辑（必须记牢）：

- `container == -100` → 在桌面，`screenId` 是第几屏，`cellX/cellY` 是网格坐标。
- `container == -101` → 在 Hotseat，`screenId` 表示第几个槽位（0 ~ `numDatabaseHotseatIcons-1`）。
- **`container > 0` → 在某个文件夹/应用对里**，这个正数就是该 `FolderInfo`/`AppPairInfo` 的 `id`。

> **常见错误**：把文件夹说成固定常量（如 -102）。实际上文件夹不是常量，而是动态的 `folder.id`（正数）。`-102` 是 `CONTAINER_ALL_APPS_PREDICTION`。判断"是否在文件夹里"用 `container > 0`，不是比对固定值。

### 3.4 ITEM_TYPE 映射表

| 常量 | 值 | 含义 | 对应 ItemInfo 子类 |
|------|----|------|-------------------|
| `ITEM_TYPE_APPLICATION` | 0 | 应用快捷方式 | `WorkspaceItemInfo` / `AppInfo` |
| `ITEM_TYPE_SHORTCUT` | 1 | 旧式快捷方式（已废弃） | `WorkspaceItemInfo` |
| `ITEM_TYPE_FOLDER` | 2 | 文件夹 | `FolderInfo` |
| `ITEM_TYPE_APPWIDGET` | 4 | 系统小组件 | `LauncherAppWidgetInfo` |
| `ITEM_TYPE_CUSTOM_APPWIDGET` | 5 | 自定义小组件 | `LauncherAppWidgetInfo`（`isCustomWidget()`） |
| `ITEM_TYPE_DEEP_SHORTCUT` | 6 | 深度快捷方式（ShortcutManager） | `WorkspaceItemInfo` |
| `ITEM_TYPE_TASK` | 7 | 任务（任务栏/最近任务） | `TaskItemInfo` |
| `ITEM_TYPE_QSB` | 8 | 搜索框 QSB | — |
| `ITEM_TYPE_SEARCH_ACTION` | 9 | 搜索动作 | — |
| `ITEM_TYPE_APP_PAIR` | 10 | 应用对（分屏启动） | `AppPairInfo` |
| `ITEM_TYPE_PRIVATE_SPACE_INSTALL_APP_BUTTON` | 11 | 私密空间安装按钮 | `PrivateSpaceInstallAppButtonInfo` |
| `ITEM_TYPE_FILE_SYSTEM_FILE` | 12 | 文件系统文件 | `WorkspaceItemInfo` |
| `ITEM_TYPE_FILE_SYSTEM_FOLDER` | 13 | 文件系统文件夹 | `WorkspaceItemInfo` |
| `ITEM_TYPE_CUSTOM_VIEW` | 14 | 自定义视图 | — |
| `ITEM_TYPE_SYSTEM_DRAG` | 15 | 系统拖拽项 | — |

### 3.5 ItemInfoWithIcon（带图标的项）

> 源文件：`model/data/ItemInfoWithIcon.java`

在 `ItemInfo` 基础上增加图标与运行时状态：

```java
@NonNull public BitmapInfo bitmap = BitmapInfo.LOW_RES_INFO;   // 图标位图（默认低清占位）
public int runtimeStatusFlags = 0;                             // 运行时状态位标志（不写库，每次加载重算）
private int mProgressLevel = 100;                              // 下载/安装进度（0-100）
```

`runtimeStatusFlags` 是位标志，描述图标的运行时状态（**不持久化**，每次 `LoaderTask` 重新计算）：

| Flag | 值 | 含义 |
|------|----|------|
| `FLAG_DISABLED_SAFEMODE` | 1<<0 | 安全模式禁用 |
| `FLAG_DISABLED_NOT_AVAILABLE` | 1<<1 | App 不可用（SD 卡未就绪） |
| `FLAG_DISABLED_SUSPENDED` | 1<<2 | App 被挂起 |
| `FLAG_DISABLED_QUIET_USER` | 1<<3 | 用户处于免打扰 |
| `FLAG_DISABLED_BY_PUBLISHER` | 1<<4 | 发布者禁用了 shortcut |
| `FLAG_DISABLED_LOCKED_USER` | 1<<5 | 用户分区未解锁 |
| `FLAG_SYSTEM_YES`/`FLAG_SYSTEM_NO` | 1<<6/1<<7 | 是否系统应用 |
| `FLAG_INSTALL_SESSION_ACTIVE` | 1<<10 | 正在安装 |
| `FLAG_INCREMENTAL_DOWNLOAD_ACTIVE` | 1<<11 | 增量下载中 |
| `FLAG_DISABLED_VERSION_LOWER` | 1<<12 | App 版本过低 |
| `FLAG_NOT_PINNABLE` | 1<<13 | 不可固定到桌面 |
| `FLAG_ARCHIVED` | 1<<14 | 已归档 App |
| `FLAG_NOT_RESIZEABLE` | 1<<15 | 不可调整大小 |
| `FLAG_SUPPORTS_MULTI_INSTANCE` | 1<<16 | 支持多实例 |

图标生成入口（UI 渲染时调）：

```java
public FastBitmapDrawable newIcon(Context context, @DrawableCreationFlags int creationFlags) {
    ThemeManager themeManager = ThemeManager.INSTANCE.get(context);
    IconShape iconShape = null;
    if (supportsCustomShapes(creationFlags)) {                  // 仅 full-bleed 图标支持裁剪形状
        iconShape = themeManager.getIconShapeData().getValue();
    }
    if (!themeManager.isIconThemeEnabled()) {
        creationFlags &= ~FLAG_THEMED;                          // 未启用主题则去掉 themed 标志
    }
    FastBitmapDrawable drawable = bitmap.newIcon(context, creationFlags, iconShape);
    drawable.setDisabled(isDisabled());                         // 禁用态灰化
    return drawable;
}
```

### 3.6 WorkspaceItemInfo（桌面快捷方式）

> 源文件：`model/data/WorkspaceItemInfo.java`
> 注释：*"Represents a launchable icon on the workspaces and in folders."*

继承 `ItemInfoWithIcon`，是桌面上可点击启动的图标（应用 + Deep Shortcut）。构造时默认 `itemType = ITEM_TYPE_APPLICATION`，从 `ShortcutInfo` 构造时设为 `ITEM_TYPE_DEEP_SHORTCUT`。

核心字段：

```java
@NonNull public Intent intent;              // 启动 Intent（最重要的字段）
public CharSequence disabledMessage;        // 禁用时提示
public int status;                          // 持久化状态（写 RESTORED 列）
public int options;
@NonNull private String[] personKeys = Utilities.EMPTY_STRING_ARRAY;  // Deep Shortcut 关联的 Person
```

`status` 标志（持久化到 DB 的 `RESTORED` 列）：

| Flag | 值 | 含义 |
|------|----|------|
| `FLAG_RESTORED_ICON` | 1 | 从备份恢复，未就绪 |
| `FLAG_AUTOINSTALL_ICON` | 1<<1 | 自动安装项 / 用户主动安装会话 |
| `FLAG_RESTORE_STARTED` | 1<<2 | 恢复已开始 |
| `FLAG_SUPPORTS_WEB_UI` | 1<<3 | 支持 Web UI |
| `FLAG_START_FOR_RESULT` | 1<<4 | — |
| `FLAG_RESTORED_FULL_BLEED` | 1<<5 | 恢复的图标是全出血（未裁剪） |

**Promise 图标**：`isPromise()` = 备份恢复中 / 自动安装中 / 已归档。这类图标显示"占位 + 进度"。

写库逻辑（注意图标列的条件写入）：

```java
@Override
public void onAddToDatabase(@NonNull ContentWriter writer) {
    super.onAddToDatabase(writer);                            // 先写基类字段
    writer.put(Favorites.TITLE, title)                        // 标题
            .put(Favorites.INTENT, getIntent())               // Intent（序列化）
            .put(Favorites.OPTIONS, options)
            .put(Favorites.RESTORED, status);                 // 状态写 RESTORED 列
    if (!getMatchingLookupFlag().useLowRes()) {               // 非低分辨率才写图标 BLOB
        writer.putIcon(bitmap, user);                         // 写 Favorites.ICON 列（备份恢复用）
    }
}
```

### 3.7 LauncherAppWidgetInfo（桌面小组件）

> 源文件：`model/data/LauncherAppWidgetInfo.java`
> 注释：*"Represents a widget (either instantiated or about to be) in the Launcher."*

**直接继承 `ItemInfo`（不继承 `ItemInfoWithIcon`）**，因为小组件的图标/内容由 `AppWidgetHostView` 渲染，不需要 bitmap。

核心字段：

```java
public int appWidgetId = NO_ID;              // AppWidgetManager 分配的 id（NO_ID=-1）
public ComponentName providerName;           // Widget Provider 组件名
public int restoreStatus;                    // 恢复状态（写 RESTORED 列）
public int installProgress = -1;             // 安装进度
public Intent bindOptions;                   // bind 时的 extras（FLAG_DIRECT_CONFIG 时有）
public int options;                          // OPTION_SEARCH_WIDGET 等
public PackageItemInfo pendingItemInfo;      // 待安装 widget 的占位信息
public int sourceContainer = CONTAINER_UNKNOWN;  // 来源容器（写 APPWIDGET_SOURCE 列）
private int widgetFeatures;                  // RECONFIGURABLE/PREVIEW_LAYOUT... 位标志
```

`restoreStatus` 标志：

| Flag | 值 | 含义 |
|------|----|------|
| `FLAG_ID_NOT_VALID` | 1 | widget id 无效 |
| `FLAG_PROVIDER_NOT_READY` | 2 | Provider 不可用 |
| `FLAG_UI_NOT_READY` | 4 | UI 未就绪 |
| `FLAG_RESTORE_STARTED` | 8 | 恢复已开始 |
| `FLAG_ID_ALLOCATED` | 16 | 已分配 id（尚未 bind） |
| `FLAG_DIRECT_CONFIG` | 32 | 跳过配置 Activity |

特殊常量：`CUSTOM_WIDGET_ID = -100`（本地定义的 widget，无系统 id）；`isCustomWidget()` 判断 `appWidgetId <= CUSTOM_WIDGET_ID`。

写库：

```java
@Override
public void onAddToDatabase(@NonNull ContentWriter writer) {
    super.onAddToDatabase(writer);
    writer.put(Favorites.APPWIDGET_ID, appWidgetId)
            .put(Favorites.APPWIDGET_PROVIDER, providerName.flattenToString())   // 组件名扁平化
            .put(Favorites.RESTORED, restoreStatus)
            .put(Favorites.OPTIONS, options)
            .put(Favorites.INTENT, bindOptions)
            .put(Favorites.APPWIDGET_SOURCE, sourceContainer);
}
```

### 3.8 CollectionInfo & FolderInfo & AppPairInfo（文件夹与应用对）

> 源文件：`model/data/CollectionInfo.kt` / `FolderInfo.java` / `AppPairInfo.kt`

`CollectionInfo` 是抽象"集合"基类（文件夹、应用对的共同抽象）：

```kotlin
abstract class CollectionInfo : ItemInfo() {
    abstract fun add(item: ItemInfo)                       // 添加子项（类型不合法抛异常）
    abstract fun getContents(): List<ItemInfo>             // 所有子项（含嵌套集合）
    abstract fun getAppContents(): List<WorkspaceItemInfo> // 仅 App 子项（递归展开 AppPair）
    fun anyMatch(matcher: Predicate<ItemInfo>) = getContents().any { matcher.test(it) }

    override fun onAddToDatabase(writer: ContentWriter) {
        super.onAddToDatabase(writer)
        writer.put(LauncherSettings.Favorites.TITLE, title)  // 集合只额外写标题
    }
}
```

`FolderInfo` 是文件夹实现：

```java
public class FolderInfo extends CollectionInfo {
    public int options;                                      // FLAG_MANUAL_FOLDER_NAME 等
    public FolderNameInfos suggestedFolderNames;             // 推荐文件夹名
    private final ArrayList<ItemInfo> contents = new ArrayList<>();  // 文件夹内项

    public FolderInfo() { itemType = LauncherSettings.Favorites.ITEM_TYPE_FOLDER; }

    // 文件夹只接受这几种类型
    public static boolean willAcceptItemType(int itemType) {
        return itemType == ITEM_TYPE_APPLICATION
            || itemType == ITEM_TYPE_DEEP_SHORTCUT
            || itemType == ITEM_TYPE_APP_PAIR;
    }

    public enum LabelState { UNLABELED, EMPTY, SUGGESTED, MANUAL }  // 文件夹名状态机
}
```

`AppPairInfo` 是应用对（分屏同时启动两个 App）：

```kotlin
class AppPairInfo() : CollectionInfo() {
    private var contents = mutableListOf<WorkspaceItemInfo>()     // 只接受 WorkspaceItemInfo
    init { itemType = LauncherSettings.Favorites.ITEM_TYPE_APP_PAIR }

    override fun add(item: ItemInfo) {
        if (item !is WorkspaceItemInfo) {
            throw RuntimeException("tried to add an illegal type into an app pair")
        }
        contents.add(item)
    }
    fun getFirstApp() = contents[0]                               // 分屏第一个 App
    fun getSecondApp() = contents[1]                              // 分屏第二个 App
    fun generateTitle(context: Context) = context.getString(R.string.app_pair_default_title, getFirstApp().title, getSecondApp().title)
    fun fetchHiResIconsIfNeeded(iconCache: IconCache) {           // 加载时补高清图标
        getAppContents().filter { it.matchingLookupFlag.isVisuallyLessThan(DESKTOP_ICON_FLAG) }
            .forEach { iconCache.getTitleAndIcon(it, DESKTOP_ICON_FLAG) }
    }
}
```

**文件夹/应用对在数据模型里的表达**：

- 文件夹本身是一个 `FolderInfo`，`itemType = ITEM_TYPE_FOLDER`，有自己的 `id`，存在 Favorites 表里一条记录。
- 文件夹内的每个 `WorkspaceItemInfo`，其 `container = 文件夹的 id`（正数）。
- 加载时 `LoaderCursor.findOrMakeFolder(id)` 会先建占位 FolderInfo，遇到子项时 `findOrMakeFolder(...).add(item)`。

### 面试深问

1. **Q：为什么 `LauncherAppWidgetInfo` 不继承 `ItemInfoWithIcon`？**
   A：小组件的视觉内容由 `AppWidgetHostView` 实时渲染（远程 View 树），没有静态 bitmap。继承 `ItemInfoWithIcon` 会白白占用 `bitmap` 字段和 `runtimeStatusFlags` 的语义。它直接继承 `ItemInfo`，用 `providerName` + `appWidgetId` 定位 Provider。

2. **Q：`FolderInfo.willAcceptItemType` 允许 APP_PAIR，但 AppPair 内部只接受 WorkspaceItemInfo，嵌套关系如何？**
   A：文件夹可以装应用、深度快捷、应用对；应用对只能装两个 App。`FolderInfo.getAppContents()` 会递归展开：遇到 `AppPairInfo` 就把它的 `getAppContents()` 全部加入返回列表，这样文件夹预览图标计算、推荐名生成都能拿到扁平的 App 列表。

3. **Q：`container > 0` 判断文件夹，那 `container == 0` 会发生吗？**
   A：不会。`id` 由 `DatabaseHelper.generateNewItemId()` 分配，从 1 开始自增，0 不会被分配。`container` 等于 0 是非法值，`checkItemPlacement` 不会拦（它只校验 HOTSEAT/DESKTOP），但加载时该子项找不到对应集合会被 `deleteUnparentedApps` 清理。

---

## 四、数据加载全流程（数据库 → Model → UI）

这是本文档最核心的部分：**一条数据库记录如何变成屏幕上的图标**。

### 4.1 入口：startLoader → LoaderTask

加载由 `LauncherModel.startLoader()` 触发（启动、配置变更、包变更、用户解锁等）。注意：源码里**没有 `startForcedLoad` 方法**，全量重载走 `forceReload()` → `rebindCallbacks()` → `startLoader()`。

```kotlin
// LauncherModel.kt
fun forceReload() {
    synchronized(mLock) {
        stopLoader()                  // 先停旧 LoaderTask（stopLocked）
        mModelLoaded = false
    }
    rebindCallbacks()                 // 有 callbacks 就 startLoader
}

private fun startLoader(newCallbacks: Array<BgDataModel.Callbacks>): Boolean {
    installQueue.pauseModelPush(ItemInstallQueue.FLAG_LOADER_RUNNING)   // 加载期间暂停自动安装推送
    synchronized(mLock) {
        val wasRunning = stopLoader()
        val bindDirectly = mModelLoaded && !mIsLoaderTaskRunning        // 已加载且无任务在跑：直接 bind
        val bindAllCallbacks = wasRunning || !bindDirectly || newCallbacks.isEmpty()
        val callbacksList = if (bindAllCallbacks) callbacks else newCallbacks
        if (callbacksList.isNotEmpty()) {
            val launcherBinder = binderFactory.createBinder(callbacksList)
            if (bindDirectly) {                                        // 热路径：跳过加载，直接同步 bind
                launcherBinder.bindWorkspace(bindAllCallbacks, /* isBindSync= */ true)
                launcherBinder.bindAllApps()
                launcherBinder.bindWidgets()
                return true
            } else {                                                   // 冷路径：起 LoaderTask
                val task = loaderFactory.newLoaderTask(launcherBinder)
                mLoaderTask = task
                MODEL_EXECUTOR.post(task)                              // post 到后台线程（不直接 run，退出嵌套锁）
            }
        }
    }
    return false
}
```

`LoaderTask` 用 `@AssistedInject`（需要运行时参数 `BaseLauncherBinder`），由 `LoaderTaskFactory` 创建。

### 4.2 LoaderTask 五段式有序加载

> 源文件：`model/LoaderTask.java`
> 注释：*"Runnable for the thread that loads the contents of the launcher: workspace icons, widgets, all apps icons, deep shortcuts within apps"*

`loadAllSurfacesOrdered()` 严格有序，每步之间 `waitForIdle()` 等主线程处理完上一批 bind，避免拥塞：

```
┌─────────────────────────────────────────────────────────────────┐
│ 步骤1: loadWorkspaceImpl → sanitize → bindWorkspace              │
│   读 Favorites 表 → 填 itemsIdMap → bind 到 UI                    │
│   waitForIdle()                                                  │
├─────────────────────────────────────────────────────────────────┤
│ 步骤2: loadAllApps → bindAllApps → updateIcons(AllApps)          │
│   LauncherApps.getActivityList() → 填 AllAppsList                 │
│   批量补图标 → waitForIdle()                                       │
├─────────────────────────────────────────────────────────────────┤
│ 步骤3: loadDeepShortcuts → updateIcons(shortcuts)                │
│   ShortcutRequest 查所有动态/固定快捷方式                          │
│   updateDeepShortcutCounts 填 deepShortcutMap                     │
│   waitForIdle()                                                  │
├─────────────────────────────────────────────────────────────────┤
│ 步骤4: WidgetsModel.update → bindWidgets → updateIcons(widgets)  │
│   查所有可用 Widget，绑定到选择器                                    │
├─────────────────────────────────────────────────────────────────┤
│ 步骤5: loadFolderNames → updateHandler.finish()                  │
│   计算文件夹推荐名；收尾图标缓存更新                                 │
└─────────────────────────────────────────────────────────────────┘
```

源码（精简）：

```java
private void loadAllSurfacesOrdered(LoaderMemoryLogger memoryLogger, LauncherRestoreEventLogger restoreEventLogger) {
    List<CacheableShortcutInfo> allShortcuts = new ArrayList<>();
    Trace.beginSection("LoadWorkspace");
    try {
        loadWorkspaceImpl(allShortcuts, mParams.getWorkspaceSelection(), memoryLogger, restoreEventLogger);  // 步骤1-加载
    } finally { Trace.endSection(); }

    if (Objects.equals(mIDP.dbFile, mDbName) && mParams.getSanitizeData()) {
        verifyNotStopped();
        sanitizeWidgetsShortcutsAndPackages();   // 同步 widget/shortcut/pin 状态（删 ghost widget、重 pin）
    }

    verifyNotStopped();
    mLauncherBinder.bindWorkspace(true /* incrementBindId */, /* isBindSync= */ false);   // 步骤1-bind
    if (!mParams.getLoadNonWorkspaceItems()) return;     // 预览模式只加载桌面

    mModelDelegate.workspaceLoadComplete();
    sendFirstScreenActiveInstallsBroadcast();             // 通知安装器首屏应用
    waitForIdle();                                         // 等主线程空闲
    verifyNotStopped();

    // 步骤2: AllApps
    List<LauncherActivityInfo> allActivityList = loadAllApps();
    verifyNotStopped();
    mLauncherBinder.bindAllApps();
    IconCacheUpdateHandler updateHandler = mIconCache.getUpdateHandler();
    setIgnorePackages(updateHandler);                      // promise 图标的包加入 ignore（避免覆盖占位图标）
    updateHandler.updateIcons(allActivityList, LauncherActivityCachingLogic.INSTANCE, mModel::onPackageIconsUpdated);
    updateHandler.updateIcons(allShortcuts, CacheableShortcutCachingLogic.INSTANCE, mModel::onPackageIconsUpdated);
    waitForIdle();
    verifyNotStopped();

    // 步骤3: DeepShortcuts
    List<ShortcutInfo> allDeepShortcuts = loadDeepShortcuts();
    updateHandler.updateIcons(convertShortcutsToCacheableShortcuts(allDeepShortcuts, allActivityList), CacheableShortcutCachingLogic.INSTANCE, (pkgs, user) -> {});
    waitForIdle();
    verifyNotStopped();

    // 步骤4: Widgets
    WidgetsModel widgetsModel = mBgDataModel.widgetsModel;
    List<CachedObject> allWidgetsList = widgetsModel.update(/*packageUser=*/null);
    mLauncherBinder.bindWidgets();
    updateHandler.updateIcons(allWidgetsList, CachedObjectCachingLogic.INSTANCE, mModel::onWidgetLabelsUpdated);

    // 步骤5: FolderNames + finish
    loadFolderNames();
    updateHandler.finish();                                // 提交所有图标缓存更新
    mModelDelegate.modelLoadComplete();
}
```

每一步填到哪个字段：

| 步骤 | 读什么 | 填到 BgDataModel 哪个字段 |
|------|--------|--------------------------|
| 1 loadWorkspace | `dbController.query(Favorites)` | `itemsIdMap`（经 `dataLoadComplete`） |
| 2 loadAllApps | `LauncherApps.getActivityList` | `AllAppsList`（平行结构，非 BgDataModel） |
| 3 loadDeepShortcuts | `ShortcutRequest(ALL)` | `deepShortcutMap` |
| 4 WidgetsModel.update | `AppWidgetManager` | `widgetsModel` |
| 5 loadFolderNames | `FolderNameProvider` 算 | `FolderInfo.suggestedFolderNames` |

### 4.3 步骤1详解：loadWorkspaceImpl（核心）

```java
private void loadWorkspaceImpl(List<CacheableShortcutInfo> allDeepShortcuts, String selection,
        @Nullable LoaderMemoryLogger memoryLogger, @Nullable LauncherRestoreEventLogger restoreEventLogger) {
    final boolean isSdCardReady = Utilities.isBootCompleted();          // SD 卡是否就绪
    ModelDbController dbController = mModel.getModelDbController();

    dbController.attemptMigrateDb(restoreEventLogger, mModelDelegate);  // 网格迁移（屏幕尺寸变化）
    dbController.loadDefaultFavoritesIfNecessary();                     // 首次加载默认布局

    synchronized (mBgDataModel) {
        mBgDataModel.clear();                                           // 清 deepShortcutMap/extraItems
        mPendingPackages.clear();

        final HashMap<PackageUserKey, SessionInfo> installingPkgs = mSessionHelper.getActiveSessions();  // 活跃安装会话
        installingPkgs.forEach(mIconCache::updateSessionCache);         // 安装中 App 的临时图标入内存缓存

        mShortcutKeyToPinnedShortcuts = new HashMap<>();
        final LoaderCursor c = mLoaderCursorFactory.createLoaderCursor( // 查 Favorites，包装成 LoaderCursor
                dbController.query(null, selection, null, LauncherDbUtils.getLoaderCursorQuerySortOrder()),
                mUserManagerState, mIsRestoreFromBackup ? restoreEventLogger : null);
        mDbName = c.getExtras().getString(ModelDbController.EXTRA_DB_NAME);

        WorkspaceItemProcessor itemProcessor;
        try {
            final LongSparseArray<Boolean> unlockedUsers = new LongSparseArray<>();
            queryPinnedShortcutsForUnlockedUsers(mContext, unlockedUsers);  // 预查每个用户的 pinned shortcuts

            mWorkspaceIconRequestInfos = new ArrayList<>();
            itemProcessor = new WorkspaceItemProcessor(c, memoryLogger, mUserManagerState, mLauncherApps,
                    mPendingPackages, mShortcutKeyToPinnedShortcuts, mContext, mIDP, mIconCache,
                    mIsSafeModeEnabled, installingPkgs, isSdCardReady, ...);

            if (mStopped) {
                Log.w(TAG, "loadWorkspaceImpl: Loader stopped, skipping item processing");
            } else {
                if (Flags.injectableModelItems()) {
                    itemProcessor.processPreloadedItems(mExtraItemsProvider.get());  // 注入式额外项（如 QSB）
                }
                while (!mStopped && c.moveToNext()) {                  // 逐行处理 Cursor
                    itemProcessor.processItem();                       // ← 每行记录变成 ItemInfo
                }
            }
            tryLoadWorkspaceIconsInBulk(mWorkspaceIconRequestInfos);   // 批量补图标（一次 DB 查询）
        } finally {
            IOUtils.closeSilently(c);
        }

        if (mStopped) { mBgDataModel.clear(); return; }                // 中途被停，清空退出

        mBgDataModel.updateStringCache(mContext);                       // 更新文案缓存
        mBgDataModel.dataLoadComplete(itemProcessor.finalizeData(mModelDelegate, mModel.getModelDbController()));  // 全量替换 itemsIdMap
    }
}
```

`finalizeData` 在所有行处理完后做收尾：

```kotlin
fun finalizeData(delegate: ModelDelegate, modelDbController: ModelDbController): SparseArray<ItemInfo> {
    delegate.loadAndAddExtraModelItems(loadedItems)                     // 1) 加载非 DB 来源的额外项
    delegate.markActive()
    val itemsDeleted = c.commitDeleted()                                // 2) 提交删除（markDeleted 标记的）
    processFolderItems()                                                // 3) 排序文件夹内项 + 补预览高清图标
    loadedItems.forEach { if (it is AppPairInfo) it.fetchHiResIconsIfNeeded(iconCache) }  // 应用对补图标
    c.commitRestoredItems()                                             // 4) 提交恢复标记（RESTORED 置 0）
    if (itemsDeleted) removeItems(modelDbController.deleteEmptyFolders())   // 5) 删空文件夹
    removeItems(modelDbController.deleteBadAppPairs())                  // 6) 删成员数≠2 的应用对
    removeItems(modelDbController.deleteUnparentedApps())               // 7) 删找不到父集合的孤儿项
    addRemainingFileSystemItems(modelDbController)                      // 8) 补文件系统项
    return loadedItems
}
```

### 4.4 LoaderCursor：数据库行的解析器

> 源文件：`model/LoaderCursor.java`
> 注释：*"Extension of Cursor with utility methods for workspace loading."*

`LoaderCursor extends CursorWrapper`，包装原始 SQLite Cursor，提供四类能力：列索引缓存、逐行公共属性提取、按类型构造 ItemInfo 的工厂方法、位置合法性校验。

**列索引缓存**（构造时一次性 `getColumnIndexOrThrow`）：

```java
mIconIndex = getColumnIndexOrThrow(Favorites.ICON);          // 图标 BLOB
mTitleIndex = getColumnIndexOrThrow(Favorites.TITLE);
mIdIndex = getColumnIndexOrThrow(Favorites._ID);
mContainerIndex = getColumnIndexOrThrow(Favorites.CONTAINER);
mItemTypeIndex = getColumnIndexOrThrow(Favorites.ITEM_TYPE);
mScreenIndex = getColumnIndexOrThrow(Favorites.SCREEN);
mCellXIndex = getColumnIndexOrThrow(Favorites.CELLX);
mCellYIndex = getColumnIndexOrThrow(Favorites.CELLY);
mProfileIdIndex = getColumnIndexOrThrow(Favorites.PROFILE_ID);
mRestoredIndex = getColumnIndexOrThrow(Favorites.RESTORED);
mIntentIndex = getColumnIndexOrThrow(Favorites.INTENT);
mAppWidgetIdIndex = getColumnIndexOrThrow(Favorites.APPWIDGET_ID);
mAppWidgetProviderIndex = getColumnIndexOrThrow(Favorites.APPWIDGET_PROVIDER);
mSpanXIndex = getColumnIndexOrThrow(Favorites.SPANX);
mSpanYIndex = getColumnIndexOrThrow(Favorites.SPANY);
mRankIndex = getColumnIndexOrThrow(Favorites.RANK);
mOptionsIndex = getColumnIndexOrThrow(Favorites.OPTIONS);
mAppWidgetSourceIndex = getColumnIndexOrThrow(Favorites.APPWIDGET_SOURCE);
```

**逐行公共属性提取**（每次 `moveToNext` 读一次）：

```java
@Override
public boolean moveToNext() {
    boolean result = super.moveToNext();
    if (result) {
        mActivityInfo = null;                       // 重置缓存
        itemType = getInt(mItemTypeIndex);          // 项类型
        container = getInt(mContainerIndex);        // 容器
        id = getInt(mIdIndex);                      // 主键
        serialNumber = getInt(mProfileIdIndex);     // 用户 serial
        user = mUserManagerState.getUser(serialNumber);  // 解析 UserHandle
        restoreFlag = getInt(mRestoredIndex);       // 恢复标记
    }
    return result;
}
```

**按类型构造 ItemInfo 的工厂方法**：

```java
// 应用快捷方式（已安装）
WorkspaceItemInfo getAppShortcutInfo(Intent intent, boolean allowMissingTarget, boolean useLowResIcon, boolean loadIcon);

// 备份恢复中的项（promise 图标）
WorkspaceItemInfo getRestoredItemInfo(Intent intent, boolean isArchived);

// 旧式 shortcut / 无法识别的项（兜底）
WorkspaceItemInfo loadSimpleWorkspaceItem();
```

`getAppShortcutInfo` 核心：用 `LauncherApps.resolveActivity` 校验目标存在，构造 `WorkspaceItemInfo` 并补图标：

```java
public WorkspaceItemInfo getAppShortcutInfo(Intent intent, boolean allowMissingTarget, boolean useLowResIcon, boolean loadIcon) {
    if (user == null) return null;
    ComponentName componentName = intent.getComponent();
    if (componentName == null) return null;

    Intent newIntent = new Intent(Intent.ACTION_MAIN, null);
    newIntent.addCategory(Intent.CATEGORY_LAUNCHER);
    newIntent.setComponent(componentName);
    mActivityInfo = mContext.getSystemService(LauncherApps.class).resolveActivity(newIntent, user);  // 校验 Activity 存在
    if ((mActivityInfo == null) && !allowMissingTarget) return null;     // 不允许缺失目标，返回 null（会被删除）

    final WorkspaceItemInfo info = new WorkspaceItemInfo();
    info.user = user;
    info.intent = newIntent;
    if (mActivityInfo != null) {
        AppInfo.updateRuntimeFlagsForActivityTarget(info, mActivityInfo, ...);  // 设置 suspended/system/archived 等运行时标志
    }
    loadWorkspaceTitleAndIcon(useLowResIcon, loadIcon, info);            // 从缓存或 DB 加载标题图标
    if (TextUtils.isEmpty(info.title)) info.title = getTitle();          // 兜底用 DB 的 TITLE 列
    info.contentDescription = mIconCache.getUserBadgedLabel(info.title, info.user);
    return info;
}
```

**图标请求构造**（决定是否带 DB 的 iconBlob）：

```java
public IconRequestInfo<WorkspaceItemInfo> createIconRequestInfo(WorkspaceItemInfo wai, boolean useLowResIcon) {
    byte[] iconBlob = itemType == Favorites.ITEM_TYPE_DEEP_SHORTCUT || restoreFlag != 0
            || (wai.isInactiveArchive() && Flags.restoreArchivedAppIconsFromDb())
            ? getIconBlob() : null;                                      // deep shortcut/恢复中/归档：带 DB blob
    return new IconRequestInfo<>(wai, mActivityInfo, iconBlob,
            wai.hasStatusFlag(FLAG_RESTORED_FULL_BLEED),
            DESKTOP_ICON_FLAG.withUseLowRes(useLowResIcon));
}
```

**文件夹懒创建**：

```java
public CollectionInfo findOrMakeFolder(int id, IntSparseArrayMap<ItemInfo> loadedItems) {
    ItemInfo info = loadedItems.get(id);
    if (info instanceof CollectionInfo c) return c;            // 已加载过（先遇到文件夹本身）
    CollectionInfo pending = mPendingCollectionInfo.get(id);   // 占位（先遇到子项）
    if (pending != null) return pending;
    // 没有就建占位 FolderInfo（此时不知是 folder 还是 app pair，app pair 会在 processFolderOrAppPair 里替换）
    pending = new FolderInfo();
    pending.id = id;
    mPendingCollectionInfo.put(id, pending);
    return pending;
}
```

### 4.5 WorkspaceItemProcessor：类型分发

> 源文件：`model/WorkspaceItemProcessor.kt`
> 注释：*"This method is like the midfielder that delegates the actual processing..."*

`processItem()` 按 `itemType` 分发：

```kotlin
fun processItem() {
    try {
        if (c.user == null) {                                  // 用户已被删除
            c.markDeleted("User has been deleted for item id=${c.id}", RestoreError.PROFILE_DELETED)
            return
        }
        when (c.itemType) {
            Favorites.ITEM_TYPE_APPLICATION,
            Favorites.ITEM_TYPE_DEEP_SHORTCUT -> processAppOrDeepShortcut()    // 应用/深度快捷
            Favorites.ITEM_TYPE_FOLDER,
            Favorites.ITEM_TYPE_APP_PAIR      -> processFolderOrAppPair()      // 文件夹/应用对
            Favorites.ITEM_TYPE_APPWIDGET,
            Favorites.ITEM_TYPE_CUSTOM_APPWIDGET -> processWidget()            // 小组件
            Favorites.ITEM_TYPE_FILE_SYSTEM_FILE,
            Favorites.ITEM_TYPE_FILE_SYSTEM_FOLDER -> processFileSystemItem()  // 文件系统项
        }
    } catch (e: Exception) {
        Log.e(TAG, "Desktop items loading interrupted", e)
    }
}
```

`processAppOrDeepShortcut` 做的事（高度精简）：

1. 解析 Intent，校验目标包名存在。
2. 根据 `validTarget`（包是否启用）、`restoreFlag`、SD 卡状态决定 `allowMissingTarget` 和 `disabledState`。
3. 三种分支构造 `WorkspaceItemInfo`：

```kotlin
when {
    c.restoreFlag != 0 -> info = c.getRestoredItemInfo(intent, isPreArchivedShortcut)   // promise 图标
    c.itemType == Favorites.ITEM_TYPE_APPLICATION ->
        info = c.getAppShortcutInfo(intent, allowMissingTarget, useLowResIcon, false)   // 普通应用
    c.itemType == Favorites.ITEM_TYPE_DEEP_SHORTCUT -> {
        val key = ShortcutKey.fromIntent(intent, c.user)
        if (unlockedUsers[c.serialNumber]) {
            val pinnedShortcut = shortcutKeyToPinnedShortcuts[key] ?: retryDeepShortcutById(key)
            if (pinnedShortcut == null) { c.markDeleted(...); return }
            info = WorkspaceItemInfo(pinnedShortcut, context)                            // 从 ShortcutInfo 构造
            iconCache.getShortcutIcon(info, csi, DEFAULT_LOOKUP_FLAG.withThemeIcon())     // shortcut 图标（带 badge）
        } else {
            info = c.loadSimpleWorkspaceItem()                                           // 用户锁定，禁用态
            info.runtimeStatusFlags = info.runtimeStatusFlags or ItemInfoWithIcon.FLAG_DISABLED_LOCKED_USER
        }
    }
}
```

4. `applyCommonProperties`（id/container/screenId/cellX/cellY），设 `spanX=spanY=1`，合并 `disabledState`。
5. `checkAndAddItem(info, loadedItems, memoryLogger)` 入模。

`processFolderOrAppPair` 处理集合本身（注意占位替换）：

```kotlin
private fun processFolderOrAppPair() {
    var collection = c.findOrMakeFolder(c.id, loadedItems)           // 先找占位
    if (c.itemType == Favorites.ITEM_TYPE_APP_PAIR && collection is FolderInfo) {
        val newAppPair = AppPairInfo()                               // 占位 Folder 替换为 AppPair
        collection.getContents().forEach(newAppPair::add)            // 把已收集的子项搬过去
        collection = newAppPair
    }
    c.applyCommonProperties(collection)
    collection.title = c.getString(c.mTitleIndex)                    // 文件夹名不 trim（用户手输）
    collection.spanX = 1; collection.spanY = 1
    if (collection is FolderInfo) collection.options = c.options
    else collection.rank = c.rank                                    // app pair 可能嵌套在文件夹，保留 rank
    c.markRestored()
    c.checkAndAddItem(collection, loadedItems, memoryLogger)
}
```

`processWidget` 构造 `LauncherAppWidgetInfo`，读 `appWidgetId`/`providerName`，用 `WidgetInflater.inflateAppWidget` 决定 TYPE_DELETE/TYPE_PENDING/TYPE_REAL，处理恢复状态。

### 4.6 checkItemPlacement：防重叠校验

> 源文件：`model/LoaderCursor.java`

数据库可能被外部写入脏数据（重叠、越界）。`checkItemPlacement` 用 `GridOccupancy` 网格占用图校验：

```java
protected boolean checkItemPlacement(ItemInfo item) {
    if (item.container == Favorites.CONTAINER_HOTSEAT) {
        final GridOccupancy hotseatOccupancy = mOccupied.get(Favorites.CONTAINER_HOTSEAT);
        if (item.screenId >= mIDP.numDatabaseHotseatIcons) return false;  // 槽位越界
        if (hotseatOccupancy != null) {
            if (hotseatOccupancy.cells[(int) item.screenId][0]) return false;  // 槽位已占
            hotseatOccupancy.cells[item.screenId][0] = true;
            return true;
        } else {
            final GridOccupancy occupancy = new GridOccupancy(mIDP.numDatabaseHotseatIcons, 1);  // 首次建占用图
            occupancy.cells[item.screenId][0] = true;
            mOccupied.put(Favorites.CONTAINER_HOTSEAT, occupancy);
            return true;
        }
    } else if (item.container != Favorites.CONTAINER_DESKTOP) {
        return true;                                  // 非桌面非 hotseat（如文件夹内）不校验
    }

    // 桌面：校验网格边界
    final int countX = mIDP.numColumns;
    final int countY = mIDP.numRows;
    if (item.cellX < 0 || item.cellY < 0
            || item.cellX + item.spanX > countX || item.cellY + item.spanY > countY) {
        return false;                                 // 越界
    }

    if (!mOccupied.containsKey(item.screenId)) {
        GridOccupancy screen = new GridOccupancy(countX + 1, countY + 1);
        if (qsbOnFirstScreen() && item.screenId == Workspace.FIRST_SCREEN_ID) {
            screen.markCells(0, 0, mIDP.numSearchContainerColumns, 1, true);  // 首屏预留 QSB 区域
        }
        mOccupied.put(item.screenId, screen);
    }
    final GridOccupancy occupancy = mOccupied.get(item.screenId);
    if (occupancy.isRegionVacant(item.cellX, item.cellY, item.spanX, item.spanY)) {
        occupancy.markCells(item, true);              // 标记占用
        return true;
    } else {
        return false;                                 // 区域已被占（重叠）
    }
}
```

**入模 `checkAndAddItem`**（合法才进数据结构）：

```java
public void checkAndAddItem(ItemInfo info, IntSparseArrayMap<ItemInfo> loadedItems, LoaderMemoryLogger logger) {
    if (info.itemType == Favorites.ITEM_TYPE_DEEP_SHORTCUT) {
        ShortcutKey.fromItemInfo(info);               // 校验 Intent 合法（非法抛异常，跳过该项）
    }
    if (checkItemPlacement(info)) {                   // 位置合法
        loadedItems.put(info.id, info);               // 进主 map
        if ((info.itemType == ITEM_TYPE_APP_PAIR || info.itemType == ITEM_TYPE_DEEP_SHORTCUT
                || info.itemType == ITEM_TYPE_APPLICATION)
                && info.container != CONTAINER_DESKTOP && info.container != CONTAINER_HOTSEAT) {
            findOrMakeFolder(info.container, loadedItems).add(info);  // 不在桌面/hotseat → 进文件夹
        }
    } else {
        markDeleted("Item position overlap", RestoreError.OVERLAPPING_ITEM);  // 标记删除
    }
}
```

### 4.7 完整时序图：数据库记录 → 屏幕图标

```
UI线程            MODEL_EXECUTOR(后台)          SQLite
 │                    │                          │
 │ 启动/触发重载       │                          │
 │───────────────────>│ LauncherModel.startLoader│
 │                    │ MODEL_EXECUTOR.post(task)│
 │                    │                          │
 │                    │ LoaderTask.run()         │
 │                    │ beginLoader() ── lastLoadId++, mModelLoaded=false
 │                    │                          │
 │                    │ loadWorkspaceImpl()      │
 │                    │  ├─ attemptMigrateDb ────>│ (网格迁移)
 │                    │  ├─ loadDefaultFavoritesIfNecessary
 │                    │  ├─ query(Favorites) ───>│ SELECT * FROM Favorites
 │                    │  │                   <────│ Cursor
 │                    │  ├─ queryPinnedShortcuts ─> ShortcutRequest (预查 pinned)
 │                    │  │
 │                    │  │ while(c.moveToNext()):
 │                    │  │   LoaderCursor.moveToNext()        // 解析一行公共字段
 │                    │  │     itemType/container/id/user/restoreFlag
 │                    │  │   WorkspaceItemProcessor.processItem()
 │                    │  │     ├─ processAppOrDeepShortcut()
 │                    │  │     │   ├─ getAppShortcutInfo(intent)
 │                    │  │     │   │   ├─ resolveActivity (校验)
 │                    │  │     │   │   └─ 加入 mWorkspaceIconRequestInfos
 │                    │  │     │   └─ applyCommonProperties(id/container/screen/cell)
 │                    │  │     └─ checkAndAddItem(info, loadedItems)
 │                    │  │          ├─ checkItemPlacement()    // 防重叠/越界
 │                    │  │          └─ loadedItems.put(id, info)
 │                    │  │
 │                    │  ├─ tryLoadWorkspaceIconsInBulk()       // 批量补图标
 │                    │  │    iconCache.getTitlesAndIconsInBulk(requestInfos)
 │                    │  │      └─ 详见第五章 IconCache
 │                    │  │
 │                    │  └─ finalizeData()
 │                    │       ├─ commitDeleted (markDeleted 标记的)
 │                    │       ├─ processFolderItems (排序+预览图标)
 │                    │       └─ deleteEmptyFolders/deleteBadAppPairs/deleteUnparentedApps
 │                    │
 │                    │ dataLoadComplete(loadedItems)
 │                    │   itemsIdMap.replaceDataMap(loadedItems)  // version++
 │                    │
 │                    │ bindWorkspace()   [BaseLauncherBinder]
 │                    │   itemsIdMap = mBgDataModel.itemsIdMap.copy()   // 不可变快照
 │                    │   lastBindId++；lastLoadId = model.getLastLoadId()
 │<───────────────────│   cb.bindCompleteModelAsync(itemsIdMap, false)
 │                    │
 │ 主线程渲染           │
 │ Launcher.bindCompleteModel(...)
 │   遍历 itemsIdMap，按 container/screen/cellX/cellY
 │   创建 BubbleTextView（icon = info.newIcon(ctx)）
 │ ▼
 │ 屏幕上出现图标
```

### 面试深问

1. **Q：为什么 `processAppOrDeepShortcut` 里要先查 `shortcutKeyToPinnedShortcuts` 再 `retryDeepShortcutById`？**
   A：`queryPinnedShortcutsForUnlockedUsers` 在加载开始时一次性批量查了所有用户的 pinned shortcuts 缓存到 map，避免每行都查 ShortcutManager。但 ShortcutManager 的数据可能在加载期间被清，所以 map miss 时再按 id 重查一次（`retryDeepShortcutById`），两次都 miss 才 `markDeleted`。

2. **Q：`checkItemPlacement` 用什么数据结构防重叠？为什么 hotseat 和 desktop 分开？**
   A：用 `IntSparseArrayMap<GridOccupancy> mOccupied`，key 是容器 id（HOTSEAT 用 `CONTAINER_HOTSEAT` 常量，desktop 用 `screenId`）。hotseat 是 `1×N` 一维，desktop 是 `countX×countY` 二维，结构不同所以分开。文件夹内的项不校验（`container != CONTAINER_DESKTOP` 直接 return true），因为文件夹内位置由 rank 决定。

3. **Q：`finalizeData` 为什么要删 `deleteUnparentedApps`？**
   A：脏数据场景：DB 里某个 WorkspaceItemInfo 的 container 指向一个不存在的文件夹 id（文件夹记录被外部删了，子项没删）。加载时 `findOrMakeFolder` 会建占位文件夹，但如果该文件夹记录本身没在 Cursor 里出现，占位 FolderInfo 不会进 loadedItems，子项就成了孤儿。`deleteUnparentedApps` 清理这些找不到父集合的项，保持数据一致性。

---

## 五、IconCache 图标缓存机制

> 源文件：`icons/IconCache.java`（Launcher3）+ `icons/cache/BaseIconCache.java`（iconloaderlib）

图标缓存是性能关键：从 APK 解码渲染图标很慢，不能每次都做。

### 5.1 两级缓存架构

```
┌──────────────────────────────────────────────────────┐
│                    IconCache                          │
│  ┌────────────────────────────────────────────────┐  │
│  │ 内存缓存 mCache (HashMap)                       │  │
│  │  key = ComponentKey(ComponentName, UserHandle)  │  │
│  │  value = CacheEntry { BitmapInfo bitmap;        │  │
│  │          CharSequence title;                    │  │
│  │          CharSequence contentDescription }      │  │
│  └──────────────────────┬─────────────────────────┘  │
│                         │ miss 时                      │
│  ┌──────────────────────▼─────────────────────────┐  │
│  │ 磁盘缓存 IconDB (SQLiteCacheHelper)             │  │
│  │  表 icons: componentName, profileId,            │  │
│  │   lastUpdated, version, icon BLOB,              │  │
│  │   icon_color, label, system_state, keywords     │  │
│  │  库: icon_cache.db                              │  │
│  └──────────────────────┬─────────────────────────┘  │
│                         │ miss 时                      │
│  ┌──────────────────────▼─────────────────────────┐  │
│  │ 实时加载 cachingLogic.loadIcon                  │  │
│  │  LauncherActivityCachingLogic: 从 APK 解码渲染   │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

### 5.2 内存缓存：mCache

```java
// BaseIconCache
private final Map<ComponentKey, CacheEntry> mCache;          // 核心存储
private final HashMap<UserHandle, BitmapInfo> mDefaultIcons; // 每个 user 的默认图标（懒加载）

public static class CacheEntry {
    @NonNull public BitmapInfo bitmap = BitmapInfo.LOW_RES_INFO;   // 图标（默认低清占位）
    public CharSequence title = "";
    public CharSequence contentDescription = "";
}
```

初始容量 `INITIAL_ICON_CACHE_CAPACITY = 50`。构造时 `inMemoryCache=false`（如 Go 版）用一个空 Map 适配器（`put` 直接返回 value，`entrySet` 返回空集），即"只写不存"。

```java
if (inMemoryCache) {
    mCache = new HashMap<>(INITIAL_ICON_CACHE_CAPACITY);
} else {
    mCache = new AbstractMap<ComponentKey, CacheEntry>() {       // 空适配器
        @Override public Set<Entry<ComponentKey, CacheEntry>> entrySet() { return Collections.emptySet(); }
        @Override public CacheEntry put(ComponentKey key, CacheEntry value) { return value; }
    };
}
```

**BitmapInfo 高低分辨率**：高清存完整 Bitmap（内存大），低清只存主色 `color` + 缩略图（`BitmapInfo.LOW_RES_INFO`）。桌面/Hotseat 用高清，AllApps/文件夹内用低清省内存。

### 5.3 磁盘缓存：IconDB 表结构

```java
public static final class IconDB extends SQLiteCacheHelper {
    private static final int RELEASE_VERSION = 31;              // 版本号（影响 DB 重建）
    public static final String TABLE_NAME = "icons";

    // onCreateTable 建表 SQL：
    // CREATE TABLE IF NOT EXISTS icons (
    //   componentName TEXT NOT NULL,            ComponentName.flattenToString()
    //   profileId INTEGER NOT NULL,             userSerial
    //   lastUpdated INTEGER NOT NULL DEFAULT 0, 包最后更新时间
    //   version INTEGER NOT NULL DEFAULT 0,     versionCode
    //   icon BLOB,                              图标二进制（高清才有）
    //   icon_color INTEGER NOT NULL DEFAULT 0,  主色（低清也有）
    //   label TEXT,                             应用名
    //   system_state TEXT,                      系统状态（locale + sdk）
    //   keywords TEXT,                          搜索关键词
    //   PRIMARY KEY (componentName, profileId)
    // )

    public static final String[] COLUMNS_HIGH_RES = { COLUMN_ICON_COLOR, COLUMN_LABEL, COLUMN_ICON };  // 高清查三列
    public static final String[] COLUMNS_LOW_RES  = { COLUMN_ICON_COLOR, COLUMN_LABEL };               // 低清查两列（无 icon BLOB）
}
```

`SQLiteCacheHelper` 的版本号 = `(RELEASE_VERSION << 16) + iconPixelSize`，图标尺寸变化时版本号变，DB 自动重建。

### 5.4 system_state 校验机制

```java
private void updateSystemState() {
    mLocaleList = mContext.getResources().getConfiguration().getLocales();
    mSystemState = mLocaleList.toLanguageTags() + "," + Build.VERSION.SDK_INT;   // locale + SDK 版本
}
```

系统语言/版本变化时 `mSystemState` 变化，存进 `system_state` 列。`IconCacheUpdateHandler` 比对 `lastUpdated` 和 `system_state` 决定是否刷新图标——语言变了，应用名（label）变了，缓存自动失效。

### 5.5 核心取图标逻辑：cacheLocked（三级查找）

> 源文件：`BaseIconCache.java`

```java
protected <T> CacheEntry cacheLocked(
        @NonNull ComponentName componentName, @NonNull UserHandle user,
        @NonNull Supplier<T> infoProvider, @NonNull CachingLogic<T> cachingLogic,
        boolean usePackageIcon, boolean useLowResIcon) {
    assertWorkerThread();                                      // 必须在后台线程
    ComponentKey cacheKey = new ComponentKey(componentName, user);

    // ① 先查内存
    CacheEntry entry = mCache.get(cacheKey);
    if (entry == null || (entry.bitmap.isLowRes() && !useLowResIcon)) {  // miss 或需要高清但只有低清
        entry = new CacheEntry();
        if (cachingLogic.addToMemCache()) mCache.put(cacheKey, entry);   // 允许才入内存缓存

        T object = null;
        boolean providerFetchedOnce = false;

        // ② 再查磁盘
        if (!getEntryFromDB(cacheKey, entry, useLowResIcon)) {
            // ③ 磁盘也没有，从 APK 实时加载
            object = infoProvider.get();                       // LauncherActivityInfo
            providerFetchedOnce = true;
            if (object != null) {
                entry.bitmap = cachingLogic.loadIcon(mContext, object);  // 解码渲染
            } else {
                if (usePackageIcon) {                          // 用包级默认图标兜底
                    CacheEntry packageEntry = getEntryForPackageLocked(componentName.getPackageName(), user, false);
                    if (packageEntry != null) {
                        entry.bitmap = packageEntry.bitmap;
                        entry.title = packageEntry.title;
                        entry.contentDescription = packageEntry.contentDescription;
                    }
                }
                if (entry.bitmap == null) {
                    entry.bitmap = getDefaultIcon(user);       // 最终兜底：默认图标
                }
            }
        }
        // 补 title（DB 没有时）
        if (TextUtils.isEmpty(entry.title)) {
            if (object == null && !providerFetchedOnce) object = infoProvider.get();  // 懒加载，避免重复查
            if (object != null) {
                entry.title = cachingLogic.getLabel(object);
                entry.contentDescription = mPackageManager.getUserBadgedLabel(cachingLogic.getDescription(object, entry.title), user);
            }
        }
    }
    return entry;
}
```

磁盘查询 `getEntryFromDB`：

```java
protected boolean getEntryFromDB(ComponentKey cacheKey, CacheEntry entry, boolean lowRes) {
    Cursor c = null;
    try {
        c = mIconDb.query(
                lowRes ? IconDB.COLUMNS_LOW_RES : IconDB.COLUMNS_HIGH_RES,    // 低清不查 icon BLOB
                IconDB.COLUMN_COMPONENT + " = ? AND " + IconDB.COLUMN_USER + " = ?",
                new String[]{ cacheKey.componentName.flattenToString(),
                              Long.toString(getSerialNumberForUser(cacheKey.user)) });
        if (c.moveToNext()) {
            entry.bitmap = BitmapInfo.of(LOW_RES_ICON, setColorAlphaBound(c.getInt(0), 255));  // 先用主色建低清
            entry.title = c.getString(1);
            if (entry.title == null) { entry.title = ""; entry.contentDescription = ""; }
            else entry.contentDescription = mPackageManager.getUserBadgedLabel(entry.title, cacheKey.user);

            if (!lowRes) {                                     // 高清：解码 icon BLOB
                entry.bitmap = BitmapInfo.fromByteArray(c.getBlob(2), entry.bitmap.color, cacheKey.user, this, mContext);
            }
            return entry.bitmap != null;
        }
    } catch (SQLiteException e) { Log.d(TAG, "Error reading icon cache", e); }
    finally { if (c != null) c.close(); }
    return false;
}
```

### 5.6 批量加载优化：getTitlesAndIconsInBulk

`LoaderTask` 不对每个图标查一次 DB（N 次 IO），而是收集所有 `IconRequestInfo` 一次性批量查询：

```java
// IconCache.getTitlesAndIconsInBulk
public synchronized <T extends ItemInfoWithIcon> void getTitlesAndIconsInBulk(
        List<IconRequestInfo<T>> iconRequestInfos) {
    // 按 (UserHandle, CacheLookupFlag) 分组
    Map<Pair<UserHandle, CacheLookupFlag>, List<IconRequestInfo<T>>> iconLoadSubsectionsMap =
        iconRequestInfos.stream()
            .filter(iconRequest -> {                            // 过滤 null component
                if (iconRequest.itemInfo.getTargetComponent() == null) {
                    iconRequest.itemInfo.bitmap = getDefaultIcon(iconRequest.itemInfo.user);
                    return false;
                }
                return true;
            })
            .collect(groupingBy(iconRequest ->
                    Pair.create(iconRequest.itemInfo.user, iconRequest.lookupFlag)));

    iconLoadSubsectionsMap.forEach((sectionKey, filteredList) -> {
        // 组内再按 ComponentName 分组（去重，同名图标只查一次）
        Map<ComponentName, List<IconRequestInfo<T>>> duplicateIconRequestsMap =
            filteredList.stream()
                .filter(iconRequest -> {                        // deep shortcut 不走批量
                    if (iconRequest.itemInfo.itemType == ITEM_TYPE_DEEP_SHORTCUT) return false;
                    return true;
                })
                .collect(groupingBy(iconRequest -> iconRequest.itemInfo.getTargetComponent()));
        loadIconSubsection(sectionKey, filteredList, duplicateIconRequestsMap);
    });
}
```

`createBulkQueryCursor` 生成形如 `WHERE componentName IN (...) AND profileId = ?` 的批量 SQL：

```java
private <T extends ItemInfoWithIcon> Cursor createBulkQueryCursor(
        List<IconRequestInfo<T>> iconRequestInfos, UserHandle user, CacheLookupFlag lookupFlag) {
    String[] queryParams = Stream.concat(
            iconRequestInfos.stream()
                .map(r -> r.itemInfo.getTargetComponent())
                .filter(Objects::nonNull).distinct()
                .map(ComponentName::flattenToString),
            Stream.of(Long.toString(getSerialNumberForUser(user)))).toArray(String[]::new);
    String componentNameQuery = TextUtils.join(",", Collections.nCopies(queryParams.length - 1, "?"));  //?,?,?

    return iconDb.query(
            toLookupColumns(lookupFlag),
            COLUMN_COMPONENT + " IN ( " + componentNameQuery + " )" + " AND " + COLUMN_USER + " = ?",
            queryParams);
}
```

`loadIconSubsection` 先用批量 Cursor 命中 DB 的项，未命中的 fallback 到实时加载：

```java
private <T extends ItemInfoWithIcon> void loadIconSubsection(...) {
    try (Cursor c = createBulkQueryCursor(filteredList, sectionKey.first, sectionKey.second)) {
        while (c.moveToNext()) {                               // 命中的直接用
            ComponentName cn = ComponentName.unflattenFromString(c.getString(...));
            List<IconRequestInfo<T>> duplicateIconRequests = duplicateIconRequestsMap.get(cn);
            if (cn != null && duplicateIconRequests != null) {
                CacheEntry entry = cacheLocked(cn, sectionKey.first, () -> duplicateIconRequests.get(0).launcherActivityInfo,
                        LauncherActivityCachingLogic.INSTANCE, sectionKey.second, c);  // 把 Cursor 传进去避免重复查
                for (IconRequestInfo<T> iconRequest : duplicateIconRequests) {
                    applyCacheEntry(entry, iconRequest.itemInfo);                  // 同名图标复用
                }
            }
        }
    } catch (SQLiteException e) { Log.d(TAG, "Error reading icon cache", e); }

    // 未命中的 fallback：实时从 APK 加载
    for (ComponentName cn : duplicateIconRequestsMap.keySet()) {
        IconRequestInfo<T> iconRequestInfo = duplicateIconRequestsMap.get(cn).get(0);
        ItemInfoWithIcon itemInfo = iconRequestInfo.itemInfo;
        boolean loadFallbackIcon = icon == null || isDefaultIcon(icon, itemInfo.user) || icon == BitmapInfo.LOW_RES_INFO;
        if (loadFallbackTitle || loadFallbackIcon) {
            // loadFallbackIcon / loadFallbackTitle 从 APK 实时解码
        }
    }
}
```

### 5.7 图标写回：addIconToDBAndMemCache

```java
public synchronized <T> void addIconToDBAndMemCache(T object, CachingLogic<T> cachingLogic,
        PackageInfo info, long userSerial, boolean replaceExisting) {
    UserHandle user = cachingLogic.getUser(object);
    ComponentName componentName = cachingLogic.getComponent(object);
    final ComponentKey key = new ComponentKey(componentName, user);
    CacheEntry entry = null;
    if (!replaceExisting) {
        entry = mCache.get(key);
        if (entry == null || entry.bitmap.isNullOrLowRes()) entry = null;  // 低清不能复用
    }
    if (entry == null) {
        entry = new CacheEntry();
        entry.bitmap = cachingLogic.loadIcon(mContext, object);             // 实时渲染
    }
    if (entry.bitmap.isNullOrLowRes()) return;                              // 无效图标不缓存
    entry.title = cachingLogic.getLabel(object);
    entry.contentDescription = mPackageManager.getUserBadgedLabel(entry.title, user);
    if (cachingLogic.addToMemCache()) mCache.put(key, entry);               // 写内存

    ContentValues values = newContentValues(entry.bitmap, entry.title.toString(),
            componentName.getPackageName(), cachingLogic.getKeywords(object, mLocaleList));
    addIconToDB(values, componentName, info, userSerial, cachingLogic.getLastUpdatedTime(object, info));  // 写磁盘
}
```

### 5.8 Favorites 表也存图标（ICON 列）的作用

`WorkspaceItemInfo.onAddToDatabase()` 在非低分辨率场景调 `writer.putIcon(bitmap, user)`，把图标 BLOB 写进 **Favorites 表的 ICON 列**。用途：

- **备份恢复**：系统备份恢复时 `icon_cache.db` 不一定在，但 Favorites 表跟着备份，归档/恢复的图标能从 `Favorites.ICON` 取回。
- 加载时 `IconRequestInfo.loadIconFromDbBlob()` 优先尝试从 Favorites 行的 blob 解码，失败再走 IconCache。

```java
// LoaderCursor.createIconRequestInfo —— 决定是否带 DB blob
public IconRequestInfo<WorkspaceItemInfo> createIconRequestInfo(WorkspaceItemInfo wai, boolean useLowResIcon) {
    byte[] iconBlob = itemType == Favorites.ITEM_TYPE_DEEP_SHORTCUT || restoreFlag != 0
            || (wai.isInactiveArchive() && Flags.restoreArchivedAppIconsFromDb())
            ? getIconBlob() : null;                                          // shortcut/恢复/归档才带 blob
    return new IconRequestInfo<>(wai, mActivityInfo, iconBlob, wai.hasStatusFlag(FLAG_RESTORED_FULL_BLEED), DESKTOP_ICON_FLAG.withUseLowRes(useLowResIcon));
}
```

```java
// IconRequestInfo.loadIconFromDbBlob —— 从 blob 解码
public boolean loadIconFromDbBlob(Context context) {
    if (!(itemInfo instanceof WorkspaceItemInfo) && !(itemInfo instanceof AppInfo)) {
        throw new IllegalStateException(...);                                 // 仅这两种类型支持
    }
    try (LauncherIcons li = LauncherIcons.obtain(context)) {
        BitmapInfo bitmap = parseIconBlob(li);
        if (bitmap == null) return false;
        info.bitmap = bitmap;
        return true;
    }
}
```

`LoaderTask.tryLoadWorkspaceIconsInBulk` 在批量补图标后，对仍是默认图标的项尝试从 DB blob 恢复：

```java
private void tryLoadWorkspaceIconsInBulk(List<IconRequestInfo<WorkspaceItemInfo>> iconRequestInfos) {
    mIconCache.getTitlesAndIconsInBulk(iconRequestInfos);                    // 批量补
    for (IconRequestInfo<WorkspaceItemInfo> iconRequestInfo : iconRequestInfos) {
        WorkspaceItemInfo wai = iconRequestInfo.itemInfo;
        if (mIconCache.isDefaultIcon(wai.bitmap, wai.user)) {                // 仍是默认图标
            iconRequestInfo.loadIconFromDbBlob(mContext);                    // 从 Favorites.ICON blob 恢复
        }
    }
}
```

### 5.9 内存占用控制

`mCache` 是普通 `HashMap`，**没有 LruCache 也没有弱引用**。控制策略：

1. **高低分辨率分级**：AllApps/文件夹内用低清（只存主色 + 缩略图），桌面/Hotseat 用高清。低清 `BitmapInfo` 内存占用远小于完整 Bitmap。
2. **`cachingLogic.addToMemCache()` 开关**：deep shortcut 不入内存缓存（`getShortcutIcon` 用 `withSkipAddToMemCache()`），因为 shortcut 不常用且数量可能很大。
3. **包卸载时清理**：`removeIconsForPkg` 同时清内存和磁盘。
4. **图标尺寸变化重建**：`updateIconParamsBg` 清空 `mCache` 并重建 `IconDB`（版本号变）。

### 面试深问

1. **Q：为什么 deep shortcut 不入内存缓存？**
   A：shortcut 数量可能很大（每个 App 可发布多个），且大部分不常访问。`getShortcutIcon` 用 `lookupFlag.withSkipAddToMemCache()`，只查磁盘 IconDB，miss 则实时渲染后直接返回不缓存到内存。这样避免 mCache 膨胀，磁盘缓存仍然命中。

2. **Q：批量加载为什么先按 `(User, LookupFlag)` 分组，再按 ComponentName 去重？**
   A：第一层分组是因为批量 SQL 的 `WHERE componentName IN(...) AND profileId=?` 只能查同一 user、同一 lookup flag 的项（不同 user 的 serial 不同，lookup flag 决定查高清还是低清列）。第二层去重是因为多个 IconRequestInfo 可能指向同一 ComponentName（如同一 App 的多个快捷方式），DB 查一次，结果复用给所有请求。

3. **Q：`system_state` 失效后，旧图标数据会立即删吗？**
   A：不会主动删。`IconCacheUpdateHandler` 比对 `lastUpdated` 和 `system_state`，不一致就重新生成图标并 `addIconToDB` 覆盖（`insertOrReplace`）。旧记录被新记录覆盖，无需显式删除。DB 文件本身的扩容空间由 SQLite 的自动页回收处理。

---

## 六、ModelWriter：增删改同步机制

桌面不是静态的：拖动图标、新建文件夹、卸载应用……每次变更都要同时更新数据库和内存模型，并通知 UI。

### 6.1 ModelWriter：变更的唯一入口

> 源文件：`model/ModelWriter.java`
> 注释：*"Class for handling model updates."*

所有桌面项的持久化操作都走 `ModelWriter`。核心 API：

| 方法 | 作用 |
|------|------|
| `addItemToDatabase(item, container, screen, cellX, cellY)` | 新增（分配 id + 写库 + 入模 + 通知） |
| `addItemsToDatabase(items)` | 批量新增 |
| `moveItemInDatabase(item, container, screen, cellX, cellY)` | 移动（仅位置） |
| `modifyItemInDatabase(item, ..., spanX, spanY)` | 移动 + 改大小 |
| `updateItemInDatabase(item)` | 通用更新（调 `item.onAddToDatabase`） |
| `deleteItemFromDatabase(item, reason)` | 删除 |
| `deleteItemsFromDatabase(matcher, reason)` | 按条件批量删 |
| `deleteCollectionAndContentsFromDatabase(folderInfo)` | 删文件夹及其内容 |
| `addOrMoveItemInDatabase(item, ...)` | 新项则 add，旧项则 move |

### 6.2 一个"新增图标"的完整链路（乐观更新）

以从 AllApps 拖一个应用到桌面为例：

```java
// ModelWriter.addItemToDatabase
public void addItemToDatabase(final ItemInfo item, int container, int screenId, int cellX, int cellY) {
    updateItemInfoProps(item, container, screenId, cellX, cellY);   // 设置位置字段（经 CellPosMapper 转换）
    addItemsToDatabase(Collections.singletonList(item));
}

public void addItemsToDatabase(final List<ItemInfo> items) {
    items.forEach(info -> info.id = mModel.getModelDbController().generateNewItemId());  // ① 分配新 id
    notifyOtherCallbacks(c -> c.bindItemsAdded(items));             // ② 立即通知 UI（乐观显示，写库前）

    ModelVerifier verifier = new ModelVerifier();
    final StackTraceElement[] stackTrace = new Throwable().getStackTrace();
    newModelTask(() -> {
        // ③ 后台线程真正写库 + 入模
        for (ItemInfo item: items) {
            final ContentWriter writer = new ContentWriter(mContext);
            item.onAddToDatabase(writer);                           // ItemInfo 自己决定写哪些列
            writer.put(Favorites._ID, item.id);
            mModel.getModelDbController().insert(writer.getValues(mContext));   // INSERT
        }
        synchronized (mBgDataModel) {
            for (ItemInfo item: items) {
                checkItemInfoLocked(item.id, item, stackTrace);     // 一致性校验
            }
            mBgDataModel.addItems(mContext, items, mOwner);          // 进 itemsIdMap
            verifier.verifyModel();                                  // 校验绑定一致性
        }
    }).executeOnModelThread();
}
```

**关键设计：乐观更新（optimistic update）**

- `notifyOtherCallbacks(bindItemsAdded)` 在**写库之前**就执行，UI 先把图标画出来，体验流畅。
- 真正的 DB 写入和入模在 `MODEL_EXECUTOR` 异步进行。
- `ModelVerifier` 校验：如果写库期间发生了新一轮全量加载（`lastBindId` 变了），就触发 `rebindCallbacks()` 重新绑定。

### 6.3 一致性校验：checkItemInfoLocked

```java
private void checkItemInfoLocked(int itemId, ItemInfo item, StackTraceElement[] stackTrace) {
    ItemInfo modelItem = mBgDataModel.itemsIdMap.get(itemId);
    if (modelItem != null && item != modelItem) {                   // 模型里的项和传入的项必须同一引用
        // 宽松校验：WorkspaceItemInfo 字段全等也算一致（仅 debug/studio 走严格引用校验）
        if (!Utilities.IS_DEBUG_DEVICE && !FeatureFlags.IS_STUDIO_BUILD
                && modelItem instanceof WorkspaceItemInfo && item instanceof WorkspaceItemInfo) {
            if (modelItem.title.toString().equals(item.title.toString()) &&
                    modelItem.getIntent().filterEquals(item.getIntent()) &&
                    modelItem.id == item.id && modelItem.itemType == item.itemType &&
                    modelItem.container == item.container && modelItem.screenId == item.screenId &&
                    modelItem.cellX == item.cellX && modelItem.cellY == item.cellY &&
                    modelItem.spanX == item.spanX && modelItem.spanY == item.spanY) {
                return;                                             // 字段全等，放过
            }
        }
        // 否则抛 RuntimeException —— 数据模型不一致是致命 bug
        throw new RuntimeException("ItemInfo passed to checkItemInfo doesn't match original");
    }
}
```

这保证 `itemsIdMap` 里的 ItemInfo 引用和 UI 层持有的引用是同一对象，修改字段能即时反映。

### 6.4 ModelTask 的 loadId 守卫

```java
private abstract class ModelTask implements Runnable {
    private final int mLoadId = mBgDataModel.lastLoadId;            // 提交时的快照

    @Override
    public final void run() {
        if (mLoadId != mModel.getLastLoadId()) {                    // 排队期间模型已被重新加载
            Log.d(TAG, "Model changed before the task could execute");
            return;                                                 // 丢弃这个过期任务
        }
        runImpl();
    }

    public final void executeOnModelThread() { MODEL_EXECUTOR.execute(this); }
    public abstract void runImpl();
}
```

防止"旧快照上的写操作"污染"新加载的模型"。场景：用户拖动图标 → 任务排队 → 此时配置变更触发全量重载（`lastLoadId++`）→ 任务出队执行时 `mLoadId != lastLoadId`，直接丢弃，避免把旧位置的写入覆盖到新模型。

### 6.5 ModelVerifier：绑定一致性校验

```java
public class ModelVerifier {
    final int startId;
    ModelVerifier() { startId = mBgDataModel.lastBindId; }          // 任务提交时的 bindId

    void verifyModel() {
        if (!mVerifyChanges || !mModel.hasCallbacks()) return;
        int executeId = mBgDataModel.lastBindId;                    // 任务执行时的 bindId

        mUiExecutor.post(() -> {
            int currentId = mBgDataModel.lastBindId;                // post 到主线程时的 bindId
            if (currentId > executeId) return;                      // 模型已绑定到更新版本，无需重绑
            if (executeId == startId) return;                       // 任务期间 bindId 没变，正常
            // bindId 在任务提交和执行之间变了，但没绑定到更新版本 → 需要重绑
            mModel.rebindCallbacks();
        });
    }
}
```

### 6.6 移动/修改的链路

```java
// ModelWriter.moveItemInDatabase
public void moveItemInDatabase(final ItemInfo item, int container, int screenId, int cellX, int cellY) {
    updateItemInfoProps(item, container, screenId, cellX, cellY);   // 改 ItemInfo 字段
    notifyItemModified(item);                                       // 立即 bindItemsUpdated（乐观刷新）

    enqueueDeleteRunnable(new UpdateItemRunnable(item, () ->        // 后台写库
            new ContentWriter(mContext)
                    .put(Favorites.CONTAINER, item.container)
                    .put(Favorites.CELLX, item.cellX)
                    .put(Favorites.CELLY, item.cellY)
                    .put(Favorites.RANK, item.rank)
                    .put(Favorites.SCREEN, item.screenId)));
}

// UpdateItemRunnable.runImpl
public void runImpl() {
    mModel.getModelDbController().update(mWriter.get().getValues(mContext), itemIdMatch(mItemId), null);  // UPDATE WHERE _ID=?
    updateItemArrays(mItem, mItemId);                               // 加锁一致性校验
    mBgDataModel.updateItems(Collections.singletonList(mItem), mOwner);
}
```

### 6.7 删除的 Undo 机制

```java
// ModelWriter
public void prepareToUndoDelete() {
    if (!mPreparingToUndo) {
        if (!mDeleteRunnables.isEmpty() && FeatureFlags.IS_STUDIO_BUILD) {
            throw new IllegalStateException("There are still uncommitted delete operations!");
        }
        mDeleteRunnables.clear();
        mPreparingToUndo = true;                                    // 进入"待撤销"模式
    }
}

private void enqueueDeleteRunnable(ModelTask r) {
    if (mPreparingToUndo) {
        mDeleteRunnables.add(r);                                    // 暂存，不立即执行
    } else {
        r.executeOnModelThread();                                  // 正常模式直接执行
    }
}

public void commitDelete() {                                       // 用户确认删除
    mPreparingToUndo = false;
    mDeleteRunnables.forEach(ModelTask::executeOnModelThread);     // 提交所有暂存的删除
    mDeleteRunnables.clear();
}

public void abortDelete() {                                        // 用户撤销
    mPreparingToUndo = false;
    mDeleteRunnables.clear();                                      // 清空待删队列
    // 全量重载，因为 Folder 拖出项时会改内部状态，rebind 无法恢复
    mModel.forceReload();
}
```

删除链路（如拖到删除区）：

```java
public void deleteItemsFromDatabase(final Collection<? extends ItemInfo> items, @Nullable final String reason) {
    ModelVerifier verifier = new ModelVerifier();
    FileLog.d(TAG, "removing items from db " + items.stream()...);  // 记录删除原因到 FileLog
    notifyDelete(items);                                            // 立即 bindWorkspaceComponentsRemoved（UI 先消失）
    enqueueDeleteRunnable(newModelTask(() -> {                      // 后台删
        for (ItemInfo item : items) {
            mModel.getModelDbController().delete(itemIdMatch(item.id), null);  // DELETE WHERE _ID=?
        }
        mBgDataModel.removeItem(mContext, items, mOwner);           // 从 itemsIdMap 删
        verifier.verifyModel();
    }));
}

// 删文件夹及其内容
public void deleteCollectionAndContentsFromDatabase(final CollectionInfo info) {
    notifyDelete(Collections.singleton(info));
    enqueueDeleteRunnable(newModelTask(() -> {
        mModel.getModelDbController().delete(Favorites.CONTAINER + "=" + info.id, null);  // 删所有子项
        mModel.getModelDbController().delete(Favorites._ID + "=" + info.id, null);        // 删文件夹本身
        List<ItemInfo> itemsToDelete = new ArrayList<>(info.getContents());
        itemsToDelete.add(info);
        mBgDataModel.removeItem(mContext, itemsToDelete, mOwner);
        verifier.verifyModel();
    }));
}
```

### 6.8 notifyOtherCallbacks 的 owner 过滤

```java
private void notifyOtherCallbacks(CallbackTask task) {
    if (mOwner == null) return;                                     // 从 model 调用，由 model 统一通知
    mUiExecutor.execute(() -> {
        for (Callbacks c : mModel.getCallbacks()) {
            if (c != mOwner) {                                      // 排除自己（自己已乐观更新）
                task.execute(c);
            }
        }
    });
}
```

### 面试深问

1. **Q：乐观更新如果写库失败了怎么办？**
   A：UI 已经显示了图标，但 DB 没写进去。下一次全量加载（重启/配置变更）时该图标会消失。这是 Launcher 的取舍——优先保证交互流畅，写库失败是低概率事件。`FileLog` 会记录失败堆栈辅助排查。`ModelVerifier` 不兜底写库失败，它只管 bindId 一致性。

2. **Q：`loadId` 守卫和 `ModelVerifier` 的 `bindId` 守卫有什么区别？**
   A：`loadId` 守卫防"过期写任务污染新模型"——任务排队期间发生全量重载（`lastLoadId++`），任务直接丢弃。`bindId` 守卫防"绑定不一致"——任务提交到执行期间 `lastBindId` 变了但没 rebind，触发 `rebindCallbacks`。前者丢任务，后者触发重绑，粒度不同。

3. **Q：`abortDelete` 为什么用 `forceReload` 全量重载，而不是直接 rebind？**
   A：源码注释明确：Folder 拖出项时会改内部状态（如关闭预览、调整 contents），clobber 了 rebind 能恢复的状态。全量重载从 DB 读原始数据，能正确恢复 Folder 内部状态。代价是性能（重新查 DB），但撤销是低频操作，可接受。

---

## 七、关键协作类速查

| 类 | 职责 |
|----|------|
| `LauncherModel` | 数据模型总管，持有 `BgDataModel`/`AllAppsList`/`ModelWriter`，调度 `LoaderTask`，管理 `LoaderTransaction` |
| `ModelDbController` | DB 控制器（CRUD、网格迁移、默认布局、generateNewItemId） |
| `DatabaseHelper` | `SQLiteOpenHelper`，定义 Favorites 表 schema、版本升级 |
| `LoaderTask` | 全量加载 Runnable（五段式），跑在 `MODEL_EXECUTOR` |
| `LoaderCursor` | Cursor 包装 + 行解析 + 位置校验（`checkItemPlacement`）+ 文件夹懒创建（`findOrMakeFolder`） |
| `WorkspaceItemProcessor` | 单行记录的类型分发处理（app/folder/widget/appPair） |
| `BaseLauncherBinder` | 把后台数据绑定到 UI Callbacks（`bindWorkspace` 拷贝不可变快照） |
| `ModelWriter` | 增删改唯一入口（乐观更新 + loadId 守卫 + ModelVerifier + Undo） |
| `IconCache`/`BaseIconCache` | 图标两级缓存（内存 mCache + 磁盘 IconDB）+ 批量加载 |
| `AllAppsList` | AllApps 应用列表（`AppInfo[]`，平行结构，不入 Favorites） |
| `WidgetsModel` | 可用小组件模型（按包分组） |
| `HomeScreenRepository` | 新架构响应式 Repository（`Flags.modelRepository()` 控制，dispatch `WorkspaceChangeEvent`） |
| `IconCacheUpdateHandler` | 图标缓存更新协调器（比对 `system_state`/`lastUpdated` 决定刷新） |
| `ModelDelegate` | 加载委托（`loadAndAddExtraModelItems` 注入预测项等） |
| `WorkspaceItemSpaceFinder` | 桌面空位查找（文件系统项落位） |

### 数据流一句话总结

`Favorites 表` →（`LoaderTask.loadWorkspaceImpl` + `LoaderCursor` 逐行解析 + `WorkspaceItemProcessor` 类型分发 + `checkItemPlacement` 防重叠）→ `BgDataModel.itemsIdMap`（`WorkspaceData` 可变实现）→（`tryLoadWorkspaceIconsInBulk` 批量补图标，`IconCache` 两级缓存）→ `dataLoadComplete` 全量替换 → `BaseLauncherBinder.bindWorkspace` 拷贝不可变快照 → 主线程 `bindCompleteModelAsync` 遍历建 `BubbleTextView` → `info.newIcon(ctx)` 拿 Drawable 渲染。增删改走 `ModelWriter`：乐观通知 UI → 后台写库 + 入模（`loadId` 守卫丢弃过期任务，`ModelVerifier` 校验绑定一致性，`prepareToUndoDelete` 支持撤销）。
