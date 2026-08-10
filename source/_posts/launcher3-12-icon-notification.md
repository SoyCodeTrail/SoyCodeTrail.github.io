---
title: Launcher3 源码精读（12）：图标与通知系统
category: client
platform: android
tags: ["AOSP", "Launcher3", "源码", "Framework"]
readTime: 26分钟
featured: true
date: 2026-08-02
---

# Launcher3 图标与通知系统

Launcher3 把所有"画图标"的代码拆成了两个工程：Launcher3 主工程只保留 `IconCache`（缓存编排）和 `NotificationListener`（系统通知接入）这些和 Launcher 业务强绑定的薄壳；真正的图标渲染管线（`FastBitmapDrawable`、`BaseIconFactory`、`ShadowGenerator`、`DotRenderer`、`IconNormalizer`）全部下沉到 `frameworks/libs/systemui/iconloaderlib`，被 SystemUI、PermissionController 等多个系统模块共享。本文按"加载 → 渲染 → 通知红点"三条主线拆解，所有引用均来自 `aosp-r4` 分支真实源码（注意该分支已用 Kotlin + Dagger 重构，旧文档里的 `DrawableFactory` / `PreloadIconDrawable` 已分别被 `FastBitmapDrawableDelegate` 委托机制和 `PreloadIconDelegate` 取代）。

涉及目录：
- `packages/apps/Launcher3/src/com/android/launcher3/icons/`（IconCache、LauncherIconProvider、LauncherIcons）
- `packages/apps/Launcher3/src/com/android/launcher3/graphics/`（PreloadIconDelegate、SysUiScrim、ThemeManager）
- `packages/apps/Launcher3/src/com/android/launcher3/notification/`（NotificationListener 及数据类）
- `packages/apps/Launcher3/src/com/android/launcher3/dot/`（DotInfo、FolderDotInfo）
- `frameworks/libs/systemui/iconloaderlib/src/com/android/launcher3/icons/`（渲染核心，FastBitmapDrawable / BaseIconFactory / DotRenderer / ShadowGenerator 等）

---

## 一、整体架构与责任划分

图标系统按"数据"和"渲染"两层切分，再按"共享库 vs Launcher 专属"切一刀，形成四象限：

| 层 | iconloaderlib（共享） | Launcher3 专属 |
|---|---|---|
| 数据/缓存 | `BaseIconCache`、`BitmapInfo`、`IconProvider` | `IconCache extends BaseIconCache`、`LauncherIconProvider extends IconProvider` |
| 渲染 | `FastBitmapDrawable`、`BaseIconFactory`、`ShadowGenerator`、`DotRenderer`、`IconShape` | `PreloadIconDelegate`、`LauncherIcons extends BaseIconFactory` |
| 通知接入 | —— | `NotificationListener`、`NotificationRepository`、`DotInfo` |

这种切分的目的：

1. **共享库避免重复造轮子**。SystemUI 的 Recents、PermissionController 的角色选择器都要画 Launcher 同款图标，复用 `iconloaderlib` 才能保证视觉一致。所以 `BaseIconFactory` 里看不到任何 `Launcher`、`ItemInfo` 这类 Launcher3 专属符号。
2. **子类只补差异**。`IconCache` 只重写 `getIconFactory()`、`getSerialNumberForUser()` 等抽象方法；`LauncherIconProvider` 只补"主题图标映射表"这一项。基类已经把 90% 逻辑写死。
3. **通知和图标解耦**。红点 (`DotRenderer`) 不挂在 `FastBitmapDrawable` 上，而由 `BubbleTextView.onDraw` 自己调。这样图标 Drawable 保持纯净，红点逻辑可独立演进（例如以后改成数字角标）。

### 数据流总览

```
应用安装/更新
    │
    ▼
IconCache.updateIconsForPkg() ──► addIconToDBAndMemCache()
    │                                   │
    │                          LauncherIcons.obtain()  (从对象池取)
    │                                   │
    │                          BaseIconFactory.createBadgedIconBitmap()
    │                                   │
    │                          drawableToBitmap():  原图 → 阴影 → 规范化缩放
    │                                   │
    │                          BitmapInfo {icon, color, flags}
    │                                   │
    ▼                                   ▼
SQLite (iconDb)                    内存 HashMap<ComponentKey, CacheEntry>
                                          │
UI 请求图标 ◄─────────────────────────────┘
    │
    ▼
BitmapInfo.newIcon() → FastBitmapDrawable
    │
    ▼
BubbleTextView.setIcon()
```

通知红点是独立的旁路：

```
系统通知中心
    │  NotificationListenerService 回调
    ▼
NotificationListener (worker 线程)
    │  过滤 + 分组 + 计数
    ▼
NotificationRepository.updateStream (ListenableStream)
    │  主线程 forEach
    ▼
PopupDataProvider.updateNotificationDots()
    │  mapOverItems
    ▼
BubbleTextView.applyDotState()  →  DotRenderer.draw()
```

### 面试深问

**Q1：为什么 iconloaderlib 放在 `frameworks/libs/systemui` 而不是 Launcher3 内部？**
共享库定位。SystemUI、PermissionController、RoleController 都要画 Launcher 同款图标，放共享库保证视觉一致和单一实现。源码注释明确写"This class will be moved to androidx library. There shouldn't be any dependency outside this package."（`BaseIconFactory` 类注释）。

**Q2：FastBitmapDrawable 和 NotificationListener 为什么完全不互相 import？**
解耦。红点由 `BubbleTextView.onDraw` 直接调 `DotRenderer.draw`，不污染图标 Drawable 的绘制链路。这样图标 Drawable 可被 Folder 预览、拖拽预览、Recents 等场景复用，不必每个场景都处理红点逻辑。

**Q3：BaseIconCache 为什么要 `assertWorkerThread()`？**
所有读写都绑死在 `MODEL_EXECUTOR` 单线程上（构造时传 `bgLooper = MODEL_EXECUTOR.getLooper()`），用 `@Synchronized` + 线程断言双重保险。UI 线程要读图标必须走异步 `updateIconInBackground`，避免在主线程持有锁造成卡顿。

---

## 二、IconCache 两级缓存

### 2.1 缓存结构

`BaseIconCache` 维护两级缓存：

```kotlin
// 内存缓存：ComponentKey(componentName, user) → CacheEntry
private val cache: MutableMap<ComponentKey, CacheEntry?> =
    if (inMemoryCache) HashMap(INITIAL_ICON_CACHE_CAPACITY) // Launcher 用这个
    else object : AbstractMutableMap<...>() { ... }          // 纯磁盘场景用空实现

// 磁盘缓存：SQLite，表名 "icons"
@JvmField protected var iconDb = createIconDb(iconPixelSize)
```

`CacheEntry` 是个极简三字段容器：

```kotlin
class CacheEntry {
    @JvmField var bitmap: BitmapInfo = BitmapInfo.LOW_RES_INFO // 图标位图（可能低分辨率占位）
    @JvmField var title: CharSequence = ""                     // 应用名
    @JvmField var contentDescription: CharSequence = ""        // 无障碍朗读文本
}
```

SQLite 表结构（`createIconDb`）：

```kotlin
"CREATE TABLE IF NOT EXISTS $TABLE_NAME (" +
    "$COLUMN_COMPONENT TEXT NOT NULL, " +        // 组件名扁平化字符串
    "$COLUMN_USER INTEGER NOT NULL, " +          // 用户 serial number
    "$COLUMN_FRESHNESS_ID TEXT, " +              // 新鲜度标识（系统状态+应用哈希）
    "$COLUMN_ICON BLOB, " +                      // 图标 PNG 字节流
    "$COLUMN_MONO_ICON BLOB, " +                 // 单色图标（主题化用）
    "$COLUMN_ICON_COLOR INTEGER NOT NULL DEFAULT 0, " + // 主色（低分辨率时仍可用）
    "$COLUMN_FLAGS INTEGER NOT NULL DEFAULT 0, "        // WORK/INSTANT/CLONE 等标记
    "$COLUMN_LABEL TEXT, " +                            // 应用名
    "PRIMARY KEY ($COLUMN_COMPONENT, $COLUMN_USER) " +  // 联合主键
    ");"
```

设计意图：`icon_color` 单独存一列。这样即使只查 `COLUMNS_LOW_RES`（不读 BLOB），也能拿到主色用于绘制低分辨率占位图标，省掉一次大 BLOB 的磁盘 IO。

### 2.2 cacheLocked 的真实实现

`cacheLocked` 是整个缓存系统的核心入口，所有 `getTitleAndIcon` 最终都汇聚到它：

```kotlin
@JvmOverloads
protected fun <T : Any> cacheLocked(
    componentName: ComponentName,           // 组件名（缓存 key 的一部分）
    user: UserHandle,                       // 用户（多用户/工作资料）
    infoProvider: Supplier<T?>,             // 懒加载源对象（LauncherActivityInfo 等）
    cachingLogic: CachingLogic<T>,          // 缓存策略（App/Shortcut/Widget 不同）
    lookupFlags: CacheLookupFlag,           // 查询标志（是否要主题图标、是否低分辨率）
    cursor: Cursor? = null,                 // 批量查询时复用的 Cursor
): CacheEntry {
    assertWorkerThread()                    // 必须在 MODEL_EXECUTOR 线程
    val cacheKey = ComponentKey(componentName, user)
    var entry = cache[cacheKey]
    // 命中条件：内存有且已有图标的 lookupFlag 不低于本次请求
    if (entry == null || entry.bitmap.matchingLookupFlag.isVisuallyLessThan(lookupFlags)) {
        val addToMemCache = entry != null || !lookupFlags.skipAddToMemCache()
        entry = CacheEntry()
        if (addToMemCache) cache[cacheKey] = entry
        // 先查 SQLite
        val cacheEntryUpdated =
            if (cursor == null) getEntryFromDBLocked(cacheKey, entry, lookupFlags, cachingLogic)
            else updateTitleAndIconLocked(cacheKey, entry, cursor, lookupFlags, cachingLogic)

        // by lazy：只有真用到才执行 infoProvider.get()（省掉不必要的 binder 调用）
        val obj: T? by lazy { infoProvider.get() }
        if (!cacheEntryUpdated) {           // DB 也没有，走兜底加载
            loadFallbackIcon(obj, entry, cachingLogic, lookupFlags,
                usePackageTitle = true, componentName, user)
        }
        if (TextUtils.isEmpty(entry.title)) { // 标题仍空，再兜底
            obj?.let { loadFallbackTitle(it, entry, cachingLogic, user) }
        }
    }
    return entry
}
```

三个关键设计：

1. **三级查找**：内存 HashMap → SQLite → 实时加载（`loadFallbackIcon` 会调 `cachingLogic.loadIcon`，最终走 `IconProvider.getIcon` 读 APK 资源）。前两级命中就完全避免 binder 调用。
2. **`val obj: T? by lazy`**：`infoProvider` 通常是 `() -> mLauncherApps.resolveActivity(intent, user)`，一次 binder 往返。用 `lazy` 保证只有 DB miss 时才执行，省掉绝大多数情况的系统服务调用。
3. **`matchingLookupFlag.isVisuallyLessThan(lookupFlags)`**：缓存里存的是低分辨率图标，但本次请求要主题化高分辨率图标，则视为 miss 重新加载。lookupFlag 是一个有序比较，避免"低精度命中导致显示模糊"。

### 2.3 批量加载的并发处理

开机首次加载要把几十上百个应用图标一次性灌入缓存。逐个 `cacheLocked` 会触发 N 次 SQLite 查询，性能不可接受。`IconCache.getTitlesAndIconsInBulk` 用单次 SQL `IN (...)` 批量查：

```java
public synchronized <T extends ItemInfoWithIcon> void getTitlesAndIconsInBulk(
        List<IconRequestInfo<T>> iconRequestInfos) {
    // 按 (UserHandle, CacheLookupFlag) 分组——不同用户/不同标志查不同列集合
    Map<Pair<UserHandle, CacheLookupFlag>, List<IconRequestInfo<T>>> iconLoadSubsectionsMap =
            iconRequestInfos.stream()
                .filter(iconRequest -> { /* 过滤掉 component 为 null 的 */ })
                .collect(groupingBy(iconRequest ->
                        Pair.create(iconRequest.itemInfo.user, iconRequest.lookupFlag)));

    Trace.beginSection("loadIconsInBulk");
    iconLoadSubsectionsMap.forEach((sectionKey, filteredList) -> {
        // 再按 ComponentName 分组，处理同包多入口的重复请求
        Map<ComponentName, List<IconRequestInfo<T>>> duplicateIconRequestsMap =
                filteredList.stream().filter(/* 排除 DEEP_SHORTCUT */)
                    .collect(groupingBy(ir -> ir.itemInfo.getTargetComponent()));
        loadIconSubsection(sectionKey, filteredList, duplicateIconRequestsMap);
    });
}
```

`loadIconSubsection` 内部用 `IN (...)` 单次查询：

```java
String componentNameQuery = TextUtils.join(
        ",", Collections.nCopies(queryParams.length - 1, "?")); // 生成 "?,?,?"

return iconDb.query(
        toLookupColumns(lookupFlag),
        COLUMN_COMPONENT + " IN ( " + componentNameQuery + " ) AND " + COLUMN_USER + " = ?",
        queryParams);
```

并发模型要点：

- **整个方法 `synchronized`**：`BaseIconCache` 所有读写都在 `MODEL_EXECUTOR` 单线程，加 `synchronized` 是为防止 `updateIconInBackground` 投递的并发任务穿插。`MODEL_EXECUTOR` 是单线程，理论上不会并发，`synchronized` 是双保险。
- **Cursor 复用**：`cacheLocked(... cursor = c)` 把批量查出的 Cursor 直接传入，逐行 `cursor.moveToNext()` 复用，避免每条记录再查一次 DB。
- **Fallback 兜底**：批量查完后，遍历 `duplicateIconRequestsMap`，对 DB 没命中的条目（`loadFallbackIcon`/`loadFallbackTitle`）逐个实时加载。这保证即使 SQLite 损坏也能显示完整图标。

### 2.4 updateIconInBackground 的优先级提升

UI 线程调 `updateIconInBackground` 时有个细节：

```java
if (Looper.myLooper() == Looper.getMainLooper()) {
    if (mPendingIconRequestCount <= 0) {
        MODEL_EXECUTOR.elevatePriority(CALLER_ICON_CACHE); // 提升 MODEL_EXECUTOR 优先级
    }
    mPendingIconRequestCount++;
    endRunnable = this::onIconRequestEnd;
}
```

`MODEL_EXECUTOR` 默认是后台优先级（避免和系统抢占）。但用户滑动 AllApps 时图标必须秒出，所以从主线程发起的图标请求会把 executor 临时升到前台优先级，请求处理完 (`onIconRequestEnd`) 再 `restorePriority`。这是用计数而非布尔，因为可能并发多个请求。

### 面试深问

**Q1：内存缓存为什么用 `HashMap` 而不是 `LruCache`？**
图标总量有限（几十到几百个），单个 `CacheEntry` 的内存大头是 `BitmapInfo.icon`（图标位图）。低分辨率场景 `icon` 是 1x1 占位图（`LOW_RES_ICON`），几乎不占内存；高分辨率才占几十 KB。总量可控，不需要 LRU 淘汰。新增/更新靠包变更广播主动 `removeIconsForPkg`。

**Q2：`freshnessId` 字段的作用？**
缓存失效标识。`getStateForApp` 返回 `locale + sdkVersion + appInfo.sourceDir`（APK 路径随每次安装变化）。应用升级后 `sourceDir` 变，`freshnessId` 不匹配，`IconCacheUpdateHandler` 判定缓存失效触发重绘。语言切换同理（locale 变化）。这比遍历所有图标逐个比对版本号高效得多。

**Q3：批量加载为什么按 `(User, CacheLookupFlag)` 分组？**
`toLookupColumns` 根据 lookupFlag 决定查哪些列：`useLowRes` 查 4 列，`hasThemeIcon` 查 7 列（含 mono_icon）。不同 flag 查询的 SQL 列不同，无法合并成一条 `IN` 语句。按 flag 分组后每组一条 SQL，既保证批量又保证列集一致。

---

## 三、图标渲染管线 BaseIconFactory

`BaseIconFactory` 是图标从 Drawable 变成 Bitmap 的唯一通道。`LauncherIcons` 只是它的薄包装 + 对象池：

```kotlin
class LauncherIcons @AssistedInject internal constructor(
    @ApplicationContext context: Context,
    idp: InvariantDeviceProfile,
    themeManager: ThemeManager,
    private var userCache: UserCache,
    @Assisted private val pool: ConcurrentLinkedQueue<LauncherIcons>, // 对象池
) : BaseIconFactory(
        context,
        idp.fillResIconDpi,        // 全分辨率 DPI
        idp.iconBitmapSize,        // 目标图标像素尺寸
        /* drawFullBleedIcons */ Flags.enableLauncherIconShapes(), // 是否满溢绘制
        themeManager.themeController,
    ), AutoCloseable {

    fun recycle() { clear(); pool.add(this) } // 用完归还对象池
    override fun close() { recycle() }

    // 对象池：ConcurrentLinkedQueue 保证多线程安全 obtain
    class IconPool @Inject internal constructor(private val factory: LauncherIconsFactory) {
        private var pool = ConcurrentLinkedQueue<LauncherIcons>()
        fun obtain(): LauncherIcons = pool.let { it.poll() ?: factory.create(it) } // 没有就 new
    }
}
```

对象池目的：`BaseIconFactory` 内部持有 `ShadowGenerator`、`Paint`、`SparseArray<UserIconInfo>` 等带状态的成员，反复 new 会触发 GC 和重复初始化。池化后 `obtain` 直接复用，`IconCache.getIconFactory()` 每次返回都走池。

### 3.1 createBadgedIconBitmap 总入口

所有图标生成都走这个方法：

```kotlin
@JvmOverloads
fun createBadgedIconBitmap(icon: Drawable?, options: IconOptions = IconOptions()): BitmapInfo {
    if (icon == null) {
        return BitmapInfo(icon = /* 空白 bitmap */, color = 0)
    }
    val oldBounds = icon.bounds
    var tempIcon: Drawable = icon

    // 情况1：源是 BitmapDrawable 且声明为 full-bleed，包成 AdaptiveIcon
    if (options.isFullBleed && icon is BitmapDrawable) {
        var inset = AdaptiveIconDrawable.getExtraInsetFraction()
        inset /= (1 + 2 * inset)                              // 换算到内边距比例
        tempIcon = AdaptiveIconDrawable(
            ColorDrawable(Color.BLACK),                       // 黑色背景
            InsetDrawable(icon, inset, inset, inset, inset),  // 原图缩进当前景
        )
    }
    // 情况2：非自适应图标且要求包装，强制套 AdaptiveIcon 外壳
    if (options.wrapNonAdaptiveIcon) tempIcon = wrapToAdaptiveIcon(tempIcon, options)

    val drawFullBleed = options.drawFullBleed ?: drawFullBleedIcons
    val bitmap = drawableToBitmap(tempIcon, drawFullBleed, options) // 真正画位图
    icon.bounds = oldBounds                                     // 恢复原 bounds

    // 提取主色（除非调用方显式指定）
    val color = options.extractedColor ?: findDominantColorByHue(bitmap)
    var flagOp = getBitmapFlagOp(options)                       // 计算用户角标 flag
    if (drawFullBleed) {
        flagOp = flagOp.addFlag(BitmapInfo.FLAG_FULL_BLEED)
        bitmap.setHasAlpha(false)                               // 满溢图标关闭 alpha 通道
    }

    var info = BitmapInfo(icon = bitmap, color = color,
            defaultIconShape = defaultIconShape, flags = flagOp.apply(0))
    // Extender 钩子：日历/时钟等动态图标自定义位图
    if (icon is Extender) info = icon.getUpdatedBitmapInfo(info, this)
    // 主题化（Android 13+）：生成 themedBitmap 供深色/壁纸取色
    if (IconProvider.ATLEAST_T && themeController != null) {
        info = info.copy(themedBitmap =
            if (tempIcon is AdaptiveIconDrawable)
                themeController.createThemedBitmap(tempIcon, info, this, options.sourceHint)
            else ThemedBitmap.NOT_SUPPORTED)
    }
    return info
}
```

### 3.2 drawableToBitmap 渲染核心

按源 Drawable 类型分两条路径：

**AdaptiveIconDrawable 路径**（Android 8.0+ 自适应图标）：

```kotlin
private fun drawableToBitmap(icon: Drawable, drawFullBleed: Boolean, options: IconOptions): Bitmap {
    if (icon is AdaptiveIconDrawable) {
        // 计算留白：为阴影预留空间（BLUR_FACTOR * iconBitmapSize）
        val offset =
            if (drawFullBleed) 0
            else max(
                (ceil(BLUR_FACTOR * iconBitmapSize)).toInt(),            // 阴影模糊半径
                Math.round(iconBitmapSize * (1 - options.iconScale) / 2),// 规范化缩放留白
            )
        val newBounds = iconBitmapSize - offset * 2
        icon.setBounds(0, 0, newBounds, newBounds)                       // 缩小有效绘制区
        return createBitmap(options) { canvas, _ ->
            canvas.transformed {
                translate(offset.toFloat(), offset.toFloat())             // 平移到中心
                if (options.addShadows && !drawFullBleed)
                    shadowGenerator.addPathShadow(icon.iconMask, canvas) // 沿图标蒙版画阴影
                if (icon is Extender) icon.drawForPersistence()          // 动态图标持久化绘制

                if (drawFullBleed) {
                    drawColor(Color.BLACK)                                // 满溢：先填黑底
                    icon.background?.draw(canvas)                         // 再画背景层
                    icon.foreground?.draw(canvas)                         // 再画前景层
                } else {
                    icon.draw(canvas)                                     // 普通模式整体绘制
                }
            }
        }
    } else {
        // 非 AdaptiveIcon：先保证方形（宽高不等则 wrapIntoSquareDrawable）
        val iconToDraw = if (icon.intrinsicWidth != icon.intrinsicHeight || options.iconScale != 1f)
            icon.wrapIntoSquareDrawable(options.iconScale) else icon
        iconToDraw.setBounds(0, 0, iconBitmapSize, iconBitmapSize)

        return createBitmap(options) { canvas, bitmap ->
            if (drawFullBleed) canvas.drawColor(Color.BLACK)
            iconToDraw.draw(canvas)
            if (options.addShadows && bitmap != null && !drawFullBleed) {
                // 阴影只能在软件层画（extractAlpha 需要 software canvas）
                shadowGenerator.drawShadow(bitmap, canvas)
                iconToDraw.draw(canvas)                                   // 阴影上再画一次原图
            }
        }
    }
}
```

关键点：

- **`offset` 同时为阴影和规范化缩放留白**。`BLUR_FACTOR = 1.68f/48`，即 48px 图标留约 1.68px 边距给阴影扩散。这样阴影不会画到 bitmap 边界外被裁剪。
- **`addPathShadow(icon.iconMask)`**：AdaptiveIcon 的 `iconMask` 是系统统一的形状路径（圆/方/水滴等），沿这条路径画阴影，保证所有图标阴影形状一致（而非按图标自身轮廓）。
- **非 AdaptiveIcon 路径用 `drawShadow(bitmap, canvas)`**：先 `extractAlpha` 提取图标轮廓，再 blur 出阴影。这是给旧版（<8.0）图标和老式 BitmapDrawable 补阴影的方式。

### 3.3 IconOptions 构建器

`IconOptions` 是典型的 Builder，链式配置渲染参数：

```kotlin
class IconOptions {
    internal var isInstantApp: Boolean = false          // Instant App 角标
    internal var userHandle: UserHandle? = null          // 用户（决定工作资料角标）
    internal var useHardware = false                     // 是否生成 HARDWARE 配置位图
    internal var addShadows = true                       // 是否加阴影
    internal var drawFullBleed: Boolean? = null          // 是否满溢绘制（铺满无留白）
    internal var iconScale = ICON_VISIBLE_AREA_FACTOR    // 图标缩放比例（默认规范化系数）
    internal var wrapNonAdaptiveIcon = true              // 非 AdaptiveIcon 是否强制包装
    fun setUser(user: UserHandle?) = apply { userHandle = user }
    fun setDrawFullBleed(fullBleed: Boolean) = apply { drawFullBleed = fullBleed }
    // ...
}
```

`ICON_VISIBLE_AREA_FACTOR` 是规范化的核心常量，下节详解。

### 面试深问

**Q1：为什么 AdaptiveIcon 和非 AdaptiveIcon 的阴影画法不同？**
AdaptiveIcon 有系统统一的 `iconMask` 路径，直接 `canvas.drawPath(iconMask, blurPaint)` 沿路径画即可，性能好且形状一致。非 AdaptiveIcon（老式 BitmapDrawable）没有路径，只能 `bitmap.extractAlpha()` 提取像素轮廓再 blur，必须软件层 canvas，性能差但兼容旧图标。

**Q2：`drawFullBleed` 和普通模式区别？**
满溢模式不缩小图标、不留阴影边距、关闭 alpha、分前景背景层绘制，图标铺满整个 bitmap。用于 Themed Icon 和新版图标形状特性 (`Flags.enableLauncherIconShapes()`)，让图标贴满形状蒙版。普通模式则缩小到 `ICON_VISIBLE_AREA_FACTOR` 并留阴影空间。

**Q3：`createBitmap` 里 `useHardware` 的取舍？**
`BitmapRenderer.createHardwareBitmap` 生成 `HARDWARE` 配置位图，GPU 渲染快但不可修改（无法 `extractAlpha`）。所以阴影路径（需要 extractAlpha）必须用 `ARGB_8888` 软件位图。`useHardware` 用于不需要阴影的高性能场景（如 AllApps 列表快速滚动）。

---

## 四、IconNormalizer 与图标规范化

### 4.1 规范化的本质问题

不同应用图标视觉大小差异巨大：有的铺满整个 canvas，有的只占中心一小块。如果不规范化，Launcher 网格里图标大小参差不齐。规范化的目标是让所有图标的"视觉直径"统一。

`aosp-r4` 分支里 `IconNormalizer` 已被精简成一个常量类：

```java
public class IconNormalizer {
    // 规范化后圆形图标的可见区域直径占整体图标尺寸的比例
    public static final float ICON_VISIBLE_AREA_FACTOR =
        Math.min(0.92f, ICON_SCALE_FOR_SHADOWS); // 约 0.85
}
```

`ICON_SCALE_FOR_SHADOWS` 来自 `ShadowGenerator`：

```java
static final float ICON_SCALE_FOR_SHADOWS =
    (HALF_DISTANCE - BLUR_FACTOR) / HALF_DISTANCE; // (0.5 - 1.68/48) / 0.5 ≈ 0.93
```

真正的规范化逻辑（扫描像素确定图标实际边界、缩放到统一可见区域）在旧版 AOSP 是个几百行的类，会逐像素扫描图标 alpha 通道找最大可见范围。`aosp-r4` 直接用固定比例 `0.85` 左右，配合 AdaptiveIcon 系统统一蒙版，已经不需要逐图标计算——系统层面保证了图标前景都在安全区内。

### 4.2 规范化系数的应用

这个系数在三个地方被用到：

**1. 图标绘制留白**（`BaseIconFactory.drawableToBitmap`）：

```kotlin
val offset = max(
    (ceil(BLUR_FACTOR * iconBitmapSize)).toInt(),
    Math.round(iconBitmapSize * (1 - options.iconScale) / 2), // iconScale 默认就是这个系数
)
```

`iconScale = 0.85` 意味着图标实际绘制区域是整体尺寸的 85%，剩下 15% 留给阴影和视觉留白。

**2. 红点位置归一化**（`DotRenderer.IconShapeInfo.normalizedPosition`）：

```java
private static PointF normalizedPosition(PointF pos) {
    float center = 0.5f;
    return new PointF(
        center + ICON_VISIBLE_AREA_FACTOR * (pos.x - center), // 把红点位置也缩到可见区内
        center + ICON_VISIBLE_AREA_FACTOR * (pos.y - center)
    );
}
```

红点要画在图标轮廓的角上，但角的位置基于完整尺寸算的，乘以这个系数缩到规范化后的可见区。

**3. 图标 bounds 缩放**（`BubbleTextView.drawDotIfNecessary`）：

```java
getIconBounds(mDotParams.iconBounds);
Utilities.scaleRectAboutCenter(mDotParams.iconBounds, ICON_VISIBLE_AREA_FACTOR); // 缩到可见区
```

画红点前把图标 bounds 整体缩到 85%，让红点贴在视觉图标的角上而非 bitmap 的角上。

### 4.3 IconProvider 与图标源

`IconProvider` 负责从 APK 加载原始 Drawable，是渲染管线的最上游：

```java
private Drawable getIcon(PackageItemInfo info, ApplicationInfo appInfo, int iconDpi) {
    String packageName = info.packageName;
    ThemeData td = getThemeDataForPackage(packageName); // 主题图标映射（子类重写）

    Drawable icon = null;
    // 特殊处理：日历图标每天换
    if (mCalendar != null && mCalendar.getPackageName().equals(packageName)) {
        icon = loadCalendarDrawable(iconDpi, td);
    } else if (mClock != null && mClock.getPackageName().equals(packageName)) {
        icon = ClockDrawableWrapper.forPackage(mContext, mClock.getPackageName(), iconDpi); // 时钟动态图标
    }
    if (icon == null) {
        icon = loadPackageIconWithFallback(info, appInfo, iconDpi);
        // Android 13+：补单色层用于主题化
        if (ATLEAST_T && icon instanceof AdaptiveIconDrawable && td != null) {
            AdaptiveIconDrawable aid = (AdaptiveIconDrawable) icon;
            if (aid.getMonochrome() == null) {
                icon = new AdaptiveIconDrawable(aid.getBackground(),
                        aid.getForeground(), td.loadPaddedDrawable()); // 注入系统提供的单色层
            }
        }
    }
    return icon;
}
```

`loadCalendarDrawable` 是个典型示例，展示"动态图标"如何实现：

```java
private Drawable loadCalendarDrawable(int iconDpi, ThemeData td) {
    PackageManager pm = mContext.getPackageManager();
    // 从 Calendar 的 ActivityInfo metadata 取图标数组
    final Bundle metadata = pm.getActivityInfo(mCalendar, ...).metaData;
    final int id = getDynamicIconId(metadata, resources); // 按日期取今天对应的图标 id
    if (id != ID_NULL) {
        return resources.getDrawableForDensity(id, iconDpi, null);
    }
}

private static int getDay() {
    return Calendar.getInstance().get(Calendar.DAY_OF_MONTH) - 1; // 0 索引
}
```

日历 APK 在 metadata 里声明一个 31 天的图标数组，Launcher 按当前日期取对应下标的图标。`getStateForApp` 里特意把 `getDay()` 拼进 freshnessId，这样日期变化时缓存自动失效，触发重绘：

```java
public String getStateForApp(@Nullable ApplicationInfo appInfo) {
    if (mCalendar != null && mCalendar.getPackageName().equals(appInfo.packageName)) {
        return mSystemState + SYSTEM_STATE_SEPARATOR + getDay() + SYSTEM_STATE_SEPARATOR
                + getApplicationInfoHash(appInfo); // 日历多拼一个日期
    } else {
        return mSystemState + SYSTEM_STATE_SEPARATOR + getApplicationInfoHash(appInfo);
    }
}
```

### 面试深问

**Q1：旧版 IconNormalizer 逐像素扫描为什么被移除？**
AdaptiveIcon 引入了系统统一蒙版 (`iconMask`)，强制所有图标前景落在安全区内（前景占 72dp，整体 108dp），系统层面保证了视觉一致性，不再需要 Launcher 逐图标计算。固定系数 `0.85` 配合蒙版已足够。逐像素扫描既慢又耗电，移除是性能优化。

**Q2：日历图标每天换，缓存怎么失效？**
`freshnessId` 拼了 `getDay()`。日期变化 → freshnessId 变 → `IconCacheUpdateHandler` 比对发现不一致 → 标记该条目需重绘 → 下次 `getTitleAndIcon` 重新加载。这套机制通用：locale 变、APK 升级、主题切换都走 freshnessId 失效。

**Q3：`ICON_VISIBLE_AREA_FACTOR = min(0.92, ICON_SCALE_FOR_SHADOWS)` 为什么要取 min？**
`0.92` 是视觉舒适上限（再大图标会贴边），`ICON_SCALE_FOR_SHADOWS ≈ 0.93` 是阴影留白算出的物理上限。取 min 保证既不超视觉上限，也留够阴影空间。

---

## 五、Adaptive Icon 适配

### 5.1 AdaptiveIcon 结构

Android 8.0 引入的自适应图标由三层组成：

```
AdaptiveIconDrawable
├── background (Drawable)   背景层（纯色或图案）
├── foreground (Drawable)   前景层（图标主体）
└── monochrome (Drawable)   单色层（Android 13+，主题化用）
```

系统用统一的 `iconMask` 路径裁剪这三层，保证不同启动器、不同形状（圆/方/水滴）下图标轮廓一致。关键参数 `getExtraInsetFraction()` 决定前景的安全区内缩比例。

### 5.2 Launcher 的处理：wrapToAdaptiveIcon

旧式图标（非 AdaptiveIcon）进入渲染管线前会被强制包装：

```kotlin
@JvmOverloads
fun wrapToAdaptiveIcon(icon: Drawable, options: IconOptions? = null): AdaptiveIconDrawable =
    icon as? AdaptiveIconDrawable                       // 已是 AdaptiveIcon 直接返回
    ?: AdaptiveIconDrawable(
            ColorDrawable(options?.wrapperBackgroundColor ?: DEFAULT_WRAPPER_BACKGROUND), // 白底
            icon.wrapIntoSquareDrawable(LEGACY_ICON_SCALE),                               // 缩进当前景
        ).apply { setBounds(0, 0, 1, 1) }
```

`wrapIntoSquareDrawable` 保证非方形图标按比例缩进成方形：

```kotlin
private fun Drawable.wrapIntoSquareDrawable(scale: Float): Drawable {
    val h = intrinsicHeight.toFloat()
    val w = intrinsicWidth.toFloat()
    var scaleX = scale
    var scaleY = scale
    if (h > w && w > 0) {
        scaleX *= w / h                                  // 高>宽，横向再缩
    } else if (w > h && h > 0) {
        scaleY *= h / w                                  // 宽>高，纵向再缩
    }
    scaleX = (1 - scaleX) / 2                            // 换算成四边 inset 比例
    scaleY = (1 - scaleY) / 2
    return InsetDrawable(this, scaleX, scaleY, scaleX, scaleY)
}
```

`LEGACY_ICON_SCALE` 是为旧图标精心算的缩放系数，保证旧图标包成 AdaptiveIcon 后视觉大小和新图标一致：

```kotlin
private val LEGACY_ICON_SCALE =
    sqrt(MAX_SQUARE_AREA_FACTOR).toFloat() *             // 375.0/576 开根号
    .7f *                                                 // 经验系数
    (1f / (1 + 2 * AdaptiveIconDrawable.getExtraInsetFraction())) // 反算 inset
```

### 5.3 满溢绘制 drawFullBleed

新版图标形状特性 (`Flags.enableLauncherIconShapes()`) 开启满溢模式，图标铺满整个 bitmap 不留边距：

```kotlin
if (drawFullBleed) {
    drawColor(Color.BLACK)            // 先填黑底（保证无 alpha）
    icon.background?.draw(canvas)     // 单独画背景层
    icon.foreground?.draw(canvas)     // 单独画前景层
} else {
    icon.draw(canvas)                 // 普通模式整体绘制
}
```

满溢模式下，形状裁剪交给 `FastBitmapDrawableDelegate.FullBleedDrawableDelegate` 用 `BitmapShader` + `IconShape` 路径在绘制时实时裁剪（见下节）。这样存储的 bitmap 是完整方形的，形状可动态切换（用户换图标形状无需重新生成所有 bitmap）。

### 面试深问

**Q1：为什么满溢模式要分 background/foreground 单独画？**
整体 `icon.draw()` 会按 AdaptiveIcon 自带的 inset 缩小前景。满溢模式要前景铺满，必须绕过 AdaptiveIcon 的内置缩放，手动分层绘制。这样配合 `FullBleedDrawableDelegate` 的 shader 裁剪，形状切换才实时生效。

**Q2：`wrapToAdaptiveIcon` 为什么要 `setBounds(0,0,1,1)`？**
占位 bounds。真实 bounds 在 `drawableToBitmap` 里根据 `iconBitmapSize` 重新设置。设个 1x1 占位避免 Drawable 未设 bounds 时 `intrinsicWidth` 返回 -1 导致后续计算异常。

**Q3：LEGACY_ICON_SCALE 里 `.7f` 这个魔法数字怎么来的？**
经验值。系统 AdaptiveIcon 前景实际可见区约为整体的 70%（去掉 inset 后），旧图标缩到这个比例才能视觉对齐。配合 `getExtraInsetFraction` 反算，保证不同设备 inset 不同时仍对齐。

---

## 六、FastBitmapDrawable 高性能图标 Drawable

### 6.1 为什么不用普通 BitmapDrawable

`BitmapDrawable` 每次绘制会走完整的 Drawable 状态机（state list、level、tint 等检查），Launcher 每帧要画几十个图标，这些检查是纯开销。`FastBitmapDrawable` 直接持有一个 `Paint` 和 `Bitmap`，`draw` 里只做一次 `canvas.drawBitmap`，跳过所有无关分支。

```kotlin
class FastBitmapDrawable @JvmOverloads constructor(
    info: BitmapInfo?,                                    // 图标位图+主色信息
    private val iconShape: IconShape = IconShape.EMPTY,   // 图标形状（满溢裁剪用）
    private val delegateFactory: DelegateFactory = SimpleDelegateFactory, // 渲染委托工厂
    @JvmField @DrawableCreationFlags val creationFlags: Int = 0,
    private val disabledAlpha: Float = 1f,
    val badge: Drawable? = null,                          // 用户角标（工作资料等）
) : Drawable(), Callback {

    @JvmField val bitmapInfo: BitmapInfo = info ?: LOW_RES_INFO
    var isAnimationEnabled: Boolean = true
    @JvmField protected val paint: Paint = Paint(FILTER_BITMAP_FLAG or ANTI_ALIAS_FLAG) // 复用单一 Paint

    // 委托：实际绘制逻辑交给 delegate，支持运行时替换（主题化、进度图标）
    val delegate = delegateFactory.newDelegate(bitmapInfo, iconShape, paint, this)
```

### 6.2 委托模式实现多继承

Java/Kotlin 单继承限制下，`FastBitmapDrawable` 要同时支持"普通图标、满溢图标、进度图标、主题化图标"四种渲染逻辑，又不能每个都建子类（子类无法被 ConstantState 复用）。解法是**委托**：

```kotlin
interface FastBitmapDrawableDelegate {
    fun drawContent(info: BitmapInfo, iconShape: IconShape, canvas: Canvas, bounds: Rect, paint: Paint)
    fun getIconColor(info: BitmapInfo): Int = /* 白色 138 alpha 叠加主色 */
    fun isThemed() = false
    fun setAlpha(alpha: Int) {}
    fun updateFilter(filter: ColorFilter?) {}
    fun onVisibilityChanged(isVisible: Boolean) {}
    fun onLevelChange(level: Int): Boolean = false
    fun onBoundsChange(bounds: Rect) {}

    // 工厂接口：无状态，可安全存入 ConstantState
    fun interface DelegateFactory {
        fun newDelegate(bitmapInfo: BitmapInfo, iconShape: IconShape, paint: Paint, host: FastBitmapDrawable): FastBitmapDrawableDelegate
    }
}
```

三个内置实现：

```kotlin
// 1. 普通图标：直接 drawBitmap
object SimpleDrawableDelegate : FastBitmapDrawableDelegate {
    override fun drawContent(info, iconShape, canvas, bounds, paint) {
        canvas.drawBitmap(info.icon, null, bounds, paint) // 最简单，一张位图填满 bounds
    }
}

// 2. 满溢图标：用 BitmapShader 按形状裁剪
class FullBleedDrawableDelegate(bitmapInfo: BitmapInfo) : FastBitmapDrawableDelegate {
    private val shader = BitmapShader(bitmapInfo.icon, CLAMP, CLAMP) // 位图当 shader
    override fun drawContent(info, iconShape, canvas, bounds, paint) {
        canvas.drawShaderInBounds(bounds, iconShape, paint, shader)  // 按 iconShape 路径裁剪绘制
    }
}

// 3. 默认工厂：按 FLAG_FULL_BLEED 选 delegate
object SimpleDelegateFactory : DelegateFactory {
    override fun newDelegate(bitmapInfo, iconShape, paint, host) =
        if ((bitmapInfo.flags and FLAG_FULL_BLEED) != 0) FullBleedDrawableDelegate(bitmapInfo)
        else SimpleDrawableDelegate
}
```

`FastBitmapDrawable.draw` 把绘制完全交给委托：

```kotlin
override fun draw(canvas: Canvas) {
    if (scale != 1f) {
        val count = canvas.save()
        val bounds = bounds
        canvas.scale(scale, scale, bounds.exactCenterX(), bounds.exactCenterY()) // 按压反馈缩放
        drawInternal(canvas, bounds)
        canvas.restoreToCount(count)
    } else {
        drawInternal(canvas, bounds)
    }
}

private fun drawInternal(canvas: Canvas, bounds: Rect) {
    delegate.drawContent(bitmapInfo, iconShape, canvas, bounds, paint) // 委托绘制
    badge?.draw(canvas)                                                 // 再画角标（工作资料等）
}
```

### 6.3 按压与悬浮反馈

状态变化时做缩放动画，提供点击反馈：

```kotlin
public override fun onStateChange(state: IntArray): Boolean {
    if (!isAnimationEnabled) return false

    var isPressed = false
    var isHovered = false
    for (s in state) {
        if (s == R.attr.state_pressed) { isPressed = true; break }
        else if (s == R.attr.state_hovered && hoverScaleEnabledForDisplay) { isHovered = true }
    }
    if (this.isPressed != isPressed || this.isHovered != isHovered) {
        scaleAnimation?.cancel()
        val endScale = when {
            isPressed -> PRESSED_SCALE    // 1.1f
            isHovered -> HOVERED_SCALE    // 1.1f
            else -> 1f
        }
        if (scale != endScale) {
            if (isVisible) {
                scaleAnimation = ObjectAnimator.ofFloat(this, SCALE, endScale).apply {
                    duration = if (isPressed != this@FastBitmapDrawable.isPressed)
                        CLICK_FEEDBACK_DURATION.toLong() // 200ms
                    else HOVER_FEEDBACK_DURATION.toLong() // 300ms
                    interpolator = if (isPressed != this@FastBitmapDrawable.isPressed)
                        (if (isPressed) ACCEL else DEACCEL)
                    else HOVER_EMPHASIZED_DECELERATE_INTERPOLATOR
                }
                scaleAnimation?.start()
            } else {
                scale = endScale
                invalidateSelf()
            }
        }
        this.isPressed = isPressed
        this.isHovered = isHovered
        return true
    }
    return false
}
```

### 6.4 禁用态灰度滤镜

禁用的图标（如暂停下载的应用）要变灰。用 ColorMatrix 一次搞定：

```kotlin
companion object {
    private const val DISABLED_DESATURATION = 1f   // 完全去饱和
    private const val DISABLED_BRIGHTNESS = 0.5f   // 亮度减半

    @JvmStatic
    @JvmOverloads
    fun getDisabledColorFilter(disabledAlpha: Float = 1f): ColorFilter {
        val tempBrightnessMatrix = ColorMatrix()
        val tempFilterMatrix = ColorMatrix()

        tempFilterMatrix.setSaturation(1f - DISABLED_DESATURATION) // 饱和度归零
        val scale = 1 - DISABLED_BRIGHTNESS                         // 0.5
        val brightnessI = (255 * DISABLED_BRIGHTNESS).toInt()       // 127
        val mat = tempBrightnessMatrix.array
        mat[0] = scale; mat[6] = scale; mat[12] = scale             // RGB 通道缩 0.5
        mat[4] = brightnessI.toFloat(); mat[9] = brightnessI.toFloat(); mat[14] = brightnessI.toFloat() // 加亮度
        mat[18] = disabledAlpha                                    // alpha 通道
        tempFilterMatrix.preConcat(tempBrightnessMatrix)
        return ColorMatrixColorFilter(tempFilterMatrix)
    }
}
```

### 6.5 ConstantState 复用

`FastBitmapConstantState` 让同一图标的多处引用共享底层 bitmap，只复制状态：

```kotlin
override fun getConstantState() =
    FastBitmapConstantState(
        bitmapInfo, isDisabled, badge?.constantState, iconShape,
        creationFlags, disabledAlpha, delegateFactory, level,
    )

data class FastBitmapConstantState(...) : ConstantState() {
    override fun newDrawable() = FastBitmapDrawable(
        info = bitmapInfo,
        iconShape = iconShape,
        delegateFactory = delegateFactory, // 关键：工厂无状态可共享
        creationFlags = creationFlags,
        badge = badgeConstantState?.newDrawable(),
        disabledAlpha = disabledAlpha,
    ).apply {
        isDisabled = this@FastBitmapConstantState.isDisabled
        level = this@FastBitmapConstantState.level
    }
    override fun getChangingConfigurations(): Int = 0
}
```

设计意图：`DelegateFactory` 是 `fun interface`（无状态），可安全存入 ConstantState 跨 Drawable 共享。`PreloadIconFactory` 等带状态的工厂也实现成无状态（状态在 `newDelegate` 时注入 host），保证 ConstantState 可复用。

### 面试深问

**Q1：委托模式比继承优势在哪？**
Java 单继承，`PreloadIconDelegate` 既要复用普通图标的绘制（继承 `SimpleDrawableDelegate`），又要叠加进度环逻辑。用委托（`FastBitmapDrawableDelegate by parentDelegate`）实现"装饰器"模式，运行时组合，比继承灵活。ConstantState 也能复用因为 factory 无状态。

**Q2：为什么 `paint` 是 `protected val` 而非局部变量？**
复用。每次 `draw` 不 new Paint，避免 GC。Paint 状态（alpha、colorFilter）跨帧复用，只增量更新。一个 FastBitmapDrawable 一个 Paint，生命周期与 Drawable 一致。

**Q3：`FLAG_NO_BADGE` 控制什么？**
某些场景（如拖拽预览、文件夹预览）不需要工作资料角标，创建时传 `FLAG_NO_BADGE`，`newIcon` 里 `badge = null`，绘制跳过 `badge?.draw(canvas)`。避免预览图上出现多余角标。

---

## 七、ShadowGenerator 阴影生成

### 7.1 为什么预生成而非实时画

阴影绘制（`BlurMaskFilter`、`setShadowLayer`）是 GPU 不友好的软件操作。Launcher 一屏几十个图标，每帧实时画阴影会严重掉帧。`ShadowGenerator` 的策略是**在图标生成阶段（`createBadgedIconBitmap`）把阴影一次性烘焙进 bitmap**，运行时只画一张已带阴影的位图，零阴影开销。

```java
public class ShadowGenerator {
    public static final float BLUR_FACTOR = 1.68f/48;        // 模糊半径系数
    public static final float KEY_SHADOW_DISTANCE = 1f/48;   // 关键阴影偏移
    private static final int KEY_SHADOW_ALPHA = 7;           // 关键阴影透明度
    private static final int AMBIENT_SHADOW_ALPHA = 25;      // 环境阴影透明度

    // 图标缩放系数：为阴影留空间
    static final float ICON_SCALE_FOR_SHADOWS = (HALF_DISTANCE - BLUR_FACTOR) / HALF_DISTANCE;

    private final Paint mBlurPaint;
    private final Paint mDrawPaint;
    private final BlurMaskFilter mDefaultBlurMaskFilter;

    public ShadowGenerator(int iconSize) {
        mIconSize = iconSize;
        mBlurPaint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        mDrawPaint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
        mDefaultBlurMaskFilter = new BlurMaskFilter(mIconSize * BLUR_FACTOR, Blur.NORMAL); // 模糊半径
    }
}
```

### 7.2 两种阴影画法

**对非 AdaptiveIcon 的位图阴影**（`drawShadow`）：

```java
public synchronized void drawShadow(Bitmap icon, Canvas out) {
    if (ENABLE_SHADOWS) {
        int[] offset = new int[2];
        mBlurPaint.setMaskFilter(mDefaultBlurMaskFilter);
        // extractAlpha：提取位图 alpha 通道，应用 blur，返回模糊后的阴影位图
        Bitmap shadow = icon.extractAlpha(mBlurPaint, offset);

        // 环境阴影（四周均匀，模拟环境光）
        mDrawPaint.setAlpha(AMBIENT_SHADOW_ALPHA);
        out.drawBitmap(shadow, offset[0], offset[1], mDrawPaint);

        // 关键阴影（向下偏移，模拟主光源）
        mDrawPaint.setAlpha(KEY_SHADOW_ALPHA);
        out.drawBitmap(shadow, offset[0], offset[1] + KEY_SHADOW_DISTANCE * mIconSize, mDrawPaint);
    }
}
```

**对 AdaptiveIcon 的路径阴影**（`addPathShadow`）：

```java
public void addPathShadow(Path path, Canvas out) {
    if (ENABLE_SHADOWS) {
        mDrawPaint.setMaskFilter(mDefaultBlurMaskFilter);

        // 环境阴影：沿 iconMask 路径画
        mDrawPaint.setAlpha(AMBIENT_SHADOW_ALPHA);
        out.drawPath(path, mDrawPaint);

        // 关键阴影：向下偏移再画一次
        int save = out.save();
        mDrawPaint.setAlpha(KEY_SHADOW_ALPHA);
        out.translate(0, KEY_SHADOW_DISTANCE * mIconSize);
        out.drawPath(path, mDrawPaint);
        out.restoreToCount(save);

        mDrawPaint.setMaskFilter(null);
    }
}
```

双层阴影（ambient + key）模拟真实光照：环境光是各向同性的微弱阴影，关键光是定向的较强阴影。组合起来视觉立体感强。

### 7.3 红点的阴影：createPill

`DotRenderer` 借 `ShadowGenerator.Builder` 给红点预生成带阴影的背景圆：

```java
public Bitmap createPill(int width, int height, float r) {
    radius = r;
    int centerX = Math.round(width / 2f + shadowBlur);
    int centerY = Math.round(radius + shadowBlur + keyShadowDistance);
    int center = Math.max(centerX, centerY);
    bounds.set(0, 0, width, height);
    bounds.offsetTo(center - width / 2f, center - height / 2f);

    int size = center * 2;
    return BitmapRenderer.createHardwareBitmap(size, size, this::drawShadow); // 硬件位图
}

public void drawShadow(Canvas c) {
    Paint p = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
    p.setColor(color);
    if (ENABLE_SHADOWS) {
        // 关键阴影
        p.setShadowLayer(shadowBlur, 0, keyShadowDistance,
                setColorAlphaBound(Color.BLACK, keyShadowAlpha));
        c.drawRoundRect(bounds, radius, radius, p);
        // 环境阴影
        p.setShadowLayer(shadowBlur, 0, 0,
                setColorAlphaBound(Color.BLACK, ambientShadowAlpha));
        c.drawRoundRect(bounds, radius, radius, p);
    }
    // 半透明填充的特殊处理（PorterDuff CLEAR 挖空再填）
    if (Color.alpha(color) < 255) { ... }
}
```

红点用 `createHardwareBitmap` 生成硬件位图，因为红点只需一次生成、反复绘制，硬件位图 GPU 渲染最快。

### 面试深问

**Q1：`extractAlpha` 为什么必须在软件 canvas？**
`extractAlpha` 是位图像素级操作，依赖软件渲染管线。硬件 canvas (GPU) 不支持。所以非 AdaptiveIcon 的阴影路径在 `createBitmap` 里用 `Bitmap.createBitmap(... ARGB_8888)` + 软件 Canvas，而非 `createHardwareBitmap`。

**Q2：ambient 和 key 阴影 alpha 为什么差这么多（25 vs 7）？**
模拟真实光照。环境光各向同性、强度低但覆盖广，所以 alpha 稍高（25）但仍微弱；关键光是定向主光源，强度高但只在一个方向，alpha 低（7）但偏移大，形成明显投影。组合出立体感而非平面黑圈。

**Q3：`ICON_SCALE_FOR_SHADOWS` 怎么算进图标缩放？`
`(0.5 - 1.68/48) / 0.5 ≈ 0.93`。意思是图标实际绘制区是整体的 93%，留 7% 给阴影扩散。配合 `ICON_VISIBLE_AREA_FACTOR = min(0.92, 0.93) = 0.92`（视觉上限更严），最终用 0.92。

---

## 八、PreloadIconDelegate 加载进度图标

### 8.1 进度图标的场景

应用下载/安装中，图标上要显示进度环。旧版叫 `PreloadIconDrawable`（继承 FastBitmapDrawable），`aosp-r4` 重构为 `PreloadIconDelegate`（委托），更优雅：

```kotlin
class PreloadIconDelegate(
    item: ItemInfoWithIcon,
    isDarkMode: Boolean,
    private val iconShape: IconShape,                     // 图标形状路径（进度环沿此画）
    private val host: FastBitmapDrawable,                 // 宿主 Drawable
    private val parentDelegate: FastBitmapDrawableDelegate, // 被装饰的父委托（普通图标绘制）
    private val themedSeedColor: Int,
    private val themedSeedColorDark: Int,
    private val themedProgressColor: Int,
    private val themedProgressColorDark: Int,
) : FastBitmapDrawableDelegate by parentDelegate {        // Kotlin 委托：默认行为委托给父
```

`by parentDelegate` 是 Kotlin 委托语法，`PreloadIconDelegate` 只重写 `drawContent`、`onLevelChange` 等，其余方法（`getIconColor`、`isThemed`）自动转发给 `parentDelegate`。这就是装饰器模式。

### 8.2 进度环绘制

```kotlin
override fun drawContent(info: BitmapInfo, iconShape: IconShape, canvas: Canvas, bounds: Rect, paint: Paint) {
    if (ranFinishAnimation) {
        parentDelegate.drawContent(info, iconShape, canvas, bounds, paint) // 完成后直接画原图
    } else if (Flags.enableLauncherIconShapes()) {
        drawShapedProgressIcon(info, canvas, bounds, paint)                 // 新版沿形状画进度
    } else {
        drawDefaultProgressIcon(info, canvas, bounds, paint)                // 旧版圆形进度
    }
}

private fun drawShapedProgressIcon(info: BitmapInfo, canvas: Canvas, bounds: Rect, paint: Paint) {
    if (internalStateProgress > 0f) {
        if (internalStateProgress < 1f) {
            drawIconAtScale(info, canvas, bounds, paint) // 进度中：缩小图标画在底层
        }
        val size = iconShape.pathSize.toFloat()
        canvas.resizeToContentSize(bounds, size) {
            progressPaint.style = STROKE
            // 1. 间隙描边（plateColor）：图标和进度环之间的留白
            canvas.setupStrokeWidthFactor(PLATE_STROKE_SIZE, PROGRESS_GAP_SIZE / 2, size, progressPaint) {
                progressPaint.color = plateColor
                drawPath(iconShape.path, progressPaint)
            }
            // 2. 轨道（trackColor）：完整形状的浅色底
            canvas.setupStrokeWidthFactor(PROGRESS_STROKE_SIZE, 0f, size, progressPaint) {
                progressPaint.color = trackColor
                drawPath(iconShape.path, progressPaint)
                // 3. 进度（progressColor）：按 progressPath 画已完成部分
                progressPaint.color = progressColor
                drawPath(progressPath, progressPaint)
            }
        }
        if (internalStateProgress >= 1f) {
            drawIconAtScale(info, canvas, bounds, paint) // 完成时：图标盖在进度环上
        }
    } else {
        drawIconAtScale(info, canvas, bounds, paint)     // 无进度：只画图标
    }
}
```

进度路径 `progressPath` 由 `PathMeasure.getSegment` 按进度截取形状路径：

```kotlin
private fun setInternalProgress(progress: Float) {
    if (progress > 0 && internalStateProgress == 0f) {
        // 首次有进度，动画放大图标（从 pending 态出来）
        iconScaleMultiplier.animateToValue(1f).apply {
            duration = SCALE_AND_ALPHA_ANIM_DURATION // 500ms
            interpolator = Interpolators.EMPHASIZED
            start()
        }
    }
    internalStateProgress = progress
    if (progress <= 0) {
        iconScaleMultiplier.updateValue(0f)
    } else {
        // 按进度截取形状路径的一段作为 progressPath
        pathMeasure.getSegment(
            0f,
            (min(progress.toDouble(), 1.0) * trackLength).toFloat(), // 截到 progress*总长
            progressPath,
            true,
        )
        if (progress > 1) {
            // 完成动画：图标放大回原尺寸
            iconScaleMultiplier.updateValue(
                Utilities.mapBoundToRange(progress - 1, 0f, COMPLETE_ANIM_FRACTION, 1f, 0f, Interpolators.EMPHASIZED)
            )
        }
    }
    host.invalidateSelf()
}
```

### 8.3 进度更新与完成动画

进度由 Drawable level 驱动（0-10000）：

```kotlin
override fun onLevelChange(level: Int): Boolean {
    updateInternalState(level * 0.01f, false, null) // level/100 → 0~1
    return true
}

fun reapplyProgress(item: ItemInfoWithIcon) {
    host.level = item.progressLevel            // 设置 level 触发 onLevelChange
    host.isDisabled = item.isDisabled || item.isPendingDownload
}
```

完成动画：

```kotlin
fun maybePerformFinishedAnimation(oldIcon: FastBitmapDrawable, onFinishCallback: Runnable?) {
    val oldDelegate = extractPreloadDelegate(oldIcon) ?: this
    progressColor = oldDelegate.progressColor     // 继承旧 delegate 的颜色（平滑过渡）
    trackColor = oldDelegate.trackColor
    plateColor = oldDelegate.plateColor
    if (oldDelegate.internalStateProgress >= 1) {
        internalStateProgress = oldDelegate.internalStateProgress
    }
    if (internalStateProgress == 0f) {
        internalStateProgress = 1f                // 跳过进度直接完成
    }
    updateInternalState(1 + COMPLETE_ANIM_FRACTION, true, onFinishCallback) // 播放完成动画
}
```

### 8.4 颜色主题化

进度环颜色用 Material You 取色（`ColorUtils.colorToM3HCT` 转 HCT 色彩空间）：

```kotlin
init {
    val m3HCT = FloatArray(3)
    if (isThemed()) {
        // 主题化：用预设的 seed 颜色
        val seedColor = if (isDarkMode) themedSeedColorDark else themedSeedColor
        ColorUtils.colorToM3HCT(seedColor, m3HCT)
        progressColor = if (isDarkMode) themedProgressColorDark else themedProgressColor
        plateColor = ColorUtils.M3HCTToColor(m3HCT[0], if (isDarkMode) 36f else 24f, if (isDarkMode) 10f else 80f)
        trackColor = ColorUtils.M3HCTToColor(m3HCT[0], 16f, if (isDarkMode) 30f else 90f)
    } else {
        // 非主题化：从图标主色派生
        ColorUtils.colorToM3HCT(item.bitmap.color, m3HCT)
        progressColor = ColorUtils.M3HCTToColor(m3HCT[0], m3HCT[1],
            if (isDarkMode) max(m3HCT[2].toDouble(), 55.0).toFloat() else min(m3HCT[2].toDouble(), 40.0).toFloat())
        trackColor = ColorUtils.M3HCTToColor(m3HCT[0], 16f, (if (isDarkMode) 30 else 90).toFloat())
        plateColor = ColorUtils.M3HCTToColor(m3HCT[0], (if (isDarkMode) 36 else 24).toFloat(), (if (isDarkMode) 20 else 80).toFloat())
    }
}
```

HCT（Hue-Chroma-Tone）是 Material Design 3 的色彩空间，比 HSV 更符合人眼感知，保证不同明度下颜色看起来一致。

### 8.5 创建入口

`PreloadIconDelegate.ItemInfoWithIcon.newPendingIcon` 是创建进度图标的工厂方法：

```kotlin
@JvmStatic
@JvmOverloads
fun ItemInfoWithIcon.newPendingIcon(
    context: Context,
    @DrawableCreationFlags creationFlags: Int = 0,
): FastBitmapDrawable {
    val originalState = newIcon(context, creationFlags).constantState // 先拿普通图标的 ConstantState
    val themedSeedColor = context.resources.getColor(R.color.materialColorInverseSurface)
    val themedProgressColor = context.resources.getColor(R.color.materialColorPrimary)
    val themedProgressColorDark = context.resources.getColor(R.color.materialColorSecondary)
    // 复制 ConstantState，替换 delegateFactory 为 PreloadIconFactory
    val newState = originalState.copy(
        isDisabled = isDisabled || isPendingDownload,
        level = progressLevel,
        delegateFactory = PreloadIconFactory(
            info = this,
            isDarkTheme = Utilities.isDarkTheme(context),
            parentFactory = originalState.delegateFactory, // 保留原工厂作父
            themedSeedColor = themedSeedColor,
            // ...
        ),
    )
    return newState.newDrawable()
}
```

设计巧妙：复用普通图标的 ConstantState（共享 bitmap），只换 delegateFactory 注入进度逻辑。bitmap 不重复存储。

### 面试深问

**Q1：`PreloadIconDelegate by parentDelegate` 的 Kotlin 委托具体省了什么？**
省掉所有转发样板代码。`FastBitmapDrawableDelegate` 有 8 个方法，`PreloadIconDelegate` 只关心 `drawContent`/`onLevelChange`，其余 6 个（`getIconColor`、`isThemed`、`setAlpha`、`updateFilter`、`onVisibilityChanged`、`onBoundsChange`）自动转发给 `parentDelegate`。Java 实现得手写 6 个一行转发方法。

**Q2：进度环为什么沿 `iconShape.path` 画而不是圆？**
视觉一致性。新版图标形状特性下，所有图标是统一形状（圆/方/水滴），进度环也沿这个形状画，整体协调。旧版（`drawDefaultProgressIcon`）才是圆形进度环。形状由 `IconShape.path` 决定，用户换形状只需换 path。

**Q3：`maybePerformFinishedAnimation` 为什么要继承旧 delegate 的颜色？**
平滑过渡。下载完成时图标从进度态切到正常态，如果颜色重置会闪一下。继承旧 delegate 的 `progressColor`/`trackColor`/`plateColor`，让完成动画从当前颜色过渡，避免视觉跳变。

---

## 九、通知监听 NotificationListener

### 9.1 NotificationListenerService 接入

`NotificationListener` 继承系统的 `NotificationListenerService`，绑定后能收到所有应用的通知事件：

```java
public class NotificationListener extends NotificationListenerService {
    private static final int MSG_NOTIFICATION_POSTED = 1;
    private static final int MSG_NOTIFICATION_REMOVED = 2;
    private static final int MSG_NOTIFICATION_FULL_REFRESH = 3;
    private static final int MSG_NOTIFICATION_RANKING_UPDATE = 4;

    // PackageUserKey → DotInfo 的映射（每个应用一个红点信息）
    private final Map<PackageUserKey, DotInfo> mPackageUserToDotInfos = new HashMap<>();
    // groupKey → NotificationGroup（通知分组）
    private final Map<String, NotificationGroup> mNotificationGroupMap = new HashMap<>();
    // 通知 key → 当前 groupKey（处理分组变化）
    private final Map<String, String> mNotificationGroupKeyMap = new HashMap<>();

    private final Handler mWorkerHandler;
    private final Ranking mTempRanking = new Ranking(); // 复用 Ranking 对象

    public NotificationListener() {
        // 所有处理在 UI_HELPER_EXECUTOR 后台线程（非主线程，避免卡 UI）
        mWorkerHandler = new Handler(UI_HELPER_EXECUTOR.getLooper(), this::handleWorkerMessage);
    }
```

系统回调都在 binder 线程，立即转发到 worker 线程处理：

```java
@Override
public void onNotificationPosted(final StatusBarNotification sbn) {
    if (sbn != null) {
        mWorkerHandler.obtainMessage(MSG_NOTIFICATION_POSTED, sbn).sendToTarget();
    }
}

@Override
public void onNotificationRemoved(final StatusBarNotification sbn) {
    if (sbn != null) {
        mWorkerHandler.obtainMessage(MSG_NOTIFICATION_REMOVED, sbn).sendToTarget();
    }
}
```

### 9.2 通知有效性过滤 notificationIsValidForUI

并非所有通知都显示红点，过滤规则：

```java
@WorkerThread
private boolean notificationIsValidForUI(StatusBarNotification sbn) {
    Notification notification = sbn.getNotification();
    updateGroupKeyIfNecessary(sbn);

    // 1. 检查渠道是否允许显示角标（用户可在系统设置里关）
    getCurrentRanking().getRanking(sbn.getKey(), mTempRanking);
    if (!mTempRanking.canShowBadge()) {
        return false;
    }
    // 2. 默认"杂项"渠道的特殊过滤
    if (mTempRanking.getChannel().getId().equals(NotificationChannel.DEFAULT_CHANNEL_ID)) {
        // 正在进行的通知（如音乐播放）不显示红点
        if ((notification.flags & Notification.FLAG_ONGOING_EVENT) != 0) {
            return false;
        }
    }

    // 3. 没有标题和文本的通知不显示（空通知）
    CharSequence title = notification.extras.getCharSequence(Notification.EXTRA_TITLE);
    CharSequence text = notification.extras.getCharSequence(Notification.EXTRA_TEXT);
    boolean missingTitleAndText = TextUtils.isEmpty(title) && TextUtils.isEmpty(text);
    // 4. 分组通知的 header（summary）不显示
    boolean isGroupHeader = (notification.flags & Notification.FLAG_GROUP_SUMMARY) != 0;
    return !isGroupHeader && !missingTitleAndText;
}
```

四层过滤：
- `canShowBadge()`：尊重用户的渠道级开关（用户可禁用某应用的通知角标）
- ONGOING_EVENT：音乐播放、导航等持续通知不打扰
- 空内容：纯进度条等无文案通知忽略
- Group summary：分组通知的汇总项不单独显示，只让子通知显示

### 9.3 计数与分组 handleNotificationPosted

```java
private void handleNotificationPosted(StatusBarNotification sbn) {
    PackageUserKey postedPackageUserKey = PackageUserKey.fromNotification(sbn);
    // computeIfAbsent：没有就 new DotInfo，有就复用
    if (mPackageUserToDotInfos.computeIfAbsent(postedPackageUserKey, DOT_FACTOR)
            .addOrUpdateNotificationKey(NotificationKeyData.fromNotification(sbn))) {
        dispatchUpdate(postedPackageUserKey::equals); // 计数有变化才派发更新
    }
}
```

`DOT_FACTOR` 是个工厂 lambda：

```java
private static final Function<PackageUserKey, DotInfo> DOT_FACTOR = key -> new DotInfo();
```

`addOrUpdateNotificationKey` 在 DotInfo 里维护通知列表和总计数，返回 false 表示计数没变（重复通知），不派发无效更新。

### 9.4 全量刷新 handleNotificationFullRefresh

连接/断开时需要全量重建红点状态：

```java
private void handleNotificationFullRefresh(List<StatusBarNotification> activeNotifications) {
    // 复制旧状态用于 diff
    HashMap<PackageUserKey, DotInfo> updatedDots = new HashMap<>(mPackageUserToDotInfos);
    mPackageUserToDotInfos.clear();
    for (StatusBarNotification notification : activeNotifications) {
        PackageUserKey packageUserKey = PackageUserKey.fromNotification(notification);
        mPackageUserToDotInfos.computeIfAbsent(packageUserKey, DOT_FACTOR)
                .addOrUpdateNotificationKey(NotificationKeyData.fromNotification(notification));
    }

    // diff：找出真正变化的 key
    for (PackageUserKey packageUserKey : mPackageUserToDotInfos.keySet()) {
        DotInfo prevDot = updatedDots.get(packageUserKey);
        DotInfo newDot = mPackageUserToDotInfos.get(packageUserKey);
        if (prevDot == null || prevDot.getNotificationCount() != newDot.getNotificationCount()) {
            updatedDots.put(packageUserKey, newDot); // 新增或计数变了
        } else {
            updatedDots.remove(packageUserKey); // 没变，从待更新集合移除
        }
    }
    if (!updatedDots.isEmpty()) {
        dispatchUpdate(updatedDots::containsKey); // 只通知变化的 key
    }
}
```

关键优化：**diff 后只派发变化的 key**。假设 100 个应用有通知，只 1 个变化，只触发 1 个图标的重绘，而非 100 个全刷。

### 9.5 设置开关监听

用户可在系统设置关闭"通知圆点"，Launcher 要响应：

```java
@Override
public void onListenerConnected() {
    super.onListenerConnected();
    mIsConnected = true;
    mSettingsCache = SettingsCache.INSTANCE.get(this);
    mNotificationSettingsChangedListener = this::onNotificationSettingsChanged;
    // 监听通知角标开关
    mSettingsCache.register(NOTIFICATION_BADGING_URI, mNotificationSettingsChangedListener);
    onNotificationSettingsChanged(mSettingsCache.getValue(NOTIFICATION_BADGING_URI));
    onNotificationFullRefresh(); // 首次连接全量拉取
}

private void onNotificationSettingsChanged(boolean areNotificationDotsEnabled) {
    if (!areNotificationDotsEnabled && mIsConnected) {
        requestUnbind(); // 关闭角标则解绑 listener
    }
}
```

### 面试深问

**Q1：为什么用 `UI_HELPER_EXECUTOR` 而非 `MODEL_EXECUTOR` 处理通知？**
职责分离。`MODEL_EXECUTOR` 专给图标加载/数据库操作，通知处理是独立的高频任务（每条通知都触发），放专用线程避免和图标加载互相阻塞。`UI_HELPER_EXECUTOR` 是 UI 辅助线程，适合这类轻量高频任务。

**Q2：`computeIfAbsent` + `DOT_FACTOR` 比传统 if-null-new 简洁在哪？**
原子操作。`computeIfAbsent` 在 HashMap 上是线程安全的 put-if-absent，避免"先 get 判 null 再 put"的竞态。虽然这里是 worker 单线程，但写法上更安全且简洁。`DOT_FACTOR` 复用同一个 lambda 避免每次 new Function。

**Q3：通知分组（NotificationGroup）解决什么问题？**
同一应用的多个通知合成一组。group summary 是组的 header（不显示红点），children 是实际通知。当最后一个 child 移除时，要自动移除 summary。`NotificationGroup` 维护 summaryKey 和 childKeys，`updateGroupKeyIfNecessary` 处理通知跨组移动（分组 key 变化）。

---

## 十、DotInfo 与计数模型

### 10.1 DotInfo 数据结构

`DotInfo` 是单个应用的红点数据，维护通知列表和总计数：

```java
public class DotInfo {
    public static final int MAX_COUNT = 999; // 计数上限，避免显示 "9999+" 这种超长数字

    // 该红点代表的所有通知 key（每条通知一个 NotificationKeyData）
    private final List<NotificationKeyData> mNotificationKeys = new ArrayList<>();
    private int mTotalCount; // 所有通知的 count 之和（单条通知 count 可 >1，如 "3 条消息"）

    // 添加或更新通知 key，返回 true 表示计数有变化
    public boolean addOrUpdateNotificationKey(NotificationKeyData notificationKey) {
        int indexOfPrevKey = mNotificationKeys.indexOf(notificationKey); // equals 只比 notificationKey
        NotificationKeyData prevKey = indexOfPrevKey == -1 ? null : mNotificationKeys.get(indexOfPrevKey);
        if (prevKey != null) {
            if (prevKey.count == notificationKey.count) {
                return false; // 同 key 同 count，无变化
            }
            // count 变了，差额更新
            mTotalCount -= prevKey.count;
            mTotalCount += notificationKey.count;
            prevKey.count = notificationKey.count;
            return true;
        }
        // 新通知，追加并累加 count
        boolean added = mNotificationKeys.add(notificationKey);
        if (added) {
            mTotalCount += notificationKey.count;
        }
        return added;
    }

    public boolean removeNotificationKey(NotificationKeyData notificationKey) {
        boolean removed = mNotificationKeys.remove(notificationKey);
        if (removed) {
            mTotalCount -= notificationKey.count;
        }
        return removed;
    }

    public int getNotificationCount() {
        return Math.min(mTotalCount, MAX_COUNT); // 钳制到 999
    }
}
```

设计要点：
- 用 `List<NotificationKeyData>` 而非 `Set`，因为要支持更新已存在通知的 count（`indexOf` + 改字段）。
- `mTotalCount` 实时维护，避免每次 `getNotificationCount` 遍历求和。
- `equals` 只比 `notificationKey`（通知的唯一 key），不比 count，保证 `indexOf` 能找到要更新的通知。

### 10.2 NotificationKeyData 通知元数据

```java
public class NotificationKeyData {
    public final String notificationKey;        // 通知唯一 key（sbn.getKey()）
    public final String shortcutId;             // 通知关联的 shortcut（快捷方式红点用）
    @NonNull public final String[] personKeysFromNotification; // 关联的 Person（对话红点）
    public int count;                            // 该通知代表的数量（notification.number，如 "3 条"）

    public static NotificationKeyData fromNotification(StatusBarNotification sbn) {
        Notification notif = sbn.getNotification();
        return new NotificationKeyData(sbn.getKey(), notif.getShortcutId(), notif.number,
                extractPersonKeyOnly(notif.extras.getParcelableArrayList(Notification.EXTRA_PEOPLE_LIST)));
    }

    @Override
    public boolean equals(Object obj) {
        if (!(obj instanceof NotificationKeyData)) return false;
        return ((NotificationKeyData) obj).notificationKey.equals(notificationKey); // 只比 key
    }
}
```

`shortcutId` 和 `personKeysFromNotification` 用于**快捷方式级红点**：一个应用有多个 shortcut（如聊天的不同联系人），每个 shortcut 可独立显示红点。`PopupDataProvider.getDotInfoForItem` 会按 shortcutId 匹配通知，只显示与该 shortcut 相关的通知红点。

### 10.3 FolderDotInfo 文件夹红点聚合

文件夹的红点是所有子应用红点的聚合：

```java
public class FolderDotInfo extends DotInfo {
    private static final int MIN_COUNT = 0;
    private int mNumNotifications;

    public void addDotInfo(DotInfo dotToAdd) {
        if (dotToAdd == null) return;
        // 每个子应用算 1（而非累加 count），避免文件夹显示 "99" 这种夸张数字
        mNumNotifications += dotToAdd.getNotificationKeys().size();
        mNumNotifications = Utilities.boundToRange(mNumNotifications, MIN_COUNT, DotInfo.MAX_COUNT);
    }

    @Override
    public int getNotificationCount() {
        return mNumNotifications;
    }

    public boolean hasDot() {
        return mNumNotifications > 0;
    }
}
```

设计取舍：文件夹内 3 个应用各有 5 条通知，文件夹显示 "3"（应用数）而非 "15"（总通知数）。因为文件夹红点语义是"有 N 个应用有通知"，不是"共 N 条通知"。用 `getNotificationKeys().size()`（应用数）而非 `getNotificationCount()`（通知总数）。

### 面试深问

**Q1：为什么 DotInfo 用 List 而非 Set 存通知？**
要支持更新。同一条通知（同 key）的 count 会变化（如新消息进来 notification.number 从 1 变 2）。Set 无法定位已存在元素修改其字段，List 配合 `indexOf`（equals 只比 key）能找到并就地更新 count。

**Q2：`MAX_COUNT = 999` 为什么不显示具体数字？**
视觉。红点是极小的圆，显示 "1234" 这种长数字会溢出或字号过小。999 是经验上限，超过就显示 "999+"（或直接红点不显数字，看 UI 实现）。`getNotificationCount` 钳制到 999 保证 UI 不溢出。

**Q3：`FolderDotInfo` 继承 `DotInfo` 但完全重写计数逻辑，为什么还继承？**
复用类型。`FolderIcon` 持有 `DotInfo` 引用，`FolderDotInfo is-a DotInfo`，无需改 FolderIcon 的字段类型。但行为完全不同（聚合 count 而非维护通知列表），所以重写 `getNotificationCount`。这是"接口复用、实现重写"的折中。

---

## 十一、DotRenderer 红点绘制

### 11.1 为什么单独抽出 DotRenderer

红点要画在多个视图上：`BubbleTextView`（应用图标）、`FolderIcon`（文件夹）、`PredictedAppIcon`（预测应用）等。每个视图都调 `DotRenderer.draw(canvas, params)`。如果绘制逻辑散落在各视图，重复代码且难统一改样式（改红点大小要改 N 处）。抽成 `DotRenderer`：

- **统一绘制**：所有红点走同一套绘制逻辑，样式一致。
- **预生成位图**：带阴影的红点背景位图在构造时一次生成（`mBackgroundWithShadow`），运行时只 drawBitmap，零阴影开销。
- **按尺寸复用**：`DeviceProfile.createDotRenderer` 用 `SparseArray<DotRenderer>` 缓存，同图标尺寸共享一个 renderer。

```java
public class DotRenderer {
    private static final float SIZE_PERCENTAGE = 0.228f; // 红点是图标尺寸的 22.8%
    private static final float LUMINENSCE_LIMIT = .70f;  // 亮度低于此值需加亮（可访问性）

    private final float mCircleRadius;                    // 红点半径
    private final Paint mCirclePaint = new Paint(ANTI_ALIAS_FLAG | FILTER_BITMAP_FLAG);
    private final Bitmap mBackgroundWithShadow;           // 预生成的带阴影背景
    private final float mBitmapOffset;                    // 背景位图偏移（居中用）

    public DotRenderer(int iconSizePx) {
        int size = Math.round(SIZE_PERCENTAGE * iconSizePx); // 红点尺寸
        if (size <= 0) size = MIN_DOT_SIZE;
        ShadowGenerator.Builder builder = new ShadowGenerator.Builder(Color.TRANSPARENT);
        builder.ambientShadowAlpha = notificationDotContrastBorder() ? 255 : 88; // 对比边框时全黑
        mBackgroundWithShadow = builder.setupBlurForSize(size).createPill(size, size); // 预生成
        mCircleRadius = builder.radius;
        mBitmapOffset = -mBackgroundWithShadow.getHeight() * 0.5f; // 负偏移，居中绘制
    }
}
```

### 11.2 DeviceProfile 中的实例化

```java
// DeviceProfile.java
public final DotRenderer mDotRendererWorkSpace;  // 工作区图标尺寸的红点渲染器
public final DotRenderer mDotRendererAllApps;    // AllApps 图标尺寸的红点渲染器

mDotRendererWorkSpace = createDotRenderer(getWorkspaceIconProfile().getIconSizePx(), dotRendererCache);
mDotRendererAllApps = createDotRenderer(getAllAppsProfile().getIconSizePx(), dotRendererCache);

private static DotRenderer createDotRenderer(int size, @NonNull SparseArray<DotRenderer> cache) {
    DotRenderer renderer = cache.get(size);
    if (renderer == null) {
        renderer = new DotRenderer(size); // 按图标尺寸 new
        cache.put(size, renderer);
    }
    return renderer; // 同尺寸复用
}
```

工作区和 AllApps 图标尺寸可能不同（如平板 AllApps 图标更大），分别创建 renderer。但同尺寸共享（`SparseArray` 缓存）。

### 11.3 draw 绘制流程

```java
public void draw(Canvas canvas, DrawParams params) {
    if (params == null) {
        Log.e(TAG, "Invalid null argument(s) passed in call to draw.");
        return;
    }
    canvas.save();

    Rect iconBounds = params.iconBounds;
    PointF dotPosition = params.getDotPosition(); // 红点在图标上的相对位置（0~1）
    float dotCenterX = iconBounds.left + iconBounds.width() * dotPosition.x;
    float dotCenterY = iconBounds.top + iconBounds.height() * dotPosition.y;

    // 确保红点完全在 canvas 裁剪区内（图标部分被裁时红点不溢出）
    Rect canvasBounds = canvas.getClipBounds();
    float offsetX = params.leftAlign
            ? Math.max(0, canvasBounds.left - (dotCenterX + mBitmapOffset))
            : Math.min(0, canvasBounds.right - (dotCenterX - mBitmapOffset));
    float offsetY = Math.max(0, canvasBounds.top - (dotCenterY + mBitmapOffset));

    // 平移到红点中心，按动画 scale 缩放
    canvas.translate(dotCenterX + offsetX, dotCenterY + offsetY);
    canvas.scale(params.scale, params.scale); // params.scale 0~1 控制出现/消失动画

    // 1. 画带阴影的黑色背景
    mCirclePaint.setColor(Color.BLACK);
    canvas.drawBitmap(mBackgroundWithShadow, mBitmapOffset, mBitmapOffset, mCirclePaint);

    // 2. 画红点本体（覆盖在背景上）
    mCirclePaint.setColor(params.mDotColor);
    canvas.drawCircle(0, 0, mCircleRadius, mCirclePaint);
    canvas.restore();
}
```

### 11.4 DrawParams 与可访问性

```java
public static class DrawParams {
    @ViewDebug.ExportedProperty(category = "notification dot", formatToHexString = true)
    private int mDotColor;                                    // 红点颜色
    @ViewDebug.ExportedProperty(category = "notification dot")
    public Rect iconBounds = new Rect();                     // 图标 bounds（定位红点）
    @ViewDebug.ExportedProperty(category = "notification dot")
    public float scale;                                       // 动画进度（0~1）
    @ViewDebug.ExportedProperty(category = "notification dot")
    public boolean leftAlign;                                 // 是否左对齐（默认右上）
    @NonNull public IconShapeInfo shapeInfo = IconShapeInfo.DEFAULT; // 图标形状信息

    public PointF getDotPosition() {
        return leftAlign ? shapeInfo.leftCornerPosition : shapeInfo.rightCornerPosition;
    }

    public void setDotColor(int color) {
        mDotColor = color;
        // 可访问性：颜色太暗时提亮，保证红点在图标上可见
        if (notificationDotContrastBorder() && luminance(color) < LUMINENSCE_LIMIT) {
            double[] lab = new double[3];
            ColorUtils.colorToLAB(color, lab);
            // 转 LAB 色彩空间，把亮度拉到 LUMINENSCE_LIMIT
            mDotColor = ColorUtils.LABToColor(100 * LUMINENSCE_LIMIT, lab[1], lab[2]);
        }
    }
}
```

`notificationDotContrastBorder()` 是个 feature flag，开启后红点颜色过暗时自动提亮（转 LAB 色彩空间，保持色相和饱和度，只提升亮度到 70）。保证色弱用户也能看清红点。

### 11.5 IconShapeInfo 红点定位

红点要画在图标形状的角上，而非 bitmap 的角上（图标有留白）：

```java
public record IconShapeInfo(PointF leftCornerPosition, PointF rightCornerPosition) {
    // 默认（图标填满 bounds）：用空形状的角
    public static IconShapeInfo DEFAULT = fromPath(IconShape.EMPTY.path, IconShape.EMPTY.pathSize);
    // 默认（规范化图标）：把角位置缩到可见区
    public static IconShapeInfo DEFAULT_NORMALIZED = new IconShapeInfo(
            normalizedPosition(DEFAULT.leftCornerPosition),
            normalizedPosition(DEFAULT.rightCornerPosition)
    );

    public static IconShapeInfo fromPath(Path path, int pathSize) {
        return new IconShapeInfo(
                getPathPoint(path, pathSize, -1), // 左上角：与路径左侧的交点
                getPathPoint(path, pathSize, 1)); // 右上角：与路径右侧的交点
    }

    private static PointF getPathPoint(Path path, float size, float direction) {
        // 构造一个从中心指向左/右边的三角形，与图标路径求交，交点即角的位置
        float halfSize = size / 2;
        float delta = 1;
        float x = halfSize + direction * halfSize;
        Path trianglePath = new Path();
        trianglePath.moveTo(halfSize, halfSize);
        trianglePath.lineTo(x + delta * direction, 0);
        trianglePath.lineTo(x, -delta);
        trianglePath.close();
        trianglePath.op(path, Path.Op.INTERSECT); // 三角形与路径求交
        float[] pos = new float[2];
        new PathMeasure(trianglePath, false).getPosTan(0, pos, null);
        return new PointF(pos[0] / size, pos[1] / size); // 归一化到 0~1
    }
}
```

算法巧妙：构造一个从图标中心指向左上/右上的细长三角形，与图标形状路径做 `INTERSECT` 运算，交集的起点就是形状轮廓上的角点。这样无论图标是圆、方、水滴，红点都精准贴在轮廓角上。

### 面试深问

**Q1：红点背景为什么要预生成位图？**
阴影。`ShadowGenerator.Builder.createPill` 用 `setShadowLayer` 画带阴影的圆，这是软件操作。预生成成 `mBackgroundWithShadow` 后，运行时 `drawBitmap` 是 GPU 友好的，红点出现/消失动画（频繁 invalidate）不掉帧。和图标阴影预烘焙同理。

**Q2：`getPathPoint` 用三角形求交点比直接取路径顶点好在哪？**
通用性。图标形状可能是任意 Path（圆弧、贝塞尔），顶点不一定在角上。三角形求交保证拿到的是"形状轮廓上最接近左上/右上的点"，对任意凸形状都准确。PathMeasure 取交集起点就是轮廓进入三角形的位置。

**Q3：`BubbleTextView` 里 AllApps 用 `DEFAULT` 而 Workspace 用 `ThemeManager.getIconState().getIconShapeInfo()`，区别？**
AllApps 图标是满溢绘制（`FullBleedDrawableDelegate`），图标填满 bounds，红点用 `DEFAULT`（贴 bounds 角）。Workspace 图标可能是规范化绘制（有留白），红点用 normalized 后的 shapeInfo（贴可见区角）。两者对应不同的图标渲染模式。

---

## 十二、BubbleTextView 红点显示

### 12.1 初始化与 renderer 选择

```java
// BubbleTextView.java
private DotInfo mDotInfo;
private final DotRenderer mDotRenderer;
protected final DotRenderer.DrawParams mDotParams;
private Animator mDotScaleAnim;

mDotParams = new DotRenderer.DrawParams();
mDotParams.setDotColor(Themes.getAttrColor(context, R.attr.notificationDotColor)); // 主题红点颜色

if (mDisplay == DISPLAY_ALL_APPS) {
    mDotRenderer = mActivity.getDeviceProfile().mDotRendererAllApps;
    // AllApps 图标填满 bounds，不归一化（bounds 已是可见区）
    mDotParams.shapeInfo = IconShapeInfo.DEFAULT;
} else {
    mDotRenderer = mActivity.getDeviceProfile().mDotRendererWorkSpace;
    // Workspace 图标有留白，用归一化后的 shapeInfo
    mDotParams.shapeInfo = ThemeManager.INSTANCE.get(context).getIconState().getIconShapeInfo();
}
```

### 12.2 onDraw 触发红点绘制

```java
@Override
public void onDraw(Canvas canvas) {
    super.onDraw(canvas);              // 先画图标（TextView 的 compound drawable）
    drawDotIfNecessary(canvas);        // 再画红点
    drawRunningAppIndicatorIfNecessary(canvas); // 运行指示器（桌面模式）
}

protected void drawDotIfNecessary(Canvas canvas) {
    if (!mForceHideDot && (hasDot() || mDotParams.scale > 0)) {
        getIconBounds(mDotParams.iconBounds);                              // 取图标 bounds
        Utilities.scaleRectAboutCenter(mDotParams.iconBounds, ICON_VISIBLE_AREA_FACTOR); // 缩到可见区
        final int scrollX = getScrollX();
        final int scrollY = getScrollY();
        canvas.translate(scrollX, scrollY);                                // 补偿文字滚动偏移
        mDotRenderer.draw(canvas, mDotParams);
        canvas.translate(-scrollX, -scrollY);
    }
}
```

`mForceHideDot` 用于拖拽等场景临时隐藏红点。`mDotParams.scale > 0` 保证消失动画过程中（hasDot 已 false 但 scale 还在衰减）继续绘制。

### 12.3 applyDotState 状态同步

红点状态由通知数据驱动，通过 `applyDotState` 同步到视图：

```java
public void applyDotState(ItemInfo itemInfo, boolean animate) {
    if (mIcon != null) {
        boolean wasDotted = mDotInfo != null;
        mDotInfo = mActivity.getDotInfoForItem(itemInfo); // 从 PopupDataProvider 查当前 item 的红点
        boolean isDotted = mDotInfo != null;
        float newDotScale = isDotted ? 1f : 0;
        if (wasDotted || isDotted) {
            // 状态翻转时（无→有 或 有→无）才动画
            if (animate && (wasDotted ^ isDotted) && isShown()) {
                animateDotScale(newDotScale);
            } else {
                cancelDotScaleAnim();
                mDotParams.scale = newDotScale;
                invalidate();
            }
        }
        // 更新无障碍描述（含通知计数）
        if (!TextUtils.isEmpty(itemInfo.contentDescription)) {
            if (hasDot()) {
                int count = mDotInfo.getNotificationCount();
                setContentDescription(getAppLabelPluralString(itemInfo.contentDescription.toString(), count));
                // 如 "微信，3 条通知"
            } else {
                setContentDescription(itemInfo.contentDescription);
            }
        }
    }
}
```

### 12.4 红点出现/消失动画

```java
private void cancelDotScaleAnim() {
    if (mDotScaleAnim != null) {
        mDotScaleAnim.cancel();
    }
}

public void animateDotScale(float... dotScales) {
    cancelDotScaleAnim();
    mDotScaleAnim = ObjectAnimator.ofFloat(this, DOT_SCALE_PROPERTY, dotScales);
    mDotScaleAnim.addListener(new AnimatorListenerAdapter() {
        @Override
        public void onAnimationEnd(Animator animation) {
            mDotScaleAnim = null;
        }
    });
    mDotScaleAnim.start();
}

// DOT_SCALE_PROPERTY：代理到 mDotParams.scale
private static final FloatProperty<BubbleTextView> DOT_SCALE_PROPERTY = new FloatProperty<BubbleTextView>("dotScale") {
    @Override
    public Float get(BubbleTextView bubbleTextView) {
        return bubbleTextView.mDotParams.scale;
    }
    @Override
    public void setValue(BubbleTextView bubbleTextView, float value) {
        bubbleTextView.mDotParams.scale = value; // 动画驱动 scale 0~1
    }
};
```

动画通过修改 `mDotParams.scale`，`DotRenderer.draw` 里 `canvas.scale(params.scale, params.scale)` 实现红点从小到大弹出/从大到小消失。

### 12.5 强制隐藏与恢复

拖拽时临时隐藏红点，松手恢复：

```java
@Override
public void setForceHideDot(boolean forceHideDot) {
    if (mForceHideDot == forceHideDot) return;
    mForceHideDot = forceHideDot;

    if (forceHideDot) {
        invalidate(); // 隐藏：直接重绘（drawDotIfNecessary 会因 mForceHideDot 跳过）
    } else if (hasDot()) {
        animateDotScale(0, 1); // 恢复：从 0 弹到 1，有动画
    }
}
```

### 面试深问

**Q1：为什么 `drawDotIfNecessary` 要 `canvas.translate(scrollX, scrollY)`？**
TextView 文字可能 marquee 滚动（ellipsize=MARQUEE），canvas 有滚动偏移。红点画在图标上不随文字滚，但要补偿这个偏移保证红点位置正确。画完再 translate 回去恢复 canvas 状态。

**Q2：`applyDotState` 里 `wasDotted ^ isDotted` 异或的作用？**
只在状态翻转时动画。如果本来就有点、现在还有点（只是 count 变了），不播放出现/消失动画，直接 invalidate 重绘新 count。避免每次通知数变化都弹一下。只有从无到有或从有到无才弹。

**Q3：`getDotInfoForItem` 为什么对 pinned shortcut 做额外过滤？**
快捷方式级红点。一个 shortcut（如聊天的某联系人）只应显示与该 shortcut 关联的通知，而非整个应用所有通知。`getDotInfoForItem` 按 `shortcutId` 或 `personKeys` 过滤，只匹配的通知存在才返回 dotInfo。这是"快捷方式也能单独亮红点"的实现基础。

---

## 十三、通知更新派发链路

### 13.1 NotificationRepository 数据中枢

`NotificationRepository` 是通知数据的单一数据源（Single Source of Truth），用 Kotlin `ListenableStream` 暴露更新事件：

```kotlin
@LauncherAppSingleton
class NotificationRepository @Inject constructor() {
    // 当前所有应用的红点信息（不可变 Map，保证读一致性）
    var packageUserToDotInfos: Map<PackageUserKey, DotInfo> = emptyMap()
        private set

    private val _updateStream = MutableListenableStream<Predicate<PackageUserKey>>()
    /** 更新事件流：Predicate 标识哪些 key 变了 */
    val updateStream = _updateStream.asListenable()

    /** 派发一次通知数据更新 */
    fun dispatchUpdate(newValue: Map<PackageUserKey, DotInfo>, update: Predicate<PackageUserKey>) {
        packageUserToDotInfos = newValue            // 原子替换整个 Map
        _updateStream.dispatchValue(update)         // 派发变更谓词
    }
}
```

设计要点：
- **不可变 Map**：每次更新整个替换，读者拿到的快照始终一致，无需加锁。
- **Predicate 标识变更范围**：不只告诉"变了"，还告诉"哪些 key 变了"，订阅者只更新受影响的视图。
- **`@LauncherAppSingleton`**：Dagger 作用域，整个 Launcher 进程单例。

### 13.2 NotificationListener 派发

```java
private void dispatchUpdate(Predicate<PackageUserKey> updatedDots) {
    LauncherComponentProvider.get(this).getNotificationRepository().dispatchUpdate(
            new HashMap<>(mPackageUserToDotInfos), updatedDots); // 复制一份防并发修改
}
```

`new HashMap<>(...)` 复制是因为 repository 会持有这个 Map，复制避免后续 listener 修改影响 repository 状态。

### 13.3 PopupDataProvider 订阅与分发

```java
@Inject
public PopupDataProvider(
        ActivityContext context,
        NotificationRepository notificationRepository,
        AllAppsStore appsStore,
        BgDataModel dataModel) {
    mContext = context;
    mNotificationRepo = notificationRepository;
    mAppsStore = appsStore;
    mBgDataModel = dataModel;

    // 订阅更新流，主线程处理
    mContext.closeOnDestroy(mNotificationRepo.getUpdateStream().forEach(
            Executors.MAIN_EXECUTOR, this::updateNotificationDots));
}

private Unit updateNotificationDots(Predicate<PackageUserKey> updatedDots) {
    final PackageUserKey packageUserKey = new PackageUserKey(null, null); // 复用对象
    // matcher：item 的 key 不变（updateFromItemInfo 返回 false）或 key 在变更集合里
    Predicate<ItemInfo> matcher = info -> !packageUserKey.updateFromItemInfo(info)
            || updatedDots.test(packageUserKey);

    ItemOperator op = (info, v) -> {
        if (v instanceof BubbleTextView btv && info != null && matcher.test(info)) {
            btv.applyDotState(info, true /* animate */); // 触发红点更新（带动画）
        } else if (v instanceof FolderIcon icon
                && info instanceof FolderInfo fi && fi.anyMatch(matcher)) {
            icon.updateDotInfo(); // 文件夹重新聚合子应用红点
        }
        return false; // 继续遍历所有 item
    };

    mContext.getContent().mapOverItems(op);      // 遍历工作区所有图标
    Folder folder = Folder.getOpen(mContext);
    if (folder != null) {
        folder.mapOverItems(op);                  // 打开的文件夹也要遍历
    }
    mAppsStore.updateNotificationDots(updatedDots); // AllApps 列表也更新
    return null;
}
```

### 13.4 getDotInfoForItem 查询入口

```java
public @Nullable DotInfo getDotInfoForItem(@NonNull ItemInfo info) {
    if (!ShortcutUtil.supportsShortcuts(info)) {
        return null; // 不支持快捷方式的 item 不显示红点
    }
    DotInfo dotInfo = mNotificationRepo.getPackageUserToDotInfos()
            .get(PackageUserKey.fromItemInfo(info)); // 查当前 item 对应应用的 DotInfo
    if (dotInfo == null) {
        return null;
    }

    // 如果是 pinned shortcut，只显示与该 shortcut 关联的通知
    String shortcutId = ShortcutUtil.getShortcutIdIfPinnedShortcut(info);
    if (shortcutId == null) {
        return dotInfo; // 普通应用图标，直接返回
    }
    String[] personKeys = ShortcutUtil.getPersonKeysIfPinnedShortcut(info);
    // 检查是否有通知匹配该 shortcut（按 shortcutId 或 personKeys）
    return (dotInfo.getNotificationKeys().stream().anyMatch(notification -> {
        if (notification.shortcutId != null) {
            return notification.shortcutId.equals(shortcutId);
        }
        if (notification.personKeysFromNotification.length != 0) {
            return Arrays.equals(notification.personKeysFromNotification, personKeys);
        }
        return false;
    })) ? dotInfo : null; // 无匹配则不显示红点
}
```

### 面试深问

**Q1：为什么用 ListenableStream 而非 LiveData 或 RxJava？**
轻量。`ListenableStream` 是 Launcher3 自研的极简事件流，无外部依赖，API 就 `forEach(executor, callback)` 和 `dispatchValue`。LiveData 绑 Android 生命周期，RxJava 过重。Launcher3 已经在 `closeOnDestroy` 管理生命周期，不需要 Stream 再管。

**Q2：`mapOverItems` 遍历所有图标性能如何？**
只在通知变化时触发，且 Predicate 提前过滤掉未变更的 key（`matcher.test(info)` 快速短路）。实际只有少数图标会进 `applyDotState`。工作区一屏约 20-30 个图标，遍历开销可忽略。通知变化频率远低于帧率，不是性能瓶颈。

**Q3：为什么 `dispatchUpdate` 要 `new HashMap` 复制？**
读写隔离。`mPackageUserToDotInfos` 是 listener 持有的可变 Map，后续通知事件会继续修改它。repository 要长期持有传入的 Map（读者会读），不复制会导致读者读到中途被修改的 Map。复制一份快照保证 repository 持有的是不可变快照。

---

## 十四、ThemeManager 与主题图标

### 14.1 LauncherIconProvider 主题映射

`LauncherIconProvider` 扩展 `IconProvider`，提供"系统图标 → 主题图标"的映射：

```java
@LauncherAppSingleton
public class LauncherIconProvider extends IconProvider {
    private Map<String, ThemeData> mThemedIconMap;

    @Override
    protected ThemeData getThemeDataForPackage(String packageName) {
        return getThemedIconMap().get(packageName); // 查映射表
    }

    @Override
    public void updateSystemState() {
        super.updateSystemState();
        mSystemState += "," + mThemeManager.getIconState().toUniqueId(); // 主题变化也进 freshnessId
    }

    // 解析 grayscale_icon_map.xml：<icon package="..." drawable="..."/>
    private Map<String, ThemeData> getThemedIconMap() {
        if (mThemedIconMap != null) return mThemedIconMap;
        ArrayMap<String, ThemeData> map = new ArrayMap<>();
        Resources res = mContext.getResources();
        try (XmlResourceParser parser = res.getXml(R.xml.grayscale_icon_map)) {
            // 解析 XML，建立 packageName → ThemeData 映射
            while (... ) {
                if (TAG_ICON.equals(parser.getName())) {
                    String pkg = parser.getAttributeValue(null, ATTR_PACKAGE);
                    int iconId = parser.getAttributeResourceValue(null, ATTR_DRAWABLE, 0);
                    if (iconId != 0 && !TextUtils.isEmpty(pkg)) {
                        map.put(pkg, new ThemeData(res, iconId));
                    }
                }
            }
        }
        mThemedIconMap = map;
        return mThemedIconMap;
    }
}
```

`grayscale_icon_map.xml` 列出所有支持主题化的系统应用包名及其灰度图标资源。非系统应用的主题化靠 AdaptiveIcon 自带的 monochrome 层（Android 13+）。

### 14.2 主题状态影响缓存

主题变化时，`updateSystemState` 把主题 ID 拼进 `mSystemState`，进而进入 `freshnessId`，导致缓存失效触发全量重绘：

```java
@Override
public void updateSystemState() {
    super.updateSystemState(); // locale + sdkVersion
    mSystemState += "," + mThemeManager.getIconState().toUniqueId(); // 主题 ID
}
```

用户切换深色模式或换壁纸取色，主题 ID 变 → freshnessId 变 → `IconCacheUpdateHandler` 标记全部失效 → 重绘所有图标。

### 面试深问

**Q1：主题图标和 AdaptiveIcon 的 monochrome 层什么关系？**
互补。`IconProvider.getIcon` 里：如果应用自带 monochrome 层（`aid.getMonochrome() != null`）直接用；否则从 `grayscale_icon_map` 查系统提供的灰度图标注入。前者是应用开发者提供（Android 13+），后者是 Launcher 为老应用兜底（主要是 Google 系应用）。

**Q2：为什么主题 ID 进 freshnessId 而非单独存？**
复用现有失效机制。freshnessId 已经是"任何影响图标视觉的因素"的聚合（locale、sdk、APK 版本），主题是其中一个因素。拼进去就自动享受 `IconCacheUpdateHandler` 的失效逻辑，无需单独写主题失效代码。

**Q3：`grayscale_icon_map.xml` 为什么是 Launcher 维护而非系统？**
Launcher 私有。不同 Launcher（Launcher3、第三方桌面）主题图标样式不同，映射表各 Launcher 自定义。Launcher3 只为预装 Google 应用提供主题图标，第三方应用靠 AdaptiveIcon monochrome。这是 Launcher 差异化的视觉资产。

---

## 十五、SysUiScrim 背景遮罩

### 15.1 作用

`SysUiScrim` 在 workspace 和 hotseat 后方绘制渐变遮罩，提升图标对比度（尤其是壁纸上半部分过亮或下半部分过暗时）：

```java
public class SysUiScrim implements View.OnAttachStateChangeListener {
    private static final int MAX_SYSUI_SCRIM_ALPHA = 255;
    private static final int ALPHA_MASK_BITMAP_WIDTH_DP = 2;
    private static final int BOTTOM_MASK_HEIGHT_DP = 200; // 底部遮罩高度
    private static final int TOP_MASK_HEIGHT_DP = 70;     // 顶部遮罩高度

    private boolean mDrawTopScrim, mDrawBottomScrim;
    private final RectF mTopMaskRect = new RectF();
    private final Paint mTopMaskPaint = new Paint(FILTER_BITMAP_FLAG | DITHER_FLAG);
    private final Bitmap mTopMaskBitmap;    // 顶部遮罩位图（预生成渐变）
    private final int mTopMaskHeight;
    private final RectF mBottomMaskRect = new RectF();
    private final Paint mBottomMaskPaint = new Paint(FILTER_BITMAP_FLAG | DITHER_FLAG);
    private final Bitmap mBottomMaskBitmap; // 底部遮罩位图
    private final int mBottomMaskHeight;
}
```

### 15.2 预生成遮罩位图

和阴影、红点背景同理，遮罩用 `LinearGradient` 预生成位图，运行时只 `drawBitmap`：

```java
// 顶部遮罩：从上到下渐隐的暗色条（让顶部状态栏区域图标更清晰）
// 底部遮罩：从下到上渐隐的暗色条（让 hotseat 图标更清晰）
```

`ALPHA_MASK_BITMAP_WIDTH_DP = 2` 宽度只有 2dp，因为遮罩是垂直渐变（水平无变化），2dp 宽的位图靠 `FILTER_BITMAP_FLAG` 横向拉伸即可，省内存。

### 15.3 屏幕开关动画

锁屏解锁后遮罩有渐现动画，避免突兀：

```java
private final ScreenOnListener mScreenOnListener = new ScreenOnListener() {
    @Override
    public void onScreenOnChanged(boolean isOn) {
        if (!isOn) {
            mAnimateScrimOnNextDraw = true; // 灭屏标记，下次绘制时动画
        }
    }
    @Override
    public void onUserPresent() {
        // 解锁完成（用户在场），取消动画直接显示
        mAnimateScrimOnNextDraw = false;
    }
};
```

### 面试深问

**Q1：遮罩位图为什么只 2dp 宽？**
垂直渐变。遮罩只在 Y 方向有亮度变化（顶部暗→透明，底部暗→透明），X 方向均匀。2dp 宽位图横向拉伸即可，比全宽位图省 99%+ 内存。`FILTER_BITMAP_FLAG` 保证拉伸平滑无锯齿。

**Q2：`SysUiScrim` 和 AllApps 拉出的暗化什么关系？`
不同机制。`SysUiScrim` 是 workspace/hotseat 的静态对比度遮罩。AllApps 拉出时的全屏暗化由 `ScrimView`（`views/ScrimView.java`）处理，那是另一套独立的遮罩系统，跟随 AllApps 滑动进度动态调整透明度。两者职责不同。

**Q3：为什么用 `DITHER_FLAG`？`
渐变带。预生成的渐变位图色阶有限（每通道 8bit），拉伸后可能出现色带（banding）。`DITHER_FLAG` 启用抖动，用噪声打散色带，视觉上更平滑。对低色深显示特别重要。

---

## 十六、关键常量与参数速查

| 常量 | 值 | 位置 | 含义 |
|---|---|---|---|
| `ICON_VISIBLE_AREA_FACTOR` | ≈0.92 | `IconNormalizer` | 图标可见区占整体比例 |
| `BLUR_FACTOR` | 1.68f/48 ≈0.035 | `ShadowGenerator` | 阴影模糊半径系数 |
| `KEY_SHADOW_DISTANCE` | 1f/48 ≈0.021 | `ShadowGenerator` | 关键阴影偏移系数 |
| `AMBIENT_SHADOW_ALPHA` | 25 | `ShadowGenerator` | 环境阴影透明度 |
| `KEY_SHADOW_ALPHA` | 7 | `ShadowGenerator` | 关键阴影透明度 |
| `PRESSED_SCALE` | 1.1f | `FastBitmapDrawable` | 按压缩放比例 |
| `HOVERED_SCALE` | 1.1f | `FastBitmapDrawable` | 悬浮缩放比例 |
| `CLICK_FEEDBACK_DURATION` | 200ms | `FastBitmapDrawable` | 点击反馈动画时长 |
| `HOVER_FEEDBACK_DURATION` | 300ms | `FastBitmapDrawable` | 悬浮反馈动画时长 |
| `WHITE_SCRIM_ALPHA` | 138 | `FastBitmapDrawable` | 白色提亮透明度 |
| `DISABLED_DESATURATION` | 1f | `FastBitmapDrawable` | 禁用态去饱和度 |
| `DISABLED_BRIGHTNESS` | 0.5f | `FastBitmapDrawable` | 禁用态亮度 |
| `SIZE_PERCENTAGE` | 0.228f | `DotRenderer` | 红点占图标尺寸比例 |
| `LUMINENSCE_LIMIT` | 0.70f | `DotRenderer` | 红点最低亮度（可访问性） |
| `MAX_COUNT` | 999 | `DotInfo` | 红点计数上限 |
| `ICON_BADGE_SCALE` | 0.444f | `BaseIconFactory` | 用户角标占图标比例 |
| `NUM_SAMPLES` | 20 | `ColorExtractor` | 主色提取采样数 |
| `RELEASE_VERSION` | 12 或 14 | `BaseIconCache` | 缓存版本（改结构时 bump） |

### 主色提取算法

`ColorExtractor.findDominantColorByHue` 两轮扫描：

```kotlin
fun findDominantColorByHue(bitmap: Bitmap): Int {
    val sampleStride = sqrt((height * width) / NUM_SAMPLES.toDouble()).toInt().coerceAtLeast(1)
    val hsv = FloatArray(3)
    val hueScoreHistogram = FloatArray(360) // 360 个色相桶
    var highScore = -1f; var bestHue = -1

    // 第一轮：找最高分色相（分数 = 饱和度 × 亮度，加权累计）
    for (y in 0..<height step sampleStride) {
        for (x in 0..<width step sampleStride) {
            val argb = bitmap.getPixel(x, y)
            val alpha = 0xFF and (argb shr 24)
            if (alpha < 0x80) continue // 丢半透明像素
            val rgb = argb or -0x1000000 // 去 alpha
            Color.colorToHSV(rgb, hsv)
            val hue = hsv[0].toInt()
            if (hue < 0 || hue >= hueScoreHistogram.size) continue
            val score = hsv[1] * hsv[2] // 饱和度 × 亮度
            hueScoreHistogram[hue] += score
            if (hueScoreHistogram[hue] > highScore) {
                highScore = hueScoreHistogram[hue]; bestHue = hue
            }
        }
    }

    // 第二轮：在最佳色相内，找最高分的具体颜色
    val rgbScores = SparseArray<Float>()
    var bestColor = -0x1000000; highScore = -1f
    for (i in 0..<pixelCount) {
        val rgb = pixels[i]
        Color.colorToHSV(rgb, hsv)
        if (hsv[0].toInt() == bestHue) {
            val bucket = (hsv[1] * 100).toInt() + (hsv[2] * 10000).toInt()
            val score = hsv[1] * hsv[2]
            val newTotal = (rgbScores[bucket] ?: 0f) + score
            rgbScores.put(bucket, newTotal)
            if (newTotal > highScore) { highScore = newTotal; bestColor = rgb }
        }
    }
    return bestColor
}
```

加权 `score = 饱和度 × 亮度` 的意图：偏好鲜艳且明亮的颜色（这是图标主视觉色），忽略暗淡或接近灰色的背景色。两轮扫描保证找到的是"出现频次高且鲜艳"的颜色，而非单纯最多的颜色。

### 面试深问

**Q1：`RELEASE_VERSION` 什么时候 bump？**
SQLite 表结构或 BitmapInfo 字段含义变化时。注释 `// LINT.IfChange(cache_release_version)` 提示改动 `COLUMNS_*` 或 flag 定义必须 bump。bump 后 `(RELEASE_VERSION shl 16) + iconPixelSize` 变化，`SQLiteCacheHelper` 检测到版本不符自动 drop 重建表，避免读到旧格式数据解析崩溃。

**Q2：主色提取为什么用 `饱和度 × 亮度` 作分数？**
模拟人眼感知。饱和度高（鲜艳）且亮度高（明亮）的颜色最抓眼，是图标的主视觉。灰暗背景色饱和度和亮度都低，分数自然低被忽略。这比简单统计出现次数更符合视觉直觉。

**Q3：`NUM_SAMPLES = 20` 采样数会不会太少导致不准？**
够用。图标是小尺寸位图（几十 px），20 个采样点已覆盖主要色块。`sampleStride` 按 `sqrt(面积/20)` 计算，保证均匀采样。过多采样增加耗时（`getPixel` 慢），20 是性能与精度的折中。
