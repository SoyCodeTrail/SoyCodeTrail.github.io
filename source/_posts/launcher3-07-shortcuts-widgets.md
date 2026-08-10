---
title: Launcher3 源码精读（07）：快捷方式与小组件
category: client
platform: android
tags: ["AOSP", "Launcher3", "源码", "Framework", "Shortcut", "Widget"]
readTime: 29分钟
featured: true
date: 2026-08-02
---

# 07 · Launcher3 快捷方式与小组件

长按是 Launcher 的核心二级交互。本文拆两条主线：长按应用图标弹出的快捷菜单（Deep Shortcuts + System Shortcuts），以及添加小组件到桌面的端到端流程（Picker → 拖拽 → 绑定 → 调整大小）。两条线共用同一套 `DragController` 拖拽基础设施，差别只在数据来源与落位处理。

> 源码基线：`packages/apps/Launcher3/src/com/android/launcher3/`
> 关键目录：`popup/`、`shortcuts/`、`widget/`、`widget/picker/`、`widgetpicker/`、`AppWidgetResizeFrame.kt`

---

# Part 1 · 快捷方式（Deep Shortcuts）

## 一、整体参与角色

长按应用图标弹出的带箭头浮层，由一条职责清晰的链路协作完成：

| 角色 | 文件 | 职责 |
|------|------|------|
| `ItemLongClickListener` | `touch/ItemLongClickListener` | 全局长按入口，分发到 PopupController |
| `PopupControllerForAppIcon` | `popup/PopupControllerAppIcons.kt` | 入口控制器：决定弹不弹、收集数据、建容器 |
| `PopupContainerWithArrow` | `popup/PopupContainerWithArrow.kt` | 浮层 UI 容器（LinearLayout + AbstractFloatingView），承载 deep + system shortcut |
| `PopupPopulator` | `popup/PopupPopulator.java` | 后台线程查询/排序/过滤 deep shortcuts |
| `ShortcutRequest` | `shortcuts/ShortcutRequest.java` | 封装 `LauncherApps.getShortcuts()` 的流式查询 |
| `PopupDataProvider` | `popup/PopupDataProvider.java` | 从 `BgDataModel.deepShortcutMap` 读 shortcut 数量、管理通知小红点 |
| `SystemShortcut` | `popup/SystemShortcut.java` | 系统级菜单项（抽象类 + 内部子类），既是数据又是点击行为 |
| `DeepShortcutView` | `shortcuts/DeepShortcutView.java` | 单条 deep shortcut 的 View（图标 + 文字 + 加号按钮） |
| `PopupItemDragHandler` | `popup/PopupItemDragHandler.kt` | 从 popup 里长按拖出 shortcut 到桌面 |

## 二、弹出流程：ItemLongClickListener → PopupControllerForAppIcon

长按的真正入口是图标的 `OnLongClickListener`。`BubbleTextView` 注册了 `ItemLongClickListener`，它判断当前是否处于可拖拽状态（非编辑锁定、无正在进行的拖拽），然后交给 `PopupControllerForAppIcon.show()`。

```kotlin
// PopupControllerAppIcons.kt
override fun show(view: View): Popup? {
    val icon = view as BubbleTextView                                  // 长按的图标
    val launcher = Launcher.getLauncher(icon.context)
    if (PopupContainer.getOpen(launcher) != null) {                    // 已有 popup 打开 → 不再弹
        icon.clearFocus()
        return null
    }
    val item = icon.tag as ItemInfo
    if (!ShortcutUtil.supportsShortcuts(item)) return null             // 该 item 不支持快捷方式

    // ① 数据：deep shortcut 数量（来自缓存，非实时查询）+ 系统菜单项
    val popupDataProvider = launcher.activityComponent.popupDataProvider
    val deepShortcutCount = popupDataProvider.getShortcutCountForItem(item)
    val systemShortcuts =
        launcher.getSupportedShortcuts(item)                           // 返回 Stream<Factory>
            .map { s -> s.getShortcut(launcher, item, icon) }          // 工厂方法实例化每条
            .filter { it != null }
            .collect(Collectors.toList())

    // ② 创建容器并填充
    val container = PopupContainerWithArrow.create<Launcher>(launcher, icon, item)
    container.configureForLauncher(launcher, item)                     // 注册拖拽监听
    container.populateAndShowRows(
        deepShortcutCount,
        if (view.showingMinimalPopup) emptyList() else systemShortcuts // 最小化模式不显示 system 项
    )
    launcher.refreshAndBindWidgetsForPackageUser(PackageUserKey.fromItemInfo(item)) // 预备 Widgets 项数据
    container.requestFocus()
    return container
}
```

设计要点拆解：

1. **重入保护**：`PopupContainer.getOpen(launcher) != null` 保证同一时刻只有一个浮层。已弹出的情况下，长按另一个图标只清焦点不弹新浮层。
2. **数量来自缓存**：`getShortcutCountForItem` 读的是 `BgDataModel.deepShortcutMap`，这是 `LauncherModel` 在后台预建的缓存，避免每次长按都同步跨进程查询。
3. **系统菜单项按容器过滤**：`getSupportedShortcuts` 根据 `itemInfo.container` 返回不同组合：

```java
// Launcher.java#getSupportedShortcuts
public Stream<SystemShortcut.Factory> getSupportedShortcuts(ItemInfo itemInfo) {
    int container = itemInfo.container;
    if (container == CONTAINER_DESKTOP || container == CONTAINER_HOTSEAT) {
        return Stream.of(APP_INFO, WIDGETS, INSTALL, REMOVE);          // 桌面/热座：四项
    } else if (container == CONTAINER_ALL_APPS || container == CONTAINER_ALL_APPS_PREDICTION) {
        boolean isPinnable = itemInfo instanceof ItemInfoWithIcon info
                && (info.runtimeStatusFlags & FLAG_NOT_PINNABLE) == 0;
        if (isPinnable) {
            return Stream.of(APP_INFO, WIDGETS, INSTALL, ADD_TO_HOME_SCREEN); // AllApps 可加桌面
        } else {
            return Stream.of(APP_INFO, WIDGETS, INSTALL);
        }
    }
    return Stream.of(APP_INFO, WIDGETS, INSTALL);                       // 兜底三项
}
```

注意这里返回的是 `Factory`（工厂），不是实例。每个 `Factory.getShortcut(context, itemInfo, originalView)` 内部还会再做条件过滤（如 `WIDGETS` 工厂发现该包没有任何 widget 就返回 null）。

## 三、容器创建与布局折叠策略

`PopupContainerWithArrow.create` 构造一个竖直方向的 `LinearLayout`，加到 `DragLayer` 显示。`ArrowPopup`（父类）负责箭头指向、贴边翻转等定位逻辑。

### 3.1 populateAndShowRows：先占位后填充

```kotlin
// PopupContainerWithArrow.kt
private fun populateAndShowRows(
    itemInfo: ItemInfo,
    deepShortcutCount: Int,
    systemShortcuts: List<SystemShortcut<*>>,
) {
    containerWidth = resources.getDimensionPixelSize(R.dimen.bg_popup_item_width)

    if (deepShortcutCount > 0) {
        addAllShortcuts(deepShortcutCount, systemShortcuts)             // 有 deep shortcut：混合布局
    } else if (systemShortcuts.isNotEmpty()) {
        addSystemShortcuts(                                            // 只有 system 项：纯系统菜单
            systemShortcuts,
            R.layout.system_shortcut_rows_container,
            R.layout.system_shortcut,
        )
    }
    show()                                                             // 立即显示（此时 deep shortcut 行还是空的）
    loadAppShortcuts(itemInfo)                                         // 异步加载真实 deep shortcut 数据
}
```

`show()` 在数据还没回来时就执行，UI 先显示空行 + 系统菜单项，然后 `loadAppShortcuts` 把真实数据填充丢到后台。

### 3.2 折叠阈值 SHORTCUT_COLLAPSE_THRESHOLD = 6

```kotlin
// PopupContainerWithArrow.kt
private fun addAllShortcuts(deepShortcutCount: Int, systemShortcuts: List<SystemShortcut<*>>) {
    if (deepShortcutCount + systemShortcuts.size <= SHORTCUT_COLLAPSE_THRESHOLD /* 6 */) {
        // 短：system shortcut 各占整行（图标+文字），deep shortcut 在下方
        addSystemShortcuts(systemShortcuts, R.layout.system_shortcut_rows_container, R.layout.system_shortcut)
        val startingHeight = ((shortcutHeight * systemShortcuts.size) + mChildContainerMargin)
        addDeepShortcuts(deepShortcutCount, startingHeight)
        return
    }
    // 长：超过 6 条 → 把可折叠的 system shortcut 压成一行小图标
    currentHeight = shortcutHeight + mChildContainerMargin
    collapseEligibleSystemShortcutsIfOverThreshold(systemShortcuts)    // 可折叠的压成图标行
    addDeepShortcuts(deepShortcutCount, currentHeight)
}
```

折叠的核心是 `mIsCollapsible` 标记。看 `SystemShortcut` 的构造：

```java
// SystemShortcut.java
public SystemShortcut(int iconResId, int labelResId, T target, ItemInfo itemInfo,
        View originalView, boolean isCollapsible) {
    // ...
    mIsCollapsible = isCollapsible;                                    // 是否可被压成纯图标
}
```

各子类在构造时传不同的 `isCollapsible`：

| 子类 | isCollapsible | 说明 |
|------|---------------|------|
| `Widgets` | `false` | "小组件"入口，永远占整行（最重要） |
| `AppInfo` | `true`（默认） | 应用信息 |
| `Install` | `true` | 安装 |
| `RemoveApp` | `false` | 删除 |
| `AddToHomeScreen` | `false` | 加到桌面 |
| `BubbleShortcut` | `true` | 气泡 |

折叠逻辑：

```kotlin
// PopupContainerWithArrow.kt
private fun collapseEligibleSystemShortcutsIfOverThreshold(systemShortcuts: List<SystemShortcut<*>>) {
    val collapsibleSystemShortcuts = getCollapsibleSystemShortcuts(systemShortcuts) // 过滤 mIsCollapsible=true
    addSystemShortcutsIconsOnly(collapsibleSystemShortcuts)           // 压成一行图标
    // 重算容器宽度（图标数 × 单图标触摸尺寸）
    containerWidth = max(containerWidth, collapsibleSystemShortcuts.size *
        resources.getDimensionPixelSize(R.dimen.system_shortcut_header_icon_touch_size))
    val nonCollapsibleSystemShortcuts = systemShortcuts
        .filter { shortcut: SystemShortcut<*> -> !shortcut.mIsCollapsible }
    if (nonCollapsibleSystemShortcuts.isNotEmpty()) {
        addSystemShortcuts(nonCollapsibleSystemShortcuts,             // 不可折叠的仍占整行
            R.layout.system_shortcut_rows_container, R.layout.system_shortcut)
        currentHeight += ((shortcutHeight * nonCollapsibleSystemShortcuts.size) + mChildContainerMargin)
    }
}
```

设计意图：总数超 6 时，把次要的（AppInfo、Install 等）压成图标行，把重要的（Widgets 入口、RemoveApp）保留为整行带文字，保证用户最常用的入口不被吞掉。

### 3.3 addDeepShortcuts：按 count 预占行

```kotlin
// PopupContainerWithArrow.kt
private fun addDeepShortcuts(deepShortcutCount: Int, startingHeight: Float) {
    var height = startingHeight
    deepShortcutContainer = inflateAndAdd(R.layout.deep_shortcut_container, this)
    for (i in deepShortcutCount downTo 1) {                            // 倒序：rank 大的在下方
        height += shortcutHeight
        // 屏幕高度不够时截断，避免浮层超出屏幕
        if (height >= (mActivityContext?.deviceProfile?.deviceProperties?.availableHeightPx ?: 0)) break
        val v = inflateAndAdd<DeepShortcutView>(R.layout.deep_shortcut, deepShortcutContainer)
        v.layoutParams.width = containerWidth
        deepShortcuts.add(v)
    }
    updateHiddenShortcuts()                                            // 超过 MAX_SHORTCUTS=4 的隐藏
}

private fun updateHiddenShortcuts() {
    val total = deepShortcuts.size
    for (i in 0..<total) {
        val view = deepShortcuts[i]
        view.visibility = if (i >= PopupPopulator.MAX_SHORTCUTS) GONE else VISIBLE  // 仅显示前 4 条
    }
}
```

注意：`deepShortcutCount` 可能大于 4（缓存里是 app 发布的全部 shortcut 数），但实际只 inflate 4 个 View，多出来的在 `updateHiddenShortcuts` 里被 `GONE` 掉。这里用缓存 count 决定预占行数，但渲染时硬限制在 `MAX_SHORTCUTS = 4`。

### 面试深问

**Q1：为什么 deep shortcut 数量用缓存而不是实时查询？**
A：实时查询要走 `LauncherApps.getShortcuts()`，这是跨进程 binder 调用，主线程直接查会卡顿。`LauncherModel` 在后台遍历所有 app 的 shortcuts 预建 `BgDataModel.deepShortcutMap`（`ComponentKey → count`），长按时只读这个内存 map，零阻塞。真实数据（标题/图标/rank）才在 `PopupPopulator` 里异步加载。

**Q2：折叠阈值 6 是怎么定的？**
A：经验值。手机竖屏下 popup 大约能舒适显示 6 行（系统项 + deep 项合计）。超过就压缩，把可折叠的系统项变成图标行，省出垂直空间给 deep shortcut。不可折叠项（Widgets、RemoveApp）强制占整行，因为它们是高频入口。

**Q3：`deepShortcutCount` 大于 4 时会发生什么？**
A：`addDeepShortcuts` 会 inflate 出 `count` 个 View，但 `updateHiddenShortcuts` 把索引 ≥ `MAX_SHORTCUTS(4)` 的设为 `GONE`。同时 `PopupPopulator.sortAndFilterShortcuts` 在后台查询后也只返回排序后的前 4 条。所以用户最多看到 4 条，多余的 View 是浪费但有上限保护。

## 四、PopupPopulator：后台线程加载真实数据

`loadAppShortcuts` 把真正耗时的查询丢到 `MODEL_EXECUTOR`（后台线程池）：

```kotlin
// PopupContainerWithArrow.kt
private fun loadAppShortcuts(originalItemInfo: ItemInfo) {
    accessibilityPaneTitle = context.getString(R.string.action_deep_shortcut)
    originalIcon.forceHideDot = true                                   // 加载期间隐藏图标上的通知小红点
    layoutTransition = LayoutTransition()                              // 开启动画，后续逐条加入有过渡效果
    Executors.MODEL_EXECUTOR.handler.postAtFrontOfQueue(               // 排到队列最前，优先执行
        PopupPopulator.createUpdateRunnable(
            mActivityContext, originalItemInfo,
            Handler(Looper.getMainLooper()),                           // UI handler，用于回主线程刷 View
            this, deepShortcuts,
        )
    )
}
```

设计意图：**为什么异步？** `LauncherApps.getShortcuts()` 是跨进程调用，需要请求系统服务 `system_server` 查询目标 app 发布的 shortcuts，耗时不可控（可能几十毫秒）。主线程执行会卡住长按的手指反馈。所以先 `show()` 显示空行，后台查完再逐条回填。

### 4.1 createUpdateRunnable：查询 + 排序 + 回填

```java
// PopupPopulator.java
public static <T extends Context & ActivityContext> Runnable createUpdateRunnable(
        final T context,
        final ItemInfo originalInfo,
        final Handler uiHandler,
        final PopupContainerWithArrow container,
        final List<DeepShortcutView> shortcutViews) {
    final ComponentName activity = originalInfo.getTargetComponent();
    final UserHandle user = originalInfo.user;
    final String targetPackage = originalInfo.getTargetPackage();
    return () -> {
        ApplicationInfoWrapper infoWrapper =
                new ApplicationInfoWrapper(context, targetPackage, user);
        // ① 查询：向 LauncherApps 拿该 activity 的所有 published shortcuts
        List<ShortcutInfo> shortcuts = new ShortcutRequest(context, user)
                .withContainer(activity)                               // 限定 activity（图标对应的 ComponentName）
                .query(ShortcutRequest.PUBLISHED);                    // = DYNAMIC | MANIFEST
        // ② 排序 + 过滤到最多 4 条
        shortcuts = PopupPopulator.sortAndFilterShortcuts(shortcuts);
        // ③ 逐条构造 WorkspaceItemInfo + 取图标 + 回主线程刷 View
        IconCache cache = LauncherAppState.getInstance(context).getIconCache();
        for (int i = 0; i < shortcuts.size() && i < shortcutViews.size(); i++) {
            final ShortcutInfo shortcut = shortcuts.get(i);
            final WorkspaceItemInfo si = new WorkspaceItemInfo(shortcut, context); // 从 ShortcutInfo 造 ItemInfo
            cache.getShortcutIcon(si, shortcut, infoWrapper);         // 取图标（可能命中缓存）
            si.rank = i;                                               // rank = 显示顺序
            si.container = CONTAINER_SHORTCUTS;                        // 标记容器类型

            final DeepShortcutView view = shortcutViews.get(i);
            uiHandler.post(() -> view.applyShortcutInfo(si, shortcut, container, context)); // 回主线程
        }
    };
}
```

关键点：

- `query(ShortcutRequest.PUBLISHED)` 只查 DYNAMIC + MANIFEST，不查 PINNED（已固定到桌面的）。
- `WorkspaceItemInfo` 是 Launcher 内部统一的数据模型，这里把系统的 `ShortcutInfo` 转成它。
- `si.container = CONTAINER_SHORTCUTS` 标记这条数据"属于快捷菜单容器"，落库时用于区分。
- 每条独立 `uiHandler.post`，配合 `LayoutTransition` 实现逐条淡入。

### 4.2 排序与过滤规则：sortAndFilterShortcuts

```java
// PopupPopulator.java
public static final int MAX_SHORTCUTS = 4;                             // 最多显示 4 条
@VisibleForTesting
static final int NUM_DYNAMIC = 2;                                      // 至少保留 2 条 dynamic

// 比较器：manifest(static) 优先于 dynamic，同类型按 rank 升序
private static final Comparator<ShortcutInfo> SHORTCUT_RANK_COMPARATOR = (a, b) -> {
    if (a.isDeclaredInManifest() && !b.isDeclaredInManifest()) {
        return -1;                                                     // a 是 manifest → 排前
    }
    if (!a.isDeclaredInManifest() && b.isDeclaredInManifest()) {
        return 1;                                                      // b 是 manifest → a 排后
    }
    return Integer.compare(a.getRank(), b.getRank());                 // 同类型按 rank
};

public static List<ShortcutInfo> sortAndFilterShortcuts(List<ShortcutInfo> shortcuts) {
    shortcuts.sort(SHORTCUT_RANK_COMPARATOR);
    if (shortcuts.size() <= MAX_SHORTCUTS) {
        return shortcuts;                                              // ≤4 条全保留
    }

    // >4 条：先放前 4 条，再保证至少 2 条是 dynamic（挤掉 static 给 dynamic 让位）
    List<ShortcutInfo> filteredShortcuts = new ArrayList<>(MAX_SHORTCUTS);
    int numDynamic = 0;
    int size = shortcuts.size();
    for (int i = 0; i < size; i++) {
        ShortcutInfo shortcut = shortcuts.get(i);
        int filteredSize = filteredShortcuts.size();
        if (filteredSize < MAX_SHORTCUTS) {
            filteredShortcuts.add(shortcut);                           // 前 4 条直接加
            if (shortcut.isDynamic()) {
                numDynamic++;
            }
            continue;
        }
        // 已经有 4 条了，但可能全是 static。如果有 dynamic 且 dynamic 数 < 2，挤掉一个 static
        if (shortcut.isDynamic() && numDynamic < NUM_DYNAMIC) {
            numDynamic++;
            int lastStaticIndex = filteredSize - numDynamic;           // 从尾部往前找 static 的位置
            filteredShortcuts.remove(lastStaticIndex);                 // 移除一个 static
            filteredShortcuts.add(shortcut);                           // 加入 dynamic
        }
    }
    return filteredShortcuts;
}
```

规则记忆：**最多 4 条；manifest 静态优先在前（稳定，如"新标签页"）；但保证至少 2 条是 dynamic（新鲜，如"继续播放"）**。

为什么这么排？manifest shortcut 是 app 在 AndroidManifest.xml 里静态声明的，稳定不变，适合放前面当默认入口。dynamic shortcut 是 app 运行时通过 `ShortcutManager.pushDynamicShortcut` 发布的，反映用户最近行为（如"继续看这个视频"），新鲜度高但可能随时变。强制保留 2 条 dynamic 避免用户看到的永远是同一组静态项。

### 4.3 ShortcutRequest：查询的流式封装

```java
// ShortcutRequest.java
public static final int ALL = ShortcutQuery.FLAG_MATCH_DYNAMIC
        | ShortcutQuery.FLAG_MATCH_MANIFEST | ShortcutQuery.FLAG_MATCH_PINNED;  // 全部
public static final int PUBLISHED = ShortcutQuery.FLAG_MATCH_DYNAMIC
        | ShortcutQuery.FLAG_MATCH_MANIFEST;                          // 已发布（不含 pinned）
public static final int PINNED = ShortcutQuery.FLAG_MATCH_PINNED;    // 仅已固定

private final ShortcutQuery mQuery = !WIDGETS_ENABLED ? null : new ShortcutQuery(); // feature flag 关时不查

public ShortcutRequest withContainer(@Nullable ComponentName activity) {
    if (WIDGETS_ENABLED) {
        if (activity == null) {
            mFailed = true;                                            // activity 为空 → 标记失败
        } else {
            mQuery.setActivity(activity);                              // 限定查询的 activity
        }
    }
    return this;                                                       // 链式返回
}

public QueryResult query(int flags) {
    if (!WIDGETS_ENABLED || mFailed) {
        return QueryResult.DEFAULT;                                    // 返回空结果（wasSuccess=false）
    }
    mQuery.setQueryFlags(flags);
    try {
        return new QueryResult(
            mContext.getSystemService(LauncherApps.class)              // 系统服务
                .getShortcuts(mQuery, mUserHandle));                  // 跨进程查询
    } catch (SecurityException | IllegalStateException e) {
        FileLog.e(TAG, "Failed to query for shortcuts", e);
        return QueryResult.DEFAULT;                                    // 异常时返回空，不崩
    }
}
```

`QueryResult` 继承 `ArrayList<ShortcutInfo>`，额外带 `mWasSuccess` 标记，区分"真的没 shortcut"和"查询失败"。

### 面试深问

**Q1：为什么 manifest shortcut 优先于 dynamic？**
A：manifest 是 app 在 AndroidManifest.xml 静态声明的，稳定不变（如浏览器的"新标签页"），适合作为默认高频入口放前面。dynamic 是运行时推送的（如"继续播放某视频"），变化频繁。静态优先保证用户看到的菜单有稳定的骨架，dynamic 作为补充。

**Q2：sortAndFilterShortcuts 为什么不直接取前 4 条？**
A：因为排序后前 4 条可能全是 static。这样用户永远看不到 dynamic（最新的）shortcut。所以加了一条约束：遍历剩余的，如果发现有 dynamic 且当前 dynamic 数 < 2，就挤掉 filtered 列表尾部的一个 static，把 dynamic 加进去。保证至少 2 条新鲜内容。

**Q3：`postAtFrontOfQueue` 为什么不用普通 post？**
A：长按是高优先级交互，用户在等反馈。普通 `post` 排在队列尾部，如果后台有其他 Model 任务（如批量绑定）会延迟 shortcut 查询。`postAtFrontOfQueue` 把查询任务插到队首，尽快拿到数据回填。

## 五、SystemShortcut 子类体系

`SystemShortcut<T>` 是抽象类，**同时 extends `ItemInfo` 并 implements `View.OnClickListener`**——每条菜单项既是数据（图标 resId / label resId）又是点击行为。这种"数据即行为"的设计让菜单项可以作为一个完整的可点击 View 直接塞进容器。

```java
// SystemShortcut.java
public abstract class SystemShortcut<T extends ActivityContext> extends ItemInfo
        implements View.OnClickListener {
    private final int mIconResId;
    protected final int mLabelResId;
    protected int mAccessibilityActionId;
    protected final T mTarget;                                         // ActivityContext（通常是 Launcher）
    protected final ItemInfo mItemInfo;                                // 被长按的 item
    protected final View mOriginalView;                                // 被长按的 View
    protected final boolean mIsCollapsible;                            // 是否可折叠成图标

    // Factory 接口：根据 item 状态决定要不要显示这条
    public interface Factory<T extends ActivityContext> {
        @Nullable
        SystemShortcut<T> getShortcut(T context, ItemInfo itemInfo, @NonNull View originalView);
    }
}
```

### 5.1 子类清单与职责

```java
// SystemShortcut.java 内部子类
public static class Widgets<T>       extends SystemShortcut<T>  // 打开 WidgetsBottomSheet（小组件选择）
public static class AppInfo<T>       extends SystemShortcut<T>  // 跳转应用详情页（Settings）
public static class RemoveApp<T>     extends SystemShortcut<T>  // 从桌面移除（isCollapsible=false）
public static class AddToHomeScreen<T> extends SystemShortcut<T>// 从 AllApps 添加到桌面（isCollapsible=false）
public static class Install<T>       extends SystemShortcut<T>  // 安装（InstantApp / WebUI 才显示）
class InstallToPrivateProfile<T>     extends SystemShortcut<T>  // 安装到私有空间
class DontSuggestApp<T>              extends SystemShortcut<T>  // 取消推荐（仅预测项显示）
class UninstallApp<T>                extends SystemShortcut<T>  // 卸载（仅私有空间 app）
public static class BubbleShortcut<T> extends SystemShortcut<T> // 气泡（SysUI 集成）
```

### 5.2 Factory 的过滤逻辑

每个子类配一个 `Factory`，决定该 item 是否应该显示这条：

```java
// WIDGETS 工厂：app 没有任何 widget 就不显示
public static final Factory<ActivityContext> WIDGETS = (context, itemInfo, originalView) -> {
    final PackageUserKey packageUserKey = PackageUserKey.fromItemInfo(itemInfo);
    if (packageUserKey == null) return null;
    final WidgetPickerData data = context.getWidgetPickerDataProvider().get();
    if (findAllWidgetsForPackageUser(data, packageUserKey).isEmpty()) {
        return null;                                                   // 该包没有 widget → 隐藏入口
    }
    return new Widgets(context, itemInfo, originalView);
};

// ADD_TO_HOME_SCREEN 工厂：只在 AllApps 容器显示
public static final Factory<ActivityContext> ADD_TO_HOME_SCREEN =
        (activity, itemInfo, originalView) -> {
            if (itemInfo.container != CONTAINER_ALL_APPS
                    && itemInfo.container != CONTAINER_ALL_APPS_PREDICTION) {
                return null;                                           // 不在 AllApps → 不显示
            }
            return new AddToHomeScreen<>(activity, itemInfo, originalView);
        };

// PRIVATE_PROFILE_INSTALL 工厂：仅当私有空间启用且 app 未安装到该空间
public static final Factory<ActivityContext> PRIVATE_PROFILE_INSTALL = (context, itemInfo, originalView) -> {
    // ... 一系列条件判断：必须是 AppInfo、必须在 AllApps、必须是当前用户、私有空间必须启用
    // ... 且 app 未安装到私有空间、包名不在 skip 列表
    return new InstallToPrivateProfile<>(context, itemInfo, originalView, privateProfileUser);
};
```

### 5.3 点击行为示例

```java
// Widgets：打开小组件底部 sheet
public static class Widgets<T extends ActivityContext> extends SystemShortcut<T> {
    public Widgets(T target, ItemInfo itemInfo, @NonNull View originalView) {
        super(getDrawableId(), R.string.widget_button_text, target, itemInfo, originalView,
                false);                                                // isCollapsible=false，永远占整行
    }
    @Override
    public void onClick(View view) {
        AbstractFloatingView.closeAllOpenViews(mTarget);              // 先关掉其他浮层
        WidgetsBottomSheet widgetsBottomSheet =
            (WidgetsBottomSheet) mTarget.getLayoutInflater().inflate(
                R.layout.widgets_bottom_sheet, mTarget.getDragLayer(), false);
        widgetsBottomSheet.populateAndShow(mItemInfo);                 // 弹出该 app 的 widget 列表
        mTarget.getStatsLogManager().logger().withItemInfo(mItemInfo)
                .log(LAUNCHER_SYSTEM_SHORTCUT_WIDGETS_TAP);            // 埋点
    }
}

// AppInfo：跳转系统应用详情
public static class AppInfo<T extends ActivityContext> extends SystemShortcut<T> {
    @Override
    public void onClick(View view) {
        Rect sourceBounds = Utilities.getViewBounds(view);
        ActivityOptionsWrapper options = mTarget.getActivityLaunchOptions(view, mItemInfo);
        options.onEndCallback.add(this::dismissTaskMenuView);          // 动画结束关掉菜单
        PackageManagerHelper.startDetailsActivityForInfo(view.getContext(), mItemInfo,
                sourceBounds, options.toBundle());                     // 跳转 Settings 应用详情
        mTarget.getStatsLogManager().logger().withItemInfo(mItemInfo)
                .log(LAUNCHER_SYSTEM_SHORTCUT_APP_INFO_TAP);
    }
}
```

### 5.4 注册到 PopupContainer

`initializeSystemShortcut` 把 `SystemShortcut` 实例塞进 View 并设为 `OnClickListener`：

```kotlin
// PopupContainerWithArrow.kt
private fun initializeSystemShortcut(
    resId: Int,
    container: ViewGroup?,
    info: SystemShortcut<*>,
    shouldAppendSpacer: Boolean,
): View {
    val view = inflateAndAdd<View>(resId, container)
    if (view is DeepShortcutView) {
        // 占整行的：设置图标 + 文字
        info.setIconAndLabelFor(shortcutView.iconView, shortcutView.bubbleText)
    } else if (view is ImageView) {
        // 纯图标行：只设置图标 + contentDescription
        info.setIconAndContentDescriptionFor(view)
        if (shouldAppendSpacer) inflateAndAdd<View>(R.layout.system_shortcut_spacer, container)
        view.setTooltipText(view.getContentDescription())
    }
    view.tag = info                                                    // SystemShortcut 实例作为 tag
    view.setOnClickListener(info)                                      // 直接用 SystemShortcut 作为点击监听
    return view
}
```

`view.setOnClickListener(info)` 直接把 `SystemShortcut` 实例当 `OnClickListener`——因为它 implements 了该接口。点击时调它的 `onClick`，执行子类的具体逻辑。

### 面试深问

**Q1：SystemShortcut 为什么同时继承 ItemInfo 和实现 OnClickListener？**
A：为了"数据即行为"。它既需要被当作 ItemInfo（带图标/label/container，可参与 ItemInfo 体系如埋点、accessibility），又需要在被点击时执行特定逻辑。合二为一避免再写一层 adapter。`view.setOnClickListener(info)` 直接把数据对象当监听器，简洁。

**Q2：Widgets 菜单项什么时候不显示？**
A：`WIDGETS` 工厂会查 `WidgetPickerData`，如果该 app 包没有任何 widget provider，返回 null，菜单项不出现。所以纯 activity 的 app 长按不会看到"小组件"入口。

**Q3：Factory 模式在这里解决了什么问题？**
A：解耦"是否显示"和"如何实例化"。`getSupportedShortcuts` 返回的是候选 `Factory` 列表，每个 Factory 内部根据 item 状态、设备能力、flag 开关等决定是否实例化。Launcher 主类只负责提供候选集，不关心具体过滤逻辑，新增系统菜单项只需加 Factory 不改 Launcher。

## 六、从 popup 拖拽 shortcut 到桌面

浮层里的 deep shortcut 可以长按拖到桌面创建快捷方式。`PopupContainerWithArrow` 实现了 `DragSource` 和 `DragController.DragListener`，并配一个 `PopupItemDragHandler`（Launcher 下是 `LauncherPopupItemDragHandler`）。

### 6.1 DeepShortcutView.applyShortcutInfo：绑定数据 + 注册拖拽

```java
// DeepShortcutView.java
public void applyShortcutInfo(WorkspaceItemInfo info, ShortcutInfo detail,
        PopupContainerWithArrow container, ActivityContext ac) {
    mInfo = info;
    mDetail = detail;
    mBubbleText.applyFromWorkspaceItem(info);                          // 应用图标 + 文字
    mIconView.setBackground(mBubbleText.getIcon());                    // 图标 View 设置背景

    // 优先用 long label，放不下才用 short label
    CharSequence longLabel = mDetail.getLongLabel();
    int availableWidth = mBubbleText.getWidth() - mBubbleText.getTotalPaddingLeft()
            - mBubbleText.getTotalPaddingRight();
    boolean usingLongLabel = !TextUtils.isEmpty(longLabel)
            && mBubbleText.getPaint().measureText(longLabel.toString()) <= availableWidth;
    mBubbleText.setText(usingLongLabel ? longLabel : mDetail.getShortLabel());

    // ★ 点击 = 启动 shortcut，长按 = 拖拽 shortcut
    mBubbleText.setOnClickListener(container.getItemClickListener());  // 点击启动
    mBubbleText.setOnLongClickListener(container.getItemDragHandler());// 长按拖拽
    mBubbleText.setOnTouchListener(container.getItemDragHandler());    // 触摸记录位置
    if (ac instanceof Launcher launcher && isPinnable(container)) {
        setupAddButton();                                              // 显示右侧"+"按钮（一键添加）
        setAddButtonClickListener(launcher, info, container);
    }
}
```

### 6.2 LauncherPopupItemDragHandler：长按启动拖拽

```kotlin
// PopupItemDragHandler.kt
class LauncherPopupItemDragHandler(
    private val mLauncher: Launcher,
    private val mContainer: PopupContainerWithArrow<*>,
) : PopupItemDragHandler {
    private val mIconLastTouchPos: Point = Point()                     // 记录最近触摸点

    override fun onTouch(v: View, ev: MotionEvent): Boolean {
        when (ev.action) {
            MotionEvent.ACTION_DOWN, MotionEvent.ACTION_MOVE ->
                mIconLastTouchPos[ev.x.toInt()] = ev.y.toInt()        // 记录触摸坐标，供长按时对齐
        }
        return false                                                   // 不消费事件，让长按检测继续
    }

    override fun onLongClick(v: View): Boolean {
        if (!ItemLongClickListener.canStartDrag(mLauncher)) return false // 拖拽锁检查
        if (v.parent !is DeepShortcutView) return false                // 必须是 shortcut 项

        val sv = v.parent as DeepShortcutView
        sv.setWillDrawIcon(false)                                      // 隐藏原图标（拖拽中）

        // 计算图标偏移，让拖拽预览对齐手指
        val iconShift = Point()
        iconShift.x = mIconLastTouchPos.x - sv.iconCenter.x
        iconShift.y = mIconLastTouchPos.y - mLauncher.deviceProfile.workspaceIconProfile.iconSizePx

        val draggableView = DraggableView.ofType(DraggableView.DRAGGABLE_ICON)
        val itemInfo = sv.finalInfo                                    // ★ 从 DeepShortcutView 拿 WorkspaceItemInfo
        itemInfo.container = LauncherSettings.Favorites.CONTAINER_SHORTCUTS
        // 启动拖拽，用 ShortcutDragPreviewProvider 生成预览
        val dv = mLauncher.workspace.beginDragShared(
            sv.iconView, draggableView, mContainer, itemInfo,
            ShortcutDragPreviewProvider(sv.iconView, iconShift),       // 缩放到图标尺寸的预览
            DragOptions(),
        )
        dv.animateShift(-iconShift.x, -iconShift.y)                    // 动画偏移到正确位置
        closeOpenContainer(mLauncher, TYPE_FOLDER)                     // 关闭打开的文件夹
        return false
    }
}
```

### 6.3 WorkspaceItemInfo 的创建与 addToWorkspace

`DeepShortcutView.getFinalInfo()` 造一个新的 `WorkspaceItemInfo`：

```java
// DeepShortcutView.java
public WorkspaceItemInfo getFinalInfo() {
    final WorkspaceItemInfo badged = new WorkspaceItemInfo(mInfo);     // 复制一份（带 badge）
    // 后台更新 badge 图标（work profile 等）
    Launcher.getLauncher(getContext()).getModel()
            .updateAndBindWorkspaceItem(badged, mDetail);
    return badged;
}
```

拖到桌面 drop 后，`DragController` 回调 `Workspace.onDrop`，最终走 `Launcher.addPendingItem` → 落到 `CellLayout` 并在 Model 层创建 `WorkspaceItemInfo` 持久化到数据库。

还有一条"一键添加"路径：`DeepShortcutView` 右侧的"+"按钮：

```java
// DeepShortcutView.java
private void setAddButtonClickListener(Launcher launcher, WorkspaceItemInfo info,
        PopupContainerWithArrow<Launcher> container) {
    LauncherAccessibilityDelegate launcherAccessibilityDelegate = launcher.getAccessibilityDelegate();
    mAddButton.setOnClickListener(v -> {
        launcherAccessibilityDelegate.addToWorkspace(info,            // 直接添加到桌面
                /*accessibility=*/ false,
                /*finishCallback=*/ (success) -> {
                    launcher.getStatsLogManager().logger().withItemInfo(info)
                            .log(StatsLogManager.LauncherEvent.LAUNCHER_TAP_TO_ADD_DEEP_SHORTCUT);
                });
        Folder folder = AbstractFloatingView.getOpenView(launcher, TYPE_FOLDER);
        container.close(folder == null);                               // 关闭 popup
        if (folder != null) folder.close(true);
    });
}
```

### 6.4 延迟拖拽：createPreDragCondition

`PopupContainerWithArrow.createPreDragCondition` 定义"手指移动超过阈值才真正开始拖"：

```kotlin
// PopupContainerWithArrow.kt
override fun createPreDragCondition(): PreDragCondition {
    return object : PreDragCondition {
        override fun shouldStartDrag(distanceDragged: Double): Boolean {
            return distanceDragged > startDragThreshold                 // 移动超过阈值才真正拖
        }
        override fun onPreDragStart(dragObject: DragObject) {
            if (!updateIconUi) return
            if (mIsAboveIcon) {
                originalIcon.setIconVisible(false)                     // 在图标上方：只藏图标，留文字
                originalIcon.visibility = VISIBLE
            } else {
                originalIcon.visibility = INVISIBLE                    // 不在上方：全藏
            }
        }
        override fun onPreDragEnd(dragObject: DragObject, dragStarted: Boolean) {
            if (!updateIconUi) return
            originalIcon.setIconVisible(true)
            if (dragStarted) {
                originalIcon.visibility = INVISIBLE                    // 拖出去了：保持隐藏
            } else {
                if (!mIsAboveIcon) {
                    originalIcon.visibility = VISIBLE
                    originalIcon.setTextVisibility(false)               // 松手没拖出去：还原图标，藏文字
                }
            }
        }
    }
}
```

`startDragThreshold` 来自 `R.dimen.deep_shortcuts_start_drag_threshold`。设计意图：避免手指轻微抖动误触发拖拽，给用户"长按看菜单"和"长按拖走"两种意图的区分空间。

### 面试深问

**Q1：为什么拖拽期间要隐藏原图标？**
A：视觉一致性。拖拽时 `DragView` 已经携带了图标副本在手指下方，如果原图标还显示，会看到两个一样的图标（一个固定在 popup，一个跟手指），造成混乱。隐藏原图标让用户只关注跟随手指的 `DragView`。

**Q2：getFinalInfo 为什么要 new 一个新的 WorkspaceItemInfo 而不是用 mInfo？**
A：`mInfo` 是 popup 内部复用的显示数据（容器是 `CONTAINER_SHORTCUTS`）。拖到桌面要创建一个独立的、可持久化的副本，container 要改成目标 CellLayout。直接改 `mInfo` 会污染 popup 的显示状态。

**Q3：PreDragCondition 解决了什么问题？**
A：触摸事件在 ACTION_DOWN 就可能触发 DragController 的拖拽流程，但用户可能只是想长按看菜单而不想拖。`shouldStartDrag` 在手指移动距离 < 阈值时返回 false，拖拽不真正开始，popup 保持显示；超过阈值才启动拖拽。这给了用户一个"反悔窗口"。

## 七、数据来源：DeepShortcutMap

`PopupDataProvider.getShortcutCountForItem` 不是实时查询，而是从 `BgDataModel` 的缓存读：

```java
// PopupDataProvider.java
public int getShortcutCountForItem(ItemInfo info) {
    if (!ShortcutUtil.supportsDeepShortcuts(info)) {
        return 0;
    }
    ComponentName component = info.getTargetComponent();
    if (component == null) {
        return 0;
    }
    return mBgDataModel.getDeepShortcutMap()                            // 内存缓存
            .getOrDefault(new ComponentKey(component, info.user), 0);  // ComponentKey → count
}
```

`BgDataModel.deepShortcutMap` 由 `LauncherModel` 在后台遍历所有 app 的 shortcuts 预先建立（`ComponentKey → Integer count`）。这个 map 在 `PackageUpdatedTask` / `BgDataModel` 重建时刷新。

长按时的流程是两段式：
1. **同步阶段**：从缓存 map 拿 count，预占 N 个 View 行（零阻塞）。
2. **异步阶段**：`PopupPopulator` 在后台用 `ShortcutRequest` 查真实数据（标题/图标/rank），排序过滤后回主线程逐条 `applyShortcutInfo` 填充。

`PopupDataProvider` 还负责通知小红点（`NotificationRepository` 的更新流 → `updateNotificationDots` 遍历所有 BubbleTextView 刷 dot 状态），但那是通知体系，不在本文展开。

### 面试深问

**Q1：deepShortcutMap 什么时候更新？**
A：`LauncherModel` 在 `PackageUpdatedTask`（包安装/更新/卸载）、`ShortcutAvailabilityTask`（shortcut 变更广播）、`BgDataModel` 重建时会重新遍历所有 app 的 shortcuts 刷新这个 map。app 调 `ShortcutManager.pushDynamicShortcut` 后，系统会通知 Launcher，触发 map 更新。

**Q2：如果缓存 count 和实际查询数量不一致会怎样？**
A：以实际查询为准。`addDeepShortcuts` 按 count 预占 View，但 `updateHiddenShortcuts` 硬限制只显示前 `MAX_SHORTCUTS=4` 个。`PopupPopulator` 查到的真实数据也只取前 4 条。如果 count=6 但实际查到 3 条，多占的 3 个 View 会是空的（但通常 LayoutTransition 不会特别处理空 View，视觉上可能有空隙，不过实际很少发生因为缓存和查询是同一数据源）。

**Q3：PopupDataProvider 还管什么？**
A：除了 shortcut count，还管通知小红点。它订阅 `NotificationRepository.getUpdateStream()`，每当通知变更，`updateNotificationDots` 遍历 Workspace/Hotseat/AllApps/Folder 里所有 `BubbleTextView`，调 `applyDotState` 刷新角标。这是把通知和图标状态绑定的中枢。

---

# Part 2 · 小组件（AppWidget）

## 八、整体架构与核心类

```
       WidgetsFullSheet / WidgetsTwoPaneSheet / WidgetPickerActivity
                         │  (选择 widget)
                         ▼
                WidgetCell / WidgetImageView (预览)
                         │  长按开始拖
                         ▼
                PendingItemDragHelper ──startDrag──▶ DragController
                         │                              │
                  (拖拽中预加载)                        │
                WidgetHostViewLoader                    │
                         │                              ▼
                         ▼                       Workspace (drop)
                WidgetAddFlowHandler                  │
                         │  startBindFlow             │ 添加完成
                         ▼                            ▼
                LauncherWidgetHolder ←── ListenableAppWidgetHost(系统)
                         │  createView
                         ▼
                LauncherAppWidgetHostView (展示 RemoteViews)
                         │
                长按 → AppWidgetResizeFrame (调整大小)
```

| 角色 | 文件 | 职责 |
|------|------|------|
| `LauncherWidgetHolder` | `widget/LauncherWidgetHolder.java` | `AppWidgetHost` 的封装，管理 id 分配/监听/创建 View |
| `LauncherAppWidgetHost` | `widget/LauncherAppWidgetHost.java` | 具体 `AppWidgetHost` 子类，`onCreateView` 造 `LauncherAppWidgetHostView` |
| `LauncherAppWidgetHostView` | `widget/LauncherAppWidgetHostView.java` | widget 展示容器，承载 `RemoteViews` |
| `WidgetAddFlowHandler` | `widget/WidgetAddFlowHandler.java` | 单个 widget 的添加流程（绑定 + 配置） |
| `PendingAddWidgetInfo` | `widget/PendingAddWidgetInfo.java` | "待添加"widget 的元数据 |
| `PendingItemDragHelper` | `widget/PendingItemDragHelper.java` | 从 picker 拖 widget 时的拖拽预览提供者 |
| `WidgetHostViewLoader` | `widget/WidgetHostViewLoader.java` | 拖拽期间预加载（预绑定 + 预 inflate） |
| `AppWidgetResizeFrame` | `AppWidgetResizeFrame.kt` | widget 调整大小浮层（4 个拖拽点） |
| `WidgetManagerHelper` | `widget/WidgetManagerHelper.java` | 封装 `AppWidgetManager` 的绑定调用 |
| `LauncherAppWidgetProviderInfo` | `widget/LauncherAppWidgetProviderInfo.java` | `AppWidgetProviderInfo` 的 Launcher 包装（含 min/max span） |

## 九、Widget Picker（选择器）

Launcher3 有三种 widget 选择入口：

### 9.1 三种入口

1. **`WidgetsFullSheet` / `WidgetsTwoPaneSheet`**（`widget/picker/`）—— Launcher 内的全屏/双栏面板。长按桌面空白或点 popup 的"小组件"项触发 `Launcher.openWidgetPicker`：

```java
// Launcher.java#openWidgetPicker
public boolean openWidgetPicker() {
    if (getPackageManager().isSafeMode()) {
        Toast.makeText(this, R.string.safemode_widget_error, Toast.LENGTH_SHORT).show();
        return false;                                                  // 安全模式不允许加 widget
    }
    if (Flags.enableWidgetPickerRefactor() && ComposeFacade.INSTANCE.isComposeAvailable()) {
        Intent intent = new Intent(Intent.ACTION_PICK);                // 新版：独立 Activity
        intent.setPackage(asContext().getPackageName());
        asContext().startActivity(intent);
        return true;
    }
    openWidgetsFullSheet();                                            // 旧版：FullSheet
    return true;
}
```

2. **`AddItemWidgetsBottomSheet`**（`widget/AddItemWidgetsBottomSheet.java`）—— 外部 app 通过 `ACTION_APPWIDGET_BIND`（pin widget 流程，如输入法 pin 一个搜索框 widget）拉起时的底部确认 sheet。

3. **`WidgetPickerActivity`**（`widgetpicker/WidgetPickerActivity.kt`）—— 新的独立 Activity，受 `enableWidgetPickerRefactor` flag 控制，用 Compose 实现：

```kotlin
// WidgetPickerActivity.kt
override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    // ...
    if (Flags.enableWidgetPickerRefactor() && isComposeAvailable()) {
        component.widgetPickerComposeWrapper.showAllWidgets(this, widgetPickerConfig) // Compose 渲染
    }
}
```

无论哪种入口，最终都是：**用户长按某个 widget 预览 → 进入拖拽**。

### 9.2 列表加载：PackageManager.getInstalledProviders

Picker 的数据源是系统的 `AppWidgetManager.getInstalledProvidersForProfile`，由 `WidgetManagerHelper` 封装：

```java
// WidgetManagerHelper.java
public List<AppWidgetProviderInfo> getAllProviders(@Nullable PackageUserKey packageUser) {
    if (!WIDGETS_ENABLED) {
        return Collections.emptyList();
    }
    if (packageUser == null) {
        return allWidgetsSteam(mContext).collect(Collectors.toList()); // 所有用户 + 自定义 widget
    }
    try {
        return mAppWidgetManager.getInstalledProvidersForPackage(
                packageUser.mPackageName, packageUser.mUser);          // 指定包
    } catch (IllegalStateException e) {
        // 设备锁定竞态：用户解锁过程中又被锁了
        Log.e(TAG, "getAllProviders: Error getting installed providers for package=" + packageUser.mPackageName, e);
        return Collections.emptyList();
    }
}

private static Stream<AppWidgetProviderInfo> allWidgetsSteam(Context context) {
    AppWidgetManager awm = context.getSystemService(AppWidgetManager.class);
    return Stream.concat(
            UserCache.INSTANCE.get(context).getUserProfiles().stream()
                    .flatMap(u -> awm.getInstalledProvidersForProfile(u).stream()), // 每个用户 profile
            CustomWidgetManager.INSTANCE.get(context).stream());      // Launcher 自定义 widget（如搜索框）
}
```

### 9.3 拖拽预览的实现

`WidgetCell` 的预览图有三层来源，`PendingItemDragHelper.startDrag` 里决定用哪个：

```java
// PendingItemDragHelper.java
public void startDrag(Rect previewBounds, int previewBitmapWidth, int previewViewWidth,
        Point screenPos, DragSource source, DragOptions options) {
    final Launcher launcher = Launcher.getLauncher(mView.getContext());
    mEstimatedCellSize = launcher.getWorkspace().estimateItemSize(mAddInfo); // 估算落位尺寸

    if (mAddInfo instanceof PendingAddWidgetInfo) {
        PendingAddWidgetInfo createWidgetInfo = (PendingAddWidgetInfo) mAddInfo;

        if (mWidgetPreviewInfo != null) {
            if (mWidgetPreviewInfo.previewBitmap != null) {
                // ① 优先：缓存的预览位图
                preview = new RoundDrawableWrapper(new FastBitmapDrawable(mWidgetPreviewInfo.previewBitmap),
                        mEnforcedRoundedCornersForWidget);             // 包一层圆角
            } else {
                // ② 其次：用 RemoteViews 实时渲染一个预览 HostView
                mAppWidgetHostViewPreview = new LauncherAppWidgetHostView(launcher);
                mAppWidgetHostViewPreview.setAppWidget(INVALID_APPWIDGET_ID, mWidgetPreviewInfo.providerInfo);
                mAppWidgetHostViewPreview.updateAppWidget(mWidgetPreviewInfo.remoteViews);
                // measure 到目标尺寸
                Size widgetSizes = getWidgetSizePx(deviceProfile, mAddInfo.spanX, mAddInfo.spanY);
                measureAndUpdateAppWidgetHostViewScale(widgetSizes);
            }
        } else if (mRemoteViewsPreview != null) {
            // pin widget 流程传入的预览
            mAppWidgetHostViewPreview = new LauncherAppWidgetHostView(launcher);
            mAppWidgetHostViewPreview.updateAppWidget(mRemoteViewsPreview);
            // ...
        }
        // ③ 兜底：DatabaseWidgetPreviewLoader 生成预览
        if (preview == null && mAppWidgetHostViewPreview == null) {
            Drawable p = new FastBitmapDrawable(new DatabaseWidgetPreviewLoader(launcher, ...)
                    .generateWidgetPreview(createWidgetInfo.info, maxWidth, previewSizeBeforeScale));
            preview = new RoundDrawableWrapper(p, mEnforcedRoundedCornersForWidget);
        }

        scale = previewBounds.width() / (float) previewWidth;
        // ★ 关键：注册 WidgetHostViewLoader，拖拽开始时预加载 widget
        launcher.getDragController().addDragListener(new WidgetHostViewLoader(launcher, mView));

        launcher.getDragController().startDrag(
            mAppWidgetHostViewPreview != null ? mAppWidgetHostViewPreview : preview,
            DraggableView.ofType(DraggableView.DRAGGABLE_WIDGET),
            dragLayerX, dragLayerY, source, mAddInfo, dragRegion, scale, scale, options);
    } else {
        // PendingAddShortcutInfo（快捷方式/setting shortcut），走图标拖拽分支
        // ...
    }
}
```

设计意图：**预览图三层优先级**——缓存的位图（最快）> RemoteViews 实时渲染（真实）> 数据库生成（兜底）。保证拖拽跟手不卡顿，同时预览尽可能接近真实 widget。

### 面试深问

**Q1：为什么要三种 widget picker 入口？**
A：不同触发场景。FullSheet 是 Launcher 内部的传统面板（长按桌面空白触发）。AddItemBottomSheet 是外部 app 通过 pin widget 流程拉起的确认页（外部已有目标，只需用户确认）。WidgetPickerActivity 是新版 Compose 实现的独立 Activity，解耦了 picker 和 Launcher 进程，方便独立演进和测试。

**Q2：预览图为什么优先用缓存位图？**
A：RemoteViews 实时渲染需要 inflate 跨进程的视图树，有开销。缓存位图（`WidgetPreviewInfo.previewBitmap`）是之前渲染好的 Bitmap，直接用零延迟，拖拽跟手。只有缓存失效或首次加载才走 RemoteViews 或数据库生成。

**Q3：`MAX_WIDGET_SCALE = 1.25f` 是什么？**
A：预览图最大放大倍数。`maxWidth = Math.min((int)(previewBitmapWidth * MAX_WIDGET_SCALE), mEstimatedCellSize[0])`——预览图宽度不能超过"原始位图宽度的 1.25 倍"和"估算的落位 cell 宽度"中的较小者。防止预览图被放大到模糊或超过实际占位。

## 十、添加 Widget 到桌面：完整流程

这是本文最核心的部分，分四步：**拖拽预览 → 预加载绑定 → drop 落位 → 配置**。

### 10.1 步骤一：开始拖拽（PendingItemDragHelper）

见上文 9.3 节。关键产出：构造拖拽预览 + 注册 `WidgetHostViewLoader` + 启动 `DragController.startDrag`。

### 10.2 步骤二：拖拽期间预加载（WidgetHostViewLoader）

这是体验优化的精髓。`WidgetHostViewLoader` 是 `DragController.DragListener`，在 `onDragStart` 立刻开始**预绑定 + 预 inflate**，把耗时操作藏进用户拖拽的时间：

```java
// WidgetHostViewLoader.java
public class WidgetHostViewLoader implements DragController.DragListener {
    @Thunk int mWidgetLoadingId = -1;                                  // 预分配的 widget id，-1 表示无效

    public WidgetHostViewLoader(Launcher launcher, View view) {
        mLauncher = launcher;
        mHandler = new Handler();
        mView = view;
        mInfo = (PendingAddWidgetInfo) view.getTag();                  // 从 View tag 拿待添加信息
    }

    @Override
    public void onDragStart(DropTarget.DragObject dragObject, DragOptions options) {
        preloadWidget();                                               // ★ 拖拽一开始就预加载
    }

    private boolean preloadWidget() {
        final LauncherAppWidgetProviderInfo pInfo = mInfo.info;
        if (pInfo.isCustomWidget()) {
            return false;                                              // 自定义 widget 不走系统绑定
        }
        final Bundle options = mInfo.getDefaultSizeOptions(mLauncher); // 默认尺寸 options

        // ★ 如果 widget 需要配置 Activity，不预加载（等用户配完再绑）
        if (mInfo.getHandler().needsConfigure()) {
            mInfo.bindOptions = options;                               // 暂存 options，配置后再用
            return false;
        }

        // ① 分配 widget id 并绑定到 provider
        mBindWidgetRunnable = new Runnable() {
            @Override
            public void run() {
                mWidgetLoadingId = mLauncher.getAppWidgetHolder().allocateAppWidgetId(); // 分配 id
                if (new WidgetManagerHelper(mLauncher).bindAppWidgetIdIfAllowed(
                        mWidgetLoadingId, pInfo, options)) {           // 尝试绑定（需权限）
                    mHandler.post(mInflateWidgetRunnable);             // 绑定成功 → inflate
                }
            }
        };

        // ② inflate 出 HostView，加到 DragLayer（暂时不可见）
        mInflateWidgetRunnable = new Runnable() {
            @Override
            public void run() {
                if (mWidgetLoadingId == -1) {
                    return;                                            // id 已被消费或取消
                }
                AppWidgetHostView hostView = mLauncher.getAppWidgetHolder().createView(
                        mWidgetLoadingId, pInfo);                      // 创建 HostView
                mInfo.boundWidget = hostView;                          // ★ 存到 PendingAddWidgetInfo，drop 时复用
                mWidgetLoadingId = -1;                                 // id 已用，标记无效

                hostView.setVisibility(View.INVISIBLE);                // 先不可见
                int[] unScaledSize = mLauncher.getWorkspace().estimateItemSize(mInfo); // 估算尺寸
                DragLayer.LayoutParams lp = new DragLayer.LayoutParams(unScaledSize[0], unScaledSize[1]);
                lp.x = lp.y = 0;
                lp.customPosition = true;                              // 手动定位
                hostView.setLayoutParams(lp);
                mLauncher.getDragLayer().addView(hostView);            // 加到 DragLayer（不可见）
                mView.setTag(mInfo);                                   // 回写 tag
            }
        };

        mHandler.post(mBindWidgetRunnable);                            // 启动绑定链
        return true;
    }

    // 拖拽结束（drop 或取消）时清理
    @Override
    public void onDragEnd() {
        mLauncher.getDragController().removeDragListener(this);
        mHandler.removeCallbacks(mBindWidgetRunnable);                 // 移除未执行的绑定
        mHandler.removeCallbacks(mInflateWidgetRunnable);

        // 清理未消费的 widget id
        if (mWidgetLoadingId != -1) {
            mLauncher.getAppWidgetHolder().deleteAppWidgetId(mWidgetLoadingId); // 回收 id
            mWidgetLoadingId = -1;
        }
        // 清理已 inflate 但没被 drop 用的 HostView
        if (mInfo.boundWidget != null) {
            mLauncher.getDragLayer().removeView(mInfo.boundWidget);    // 从 DragLayer 移除
            mLauncher.getAppWidgetHolder().deleteAppWidgetId(mInfo.boundWidget.getAppWidgetId()); // 回收 id
            mInfo.boundWidget = null;
        }
    }
}
```

**为什么预加载？** widget 的"分配 id → 跨进程绑定 provider → inflate RemoteViews"涉及多次 binder 调用和跨进程视图渲染，总耗时可能上百毫秒。如果等用户松手 drop 后才开始，会看到明显白屏等待。`WidgetHostViewLoader` 利用用户拖拽这段时间并行完成这些操作，松手时 widget 已准备好，几乎瞬间显示。

**为什么 needsConfigure 时不预加载？** 配置 Activity 可能让用户改变 widget 的尺寸/内容（如时钟选城市），预绑定后用户再配置会导致已绑定的 RemoteViews 作废，浪费。所以需要配置的 widget 等 drop 后走标准流程。

**取消时的回收**：`onDragEnd` 检查 `mWidgetLoadingId` 和 `mInfo.boundWidget`，如果有未消费的 id 或已 inflate 但没用的 HostView，调 `deleteAppWidgetId` 回收，避免资源泄漏（widget id 是系统级资源，不回收会占名额）。

### 10.3 步骤三：Drop 落位与数据绑定

松手 drop 到 Workspace 后，走 `Launcher.addPendingItem` → `addAppWidgetFromDrop`：

```java
// Launcher.java
public void addPendingItem(PendingAddItemInfo info, int container, int screenId,
        int[] cell, int spanX, int spanY) {
    // ... 设置 cell/screen/span
    if (info instanceof PendingAddWidgetInfo) {
        addAppWidgetFromDrop((PendingAddWidgetInfo) info);             // widget 分支
    } else {
        processShortcutFromDrop((PendingAddShortcutInfo) info);        // shortcut 分支
    }
}

private void addAppWidgetFromDrop(PendingAddWidgetInfo info) {
    AppWidgetHostView hostView = info.boundWidget;                     // 预加载阶段 inflate 的 HostView
    final int appWidgetId;
    WidgetAddFlowHandler addFlowHandler = info.getHandler();
    if (hostView != null) {
        // ★ 预绑定成功：直接复用预加载的 HostView
        getDragLayer().removeView(hostView);                           // 从 DragLayer 移除（要加到 Workspace 了）
        appWidgetId = hostView.getAppWidgetId();
        addAppWidgetFromDropImpl(appWidgetId, info, hostView, addFlowHandler);
        info.boundWidget = null;                                       // 清空，避免 onDragEnd 误删
    } else {
        // 未预绑定（需要配置或绑定失败）：走标准绑定流程
        if (info.itemType == LauncherSettings.Favorites.ITEM_TYPE_CUSTOM_APPWIDGET) {
            appWidgetId = CustomWidgetManager.INSTANCE.get(this).allocateCustomAppWidgetId(info.componentName);
        } else {
            appWidgetId = getAppWidgetHolder().allocateAppWidgetId();  // 现场分配 id
        }
        Bundle options = info.bindOptions;
        boolean success = mAppWidgetManager.bindAppWidgetIdIfAllowed(appWidgetId, info.info, options);
        if (success) {
            addAppWidgetFromDropImpl(appWidgetId, info, null, addFlowHandler); // 绑定成功 → 直接加
        } else {
            // 绑定需用户授权 → 弹绑定确认
            addFlowHandler.startBindFlow(this, appWidgetId, info, REQUEST_BIND_APPWIDGET);
        }
    }
}
```

`addAppWidgetFromDropImpl` → `addAppWidgetImpl`：

```java
// Launcher.java
void addAppWidgetImpl(int appWidgetId, ItemInfo info,
        AppWidgetHostView boundWidget, WidgetAddFlowHandler addFlowHandler, int delay) {
    // 如果需要配置 Activity，启动它
    final boolean isActivityStarted = addFlowHandler.startConfigActivity(
            this, appWidgetId, info, REQUEST_CREATE_APPWIDGET);

    // ... 提取 drop 动画的预览 bitmap
    completeAddAppWidget(appWidgetId, info, boundWidget,
            addFlowHandler.getProviderInfo(this), addFlowHandler.needsConfigure(), false, widgetPreviewBitmap);
    if (!isActivityStarted) {
        mWorkspace.removeExtraEmptyScreenDelayed(delay, false, onComplete); // 移除拖拽时多出来的空屏
    }
}
```

`completeAddAppWidget`（在 Launcher.java，较长）最终在 Model 层创建 `LauncherAppWidgetInfo`，持久化到数据库，并把 HostView add 到对应 CellLayout。

### 10.4 步骤四：绑定授权与配置

**绑定授权**（`startBindFlow`）：首次添加某 provider 的 widget 时，系统可能要求用户确认（取决于 app 是否有 `BIND_APPWIDGET` 权限）：

```java
// LauncherWidgetHolder.java
public void startBindFlow(@NonNull BaseActivity activity,
        int appWidgetId, @NonNull AppWidgetProviderInfo info, int requestCode) {
    if (!WIDGETS_ENABLED) {
        sendActionCancelled(activity, requestCode);
        return;
    }
    Intent intent = new Intent(AppWidgetManager.ACTION_APPWIDGET_BIND)  // 系统绑定确认 Intent
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_PROVIDER, info.provider)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_PROVIDER_PROFILE, info.getProfile());
    activity.startActivityForResult(intent, requestCode);              // 弹系统确认框
}
```

**配置 Activity**（`startConfigActivity`）：如果 widget 声明了 `configure` 且非 optional：

```java
// WidgetAddFlowHandler.java
public boolean needsConfigure() {
    int featureFlags = mProviderInfo.widgetFeatures;
    // 配置可选的条件：标记为 OPTIONAL 且标记为 RECONFIGURABLE（可后续再配）
    boolean configurationOptional = (featureFlags & WIDGET_FEATURE_CONFIGURATION_OPTIONAL) != 0
            && (featureFlags & WIDGET_FEATURE_RECONFIGURABLE) != 0;
    return mProviderInfo.configure != null && !configurationOptional;  // 有 configure 且非可选 → 必须配
}

public boolean startConfigActivity(Launcher launcher, int appWidgetId, ItemInfo info, int requestCode) {
    if (!needsConfigure()) {
        return false;                                                  // 不需要配置
    }
    launchConfigActivity(launcher, appWidgetId, info, requestCode);
    return true;
}

private void launchConfigActivity(Launcher launcher, int appWidgetId, ItemInfo info, int requestCode) {
    launcher.setWaitingForResult(PendingRequestArgs.forWidgetInfo(appWidgetId, this, info));
    launcher.getAppWidgetHolder().startConfigActivity(launcher, appWidgetId, requestCode); // 启动配置页
}
```

配置完成后回调 `Launcher.onActivityResult` → `completeTwoStageWidgetDrop`：

```java
// Launcher.java
void completeTwoStageWidgetDrop(final int resultCode, final int appWidgetId, final PendingRequestArgs requestArgs) {
    CellLayout cellLayout = mWorkspace.getScreenWithId(
            getCellPosMapper().mapModelToPresenter(requestArgs).screenId);
    Runnable onCompleteRunnable = null;
    AppWidgetHostView boundWidget = null;
    if (resultCode == RESULT_OK) {
        // 配置成功：拿到 HostView，真正 add 到 Workspace
        final AppWidgetHostView layout = getWorkspace().getWidgetForAppWidgetId(appWidgetId);
        boundWidget = layout;
        onCompleteRunnable = () -> {
            completeAddAppWidget(appWidgetId, requestArgs, layout, null, false, true, null);
            if (!isInState(EDIT_MODE)) {
                mStateManager.goToState(NORMAL, SPRING_LOADED_EXIT_DELAY); // 退出编辑模式
            }
        };
    } else if (resultCode == RESULT_CANCELED) {
        mAppWidgetHolder.deleteAppWidgetId(appWidgetId);               // 取消：回收 id
        animationType = Workspace.CANCEL_TWO_STAGE_WIDGET_DROP_ANIMATION;
    }
    // ... 播放动画
}
```

### 面试深问

**Q1：WidgetHostViewLoader 预加载的 HostView 怎么和 drop 关联？**
A：通过 `PendingAddWidgetInfo.boundWidget` 字段。预加载 inflate 出 HostView 后存到 `mInfo.boundWidget`，而 `mInfo` 就是拖拽携带的 `PendingAddWidgetInfo`（作为 DragObject 的 tag）。drop 时 `addAppWidgetFromDrop` 从 `info.boundWidget` 取出预加载的 HostView 复用，不用重新创建。如果 `boundWidget == null`（未预加载或取消过），才现场分配 id + 绑定。

**Q2：为什么 needsConfigure 的 widget 不预加载？**
A：配置 Activity 可能改变 widget 的最终内容/尺寸（如天气 widget 选城市后布局不同）。预绑定后配置会导致已绑定的 RemoteViews 被覆盖，浪费一次跨进程绑定。所以需要配置的 widget 等 drop 后走标准流程：先 add 占位，配置完成回调里再绑定真实 RemoteViews。

**Q3：drop 失败（拖到无效区域）时预加载的资源怎么回收？**
A：`WidgetHostViewLoader.onDragEnd` 负责。它检查 `mWidgetLoadingId`（未消费的 id）和 `mInfo.boundWidget`（已 inflate 未用的 HostView），分别调 `deleteAppWidgetId` 回收并 `removeView`。保证不泄漏系统 widget id 名额。

## 十一、Widget 的数据绑定机制

### 11.1 AppWidgetHost / HostView 体系

Launcher3 不直接操作 `AppWidgetManager`，而是经由自己的 holder 链：

```
LauncherWidgetHolder  ──持有──▶  LauncherAppWidgetHost (extends ListenableAppWidgetHost extends AppWidgetHost)
     │                                    │ onCreateView()
     │ mViews (SparseArray<id→view>)      ▼
     │                          LauncherAppWidgetHostView (extends BaseLauncherAppWidgetHostView)
     │                                    │ updateAppWidget(RemoteViews)
     ▼                                    ▼
  分配/删除 id                       承载并渲染 RemoteViews
```

`LauncherAppWidgetHost` 是具体的 `AppWidgetHost` 子类，核心是 `onCreateView`：

```java
// LauncherAppWidgetHost.java
class LauncherAppWidgetHost extends ListenableAppWidgetHost {
    @Nullable
    private ListenableHostView mViewToRecycle;                         // 待回收复用的 View

    @Override
    @NonNull
    public LauncherAppWidgetHostView onCreateView(Context context, int appWidgetId,
            AppWidgetProviderInfo appWidget) {
        // ★ 如果有可回收的 View，复用；否则新建
        ListenableHostView result =
                mViewToRecycle != null ? mViewToRecycle : new ListenableHostView(context);
        mViewToRecycle = null;                                         // 用完清空
        return result;
    }

    public void recycleViewForNextCreation(ListenableHostView viewToRecycle) {
        mViewToRecycle = viewToRecycle;                                // 存起来下次 onCreateView 复用
    }
}
```

设计意图：`onCreateView` 是系统 `AppWidgetHost` 的回调，每次 `createView` 时触发。回收机制避免重复 inflate 新 View 对象，在配置 Activity 往返时复用已有 View。

### 11.2 LauncherWidgetHolder：核心封装

`LauncherWidgetHolder`（`widget/LauncherWidgetHolder.java`）是 `AppWidgetHost` 的封装层，职责包括：

- **id 管理**：`allocateAppWidgetId()` / `deleteAppWidgetId(id)`
- **监听生命周期**：`startListening()` / `stopListening()`
- **创建 View**：`createView(appWidgetId, providerInfo)`
- **绑定/配置入口**：`startBindFlow` / `startConfigActivity`
- **省电监听**：三 flag 组合决定是否监听

```java
// LauncherWidgetHolder.java
public static final int APPWIDGET_HOST_ID = 1024;                      // Launcher 的 host id（固定）

protected static final int FLAG_LISTENING = 1;                         // 正在监听
protected static final int FLAG_STATE_IS_NORMAL = 1 << 1;              // Launcher 处于 NORMAL 状态
protected static final int FLAG_ACTIVITY_STARTED = 1 << 2;             // Activity 已 start
protected static final int FLAG_ACTIVITY_RESUMED = 1 << 3;             // Activity 已 resume

// 三个 flag 都 on 才应该监听
private static final int FLAGS_SHOULD_LISTEN =
        FLAG_STATE_IS_NORMAL | FLAG_ACTIVITY_STARTED | FLAG_ACTIVITY_RESUMED;

protected AtomicInteger mFlags = new AtomicInteger(FLAG_STATE_IS_NORMAL); // 初始只有 NORMAL

public int allocateAppWidgetId() {
    if (!WIDGETS_ENABLED) {
        return INVALID_APPWIDGET_ID;
    }
    return mWidgetHost.allocateAppWidgetId();                          // 委托给系统 AppWidgetHost
}

public AppWidgetHostView createView(int appWidgetId, LauncherAppWidgetProviderInfo appWidget) {
    if (appWidget.isCustomWidget()) {
        // Launcher 自定义 widget（如搜索框），不走系统绑定
        LauncherAppWidgetHostView lahv = new LauncherAppWidgetHostView(mContext);
        lahv.setAppWidget(INVALID_APPWIDGET_ID, appWidget);
        CustomWidgetManager.INSTANCE.get(mContext).onViewCreated(lahv);
        return lahv;
    }
    LauncherAppWidgetHostView view = createViewInternal(appWidgetId, appWidget);
    if (mOnViewCreationCallback != null) mOnViewCreationCallback.accept(view);
    // 只在主线程更新 mViews（holder 非线程安全）
    if (Looper.myLooper() == Looper.getMainLooper()) {
        mViews.put(appWidgetId, view);                                 // 缓存 id → view
    }
    return view;
}

protected LauncherAppWidgetHostView createViewInternal(
        int appWidgetId, LauncherAppWidgetProviderInfo appWidget) {
    if ((mFlags.get() & FLAG_LISTENING) == 0) {
        // ★ 还没开始监听：无法跨进程拿 RemoteViews → 先放占位 View
        return new PendingAppWidgetHostView(mContext, this, appWidgetId, appWidget);
    } else {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            // 后台线程调用：返回占位，主线程再 attach
            ListenableHostView hostView = new ListenableHostView(mContext);
            hostView.setAppWidget(appWidgetId, appWidget);
            return hostView;
        }
        try {
            return (LauncherAppWidgetHostView) mWidgetHost.createView(
                    mContext, appWidgetId, appWidget);                 // 系统调用，拿真实 RemoteViews
        } catch (Exception e) {
            if (!Utilities.isBinderSizeError(e)) {
                throw new RuntimeException(e);
            }
            // Binder 数据过大：保留旧 view，等下次更新
            LauncherAppWidgetHostView view = mViews.get(appWidgetId);
            if (view == null) {
                view = new ListenableHostView(mContext);
            }
            view.setAppWidget(appWidgetId, appWidget);
            view.switchToErrorView();                                  // 显示错误态
            return view;
        }
    }
}
```

### 11.3 监听时机（省电设计）

`setShouldListenFlag` 用 `AtomicInteger` 维护三个 flag，只有全 on 才 `startListening`：

```java
// LauncherWidgetHolder.java
@VisibleForTesting
void setShouldListenFlag(int flag, boolean on) {
    if (on) {
        mFlags.updateAndGet(old -> old | flag);                        // 置位
    } else {
        mFlags.updateAndGet(old -> old & ~flag);                       // 清位
    }

    final boolean listening = isListening();
    int currentFlag = mFlags.get();
    if (!listening && shouldListen(currentFlag)) {
        // 三个 flag 都 on 且当前没监听 → 开始监听
        startListening();
    } else if (listening && (currentFlag & FLAG_ACTIVITY_STARTED) == 0) {
        // Activity stop 了 → 停止监听
        stopListening();
    }
}

protected boolean shouldListen(int flags) {
    return (flags & FLAGS_SHOULD_LISTEN) == FLAGS_SHOULD_LIST;         // 全 on 才 true
}

public void startListening() {
    if (!WIDGETS_ENABLED) {
        return;
    }
    getWidgetHolderExecutor().execute(() -> {
        try {
            mWidgetHost.startListening();                              // 系统调用，开始接收 RemoteViews 推送
        } catch (Exception e) {
            if (!Utilities.isBinderSizeError(e)) {
                throw new RuntimeException(e);
            }
            // Binder 数据过大容忍：监听关系已建立，bind 时再补
        }
        setListeningFlag(true);
        MAIN_EXECUTOR.execute(this::updateDeferredView);               // 主线程刷新延迟的 View
    });
}

// 更新延迟的 View（之前用 PendingAppWidgetHostView 占位的）
protected void updateDeferredView() {
    for (int i = mViews.size() - 1; i >= 0; i--) {                     // 倒序遍历
        LauncherAppWidgetHostView view = mViews.valueAt(i);
        if (view instanceof PendingAppWidgetHostView pv) {
            pv.reInflate();                                            // 重新 inflate 真实内容
        }
    }
}
```

Launcher 在不同生命周期调对应方法：

```java
// Launcher.java（简化）
@Override
protected void onStart() {
    super.onStart();
    mAppWidgetHolder.setActivityStarted(true);                         // FLAG_ACTIVITY_STARTED on
}
@Override
protected void onStop() {
    super.onStop();
    mAppWidgetHolder.setActivityStarted(false);                        // FLAG_ACTIVITY_STARTED off → 停止监听
}
@Override
protected void onDeferredResumed() {
    // ...
    mAppWidgetHolder.setActivityResumed(true);                         // FLAG_ACTIVITY_RESUMED on
}
// 状态切换时：mAppWidgetHolder.setStateIsNormal(state == NORMAL)
```

设计意图：Launcher 不可见（onStop）、处于 AllApps/OVERVIEW（非 NORMAL）、或未 resume 时，widget host 不监听系统更新，省电省内存。恢复到 NORMAL + resumed + started 时才重新 `startListening`，并用 `updateDeferredView` 把期间用 `PendingAppWidgetHostView` 占位的 widget 重新 inflate。

### 11.4 LauncherAppWidgetProviderInfo：min/max span 的计算

`LauncherAppWidgetProviderInfo` 是 `AppWidgetProviderInfo` 的 Launcher 包装，多了 `spanX/spanY/minSpanX/minSpanY/maxSpanX/maxSpanY`（格数）：

```java
// LauncherAppWidgetProviderInfo.java
public void initSpans(Context context, InvariantDeviceProfile idp) {
    int minSpanX = 0, minSpanY = 0;
    int maxSpanX = idp.numColumns;                                     // 默认最大 = 网格列数
    int maxSpanY = idp.numRows;                                        // 默认最大 = 网格行数
    int spanX = 0, spanY = 0;

    Point cellSize = new Point();
    for (DeviceProfile dp : idp.supportedProfiles) {                   // 遍历所有支持的设备 profile
        cellSize = dp.getWorkspaceIconProfile().getCellSize();
        Rect widgetPadding = dp.widgetPadding;

        // minSpan 由 minResizeWidth/Height 决定（widget 声明的最小尺寸）
        minSpanX = Math.max(minSpanX,
                getSpanX(widgetPadding, minResizeWidth, borderSpace.x, cellSize.x));
        minSpanY = Math.max(minSpanY,
                getSpanY(widgetPadding, minResizeHeight, borderSpace.y, cellSize.y));

        // maxSpan 由 maxResizeWidth/Height 决定（>0 时才限制）
        if (maxResizeWidth > 0) {
            maxSpanX = Math.min(maxSpanX,
                    getSpanX(widgetPadding, maxResizeWidth, borderSpace.x, cellSize.x));
        }
        if (maxResizeHeight > 0) {
            maxSpanY = Math.min(maxSpanY,
                    getSpanY(widgetPadding, maxResizeHeight, borderSpace.y, cellSize.y));
        }

        // 默认 span 由 minWidth/Height 决定
        spanX = Math.max(spanX,
                getSpanX(widgetPadding, minWidth, borderSpace.x, cellSize.x));
        spanY = Math.max(spanY,
                getSpanY(widgetPadding, minHeight, borderSpace.y, cellSize.y));
    }

    // 保证 maxSpan >= minSpan
    maxSpanX = Math.max(maxSpanX, minSpanX);
    maxSpanY = Math.max(maxSpanY, minSpanY);

    // 如果声明了 targetCellWidth/Height 且在 min/max 范围内，优先用 target
    if (targetCellWidth >= minSpanX && targetCellWidth <= maxSpanX
            && targetCellHeight >= minSpanY && targetCellHeight <= maxSpanY) {
        spanX = targetCellWidth;
        spanY = targetCellHeight;
    }

    this.minSpanX = Math.min(spanX, minSpanX);                         // 如果 minSpan > span，用 span
    this.minSpanY = Math.min(spanY, minSpanY);
    this.maxSpanX = maxSpanX;
    this.maxSpanY = maxSpanY;
    this.spanX = Math.min(spanX, idp.numColumns);                      // 不超过网格列数
    this.spanY = Math.min(spanY, idp.numRows);                         // 不超过网格行数
}

// 像素 → 格数换算：解方程 n*cellSize + (n-1)*cellSpacing - padding = widgetSize
private int getSpan(int widgetPadding, int widgetSize, int cellSpacing, float cellSize) {
    return Math.max(1, (int) Math.ceil(
            (widgetSize + widgetPadding + cellSpacing) / (cellSize + cellSpacing)));
}
```

`getSpan` 是核心换算公式：widget 的像素尺寸 `widgetSize` 加上 padding 和 spacing，除以单格尺寸加间距，向上取整得到格数。这和 `AppWidgetResizeFrame` 里的换算是同一套逻辑。

### 11.5 RemoteViews 更新流程

provider 进程调 `AppWidgetManager.updateAppWidget` 后，系统 `system_server` 把 RemoteViews 通过 binder 推给 host 进程。`AppWidgetHost`（系统类）接收后调 `onUpdateWidget` → 最终调到 `LauncherAppWidgetHostView.updateAppWidget(remoteViews)`，它 inflate RemoteViews 成真实 View 树并替换显示。

`ListenableHostView` 提供了 `addUpdateListener` 机制，允许注册回调监听每次更新（用于 picker 预览的实时刷新等）。

### 面试深问

**Q1：为什么 host id 固定是 1024？**
A：`APPWIDGET_HOST_ID = 1024` 是 Launcher 在系统的唯一标识。系统用这个 id 区分不同 host（Launcher、第三方桌面、taskbar 等）。固定值保证 Launcher 重启后能找回之前绑定的 widget id。如果每次启动用随机 id，之前的绑定关系会丢失。

**Q2：为什么 createView 时要判断是否在主线程？**
A：`mViews` 是 `SparseArray`，非线程安全。后台线程调用 `createView`（如预加载）时不能直接 put 到 `mViews`，否则和主线程并发修改崩溃。所以后台线程返回占位 `ListenableHostView`，主线程再通过 `attachViewToHostAndGetAttachedView` 正式注册到 `mViews`。

**Q3：监听状态的三 flag 为什么用 AtomicInteger？**
A：三个 flag（NORMAL/STARTED/RESUMED）可能从不同线程/回调设置（如状态机切换在主线程，Activity 生命周期可能在 binder 回调）。`AtomicInteger` 的 `updateAndGet` 保证读-改-写的原子性，避免并发下 flag 丢失。比 synchronized 轻量。

## 十二、Widget 调整大小（AppWidgetResizeFrame）

长按已放置的 widget 显示带四个拖拽圆点的浮层 `AppWidgetResizeFrame`，支持上下左右四个方向缩放。这是本文算法最密集的部分。

### 12.1 显示与初始化

```kotlin
// AppWidgetResizeFrame.kt
companion object {
    private const val SNAP_DURATION_MS = 150                            // 吸附动画时长
    private const val DIMMED_ALPHA = 0f                                // 非激活 handle 的透明度
    private const val VISIBLE_ALPHA = 1f                               // 激活 handle 的透明度
    private const val RESIZE_THRESHOLD = 0.66f                         // ★ 格数变化阈值（核心）
    private const val CELL_LAYOUT_INVALID_RESIZE_MAX_ALPHA = 0.5f      // 双面板越界时兄弟面板最低透明度

    @JvmStatic
    fun showForWidget(widget: LauncherAppWidgetHostView?, cellLayout: CellLayout) {
        if (widget == null || widget.parent == null) return             // widget 不在视图树里无法定位

        val activityContext = cellLayout.mActivity
        val dragLayer = activityContext.dragLayer as DragLayer
        closeAllOpenViewsExcept(activityContext, TYPE_ACTION_POPUP)     // 关掉其他浮层

        val frame = activityContext.layoutInflater.inflate(
                R.layout.app_widget_resize_frame, dragLayer, false) as AppWidgetResizeFrame
        frame.apply {
            setupForWidget(widget, cellLayout, dragLayer)
            tag = widget.tag                                           // 保存 widget info 给 accessibility
            accessibilityDelegate = activityContext.accessibilityDelegate
            (layoutParams as BaseDragLayer.LayoutParams).customPosition = true
        }
        dragLayer.addView(frame)
        frame.mIsOpen = true
        frame.post { frame.snapToWidget(false) }                       // 贴合 widget 边界（无动画）
    }

    // 像素 → 格数变化的判定函数（核心）
    private fun getSpanIncrement(deltaFrac: Float): Int {
        return if (abs(deltaFrac.toDouble()) > RESIZE_THRESHOLD) {     // 超过 0.66 格才算一整格
            Math.round(deltaFrac)                                      // 四舍五入到最近的整数
        } else {
            0                                                          // 不足 0.66 格 → 不变
        }
    }

    // 根据 resizeMode 判断是否启用某方向
    private fun AppWidgetProviderInfo.hasHorizontalResizeModeEnabled() =
        resizeMode and AppWidgetProviderInfo.RESIZE_HORIZONTAL != 0
    private fun AppWidgetProviderInfo.hasVerticalResizeModeEnabled() =
        resizeMode and AppWidgetProviderInfo.RESIZE_VERTICAL != 0
}
```

`resizeMode` 由 widget provider 在 `AppWidgetProviderInfo` 声明：`RESIZE_HORIZONTAL` / `RESIZE_VERTICAL` / `RESIZE_BOTH` / `RESIZE_NONE`。

### 12.2 setupForWidget：读约束边界

```kotlin
// AppWidgetResizeFrame.kt
private fun setupForWidget(
    widgetView: LauncherAppWidgetHostView,
    cellLayout: CellLayout,
    dragLayer: DragLayer,
) {
    this.cellLayout = cellLayout
    this.widgetView = widgetView
    val info = widgetView.appWidgetInfo as LauncherAppWidgetProviderInfo
    this.dragLayer = dragLayer

    // ★ 从 providerInfo 读 min/max span，这是约束边界
    minHSpan = info.minSpanX                                            // 最小水平格数
    minVSpan = info.minSpanY                                            // 最小垂直格数
    maxHSpan = info.maxSpanX                                            // 最大水平格数
    maxVSpan = info.maxSpanY                                            // 最大垂直格数

    val widgetInfoOnView = this.widgetView.tag as LauncherAppWidgetInfo
    val idp = getIDP(cellLayout.context)

    // 根据 resizeMode + min/max span + 网格尺寸，决定显示哪些 handle
    updateResizeHandlesForGrid(
        currentSpanX = widgetInfoOnView.spanX,
        currentSpanY = widgetInfoOnView.spanY,
        info = info,
        numRows = idp.numRows,
        numColumns = idp.numColumns,
    )

    if (!Flags.homeScreenEditImprovements() && info.isReconfigurable) {
        initializeReconfigureButton()                                   // 显示"重新配置"按钮
    }

    initializeWidgetViewLayoutParams(widgetInfoOnView)

    // ★ 暂时把 widget 占用的 cell 标记为"未占用"，resize 时让其他图标让位
    this.cellLayout.markCellsAsUnoccupiedForView(this.widgetView)
    // ...
}

// 根据约束决定 handle 显示
private fun updateResizeHandlesForGrid(
    currentSpanX: Int, currentSpanY: Int,
    info: LauncherAppWidgetProviderInfo,
    numRows: Int, numColumns: Int,
) {
    val isWidgetVSpanInvalid = currentSpanY < minVSpan                  // 字体/显示变化导致 span 失效
    val isWidgetHSpanInvalid = currentSpanX < minHSpan

    // 垂直方向可调条件：声明了 VERTICAL resize + (min<网格行数 且 max>1 且 min<max) 或 span 失效
    verticalResizeActive =
        info.hasVerticalResizeModeEnabled() &&
            ((minVSpan < numRows && maxVSpan > 1 && minVSpan < maxVSpan) || isWidgetVSpanInvalid)
    if (!verticalResizeActive) {
        dragHandles.top.visibility = GONE
        dragHandles.bottom.visibility = GONE
    }

    horizontalResizeActive =
        info.hasHorizontalResizeModeEnabled() &&
            ((minHSpan < numColumns && maxHSpan > 1 && minHSpan < maxHSpan) || isWidgetHSpanInvalid)
    if (!horizontalResizeActive) {
        dragHandles.left.visibility = GONE
        dragHandles.right.visibility = GONE
    }
}
```

设计意图：**为什么用格数不用像素？** Launcher 的网格是抽象单位，不同设备密度/字号下单格像素不同。用格数（span）作为约束边界，widget 的 min/max span 在 `initSpans` 时已换算成当前设备的格数，resize 时直接比较格数，与屏幕密度无关，保证一致性。`markCellsAsUnoccupiedForView` 是关键——先把 widget 当前占的格子释放，resize 过程中 `CellLayout.createAreaForResize` 才能重新计算排布，让其他图标实时让位。

### 12.3 触摸 → 识别方向 → 计算增量

```kotlin
// AppWidgetResizeFrame.kt
override fun onControllerTouchEvent(ev: MotionEvent): Boolean {
    val action = ev.action
    val x = ev.x.toInt()
    val y = ev.y.toInt()
    when (action) {
        MotionEvent.ACTION_DOWN -> return handleTouchDown(ev)           // 识别抓的是哪个边
        MotionEvent.ACTION_MOVE -> {
            closePopupIfOpen()
            visualizeResizeForDelta(deltaX = x - xDown, deltaY = y - yDown) // 实时可视化
        }
        MotionEvent.ACTION_CANCEL, MotionEvent.ACTION_UP -> {
            visualizeResizeForDelta(deltaX = x - xDown, deltaY = y - yDown)
            onTouchUp()                                                // 松手吸附
            xDown = 0; yDown = 0
        }
    }
    return true
}

private fun handleTouchDown(ev: MotionEvent): Boolean {
    val hitRect = Rect()
    val x = ev.x.toInt()
    val y = ev.y.toInt()
    getHitRect(hitRect)
    if (hitRect.contains(x, y)) {
        if (beginResizeIfPointInRegion(x - left, y - top)) {            // 判断点在哪个边
            xDown = x; yDown = y
            return true
        }
    }
    return false
}

// ★ 判断抓的是哪个边 + 计算允许的 delta 范围
private fun beginResizeIfPointInRegion(x: Int, y: Int): Boolean {
    isLeftBorderActive = (x < touchTargetWidth) && horizontalResizeActive
    isRightBorderActive = (x > width - touchTargetWidth) && horizontalResizeActive
    isTopBorderActive = (y < touchTargetWidth + topTouchRegionAdjustment) && verticalResizeActive
    isBottomBorderActive = (y > height - touchTargetWidth + bottomTouchRegionAdjustment) && verticalResizeActive

    val anyBordersActive =
        isLeftBorderActive || isRightBorderActive || isTopBorderActive || isBottomBorderActive

    if (anyBordersActive) {
        // 高亮激活的 handle，其他变暗
        dragHandles.left.alpha = if (isLeftBorderActive) VISIBLE_ALPHA else DIMMED_ALPHA
        dragHandles.right.alpha = if (isRightBorderActive) VISIBLE_ALPHA else DIMMED_ALPHA
        dragHandles.top.alpha = if (isTopBorderActive) VISIBLE_ALPHA else DIMMED_ALPHA
        dragHandles.bottom.alpha = if (isBottomBorderActive) VISIBLE_ALPHA else DIMMED_ALPHA
    }

    // ★ 计算本次拖拽允许的 delta 范围（不能拖出屏幕、不能拖穿对边）
    when {
        isLeftBorderActive -> deltaXRange.set(start = -left, end = width - 2 * touchTargetWidth) // 左边不能拖过右边界
        isRightBorderActive -> deltaXRange.set(start = 2 * touchTargetWidth - width, end = dragLayer.width - right) // 右边不拖出屏幕
        else -> deltaXRange.reset()
    }
    baselineXRange.set(start = left, end = right)                        // 记录初始 X 范围

    when {
        isTopBorderActive -> deltaYRange.set(start = -top, end = height - 2 * touchTargetWidth)
        isBottomBorderActive -> deltaYRange.set(start = 2 * touchTargetWidth - height, end = dragLayer.height - bottom)
        else -> deltaYRange.reset()
    }
    baselineYRange.set(start = top, end = bottom)

    return anyBordersActive
}
```

`touchTargetWidth = 2 * backgroundPadding`，是 handle 的触摸热区宽度。

### 12.4 核心算法：visualizeResizeForDelta + resizeWidgetIfNeeded

```kotlin
// AppWidgetResizeFrame.kt
private fun visualizeResizeForDelta(deltaX: Int, deltaY: Int) {
    this.deltaX = deltaXRange.clamp(deltaX)                             // ★ 限幅到允许范围
    this.deltaY = deltaYRange.clamp(deltaY)
    val lp = layoutParams as BaseDragLayer.LayoutParams

    // 移动 resize frame 自身的 LayoutParams（视觉跟随手指）
    baselineXRange.applyDelta(
        moveStart = isLeftBorderActive,                                // 左边激活 → 移动 start
        moveEnd = isRightBorderActive,                                 // 右边激活 → 移动 end
        delta = this.deltaX,
        outputRange = tempRange1,
    )
    lp.x = tempRange1.start
    lp.width = tempRange1.size()

    baselineYRange.applyDelta(
        moveStart = isTopBorderActive,
        moveEnd = isBottomBorderActive,
        delta = this.deltaY,
        outputRange = tempRange1,
    )
    lp.y = tempRange1.start
    lp.height = tempRange1.size()

    resizeWidgetIfNeeded(onDismiss = false)                            // ★ 计算是否要增减 span

    // 双面板越界处理
    if (cellLayout.parent is Workspace<*>) {
        val workspace = cellLayout.parent as Workspace<*>
        val pairedCellLayout = workspace.getScreenPair(cellLayout)
        if (pairedCellLayout != null) {
            handleInvalidResizeForTwoPanelUi(workspace, pairedCellLayout)
        }
    }
    requestLayout()
}

private fun resizeWidgetIfNeeded(onDismiss: Boolean) {
    val wlp: ViewGroup.LayoutParams? = widgetView.layoutParams
    if (wlp == null || wlp !is CellLayoutLayoutParams) return

    val dp = launcher.deviceProfile
    // ★ 一个 cell 的像素阈值 = cell 宽 + 间距
    val xThreshold = (cellLayout.cellWidth + dp.workspaceIconProfile.cellLayoutBorderSpacePx.x).toFloat()
    val yThreshold = (cellLayout.cellHeight + dp.workspaceIconProfile.cellLayoutBorderSpacePx.y).toFloat()

    // ★ 把像素 delta 换算成"格数增量"
    // (deltaX + deltaXAddOn) / xThreshold = 当前累计的格数偏移（浮点）
    // 减去 runningHInc = 已应用的格数 = 本次的增量（浮点）
    val hSpanInc = getSpanIncrement((deltaX + deltaXAddOn) / xThreshold - runningHInc)
    val vSpanInc = getSpanIncrement((deltaY + deltaYAddOn) / yThreshold - runningVInc)

    if (!onDismiss && (hSpanInc == 0 && vSpanInc == 0)) return          // 没有格数变化 → 不处理

    directionVector[DIRECTION_HORIZONTAL_INDEX] = DIRECTION_NONE
    directionVector[DIRECTION_VERTICAL_INDEX] = DIRECTION_NONE

    var spanX = wlp.cellHSpan
    var spanY = wlp.cellVSpan
    var cellX = if (wlp.useTmpCoords) wlp.tmpCellX else wlp.cellX
    var cellY = if (wlp.useTmpCoords) wlp.tmpCellY else wlp.cellY

    // ★ 水平方向：用 IntRange.applyDeltaAndBound 应用增量并夹到约束
    tempRange1.set(cellX, spanX + cellX)                               // 当前 [cellX, cellX+spanX]
    val hSpanDelta = tempRange1.applyDeltaAndBound(
        moveStart = isLeftBorderActive,
        moveEnd = isRightBorderActive,
        delta = hSpanInc,
        minSize = minHSpan,                                            // 最小 span
        maxSize = maxHSpan,                                            // 最大 span
        maxEnd = cellLayout.countX,                                    // 网格列数上限
        outputRange = tempRange2,
    )
    cellX = tempRange2.start
    spanX = tempRange2.size()
    if (hSpanDelta != 0) {
        directionVector[DIRECTION_HORIZONTAL_INDEX] =
            if (isLeftBorderActive) DIRECTION_LEFT else DIRECTION_RIGHT
    }

    // 垂直方向同理
    tempRange1.set(cellY, spanY + cellY)
    val vSpanDelta = tempRange1.applyDeltaAndBound(
        moveStart = isTopBorderActive, moveEnd = isBottomBorderActive,
        delta = vSpanInc, minSize = minVSpan, maxSize = maxVSpan,
        maxEnd = cellLayout.countY, outputRange = tempRange2,
    )
    cellY = tempRange2.start
    spanY = tempRange2.size()
    if (vSpanDelta != 0) {
        directionVector[DIRECTION_VERTICAL_INDEX] =
            if (isTopBorderActive) DIRECTION_TOP else DIRECTION_BOTTOM
    }

    if (!onDismiss && vSpanDelta == 0 && hSpanDelta == 0) return

    // 提交时用上次的 direction vector（保证最终 commit 和反馈一致）
    if (onDismiss) {
        directionVector[DIRECTION_HORIZONTAL_INDEX] = lastDirectionVector[DIRECTION_HORIZONTAL_INDEX]
        directionVector[DIRECTION_VERTICAL_INDEX] = lastDirectionVector[DIRECTION_VERTICAL_INDEX]
    } else {
        lastDirectionVector[DIRECTION_HORIZONTAL_INDEX] = directionVector[DIRECTION_HORIZONTAL_INDEX]
        lastDirectionVector[DIRECTION_VERTICAL_INDEX] = directionVector[DIRECTION_VERTICAL_INDEX]
    }

    // ★ 让 CellLayout 重新排布（其他图标让位）
    if (widgetView !is PendingAppWidgetHostView &&
        cellLayout.createAreaForResize(
            cellX, cellY, spanX, spanY,
            /*dragView=*/ widgetView,
            directionVector,
            /*commit=*/ onDismiss,                                     // onDismiss=true 时真正提交
        )
    ) {
        if (wlp.cellHSpan != spanX || wlp.cellVSpan != spanY) {
            stateAnnouncer?.announce(launcher.getString(R.string.widget_resized, spanX, spanY)) // 无障碍播报
        }
        wlp.tmpCellX = cellX
        wlp.tmpCellY = cellY
        wlp.cellHSpan = spanX
        wlp.cellVSpan = spanY
        runningVInc += vSpanDelta                                      // 累计已应用的增量
        runningHInc += hSpanDelta

        if (!onDismiss) {
            widgetView.updateSizeRanges(spanX, spanY)                  // 通知 widget 新尺寸（触发 RemoteViews 更新）
        }
    }
    widgetView.requestLayout()
}
```

### 12.5 RESIZE_THRESHOLD = 0.66 的意义

```kotlin
private fun getSpanIncrement(deltaFrac: Float): Int {
    return if (abs(deltaFrac.toDouble()) > RESIZE_THRESHOLD) {         // > 0.66
        Math.round(deltaFrac)                                          // 四舍五入
    } else {
        0                                                              // ≤ 0.66 → 不变
    }
}
```

**为什么是 0.66 而不是 0.5？** 这是迟滞设计（hysteresis）。

- 如果用 0.5：拖过半格就 +1，拖回半格就 -1。手指在半格附近抖动会反复触发增减，widget 尺寸来回跳。
- 用 0.66：必须拖过 2/3 格才确认变化。这给了一个"确认区"——用户明确拖到下一格的 2/3 位置才生效，减少误触发。`Math.round` 配合 0.66 阈值：当 `deltaFrac = 0.66` 时 `round(0.66) = 1`，当 `deltaFrac = -0.66` 时 `round(-0.66) = -1`，当 `deltaFrac = 0.4` 时不进入 if 返回 0。

这是一个典型的"既不灵敏也不迟钝"的折中——比 0.5 稳，比 0.9 灵敏。

### 12.6 deltaXAddOn：精度补偿

```kotlin
// AppWidgetResizeFrame.kt
private var deltaXAddOn = 0                                            // 累计的像素偏移补偿
private var deltaYAddOn = 0
private var runningHInc = 0                                            // 已应用的格数增量
private var runningVInc = 0

// resizeWidgetIfNeeded 里：
val hSpanInc = getSpanIncrement((deltaX + deltaXAddOn) / xThreshold - runningHInc)

// onTouchUp 里更新 addOn：
private fun onTouchUp() {
    val dp = launcher.deviceProfile
    val xThreshold = cellLayout.cellWidth + dp.workspaceIconProfile.cellLayoutBorderSpacePx.x
    val yThreshold = cellLayout.cellHeight + dp.workspaceIconProfile.cellLayoutBorderSpacePx.y

    deltaXAddOn = runningHInc * xThreshold                              // ★ 累计已应用的像素
    deltaYAddOn = runningVInc * yThreshold
    deltaX = 0; deltaY = 0                                              // 重置当前 delta
    post { snapToWidget(true) }                                         // 动画吸附
}
```

**为什么需要 deltaXAddOn？** 浮点精度问题。

每次 `resizeWidgetIfNeeded` 计算增量时：`(deltaX + deltaXAddOn) / xThreshold - runningHInc`。这里 `deltaX` 是当前拖拽的像素，`deltaXAddOn` 是之前已确认应用的像素累计，`runningHInc` 是已应用的格数。

假设 `xThreshold = 100px`，用户拖了 `deltaX = 70px`：
- 第一次：`(70 + 0) / 100 - 0 = 0.7 > 0.66` → `hSpanInc = round(0.7) = 1`，应用一格，`runningHInc = 1`。
- 松手 `onTouchUp`：`deltaXAddOn = 1 * 100 = 100`，`deltaX = 0`。
- 用户继续拖 `deltaX = 50px`：`(50 + 100) / 100 - 1 = 0.5`，不 > 0.66，不变。
- 如果没有 `deltaXAddOn`：`50 / 100 - 1 = -0.5`，会错误地减一格。

`deltaXAddOn` 把"之前应用的格数"换算回像素累计到当前 delta 上，保证每次计算的基准是连续的，不会因为松手重置 `deltaX` 而丢失进度。

### 12.7 IntRange.applyDeltaAndBound：边界约束算法

这是 resize 的数学核心——移动某条边，但不能违反 min/max/边界四重约束：

```kotlin
// AppWidgetResizeFrame.kt 内部类
@VisibleForTesting
class IntRange {
    var start: Int = 0
    var end: Int = 0

    fun clamp(value: Int) = Utilities.boundToRange(value, start, end)   // 限幅到 [start, end]
    fun reset() = set(start = 0, end = 0)
    fun set(start: Int, end: Int) { this.start = start; this.end = end }
    fun size(): Int = end - start

    // 移动某条边（start 或 end，不同时），delta 可正可负
    fun applyDelta(moveStart: Boolean, moveEnd: Boolean, delta: Int, outputRange: IntRange) {
        outputRange.start = if (moveStart) start + delta else start
        outputRange.end = if (moveEnd) end + delta else end
    }

    // ★ 核心：applyDelta + 四重约束
    fun applyDeltaAndBound(
        moveStart: Boolean, moveEnd: Boolean,
        delta: Int, minSize: Int, maxSize: Int, maxEnd: Int,
        outputRange: IntRange,
    ): Int {
        applyDelta(moveStart, moveEnd, delta, outputRange)              // ① 先按 delta 平移
        outputRange.start = outputRange.start.coerceAtLeast(0)          // ② start ≥ 0（不拖出左/上边界）
        outputRange.end = outputRange.end.coerceAtMost(maxEnd)          // ③ end ≤ maxEnd（不拖出右/下边界）

        if (outputRange.size() < minSize) {                             // ④ 尺寸 < minSize：拉回
            if (moveStart) {
                outputRange.start = outputRange.end - minSize           // 移的是 start → start 让步
            } else if (moveEnd) {
                outputRange.end = outputRange.start + minSize           // 移的是 end → end 让步
            }
        }
        if (outputRange.size() > maxSize) {                             // ⑤ 尺寸 > maxSize：压回
            if (moveStart) {
                outputRange.start = outputRange.end - maxSize           // 移的是 start → start 让步
            } else if (moveEnd) {
                outputRange.end = outputRange.start + maxSize           // 移的是 end → end 让步
            }
        }

        // 返回实际变化的格数（用于 runningInc 累计）
        return if (moveEnd) {
            outputRange.size() - size()                                // 移 end：新 size - 旧 size
        } else {
            size() - outputRange.size()                                // 移 start：旧 size - 新 size
        }
    }
}
```

逻辑顺序：**先按 delta 平移 → 夹到屏幕边界（0 和 maxEnd）→ 夹到 min span → 夹到 max span**。被夹住的那条边不动，另一条边自由。约束的优先级是：屏幕边界 > min span > max span。

举例：widget 当前 `[cellX=2, spanX=3]`（即占 cell 2~5），`minHSpan=2, maxHSpan=4, countX=8`：
- 用户拖左边 handle，`delta = -1`（想往左扩一格）。
- `applyDelta`：`start = 2 + (-1) = 1, end = 5`，新范围 `[1, 5]`，size=4。
- `coerceAtLeast(0)`：1 ≥ 0，不变。
- `coerceAtMost(8)`：5 ≤ 8，不变。
- `size()=4` 不小于 `minSize=2`，不大于 `maxSize=4`，不变。
- 返回 `size() - outputRange.size() = 3 - 4 = -1`（start 方向，旧 size - 新 size）。
- 结果：`cellX=1, spanX=4`，widget 往左扩了一格。

### 12.8 松手吸附与最终提交

```kotlin
// AppWidgetResizeFrame.kt
private fun onTouchUp() {
    val dp = launcher.deviceProfile
    val xThreshold = cellLayout.cellWidth + dp.workspaceIconProfile.cellLayoutBorderSpacePx.x
    val yThreshold = cellLayout.cellHeight + dp.workspaceIconProfile.cellLayoutBorderSpacePx.y

    deltaXAddOn = runningHInc * xThreshold                              // 累计偏移，避免精度丢失
    deltaYAddOn = runningVInc * yThreshold
    deltaX = 0; deltaY = 0                                              // 重置当前 delta

    post { snapToWidget(true) }                                         // 动画吸附到 widget 实际边界
}

override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    launcher.dragController.removeDragListener(this)
    // ★ 最终提交：onDismiss=true 让 CellLayout 真正落位 + 写库
    resizeWidgetIfNeeded(true)
    launcher.statsLogManager.logger()
        .withInstanceId(logInstanceId)
        .withItemInfo(widgetView.tag as ItemInfo)
        .log(LauncherEvent.LAUNCHER_WIDGET_RESIZE_COMPLETED)
}
```

`onDismiss=true` 的 `resizeWidgetIfNeeded` 把最后一次方向向量应用到 `CellLayout.createAreaForResize(commit=true)`，最终通过 Model 层把新的 `spanX/spanY/cellX/cellY` 写入 `LauncherAppWidgetInfo` 持久化到数据库。

### 12.9 双面板（Two Panel）特例

双面板布局下，widget 不能跨两个 CellLayout。`handleInvalidResizeForTwoPanelUi` 检测越界：

```kotlin
// AppWidgetResizeFrame.kt
private fun handleInvalidResizeForTwoPanelUi(
    workspace: Workspace<*>,
    pairedCellLayout: CellLayout,
) {
    val focusedCellLayoutBound = TempRect
    dragLayerRelativeCoordinateHelper.viewToRect(cellLayout, focusedCellLayoutBound)
    val resizeFrameBound = TempRect2
    findViewById<View>(R.id.widget_resize_frame).getGlobalVisibleRect(resizeFrameBound)

    // 计算越界进度（0 = 没越界，1 = 严重越界）
    val progress = when {
        workspace.indexOfChild(pairedCellLayout) < workspace.indexOfChild(cellLayout) &&
            this.deltaX < 0 &&
            resizeFrameBound.left < focusedCellLayoutBound.left ->
            // 兄弟在左，往左拖越界
            ((crossPanelInvalidDragMargin + this.deltaX) / crossPanelInvalidDragMargin)
        workspace.indexOfChild(pairedCellLayout) > workspace.indexOfChild(cellLayout) &&
            this.deltaX > 0 &&
            resizeFrameBound.right > focusedCellLayoutBound.right ->
            // 兄弟在右，往右拖越界
            ((crossPanelInvalidDragMargin - this.deltaX) / crossPanelInvalidDragMargin)
        else -> SPRING_LOADED_PROGRESS_MAX                               // 1f，没越界
    }

    // 兄弟面板透明度最低 0.5，越界越严重越透明
    val alpha = max(CELL_LAYOUT_INVALID_RESIZE_MAX_ALPHA.toDouble(), progress.toDouble()).toFloat()
    // spring loaded 进度反向（越界越严重进度越低）
    val springLoadedProgress = min(SPRING_LOADED_PROGRESS_MAX, (SPRING_LOADED_PROGRESS_MAX - progress))
    updateInvalidResizeEffect(
        cellLayout = cellLayout,
        pairedCellLayout = pairedCellLayout,
        alpha = alpha,
        springLoadedProgress = springLoadedProgress,
        animatorSet = null,
    )
}
```

设计意图：拖过头时给视觉反馈（兄弟面板渐变变暗 + spring loaded 进度降低），提示用户"这里不能跨"。松手后 `snapToWidget` 会把 frame 拉回合法范围。

### 面试深问

**Q1：RESIZE_THRESHOLD=0.66 为什么不用 0.5？**
A：迟滞防抖。0.5 的话手指在半格附近抖动会反复增减 span，widget 尺寸跳变。0.66 要求拖到下一格的 2/3 才确认，给确认区减少误触。配合 `Math.round`：delta=0.66 时 round 得 1，delta=0.4 时不变。是灵敏度和稳定性的折中。

**Q2：deltaXAddOn 解决什么问题？**
A：浮点进度连续性。每次 resize 计算增量是 `(deltaX + deltaXAddOn) / threshold - runningHInc`。松手时 `deltaX` 重置为 0，但之前应用的格数进度不能丢。`deltaXAddOn = runningHInc * threshold` 把已应用的格数换算回像素累计，保证下次拖拽的基准连续。没有它，松手后再拖会错误计算增量。

**Q3：applyDeltaAndBound 的四重约束优先级是什么？**
A：屏幕边界（start≥0, end≤maxEnd）> min span > max span。先夹屏幕边界（不能拖出网格），再夹 min（不能小于最小尺寸），最后夹 max（不能超过最大尺寸）。被夹的边不动，另一边自由。返回值是实际变化的格数，用于 `runningInc` 累计和 `deltaXAddOn` 计算。

---

# Part 3 · 设计精髓与横向对比

## 十三、六大设计精髓

1. **Deep Shortcut 的"先占位后填充"**：长按时从缓存的 `deepShortcutMap` 拿 count 预占 View 行数（零阻塞），真实 shortcut 数据在后台线程用 `ShortcutRequest` 异步查询、`sortAndFilterShortcuts` 排序过滤，回主线程逐条 `applyShortcutInfo`，配合 `LayoutTransition` 实现逐条淡入。用户感知不到查询延迟。

2. **排序保证动态性**：`sortAndFilterShortcuts` 保证最多 4 条且至少 2 条 dynamic，manifest 优先在前。manifest 提供稳定骨架（"新标签页"），dynamic 提供新鲜内容（"继续播放"），兼顾稳定性和新鲜度。

3. **Widget 预加载（WidgetHostViewLoader）**：拖拽期间并行完成「分配 id → 绑定 provider → inflate HostView」，把跨进程耗时操作藏进用户拖拽的时间。松手 drop 时 widget 已准备好，几乎瞬间显示。取消时 `onDragEnd` 干净回收 id 和 HostView，不留资源泄漏。

4. **监听时机省电**：`LauncherWidgetHolder` 只在 NORMAL + resumed + started 三条件全满足时 `startListening`，否则用 `PendingAppWidgetHostView` 占位。Launcher 不可见或处于 AllApps/OVERVIEW 时不接收 RemoteViews 推送，省电省内存。恢复后 `updateDeferredView` 重新 inflate 延迟的 View。

5. **Resize 的纯像素→格数换算**：把手指的像素 delta 除以单格像素阈值（cell 宽 + 间距），超过 0.66 才算一整格（`RESIZE_THRESHOLD`），用 `IntRange.applyDeltaAndBound` 统一处理 min/max/边界四重约束。`deltaXAddOn` 累计偏移避免浮点精度丢格。

6. **统一拖拽体系**：shortcut 和 widget 都复用 `DragController` + `DragPreviewProvider`，区别只在预览生成方式（shortcut 用 `ShortcutDragPreviewProvider` 缩放到图标尺寸；widget 用 `PendingItemDragHelper` 的三层预览源）和 drop 后的处理（shortcut 创建 `WorkspaceItemInfo`；widget 走 `addAppWidgetFromDrop` 创建 `LauncherAppWidgetInfo`）。

## 十四、横向对比：Deep Shortcut vs System Shortcut vs Widget

| 维度 | Deep Shortcut | System Shortcut | Widget |
|------|---------------|-----------------|--------|
| 数据来源 | app 进程发布（`ShortcutManager`） | Launcher 内部（Factory） | app 进程发布（`AppWidgetProviderInfo`） |
| 查询方式 | `LauncherApps.getShortcuts`（跨进程） | 内存实例化 | `AppWidgetManager.getInstalledProviders`（跨进程） |
| 缓存 | `BgDataModel.deepShortcutMap`（count） | 无（实时 Factory 过滤） | `WidgetPickerData`（Compose）/ 数据库预览 |
| 展示 View | `DeepShortcutView`（图标+文字+加号） | `DeepShortcutView` 或 `ImageView` | `LauncherAppWidgetHostView`（RemoteViews） |
| 点击行为 | 启动 shortcut（Intent） | 子类 `onClick`（打开设置/widget picker 等） | widget 本身交互 |
| 拖到桌面 | 创建 `WorkspaceItemInfo`（`CONTAINER_SHORTCUTS`） | 通常不可拖（Widgets 项打开 picker） | 创建 `LauncherAppWidgetInfo`（绑定 id） |
| 预加载 | 无（数据轻量） | 无 | `WidgetHostViewLoader`（重量级跨进程绑定） |

## 十五、完整生命周期对照

**Deep Shortcut 弹出 → 拖到桌面**：
```
长按图标
  → ItemLongClickListener
  → PopupControllerForAppIcon.show()
  → PopupDataProvider.getShortcutCountForItem()（读缓存 count）
  → Launcher.getSupportedShortcuts()（Factory 过滤 system 项）
  → PopupContainerWithArrow.create()
  → populateAndShowRows()（按 count 预占行 + show()）
  → loadAppShortcuts()（后台 MODEL_EXECUTOR）
    → PopupPopulator.createUpdateRunnable()
      → ShortcutRequest.withContainer().query(PUBLISHED)
      → sortAndFilterShortcuts()（最多4，至少2 dynamic）
      → 逐条 uiHandler.post(applyShortcutInfo)
  → 用户长按某条 shortcut
  → LauncherPopupItemDragHandler.onLongClick()
  → Workspace.beginDragShared(ShortcutDragPreviewProvider)
  → 拖拽（PreDragCondition 阈值检查）
  → drop 到桌面
  → Launcher.addPendingItem()
  → 创建 WorkspaceItemInfo 持久化到数据库
```

**Widget 添加全流程**：
```
打开 picker（FullSheet / WidgetPickerActivity / AddItemBottomSheet）
  → WidgetManagerHelper.getAllProviders()（getInstalledProvidersForProfile）
  → 用户长按 widget 预览
  → PendingItemDragHelper.startDrag()
    → 构造预览（缓存位图 > RemoteViews > 数据库生成）
    → DragController.addDragListener(WidgetHostViewLoader)  ★
    → DragController.startDrag()
  → 拖拽开始
    → WidgetHostViewLoader.onDragStart() → preloadWidget()
      → allocateAppWidgetId()（分配 id）
      → bindAppWidgetIdIfAllowed()（绑定 provider，需权限）
      → createView()（inflate HostView）
      → 加到 DragLayer（INVISIBLE）
  → drop 到 Workspace
    → Launcher.addAppWidgetFromDrop()
      → info.boundWidget != null（预加载成功）→ 复用
      → 否则现场 allocateAppWidgetId + bindAppWidgetIdIfAllowed
        → 失败 → startBindFlow()（弹系统授权确认）
    → addAppWidgetImpl()
      → startConfigActivity()（如需配置）
      → completeAddAppWidget()（创建 LauncherAppWidgetInfo 写库）
  → 配置完成（如需）
    → onActivityResult() → completeTwoStageWidgetDrop()
  → Widget 显示
```

---

## 十六、面试高频问答

**Q：长按 app 图标弹出的快捷菜单是怎么实现的？**
A：入口是 `PopupControllerForAppIcon.show()`，由图标的 `OnLongClickListener` 触发。它先从 `PopupDataProvider` 拿该 app 的 deep shortcut 数量（这个数量是 `LauncherModel` 后台预建在 `BgDataModel.deepShortcutMap` 里的，不是实时查），同时通过 `Launcher.getSupportedShortcuts` 收集适用的系统菜单项（根据 container 返回 APP_INFO/WIDGETS/INSTALL/REMOVE 等组合，每个 Factory 内部还会过滤如 WIDGETS 工厂发现没 widget 就返回 null）。然后创建 `PopupContainerWithArrow`（LinearLayout + AbstractFloatingView），按总数是否超 `SHORTCUT_COLLAPSE_THRESHOLD=6` 决定折叠策略。容器先按 count 预占行并 `show()`，再调 `PopupPopulator.createUpdateRunnable` 在 `MODEL_EXECUTOR` 后台线程用 `ShortcutRequest`（封装 `LauncherApps.getShortcuts`）查真实数据，`sortAndFilterShortcuts` 排序过滤（最多 4 条、至少 2 条 dynamic、manifest 优先）后回主线程逐条 `applyShortcutInfo` 填充图标和文字，配合 `LayoutTransition` 实现逐条淡入。

**Q：Deep Shortcut 和 System Shortcut 有什么区别？**
A：Deep Shortcut 是 app 通过 `ShortcutManager` API 发布的动态/静态快捷方式（比如"继续播放""新标签页"），数据来自 app 进程，由 `LauncherApps.getShortcuts` 跨进程查询，用 `DeepShortcutView`（图标+文字+加号按钮）展示。System Shortcut 是 Launcher 自己提供的菜单项，是 `SystemShortcut` 抽象类的内部子类（Widgets、AppInfo、Install、RemoveApp 等），它同时 extends `ItemInfo` 和 implements `OnClickListener`，由 `Launcher.getSupportedShortcuts` 根据 container 返回候选 Factory，每个 Factory 内部过滤。两类共用同一个 popup 容器，当总数超 6 时，可折叠的（`mIsCollapsible=true`，如 AppInfo）被压成图标行，不可折叠的（Widgets、RemoveApp）保留整行带文字。

**Q：添加 widget 到桌面的完整流程？**
A：四步。① 在 widget picker（FullSheet 或新的 WidgetPickerActivity）里长按某个 widget 预览，`PendingItemDragHelper.startDrag` 构造拖拽预览（三层优先级：缓存位图 > RemoteViews 实时渲染 > 数据库生成）并启动 `DragController.startDrag`，同时 `addDragListener(new WidgetHostViewLoader)`。② 拖拽期间 `WidgetHostViewLoader.onDragStart` 并行预加载：`allocateAppWidgetId` 分配 id → `WidgetManagerHelper.bindAppWidgetIdIfAllowed` 绑定 provider → `createView` inflate 出 HostView 暂时 INVISIBLE 加到 DragLayer，存到 `PendingAddWidgetInfo.boundWidget`。③ 松手 drop 到 Workspace，`addAppWidgetFromDrop` 检查 `boundWidget`：非空直接复用预加载的；否则现场分配 id+绑定，绑定失败走 `startBindFlow` 发 `ACTION_APPWIDGET_BIND` 让用户授权。落位后 `completeAddAppWidget` 在 Model 层创建 `LauncherAppWidgetInfo` 写库。④ 如果 widget 声明了 `configure` Activity 且非 optional（`needsConfigure` 判断），先启动配置页，完成后 `completeTwoStageWidgetDrop` 回调真正显示。

**Q：widget 的数据是怎么更新到桌面的？**
A：基于 Android 的 AppWidget 框架。Launcher 持有一个 `LauncherAppWidgetHost`（host id=`APPWIDGET_HOST_ID=1024`），通过 `LauncherWidgetHolder` 封装。每个 widget 有个 id，`createView(id, providerInfo)` 调到 `LauncherAppWidgetHost.onCreateView` 造 `LauncherAppWidgetHostView`（有回收机制 `mViewToRecycle`），它接收 provider 进程通过 `RemoteViews` 推送过来的视图树并渲染。provider 调 `AppWidgetManager.updateAppWidget` 时，系统把 RemoteViews 通过 binder 推给 host。一个省电设计是：`LauncherWidgetHolder` 用 `AtomicInteger` 维护三个 flag（`FLAG_STATE_IS_NORMAL`/`FLAG_ACTIVITY_STARTED`/`FLAG_ACTIVITY_RESUMED`），只在三个全 on 时 `startListening`，否则用 `PendingAppWidgetHostView` 占位，恢复监听后 `updateDeferredView` 重新 inflate。

**Q：widget 调整大小的算法是怎么实现的？**
A：核心在 `AppWidgetResizeFrame.kt`。长按 widget 弹出带四个圆点的浮层（`DragHandles`），根据 `AppWidgetProviderInfo.resizeMode`（HORIZONTAL/VERTICAL/BOTH）和 min/max span 决定显示哪些 handle。触摸时 `beginResizeIfPointInRegion` 判断抓的是哪条边并计算允许的 delta 范围（`deltaXRange`，不拖出屏幕/对边）。`visualizeResizeForDelta` 把像素 delta 限幅后移动浮层自身跟随手指，然后调 `resizeWidgetIfNeeded`：把像素 delta 除以单格像素阈值（`cellWidth + borderSpacePx`）换算成格数增量，`getSpanIncrement` 判断超过 `RESIZE_THRESHOLD=0.66` 才算一整格（迟滞防抖），用 `IntRange.applyDeltaAndBound` 把增量应用到 `[cellX, cellX+spanX]` 并依次夹到屏幕边界、min span、max span。变化后调 `CellLayout.createAreaForResize` 让其他图标让位，并 `widgetView.updateSizeRanges` 通知 widget 新尺寸。松手 `onTouchUp` 用 `deltaXAddOn = runningHInc * threshold` 累计偏移避免精度丢失，`onDetachedFromWindow` 时以 `onDismiss=true` 提交最终尺寸写库。

**Q：widget 预加载为什么能提升体验？**
A：因为 widget 的"分配 id → 跨进程绑定 provider → inflate RemoteViews"这几步都涉及 binder 调用和跨进程视图渲染，总耗时可能上百毫秒。`WidgetHostViewLoader` 利用用户拖拽这段时间并行完成——`onDragStart` 立刻 post 绑定 Runnable，绑定成功立刻 inflate 出 HostView 加到 DragLayer（INVISIBLE）。这样用户松手 drop 时 widget 已经准备好了，几乎瞬间显示，而不是 drop 后才开始绑定导致白屏等待。如果用户拖到一半取消，`onDragEnd` 会 `deleteAppWidgetId` 回收预分配的 id 并 `removeView` 清理 HostView，不留资源泄漏。这是典型的"用并行时间换体验"——把不可避免的耗时操作藏进用户感知不到的拖拽时间段。需要注意：如果 widget `needsConfigure`（必须配置），不预加载，因为配置会改变最终内容，预绑定会浪费。

**Q：sortAndFilterShortcuts 的"至少 2 条 dynamic"规则是怎么实现的？**
A：排序后先取前 `MAX_SHORTCUTS=4` 条放入 filtered 列表，同时统计其中 dynamic 数量 `numDynamic`。然后继续遍历剩余的 shortcut：如果遇到 dynamic 且 `numDynamic < NUM_DYNAMIC(2)`，就 `numDynamic++`，计算 `lastStaticIndex = filteredSize - numDynamic`（从尾部往前找 static 的位置），`filteredShortcuts.remove(lastStaticIndex)` 移除一个 static，再 `add` 把 dynamic 加进去。这样保证最终结果里至少有 2 条 dynamic，挤掉了同等数量的 static。这反映了设计意图：manifest static 稳定但 stale，dynamic 新鲜但易变，强制保留 dynamic 让用户看到最新行为入口。
