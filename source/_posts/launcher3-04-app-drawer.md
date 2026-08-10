---
title: Launcher3 源码精读（04）：应用抽屉
category: client
platform: android
tags: ["AOSP", "Launcher3", "源码", "Framework"]
readTime: 31分钟
featured: true
date: 2026-08-02
---

本文精读 Launcher3 应用抽屉（All Apps）的全部源码实现。核心数据流是：后台 Model 线程把 `LauncherApps` 收集到的应用封装为 `AppInfo[]`（预排序、预计算 `sectionName`），经 `AllAppsStore` 推送到前台，`AlphabeticalAppsList` 监听 Store 后完成二次排序（本地化 Collator）、按字母分 section、生成 `AdapterItem` 列表与 `FastScrollSectionInfo` 段表，再由 `BaseAllAppsAdapter` 配合 `DiffUtil` 增量刷新到 `AllAppsRecyclerView`。容器层 `ActivityAllAppsContainerView<T>` 用三套 `AdapterHolder`（MAIN/WORK/SEARCH）统一管理个人、工作、搜索三个互斥视图态，`AllAppsTransitionController` 用单一 `mProgress ∈ [0,1]` 驱动 Workspace ↔ All Apps 的位移与 alpha。每个设计取舍（泛型为何、为何用 ICU AlphabeticIndex、为何用位掩码 ViewType、为何 DiffUtil、为何延迟更新防抖）都在对应章节给出源码级解释。

源码路径：`packages/apps/Launcher3/src/com/android/launcher3/allapps/`，对照版本为 `aosp-r4`。

---

## 1. 整体类结构与数据流

### 1.1 目录分层与职责

`allapps/` 下 30 余个类，按职责分为五层：

**容器与状态层**

| 类 | 职责 |
|---|---|
| `ActivityAllAppsContainerView<T extends Context & ActivityContext>` | 抽象泛型总容器，继承 `SpringRelativeLayout`。持有三套 `AdapterHolder`、Header、搜索框、快速滚动条。所有交互的协调中心。 |
| `LauncherAllAppsContainerView` | `ActivityAllAppsContainerView<Launcher>` 的 Launcher 专用子类，覆写 `isInAllApps()`、浮动搜索条 margin（按 LauncherState 决定）。 |
| `SecondaryLauncherAllAppsContainerView` | 二级 Launcher（Taskbar 的 All Apps 入口）容器。 |
| `AllAppsTransitionController` | Workspace ↔ All Apps 位移动画，实现 `StateHandler<LauncherState>`，核心 `mProgress ∈ [0,1]`。 |
| `SearchTransitionController` | A‑Z ↔ 搜索结果过渡动画，继承 `RecyclerViewAnimationController`。 |

**数据层**

| 类 | 职责 |
|---|---|
| `AllAppsStore` | 前台应用数据中枢。持有 `AppInfo[] mApps`（按 `COMPONENT_KEY_COMPARATOR` 二分排序），通过 `OnUpdateListener` 通知下游。 |
| `AlphabeticalAppsList` | 排序 + 分组引擎。监听 `AllAppsStore`，做字母排序、生成 `AdapterItem` 与 `FastScrollSectionInfo`。 |
| `AppInfoComparator` | 应用比较器：先按 title（本地化 Collator），再按 componentName，再按 user serial。 |

**列表渲染层**

| 类 | 职责 |
|---|---|
| `BaseAllAppsAdapter` | 抽象适配器基类，定义全部 `VIEW_TYPE_*` 位掩码、`AdapterItem`、`ViewHolder`，`onCreate/onBind` 分发。 |
| `AllAppsGridAdapter` | 网格实现，含 `AppsGridLayoutManager` 与 `GridSpanSizer`（跨列控制）。 |
| `AllAppsRecyclerView` | 带快速滚动的 RecyclerView，继承 `FastScrollRecyclerView`。 |
| `AllAppsFastScrollHelper` | 触摸 fraction → section 的平滑滚动辅助。 |
| `FloatingHeaderView` | 悬浮 section header（滚动时吸顶），同时承载预测应用行。 |

**Profile 管理层**

| 类 | 职责 |
|---|---|
| `WorkProfileManager` | 工作资料过滤、静音切换、教育卡片。 |
| `PrivateProfileManager` | 私密空间（Android 15）解锁/锁定/动画。 |
| `UserProfileManager` | 两者基类状态机 `STATE_DISABLED / TRANSITION / ENABLED`。 |

**搜索层（`search/` 子目录）**

| 类 | 职责 |
|---|---|
| `SearchUiManager` | 搜索 UI 控制接口（非类）。 |
| `AllAppsSearchBarController` | 搜索框控制器，实现 `TextWatcher`，把输入转给 `SearchAlgorithm`。 |
| `DefaultAppSearchAlgorithm` | 默认本地搜索算法，标题前缀匹配，最多 5 条。 |
| `AppsSearchContainerLayout` | 搜索框 + 容器，实现 `SearchUiManager` 与 `SearchCallback`。 |
| `SearchAdapterProvider` | 搜索结果 View 提供者抽象（AOSP 里可被插件替换）。 |
| `DefaultSearchAdapterProvider` | 默认空实现，AOSP 默认无插件。 |

### 1.2 数据流（端到端）

```
PackageManager / LauncherApps
        │  (Model 后台线程，AllAppsList 收集，AlphabeticIndexCompat 算 sectionName)
        ▼
   AppInfo[]（预排序 COMPONENT_KEY_COMPARATOR，预填 sectionName）
        │  AllAppsStore.setApps(apps, flags, map)
        ▼
   notifyUpdate() → OnUpdateListener 回调
        │
        ├──► AlphabeticalAppsList.onAppsUpdated()
        │        │  filter → sort(AppInfoComparator) → 中文 section 归并 → 生成 AdapterItem + FastScrollSectionInfo
        │        ▼  DiffUtil.calculateDiff() → dispatchUpdatesTo(adapter)
        │
        └──► ActivityAllAppsContainerView.onAppsUpdated()
                 │  mHasWorkApps / mHasPrivateApps 重算 → rebindAdapters()
                 ▼
        AllAppsRecyclerView 渲染（Main/Work 两个 RV，或 Search RV）
```

设计要点：`sectionName` 在后台已算好（`AllAppsList` 里调 `AlphabeticIndexCompat`），前台只做二次排序和分组，避免 UI 线程做 ICU 调用。`AllAppsStore` 不持锁，用 `CopyOnWriteArrayList` 承载监听器，保证后台推送与前台回调的线程安全。

---

## 2. 容器层：ActivityAllAppsContainerView 与 LauncherAllAppsContainerView

### 2.1 泛型基类的设计意图

```java
// 源码：ActivityAllAppsContainerView.java
public class ActivityAllAppsContainerView<T extends Context & ActivityContext>
        extends SpringRelativeLayout implements DragSource, Insettable,
        OnDeviceProfileChangeListener, PersonalWorkSlidingTabStrip.OnActivePageChangedListener,
        ScrimView.ScrimDrawingController {

    protected final T mActivityContext; // 宿主上下文，既 Context 又 ActivityContext
```

`T extends Context & ActivityContext` 是交叉类型（intersection type）约束。`Context` 提供 Android 资源、`ActivityContext` 提供 Launcher 的领域能力（`getDeviceProfile()`、`getStatsLogManager()`、`getDragLayer()`、`getStateManager()`）。

为什么这么设计：
- 基类要在多个宿主复用——Launcher、Taskbar、Secondary Launcher 三套宿主各自实现 `ActivityContext`，但都不是同一个类。泛型让基类持有强类型的 `mActivityContext`，调用 `mActivityContext.getDeviceProfile()` 时编译期类型确定，无需强转。
- 若不用泛型而用接口 `ActivityContext`，则无法调用 `Context` 方法（`getResources()` 等）；若用 `Activity`，则无法给 Taskbar 用。交叉类型是唯一能同时满足两者且类型安全的写法。

子类用具体类型具现化：

```java
// 源码：LauncherAllAppsContainerView.java
public class LauncherAllAppsContainerView extends ActivityAllAppsContainerView<Launcher> {
    // Launcher 同时是 Context 又是 ActivityContext 的实现
```

`SecondaryLauncherAllAppsContainerView` 同理具现化为 `ActivityAllAppsContainerView<SecondaryLauncher>`。

### 2.2 构造链与三套 AdapterHolder

构造器三参数重载最终走到 `(Context, AttributeSet, int)`：

```java
// 源码：ActivityAllAppsContainerView.java
public ActivityAllAppsContainerView(Context context, AttributeSet attrs, int defStyleAttr) {
    super(context, attrs, defStyleAttr);
    mActivityContext = ActivityContext.lookupContext(context); // 向上查找 ActivityContext 宿主
    mAllAppsStore = mActivityContext.getActivityComponent().getAppsStore(); // 取共享的 Store

    mScrimColor = Themes.getAttrColor(context, R.attr.allAppsScrimColor);
    mHeaderThreshold = getResources().getDimensionPixelSize(
            R.dimen.dynamic_grid_cell_border_spacing); // header 隐藏触发的滚动阈值
    mHeaderProtectionColor = Themes.getAttrColor(context, R.attr.allappsHeaderProtectionColor);

    mWorkManager = new WorkProfileManager(this, mActivityContext.getStatsLogManager(),
            UserCache.INSTANCE.get(mActivityContext));
    mPrivateProfileManager = new PrivateProfileManager(this, mActivityContext.getStatsLogManager(),
            UserCache.INSTANCE.get(mActivityContext));
    mPrivateSpaceBottomExtraSpace = context.getResources().getDimensionPixelSize(
            R.dimen.ps_extra_bottom_padding);
    mAH = Arrays.asList(null, null, null); // 三个槽位预置为 null
    mNavBarScrimPaint = new Paint();
    mNavBarScrimPaint.setColor(Themes.getNavBarScrimColor(mActivityContext));

    AllAppsStore.OnUpdateListener onAppsUpdated = this::onAppsUpdated; // 方法引用
    mAllAppsStore.addUpdateListener(onAppsUpdated); // 容器自身监听 Store 更新

    // 焦点代理：容器获焦时转给当前 RV，避免搜索框光标抢占
    setOnFocusChangeListener((v, hasFocus) -> {
        if (hasFocus && getActiveRecyclerView() != null) {
            getActiveRecyclerView().requestFocus();
        }
    });
    mSearchUiDelegate = createSearchUiDelegate(); // 委托对象，子类可覆写
    initContent();

    mSearchTransitionController = new SearchTransitionController(this);
}
```

`initContent()` 创建三套 `AdapterHolder` 并 inflate 布局：

```java
// 源码：ActivityAllAppsContainerView.java
protected void initContent() {
    mMainAdapterProvider = mSearchUiDelegate.createMainAdapterProvider();

    // MAIN: 个人 A-Z，数据源 = mAllAppsStore，过滤 = 个人 User，PrivateProfileManager 参与私密空间
    mAH.set(AdapterHolder.MAIN, new AdapterHolder(AdapterHolder.MAIN,
            new AlphabeticalAppsList(mActivityContext, mAllAppsStore, null, mPrivateProfileManager)));
    // WORK: 工作 A-Z，数据源 = mAllAppsStore，WorkProfileManager 过滤工作 app
    mAH.set(AdapterHolder.WORK, new AdapterHolder(AdapterHolder.WORK,
            new AlphabeticalAppsList(mActivityContext, mAllAppsStore, mWorkManager, null)));
    // SEARCH: 搜索结果，数据源 = null（不监听 Store，结果由搜索算法推送）
    mAH.set(SEARCH, new AdapterHolder(SEARCH,
            new AlphabeticalAppsList(mActivityContext, null, null, null)));

    getLayoutInflater().inflate(R.layout.all_apps_content, this);
    mHeader = findViewById(R.id.all_apps_header);
    // ... 找到各 View 引用
    mSearchContainer = inflateSearchBar();
    if (!isSearchBarFloating()) {
        addView(mSearchContainer); // 非浮动搜索条时加到容器末尾
        mSearchContainer.setFocusedByDefault(true); // 视觉在顶部，故默认获焦
    }
    mSearchUiManager = (SearchUiManager) mSearchContainer;
}
```

三套 `AdapterHolder` 的职责分工：

```java
// 源码：ActivityAllAppsContainerView.java AdapterHolder 内部类
public class AdapterHolder {
    public static final int MAIN = 0;   // 个人 A-Z（含私密空间）
    public static final int WORK = 1;   // 工作 A-Z
    public static final int SEARCH = 2; // 搜索结果

    private final int mType;
    public final BaseAllAppsAdapter mAdapter;
    final RecyclerView.LayoutManager mLayoutManager;
    final AlphabeticalAppsList mAppsList; // 每个 holder 独立持有自己的列表引擎
    final Rect mPadding = new Rect();
    AllAppsRecyclerView mRecyclerView;
    private OnFocusChangeListener mOnFocusChangeListener;

    AdapterHolder(int type, AlphabeticalAppsList appsList) {
        mType = type;
        mAppsList = appsList;
        mAdapter = createAdapter(mAppsList); // 工厂方法，子类可定制 Adapter 类型
        mAppsList.setAdapter(mAdapter); // 列表引擎反向持有 Adapter（用于 DiffUtil 通知）
        mLayoutManager = mAdapter.getLayoutManager();
    }
```

为什么用三套独立 holder 而不是一个 holder 切数据源：
- 三个视图态是**互斥**的（任意时刻只有一个可见），但它们的**滚动位置、过滤条件、数据集各不相同**。用三套 holder 各持独立 `AlphabeticalAppsList` + `RecyclerView`，切换时只需切可见性，不必重新排序、重新绑定。这是空间换时间的典型取舍——多一份对象，换来切换零延迟。
- SEARCH 的 `AlphabeticalAppsList` 构造时 `appsStore = null`，不注册 Store 监听，结果完全由 `setSearchResults()` 外部推送，避免 A‑Z 列表变动污染搜索结果。

### 2.3 onCreate / onResume 对应：onFinishInflate / onAttachedToWindow

`ActivityAllAppsContainerView` 是 View，没有 `onCreate/onResume`。源码注释明确给出 View 生命周期与 Activity 的对应关系：

```
initContent -> Activity.onPreCreate
constructor/init -> Activity.onCreate
onFinishInflate -> Activity.onPostCreate
```

`onFinishInflate`（对应 onCreate 末尾）：

```java
// 源码：ActivityAllAppsContainerView.java
@Override
protected void onFinishInflate() {
    super.onFinishInflate();

    // SEARCH 的 RV 先绑定，过滤条件 = 永远返回 false（搜索结果不混入 A-Z）
    mAH.get(SEARCH).setup(mSearchRecyclerView, itemInfo -> false);
    rebindAdapters(true /* force */); // 首次强制重建 Main/Work 的 RV 绑定
    float cornerRadius = Themes.getDialogCornerRadius(getContext());
    mBottomSheetCornerRadii = new float[]{
            cornerRadius, cornerRadius, 0, 0, 0, 0, 0, 0}; // 大屏 sheet 圆角（仅顶部）
    // ... 背景色按 blur flag 选择
    updateBackgroundVisibility(mActivityContext.getDeviceProfile());
    mSearchUiManager.initializeSearch(this); // 搜索框初始化（绑定 SearchAlgorithm + Callback）
}
```

`onAttachedToWindow`（对应 onResume 首次）：

```java
// 源码：ActivityAllAppsContainerView.java
@Override
protected void onAttachedToWindow() {
    super.onAttachedToWindow();
    if (isSearchBarFloating()) {
        // 浮动搜索条加到 dragLayer 顶部，移除在 TaskbarAllAppsController#cleanUpOverlay
        mActivityContext.getDragLayer().addView(mSearchContainer);
        mSearchUiDelegate.onInitializeSearchBar();
    }
    mActivityContext.addOnDeviceProfileChangeListener(this); // 监听横竖屏/列数变化
}
```

注意 `onResume` 的真正入口不在 View 里，而在 `Launcher.onResume()` → `StateManager` → `AllAppsTransitionController.setState()`。View 自身只负责 inflate 和绑定，状态切换由 `LauncherState` 体系驱动。

### 2.4 rebindAdapters 与 Tab 切换

`rebindAdapters` 决定显示单 RV 还是双 Tab（个人/工作），是整个容器的布局重建入口：

```java
// 源码：ActivityAllAppsContainerView.java
protected void rebindAdapters(boolean force) {
    if (mSearchTransitionController.isRunning()) {
        mRebindAdaptersAfterSearchAnimation = true; // 搜索动画进行中，延后到动画结束
        return;
    }
    updateSearchResultsVisibility();

    boolean showTabs = shouldShowTabs(); // = mHasWorkApps（有工作 app 才显示 Tab）
    if (showTabs == mUsingTabs && !force) {
        return; // 状态未变且非强制，直接返回
    }

    replaceAppsRVContainer(showTabs); // 替换 RV 容器（单 RV ↔ ViewPager）
    mUsingTabs = showTabs;

    // 先解绑所有 RV 与 Store 的图标容器关系（防止旧 RV 继续接收图标更新）
    mAllAppsStore.unregisterIconContainer(mAH.get(AdapterHolder.MAIN).mRecyclerView);
    mAllAppsStore.unregisterIconContainer(mAH.get(AdapterHolder.WORK).mRecyclerView);
    mAllAppsStore.unregisterIconContainer(mAH.get(AdapterHolder.SEARCH).mRecyclerView);

    if (mUsingTabs) {
        // 双 Tab 模式：ViewPager 的两个子页分别是 Main/Work RV
        mainRecyclerView = (AllAppsRecyclerView) mViewPager.getChildAt(0);
        workRecyclerView = (AllAppsRecyclerView) mViewPager.getChildAt(1);
        mAH.get(AdapterHolder.MAIN).setup(mainRecyclerView, mPersonalMatcher); // 过滤个人 user
        mAH.get(AdapterHolder.WORK).setup(workRecyclerView, mWorkManager.getItemInfoMatcher());
        // ... Tab 点击监听、StatsLog 埋点
    } else {
        // 单 RV 模式：只绑定 Main，Work RV 置 null
        mainRecyclerView = findViewById(R.id.apps_list_view);
        mAH.get(AdapterHolder.WORK).mRecyclerView = null;
        mAH.get(AdapterHolder.MAIN).setup(mainRecyclerView, mPersonalMatcher);
    }
    // 关键：Main 和 Work 共享同一个 RecycledViewPool（见 2.5）
    setUpCustomRecyclerViewPool(mainRecyclerView, workRecyclerView,
            mActivityContext.getActivityComponent().getSharedAppsPool());
    setupHeader();
    // 重新注册 RV 为图标容器（BubbleTextView 的图标重绘由 Store 广播）
    mAllAppsStore.registerIconContainer(mAH.get(AdapterHolder.MAIN).mRecyclerView);
    mAllAppsStore.registerIconContainer(mAH.get(AdapterHolder.WORK).mRecyclerView);
    mAllAppsStore.registerIconContainer(mAH.get(AdapterHolder.SEARCH).mRecyclerView);
}
```

`replaceAppsRVContainer` 负责实际替换布局：

```java
// 源码：ActivityAllAppsContainerView.java
private void replaceAppsRVContainer(boolean showTabs) {
    for (int i = AdapterHolder.MAIN; i <= AdapterHolder.WORK; i++) {
        AdapterHolder adapterHolder = mAH.get(i);
        if (adapterHolder.mRecyclerView != null) {
            adapterHolder.mRecyclerView.setLayoutManager(null); // 解绑 LayoutManager
            adapterHolder.mRecyclerView.setAdapter(null); // 解绑 Adapter
        }
    }
    View oldView = getAppsRecyclerViewContainer();
    int index = indexOfChild(oldView);
    removeView(oldView);
    // 根据 Tab 需求 inflate 不同布局
    int layout = showTabs ? R.layout.all_apps_tabs : R.layout.all_apps_rv_layout;
    final View rvContainer = getLayoutInflater().inflate(layout, this, false);
    addView(rvContainer, index);
    if (showTabs) {
        mViewPager = (AllAppsPagedView) rvContainer;
        mViewPager.initParentViews(this);
        mViewPager.getPageIndicator().setOnActivePageChangedListener(this); // Tab 切换回调
        // ... predictive back 的 outline
    } else {
        mWorkManager.detachWorkUtilityViews(); // 单 RV 时拆掉工作工具视图
        mViewPager = null;
    }
    // ... 搜索条浮动时的布局规则
}
```

`shouldShowTabs()` 仅返回 `mHasWorkApps`：

```java
// 源码：ActivityAllAppsContainerView.java
public boolean shouldShowTabs() {
    return mHasWorkApps; // 有工作 app 才显示 Tab，否则单 RV
}
```

`mHasWorkApps` 在 `onAppsUpdated` 中扫描得出：

```java
// 源码：ActivityAllAppsContainerView.java
@VisibleForTesting
public void onAppsUpdated() {
    mHasWorkApps = Stream.of(mAllAppsStore.getApps())
            .anyMatch(mWorkManager.getItemInfoMatcher()); // 是否存在工作 user 的 app
    mHasPrivateApps = Stream.of(mAllAppsStore.getApps())
            .anyMatch(mPrivateProfileManager.getItemInfoMatcher());
    if (!isSearching()) {
        rebindAdapters(); // 非搜索态才重建（搜索态不切换 A-Z）
    }
    if (mHasWorkApps) mWorkManager.reset();
    if (mHasPrivateApps) mPrivateProfileManager.reset();
    mActivityContext.getStatsLogManager().logger()
            .withCardinality(mAllAppsStore.getApps().length)
            .log(LAUNCHER_ALLAPPS_COUNT);
}
```

Tab 切换（个人 ↔ 工作）由 `AllAppsPagedView` 触发 `onActivePageChanged`：

```java
// 源码：ActivityAllAppsContainerView.java
@Override
public void onActivePageChanged(int currentActivePage) {
    if (mSearchTransitionController.isRunning()) return; // 搜索动画中不切
    if (currentActivePage != SEARCH) mActivityContext.hideKeyboard();
    if (mAH.get(currentActivePage).mRecyclerView != null) {
        // 把快速滚动条绑定到新激活的 RV（快速滚动条是共享的）
        mAH.get(currentActivePage).mRecyclerView.bindFastScrollbar(mFastScroller, ALL_APPS_SCROLLER);
    }
    mHeader.setActiveRV(currentActivePage); // header 记录当前 RV 以正确渲染保护色
    reset(true /* animate */, !isSearching() /* exitSearch */, false /* clearScrim */);
    mWorkManager.onActivePageChanged(currentActivePage);
}
```

设计意图：快速滚动条 `mFastScroller` 是**全局唯一**的，Tab 切换时必须重新 `bindFastScrollbar` 到新 RV。Header 也是唯一的，需 `setActiveRV` 让它知道当前在算谁的 section 高亮。

### 2.5 RecycledViewPool 共享

```java
// 源码：ActivityAllAppsContainerView.java
private static void setUpCustomRecyclerViewPool(
        @NonNull AllAppsRecyclerView mainRecyclerView,
        @Nullable AllAppsRecyclerView workRecyclerView,
        @NonNull AllAppsRecyclerViewPool recycledViewPool) {
    mainRecyclerView.setRecycledViewPool(recycledViewPool);
    if (workRecyclerView != null) {
        workRecyclerView.setRecycledViewPool(recycledViewPool); // Main/Work 共享池
    }
    mainRecyclerView.updatePoolSize();
}
```

`updatePoolSize` 限定每种 ViewType 的缓存上限：

```java
// 源码：AllAppsRecyclerView.java
protected void updatePoolSize() {
    RecyclerView.RecycledViewPool pool = getRecycledViewPool();
    pool.setMaxRecycledViews(AllAppsGridAdapter.VIEW_TYPE_EMPTY_SEARCH, 1); // 空搜索结果最多缓存 1
    pool.setMaxRecycledViews(AllAppsGridAdapter.VIEW_TYPE_ALL_APPS_DIVIDER, 1); // 分隔符最多 1
}
```

为什么共享：个人页和工作页的图标 ViewType 相同（`VIEW_TYPE_ICON`），布局完全一致。共享池让两个 RV 互相复用回收的 `ViewHolder`，减少 inflate 次数。注释解释：AllApps RV 的可见性从 `INVISIBLE` 改成 `GONE`，无法靠 layout pass 自动更新池大小，故手动 `updatePoolSize`。

### 2.6 LauncherAllAppsContainerView 的覆写

```java
// 源码：LauncherAllAppsContainerView.java
@Override
public boolean isInAllApps() {
    return mActivityContext.getStateManager().isInStableState(LauncherState.ALL_APPS);
}
```

`isInAllApps()` 决定触摸事件是否拦截给快速滚动条。基类默认返回 `true`（Taskbar 场景 All Apps 总是可见），Launcher 子类则查询 `StateManager`，确保在 Workspace 态不拦截滚动事件。

浮动搜索条的 margin 也由 LauncherState 决定：

```java
// 源码：LauncherAllAppsContainerView.java
@Override
public int getFloatingSearchBarRestingMarginBottom() {
    if (!isSearchBarFloating()) return super.getFloatingSearchBarRestingMarginBottom();
    Launcher launcher = mActivityContext;
    StateManager<LauncherState, Launcher> stateManager = launcher.getStateManager();
    // 当前状态的 margin
    int currentStateMarginBottom = stateManager.getCurrentStableState()
            .getFloatingSearchBarRestingMarginBottom(launcher);
    // 过渡中取目标状态 margin，取较大值（避免关键盘时搜索条下移超过目标）
    int targetStateMarginBottom = -1;
    if (stateManager.isInTransition() && stateManager.getTargetState() != null) {
        targetStateMarginBottom = stateManager.getTargetState()
                .getFloatingSearchBarRestingMarginBottom(launcher);
        if (targetStateMarginBottom < 0) return targetStateMarginBottom; // 负值=移出屏幕
    }
    return Math.max(targetStateMarginBottom, currentStateMarginBottom);
}
```

为什么取较大值：过渡动画期间搜索条位置应保持稳定，取 `max` 确保它停在两者中更高的位置，避免在状态切换中途搜索条突兀下移。

### 面试深问

1. **为什么 AdapterHolder 用 `Arrays.asList(null, null, null)` 而不是 `new AdapterHolder[3]`？**
   `Arrays.asList` 返回固定大小 List，元素可 `set` 替换但不可 `add/remove`，语义上正好表达"三个固定槽位"。数组无法直接用 `forEach`，且 `Arrays.asList` 的不可变大小特性防止误扩容。

2. **SEARCH 的 AdapterHolder 为什么构造时传 `appsStore = null`？**
   搜索结果由 `setSearchResults()` 外部推送，不应监听全局 App 集合变化。若监听 Store，用户增删 app 时会清空当前搜索结果，体验断裂。`null` 让 `AlphabeticalAppsList` 不注册监听，保持搜索结果的独立性。

3. **`rebindAdapters` 为什么先 `unregisterIconContainer` 再 `register`？**
   RV 重建后旧的 `mRecyclerView` 引用失效，若不先解绑，Store 的图标更新仍会广播到已废弃的 RV，导致 `updateNotificationDots` 等回调操作已分离的 View。先解绑再重绑，保证图标更新只作用于当前活跃 RV。

---

## 3. 数据中枢：AllAppsStore

### 3.1 数据结构与初始化

```java
// 源码：AllAppsStore.java
@ActivityContextSingleton // Hilt/Dagger 作用域，每个 ActivityContext 单例
public class AllAppsStore {

    private static final String TAG = "AllAppsStore";
    public static final int DEFER_UPDATES_NEXT_DRAW = 1 << 0; // 延迟到下一帧绘制
    public static final int DEFER_UPDATES_TEST = 1 << 1;      // 测试用延迟

    private PackageUserKey mTempKey = new PackageUserKey(null, null); // 复用对象避免 GC
    private AppInfo mTempInfo = new AppInfo(); // 二分查找时的临时比较对象

    private @NonNull AppInfo[] mApps = EMPTY_ARRAY; // 核心数据：按 COMPONENT_KEY_COMPARATOR 排序

    private final List<OnUpdateListener> mUpdateListeners = new CopyOnWriteArrayList<>();
    private final ArrayList<ViewGroup> mIconContainers = new ArrayList<>(); // 需要刷新图标的 RV
    private Map<PackageUserKey, Integer> mPackageUserKeytoUidMap = Collections.emptyMap(); // 包→uid 映射
    private int mModelFlags;           // 模型状态位（quiet mode 等）
    private int mDeferUpdatesFlags = 0; // 延迟更新掩码
    private boolean mUpdatePending = false; // 延迟期间是否有待处理更新

    @Inject
    AllAppsStore() { } // 空构造，依赖注入
```

`@ActivityContextSingleton` 让每个 `ActivityContext`（如 Launcher 实例）共享同一个 Store 实例，`mActivityContext.getActivityComponent().getAppsStore()` 在容器构造时取出。`mApps` 是核心数组，要求**按 `COMPONENT_KEY_COMPARATOR` 排序**，这是 `getApp(ComponentKey)` 能用 `Arrays.binarySearch` 的前提。

为什么用数组而不是 List：
- 数组内存连续，CPU 缓存友好，遍历 200+ 个 app 时性能更好。
- 二分查找 `Arrays.binarySearch` 直接可用，无需装箱。
- 数组引用不可变（只能整体替换 `mApps = apps`），天然线程安全快照语义。

`CopyOnWriteArrayList` 承载监听器的原因：监听器注册/注销发生在 UI 线程（rebindAdapters），回调发生在 Model 推送线程，`CopyOnWriteArrayList` 的读无锁、写复制，避免回调时并发修改异常。

### 3.2 数据来源链路：AllAppsList → AllAppsStore

数据从后台 Model 推送的入口：

```java
// 源码：AllAppsStore.java
public void setApps(@Nullable AppInfo[] apps, int flags, Map<PackageUserKey, Integer> map) {
    mApps = apps == null ? EMPTY_ARRAY : apps;
    Log.d(TAG, "setApps: apps.length=" + mApps.length);
    mModelFlags = flags;
    notifyUpdate(); // 通知所有 OnUpdateListener
    mPackageUserKeytoUidMap = map; // 包+user → uid，用于通知圆点
}
```

`apps` 在后台已由 `AllAppsList` 排序（`COMPONENT_KEY_COMPARATOR`）并预计算 `sectionName`：

```java
// 源码：model/AllAppsList.java（相关片段）
private AlphabeticIndexCompat mIndex;
mIndex = new AlphabeticIndexCompat(LocaleList.getDefault()); // ICU 索引
info.sectionName = mIndex.computeSectionName(info.title); // 每个 app 算 sectionName
```

`notifyUpdate` 是广播入口，带延迟逻辑：

```java
// 源码：AllAppsStore.java
private void notifyUpdate() {
    if (mDeferUpdatesFlags != 0) {
        mUpdatePending = true; // 标记待处理，等延迟解除时再通知
        return;
    }
    for (OnUpdateListener listener : mUpdateListeners) {
        listener.onAppsUpdated(); // 逐个回调
    }
}
```

### 3.3 延迟更新防抖（Defer Updates）

```java
// 源码：AllAppsStore.java
public void enableDeferUpdates(int flag) {
    mDeferUpdatesFlags |= flag; // 置位
}

public void disableDeferUpdates(int flag) {
    mDeferUpdatesFlags &= ~flag; // 清位
    if (mDeferUpdatesFlags == 0 && mUpdatePending) {
        notifyUpdate(); // 所有延迟位都清零且有待处理更新，立即通知
        mUpdatePending = false;
    }
}
```

为什么需要延迟更新：
- Launcher 在状态切换动画期间（如从 All Apps 滑回 Workspace），若中途收到 `setApps`（比如后台刚装完一个 app），立即重建列表会导致动画卡顿或视觉跳变。
- `DEFER_UPDATES_NEXT_DRAW` 把更新推迟到下一帧绘制完成后，确保当前动画帧不受干扰。
- `DEFER_UPDATES_TEST` 给测试用，避免更新与断言竞态。

位掩码而非布尔值：多个延迟来源（动画、测试、将来扩展）可能同时存在，用掩码可独立置位/清位，互不干扰。`disableDeferUpdatesSilently` 清位但不触发通知，用于异常恢复。

### 3.4 getApp：二分查找

```java
// 源码：AllAppsStore.java
@Nullable
public AppInfo getApp(ComponentKey key) {
    return getApp(key, COMPONENT_KEY_COMPARATOR); // 默认比较器
}

@Nullable
public AppInfo getApp(ComponentKey key, Comparator<AppInfo> comparator) {
    mTempInfo.componentName = key.componentName; // 复用临时对象
    mTempInfo.user = key.user;
    int index = Arrays.binarySearch(mApps, mTempInfo, comparator); // 二分查找
    return index < 0 ? null : mApps[index];
}
```

`mTempInfo` 是成员变量复用，避免每次查找 new 对象。这是合法的，因为 `getApp` 只在 UI 线程调用，无并发问题。

`COMPONENT_KEY_COMPARATOR` 在 `AppInfo` 中定义，按 `componentName + user` 排序，保证唯一性——同一个组件在不同 user（如工作账户）下是两条记录。

### 3.5 图标更新：updateAllIcons

Store 不直接操作 Adapter，而是通过注册的 `mIconContainers`（即各 RV）广播：

```java
// 源码：AllAppsStore.java
public void updateNotificationDots(Predicate<PackageUserKey> updatedDots) {
    updateAllIcons((child) -> {
        if (child.getTag() instanceof ItemInfo) {
            ItemInfo info = (ItemInfo) child.getTag();
            if (mTempKey.updateFromItemInfo(info) && updatedDots.test(mTempKey)) {
                child.applyDotState(info, true /* animate */);
            }
        }
    });
}

private void updateAllIcons(Consumer<BubbleTextView> action) {
    for (int i = mIconContainers.size() - 1; i >= 0; i--) { // 倒序遍历，允许遍历中移除
        ViewGroup parent = mIconContainers.get(i);
        int childCount = parent.getChildCount();
        for (int j = 0; j < childCount; j++) {
            View child = parent.getChildAt(j);
            if (child instanceof BubbleTextView) {
                action.accept((BubbleTextView) child); // 对每个图标执行操作
            }
        }
    }
}
```

为什么倒序遍历：允许 `action` 内部触发 `unregisterIconContainer`（如 RV 被销毁），倒序遍历避免 `ConcurrentModificationException`。

为什么不通过 Adapter.notifyItemChanged：通知圆点、进度条这类**纯视觉更新**，走 RV 的 notify 会触发完整 rebind（包括 DiffUtil），开销大且可能打断滚动。直接遍历可见的 `BubbleTextView` 调 `applyDotState` 是最小开销路径。

### 面试深问

1. **`mApps` 为什么要预排序？直接 `List.contains` 不行吗？**
   `getApp(ComponentKey)` 在拖拽、点击、通知更新时被高频调用（每次点击图标都要查 AppInfo）。二分查找 O(log n)，线性查找 O(n)，200 个 app 时差 8 倍。预排序是空间换时间的标准做法。

2. **`updateAllIcons` 为什么遍历 RV 的子 View 而不是 Adapter 的数据集？**
   Adapter 数据集是全量，但屏幕上只有十几个图标可见。遍历 RV 子 View 只更新可见图标，未可见的会在滚动 rebind 时自然应用新状态。这是"按需更新"的性能优化。

3. **延迟更新的 `mUpdatePending` 为什么用布尔而不是计数？**
   延迟期间可能有多次 `setApps`（如批量安装），但语义上只需要知道"是否有待处理更新"，不需要知道几次。多次更新合并为一次 `notifyUpdate`，避免重复刷新列表。

---

## 4. 排序与分组引擎：AlphabeticalAppsList

### 4.1 字段与初始化

```java
// 源码：AlphabeticalAppsList.java
public class AlphabeticalAppsList implements AllAppsStore.OnUpdateListener {

    private final ActivityContext mActivityContext;
    private final List<AppInfo> mApps = new ArrayList<>();        // 个人区 app（排序后）
    private final List<AppInfo> mPrivateApps = new ArrayList<>(); // 私密空间 app
    @Nullable private final AllAppsStore mAllAppsStore;           // null 时不监听（搜索用）

    private int mAccessibilityResultsCount = 0; // 无障碍计数
    private final ArrayList<AdapterItem> mAdapterItems = new ArrayList<>(); // 给 Adapter 的最终列表
    private final List<FastScrollSectionInfo> mFastScrollerSections = new ArrayList<>(); // 快速滚动段表
    private final ArrayList<AdapterItem> mSearchResults = new ArrayList<>(); // 搜索结果
    private BaseAllAppsAdapter mAdapter;
    private AppInfoComparator mAppNameComparator;
    private int mNumAppsPerRowAllApps; // 每行 app 数（来自 DeviceProfile）
    private int mNumAppRowsInAdapter;  // 总行数
    private Predicate<ItemInfo> mItemFilter; // 过滤条件（个人/工作）

    public AlphabeticalAppsList(ActivityContext activityContext, @Nullable AllAppsStore appsStore,
            WorkProfileManager workProfileManager, PrivateProfileManager privateProfileManager) {
        mAllAppsStore = appsStore;
        mActivityContext = activityContext;
        Context context = activityContext.asContext();
        mAppNameComparator = new AppInfoComparator(context); // 本地化比较器
        mWorkProviderManager = workProfileManager;
        mPrivateProviderManager = privateProfileManager;
        mNumAppsPerRowAllApps = mActivityContext.getDeviceProfile().numShownAllAppsColumns;
        if (mAllAppsStore != null) {
            mAllAppsStore.addUpdateListener(this); // 自动监听 Store 更新
        }
        // 私密空间快速滚动徽章（ImageSpan 包裹一个空格）
        mPrivateProfileAppScrollerBadge = new SpannableString(" ");
        mPrivateProfileAppScrollerBadge.setSpan(new ImageSpan(context,
                R.drawable.ic_private_profile_app_scroller_badge, ImageSpan.ALIGN_CENTER),
                0, 1, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE);
        // ...
    }
```

### 4.2 onAppsUpdated 完整流程

`onAppsUpdated` 是核心重建逻辑，Store 变更时触发：

```java
// 源码：AlphabeticalAppsList.java
@Override
public void onAppsUpdated() {
    // 私密空间动画进行中不更新，否则会打断展开/收起动画
    if (mAllAppsStore == null || (mPrivateProviderManager != null &&
            mPrivateProviderManager.getAnimationRunning())) {
        return;
    }
    mApps.clear();
    mPrivateApps.clear();

    // 拆分：普通 app（排除私密空间壳 app）与私密 app
    Stream<AppInfo> appSteam = Stream.of(mAllAppsStore.getApps()).filter(
            info -> !isPrivateSpaceApp(info)); // 排除 com.android.privatespace
    Stream<AppInfo> privateAppStream = Stream.of(mAllAppsStore.getApps());

    // 非搜索态且设置了过滤条件，按过滤条件筛选
    if (!hasSearchResults() && mItemFilter != null) {
        appSteam = appSteam.filter(mItemFilter); // 个人区过滤（mPersonalMatcher 或工作 matcher）
        if (mPrivateProviderManager != null) {
            privateAppStream = privateAppStream
                    .filter(mPrivateProviderManager.getItemInfoMatcher());
        }
    }
    // 排序：AppInfoComparator（内部 Collator 本地化排序）
    appSteam = appSteam.sorted(mAppNameComparator);
    privateAppStream = privateAppStream.sorted(mAppNameComparator);

    // 简体中文特殊：section 归并
    Locale curLocale = mActivityContext.asContext().getResources().getConfiguration().locale;
    boolean localeRequiresSectionSorting = curLocale.equals(Locale.SIMPLIFIED_CHINESE);
    if (localeRequiresSectionSorting) {
        // 按 sectionName 分组，用 TreeMap(LabelComparator) 保证组间有序，再展平
        appSteam = appSteam.collect(Collectors.groupingBy(
                info -> info.sectionName,
                () -> new TreeMap<>(new LabelComparator()), // 组间按 LabelComparator 排序
                Collectors.toCollection(ArrayList::new)))
                .values().stream().flatMap(ArrayList::stream); // 展平回 Stream
    }

    appSteam.forEachOrdered(mApps::add);
    privateAppStream.forEachOrdered(mPrivateApps::add);
    if (mSearchResults.isEmpty()) {
        updateAdapterItems(); // 重建 AdapterItem 列表
    }
}
```

### 4.3 sectionName 的计算：ICU AlphabeticIndex

`sectionName` 在后台 `AllAppsList` 中用 `AlphabeticIndexCompat` 计算：

```java
// 源码：compat/AlphabeticIndexCompat.java
public class AlphabeticIndexCompat {
    private static final String MID_DOT = "\u2219"; // 间隔点 ·
    private final String mDefaultMiscLabel;
    private final AlphabeticIndex.ImmutableIndex mBaseIndex; // ICU 不可变索引

    public AlphabeticIndexCompat(LocaleList locales) {
        int localeCount = locales.size();
        Locale primaryLocale = localeCount == 0 ? Locale.ENGLISH : locales.get(0);
        AlphabeticIndex indexBuilder = new AlphabeticIndex(primaryLocale); // 主 locale
        for (int i = 1; i < localeCount; i++) {
            indexBuilder.addLabels(locales.get(i)); // 添加次 locale
        }
        indexBuilder.addLabels(Locale.ENGLISH); // 兜底英文
        mBaseIndex = indexBuilder.buildImmutableIndex(); // 构建不可变索引

        if (primaryLocale.getLanguage().equals(Locale.JAPANESE.getLanguage())) {
            mDefaultMiscLabel = "\u4ed6"; // 日文「他」
        } else {
            mDefaultMiscLabel = MID_DOT; // 其他语言用 ·
        }
    }

    public String computeSectionName(@NonNull CharSequence cs) {
        String s = Utilities.trim(cs);
        // ICU 算出 bucket label
        String sectionName = mBaseIndex.getBucket(mBaseIndex.getBucketIndex(s)).getLabel();
        if (Utilities.trim(sectionName).isEmpty() && s.length() > 0) {
            // ICU 无法归类（如表情、特殊符号）
            int c = s.codePointAt(0);
            boolean startsWithDigit = Character.isDigit(c);
            if (startsWithDigit) {
                return "#"; // 数字归到 #
            } else if (Character.isLetter(c)) {
                return mDefaultMiscLabel; // 字母但非本语言（如中文里的俄文）归到 ·
            } else {
                return MID_DOT; // 纯符号归到 ·
            }
        }
        return sectionName;
    }
}
```

为什么用 ICU `AlphabeticIndex` 而不是自己写拼音库：
- ICU（International Components for Unicode）是业界标准，覆盖所有 locale 的字母分桶规则。中文场景下，ICU 内置拼音索引（`zh` locale），能把"微信"归到 "W" 桶，无需自己维护拼音映射表。
- 自己写拼音库需要：汉字→拼音表（几万条）、多音字处理、声调、繁简转换。维护成本极高且容易出错。
- ICU 的 `addLabels(Locale.ENGLISH)` 兜底：主 locale 无法归类时回退到英文桶，保证任何字符都有归属。
- `buildImmutableIndex` 返回不可变索引，线程安全且查找 O(log buckets)，性能远优于每次调用 Collator。

`computeSectionName` 的兜底逻辑：ICU 对某些字符（表情、组合符）可能返回空 label，此时手动归类——数字到 `#`、字母到 `·`、符号到 `·`。这保证快速滚动条上每个 app 都能定位到某个 section。

### 4.4 AppInfoComparator + LabelComparator + Collator 本地化排序

```java
// 源码：AppInfoComparator.java
public class AppInfoComparator implements Comparator<AppInfo> {
    private final UserCache mUserManager;
    private final UserHandle mMyUser;       // 当前用户
    private final LabelComparator mLabelComparator;

    public AppInfoComparator(Context context) {
        mUserManager = UserCache.INSTANCE.get(context);
        mMyUser = Process.myUserHandle();
        mLabelComparator = new LabelComparator();
    }

    @Override
    public int compare(AppInfo a, AppInfo b) {
        // 第一优先级：title 本地化比较
        int result = mLabelComparator.compare(getSortingTitle(a), getSortingTitle(b));
        if (result != 0) return result;
        // title 相同时：componentName 字典序
        result = a.componentName.compareTo(b.componentName);
        if (result != 0) return result;
        // componentName 也相同时（极少见，如同名不同 user）：当前用户优先
        if (mMyUser.equals(a.user)) return -1;
        Long aUserSerial = mUserManager.getSerialNumberForUser(a.user);
        Long bUserSerial = mUserManager.getSerialNumberForUser(b.user);
        return aUserSerial.compareTo(bUserSerial);
    }

    private String getSortingTitle(AppInfo info) {
        if (!TextUtils.isEmpty(info.appTitle)) return info.appTitle.toString(); // 优先 appTitle
        if (info.title != null) return info.title.toString(); // 其次 title
        return "";
    }
}
```

`LabelComparator` 的核心是 `Collator`：

```java
// 源码：util/LabelComparator.java
public class LabelComparator implements Comparator<String> {
    private final Collator mCollator = Collator.getInstance(); // 当前 locale 的 Collator

    @Override
    public int compare(String titleA, String titleB) {
        // 把非字母数字开头的标题降权排到最后（如以表情、符号开头的 app）
        boolean aStartsWithLetter = (titleA.length() > 0) &&
                Character.isLetterOrDigit(titleA.codePointAt(0));
        boolean bStartsWithLetter = (titleB.length() > 0) &&
                Character.isLetterOrDigit(titleB.codePointAt(0));
        if (aStartsWithLetter && !bStartsWithLetter) return -1;
        else if (!aStartsWithLetter && bStartsWithLetter) return 1;
        // 本地化排序
        return mCollator.compare(titleA, titleB);
    }
}
```

三层比较的设计意图：
- `LabelComparator`：本地化字符串比较。`Collator.getInstance()` 在 Android N+ 用 ICU 实现，对中文按拼音排序（"百度" < "淘宝" 因为 B < T），对德文按 ä 排序规则，完全跟随系统 locale。
- 非字母数字降权：以符号/表情开头的 app（如 "♡Chat"）排到列表末尾，避免污染字母序。
- `componentName` 兜底：两个 app 同名（如两个浏览器都叫"浏览器"）时，按包名确定性排序，保证顺序稳定。
- `user` 优先级：同名同包名跨 user（个人与工作账户的同一个 app），当前用户的排前面。

### 4.5 简体中文 section 归并特殊处理

回到 `onAppsUpdated` 的中文分支：

```java
// 源码：AlphabeticalAppsList.java
boolean localeRequiresSectionSorting = curLocale.equals(Locale.SIMPLIFIED_CHINESE);
if (localeRequiresSectionSorting) {
    appSteam = appSteam.collect(Collectors.groupingBy(
            info -> info.sectionName,                           // 按 sectionName 分组
            () -> new TreeMap<>(new LabelComparator()),         // 组间用 LabelComparator 排序
            Collectors.toCollection(ArrayList::new)))           // 组内保持原 sorted 顺序
            .values().stream().flatMap(ArrayList::stream);      // 展平
}
```

为什么中文要特殊归并：
- ICU 对简体中文生成的 `sectionName` 可能包含**拼音桶**（如 "B"、"W"）和**笔画/部首桶**（如某些字归到非字母桶）。如果直接用 sectionName 顺序，同一个字母桶的 app 可能被非字母桶打断。
- `Collectors.groupingBy` 按 sectionName 聚合，`TreeMap(LabelComparator)` 保证组间按 LabelComparator（Collator 拼音序）排序，组内保持 `AppInfoComparator` 已排好的顺序。
- 展平后，所有 "B" 桶的 app 连续排列，"W" 桶的 app 连续排列，快速滚动的 section 跳转才能定位到连续区块。

其他语言不需要：英文 locale 下 ICU 的 sectionName 已经是连续字母（A/B/C...），`AppInfoComparator` 排序后天然连续，无需二次归并。

### 4.6 updateAdapterItems：生成最终列表与 DiffUtil

```java
// 源码：AlphabeticalAppsList.java
public void updateAdapterItems() {
    List<AdapterItem> oldItems = new ArrayList<>(mAdapterItems); // 保存旧列表供 DiffUtil
    mFastScrollerSections.clear();
    mAdapterItems.clear();
    mAccessibilityResultsCount = 0;

    if (hasSearchResults()) {
        mAdapterItems.addAll(mSearchResults); // 搜索态直接用搜索结果
    } else {
        int position = 0;
        boolean addApps = true;
        // 工作资料：先加教育卡片/暂停卡片
        if (mWorkProviderManager != null) {
            position += mWorkProviderManager.addWorkItems(mAdapterItems);
            addApps = mWorkProviderManager.shouldShowWorkApps();
        }
        if (addApps) {
            if (position == 1) { // 教育卡片在 0 号位，加对应 section
                mFastScrollerSections.add(new FastScrollSectionInfo(
                        mActivityContext.asContext().getResources()
                                .getString(R.string.work_profile_edu_section), 0));
            }
            position = addAppsWithSections(mApps, position); // 核心：加 app 并建 section
        }
        if (Flags.enablePrivateSpace()) {
            position = addPrivateSpaceItems(position); // 加私密空间 header + app
        }
        if (!mFastScrollerSections.isEmpty()) {
            // 末尾加一个占位 item，让用户能滚到底部
            mAdapterItems.add(new AdapterItem(VIEW_TYPE_BOTTOM_VIEW_TO_SCROLL_TO));
            mFastScrollerSections.add(new FastScrollSectionInfo(
                    mFastScrollerSections.get(mFastScrollerSections.size() - 1).sectionName,
                    position++)); // 复制最后一个 section 名，position 指向占位
        }
    }
    // 无障碍计数（只数 ICON 类型）
    mAccessibilityResultsCount = (int) mAdapterItems.stream()
            .filter(AdapterItem::isCountedForAccessibility).count();

    // 计算每个 item 的 rowIndex / rowAppIndex（用于网格布局）
    if (mNumAppsPerRowAllApps != 0) {
        int numAppsInSection = 0, numAppsInRow = 0, rowIndex = -1;
        for (AdapterItem item : mAdapterItems) {
            item.rowIndex = 0;
            if (BaseAllAppsAdapter.isDividerViewType(item.viewType)
                    || BaseAllAppsAdapter.isPrivateSpaceHeaderView(item.viewType)
                    || BaseAllAppsAdapter.isPrivateSpaceSysAppsDividerView(item.viewType)) {
                numAppsInSection = 0; // 分隔符/header 重置行计数
            } else if (BaseAllAppsAdapter.isIconViewType(item.viewType)) {
                if (numAppsInSection % mNumAppsPerRowAllApps == 0) {
                    numAppsInRow = 0;
                    rowIndex++;
                }
                item.rowIndex = rowIndex;
                item.rowAppIndex = numAppsInRow; // 行内第几个
                numAppsInSection++;
                numAppsInRow++;
            }
        }
        mNumAppRowsInAdapter = rowIndex + 1;
    }

    // DiffUtil 增量刷新
    if (mAdapter != null) {
        DiffUtil.calculateDiff(new MyDiffCallback(oldItems, mAdapterItems), false)
                .dispatchUpdatesTo(mAdapter);
    }
}
```

`addAppsWithSections` 是 section 创建的核心：

```java
// 源码：AlphabeticalAppsList.java
private int addAppsWithSections(List<AppInfo> appList, int startPosition) {
    String lastSectionName = null;
    int position = startPosition;
    for (int i = 0; i < appList.size(); i++) {
        AppInfo info = appList.get(i);
        // 普通区 vs 私密区：私密区加 DecorationInfo（圆角背景）
        if (hasPrivateApps) {
            mAdapterItems.add(AdapterItem.asAppWithDecorationInfo(info,
                    new SectionDecorationInfo(mActivityContext.asContext(),
                            getRoundRegions(i, appList.size())), isPrivateSpaceApp(info)));
        } else {
            mAdapterItems.add(AdapterItem.asApp(info));
        }

        String sectionName = info.sectionName;
        if (!sectionName.equals(lastSectionName)) { // section 名变化，新建 section
            lastSectionName = sectionName;
            FastScrollSectionInfo sectionInfo = new FastScrollSectionInfo(
                    usePrivateAppScrollerBadge ? mPrivateProfileAppScrollerBadge : sectionName,
                    position); // 记录该 section 在 mAdapterItems 中的起始位置
            mFastScrollerSections.add(sectionInfo);
        }
        position++;
    }
    return position;
}
```

设计要点：`sectionName` 在 `AppInfo` 中预计算（后台 ICU），这里只做"与前一个不同则新建 section"的连续判断，O(n) 单次遍历。`FastScrollSectionInfo.position` 记录的是 adapter position，快速滚动时直接 `scrollToPosition`。

`getRoundRegions` 决定私密区 app 的圆角：

```java
// 源码：AlphabeticalAppsList.java
@VisibleForTesting
int getRoundRegions(int appIndex, int appListSize) {
    int numberOfAppRows = (int) Math.ceil((double) appListSize / mNumAppsPerRowAllApps);
    int roundRegion = ROUND_NOTHING;
    if ((appIndex / mNumAppsPerRowAllApps) == numberOfAppRows - 1) { // 最后一行
        if ((appIndex % mNumAppsPerRowAllApps) == 0) {
            roundRegion = ROUND_BOTTOM_LEFT; // 第一列：左下圆角
        } else if ((appIndex % mNumAppsPerRowAllApps) == mNumAppsPerRowAllApps - 1) {
            roundRegion = ROUND_BOTTOM_RIGHT; // 最后列：右下圆角
        }
        if (appIndex == appListSize - 1) {
            roundRegion |= ROUND_BOTTOM_RIGHT; // 最后一个强制右下圆角
        }
    }
    return roundRegion;
}
```

### 4.7 DiffUtil 增量刷新

```java
// 源码：AlphabeticalAppsList.java
private static class MyDiffCallback extends DiffUtil.Callback {
    private final List<AdapterItem> mOldList;
    private final List<AdapterItem> mNewList;

    @Override
    public boolean areItemsTheSame(int oldItemPosition, int newItemPosition) {
        return mOldList.get(oldItemPosition).isSameAs(mNewList.get(newItemPosition));
    }

    @Override
    public boolean areContentsTheSame(int oldItemPosition, int newItemPosition) {
        return mOldList.get(oldItemPosition).isContentSame(mNewList.get(newItemPosition));
    }
}
```

`AdapterItem.isSameAs` 与 `isContentSame`：

```java
// 源码：BaseAllAppsAdapter.java AdapterItem
public boolean isSameAs(AdapterItem other) {
    return (other.viewType == viewType) && (other.getClass() == getClass());
}

public boolean isContentSame(AdapterItem other) {
    return itemInfo == null && other.itemInfo == null; // 无 itemInfo 视为内容相同
}
```

为什么用 DiffUtil 而不是 `notifyDataSetChanged`：
- `notifyDataSetChanged` 会重建所有可见 ViewHolder，触发全量 `onBindViewHolder`，200 个 app 时明显卡顿。
- DiffUtil 用 Eugene W. Myers 差分算法（O(ND)）计算最小变更集，只对变化的 item 发 `notifyItemInserted/Removed/Changed`，未变化的复用旧 ViewHolder。
- `calculateDiff(callback, false)` 第二参数 `false` 表示不检测移动（move），因为 app 列表是排序后的，移动等价于删除+插入，省去移动检测开销。

`areItemsTheSame` 只比 `viewType` 和 `getClass()`，不比 `itemInfo`：这是 DiffUtil 的"身份"判断，相同身份才会进一步比 `areContentsTheSame`。两个 `VIEW_TYPE_ICON` 的 item 被视为同一身份（因为都是图标行），内容比较 `itemInfo == null` 这里实际是宽松判断——Launcher 默认 `setItemAnimator(null)`（见 AdapterHolder.setup），不做 item 动画，DiffUtil 主要用于精确的 insert/remove 定位。

### 4.8 FastScrollSectionInfo

```java
// 源码：AlphabeticalAppsList.java
public static class FastScrollSectionInfo {
    public final CharSequence sectionName; // section 名（字母或徽章）
    public final int position;             // adapter position
    public int id = -1;                    // 用于字母列表 View 的 id

    public FastScrollSectionInfo(CharSequence sectionName, int position) {
        this.sectionName = sectionName;
        this.position = position;
    }
}
```

`sectionName` 是 `CharSequence` 而非 `String`，因为私密空间的 section 用 `ImageSpan`（图标徽章）而非文字。`id` 在 `setLettersToScrollLayout` 中由 `View.generateViewId()` 赋值，用于 ConstraintLayout 的链式约束。

### 面试深问

1. **为什么 `sectionName` 在后台算好而不是前台 `onAppsUpdated` 里算？**
   ICU `AlphabeticIndex.getBucketIndex` 虽然是 O(log)，但 200 个 app 累计仍是可观开销。后台 Model 线程算好后存入 `AppInfo.sectionName`，前台只做比较和分组，UI 线程零 ICU 调用。这也是 `sectionName` 是 `AppInfo` 字段而非运行时计算的原因。

2. **DiffUtil 的 `areContentsTheSame` 为什么只判 `itemInfo == null`，不比 AppInfo 内容？**
   Launcher `setItemAnimator(null)`，不依赖内容变更触发局部刷新动画。DiffUtil 的主要价值是计算 insert/remove 的精确位置，避免全量刷新。内容变化（如标题改变）由 Store 的图标更新路径（`updateAllIcons`）单独处理，不走 DiffUtil。

3. **简体中文归并为什么用 `TreeMap(LabelComparator)` 而不是 `HashMap`？**
   `HashMap` 无序，展平后 section 顺序不可预测。`TreeMap` 按 key 排序，key 是 sectionName，用 `LabelComparator`（Collator）排序保证拼音字母序（B 在 W 前）。展平后连续的字母区块才能正确支持快速滚动定位。

---

## 5. 适配器：BaseAllAppsAdapter 与 AllAppsGridAdapter

### 5.1 位掩码 ViewType 体系

```java
// 源码：BaseAllAppsAdapter.java
public static final int VIEW_TYPE_ICON = 1 << 1;                       // 普通图标 (2)
public static final int VIEW_TYPE_EMPTY_SEARCH = 1 << 2;               // 空搜索结果 (4)
public static final int VIEW_TYPE_ALL_APPS_DIVIDER = 1 << 3;           // 分隔符 (8)
public static final int VIEW_TYPE_WORK_EDU_CARD = 1 << 4;              // 工作教育卡片 (16)
public static final int VIEW_TYPE_WORK_DISABLED_CARD = 1 << 5;         // 工作已暂停卡片 (32)
public static final int VIEW_TYPE_PRIVATE_SPACE_HEADER = 1 << 6;       // 私密空间 header (64)
public static final int VIEW_TYPE_PRIVATE_SPACE_SYS_APPS_DIVIDER = 1 << 7; // 私密系统 app 分隔 (128)
public static final int VIEW_TYPE_BOTTOM_VIEW_TO_SCROLL_TO = 1 << 8;   // 底部占位 (256)
public static final int VIEW_TYPE_PRIVATE_SPACE_APP_ICON = 1 << 9;     // 私密空间图标 (512)
public static final int NEXT_ID = 10;                                  // 下一个位移

// 掩码：用于"是否属于某类"的判断
public static final int VIEW_TYPE_MASK_DIVIDER = VIEW_TYPE_ALL_APPS_DIVIDER;
public static final int VIEW_TYPE_MASK_ICON = VIEW_TYPE_ICON | VIEW_TYPE_PRIVATE_SPACE_APP_ICON;
public static final int VIEW_TYPE_MASK_PRIVATE_SPACE_HEADER = VIEW_TYPE_PRIVATE_SPACE_HEADER;
public static final int VIEW_TYPE_MASK_PRIVATE_SPACE_SYS_APPS_DIVIDER =
        VIEW_TYPE_PRIVATE_SPACE_SYS_APPS_DIVIDER;
```

为什么用位掩码（`1 << n`）而不是连续整数（0,1,2,3...）：
- 单个 ViewType 是 2 的幂，可以用**按位或**组合成掩码。`VIEW_TYPE_MASK_ICON = VIEW_TYPE_ICON | VIEW_TYPE_PRIVATE_SPACE_APP_ICON` 一次判断"是不是任何图标"。
- `isIconViewType` 等判断用 `(viewType & mask) != 0`，一次按位运算覆盖多个类型。
- 新增类型只需 `1 << NEXT_ID`，不破坏既有掩码语义。
- `RecyclerView` 的 `getItemViewType` 返回 int，位掩码天然兼容。

判断方法：

```java
// 源码：BaseAllAppsAdapter.java
public static boolean isDividerViewType(int viewType) {
    return isViewType(viewType, VIEW_TYPE_MASK_DIVIDER);
}
public static boolean isIconViewType(int viewType) {
    return isViewType(viewType, VIEW_TYPE_MASK_ICON); // 普通图标或私密图标都算
}
protected static boolean isViewType(int viewType, int viewTypeMask) {
    return (viewType & viewTypeMask) != 0;
}
```

### 5.2 AdapterItem 包装

```java
// 源码：BaseAllAppsAdapter.java
public static class AdapterItem {
    public final int viewType;       // 类型（不可变）
    public int rowIndex;             // 所在行（网格用）
    public int rowAppIndex;          // 行内序号
    public AppInfo itemInfo = null;  // 关联的 AppInfo（图标类才有）
    public SectionDecorationInfo decorationInfo = null; // 私密区装饰

    public AdapterItem(int viewType) {
        this.viewType = viewType;
    }

    // 工厂方法：普通图标
    public static AdapterItem asApp(AppInfo appInfo) {
        AdapterItem item = new AdapterItem(VIEW_TYPE_ICON);
        item.itemInfo = appInfo;
        return item;
    }

    // 工厂方法：带装饰的图标（私密空间）
    public static AdapterItem asAppWithDecorationInfo(AppInfo appInfo,
            SectionDecorationInfo decorationInfo, boolean isPrivateSpaceApp) {
        AdapterItem item = new AdapterItem(isPrivateSpaceApp ? VIEW_TYPE_PRIVATE_SPACE_APP_ICON
                : VIEW_TYPE_ICON); // 私密空间用独立的 ViewType（点击行为不同）
        item.itemInfo = appInfo;
        item.decorationInfo = decorationInfo;
        return item;
    }

    protected boolean isCountedForAccessibility() {
        return viewType == VIEW_TYPE_ICON; // 只有普通图标计入无障碍计数
    }
}
```

工厂方法的设计意图：构造 `AdapterItem` 只通过 `asApp` / `asAppWithDecorationInfo`，保证 `viewType` 与 `itemInfo` 的搭配正确（图标类必有 itemInfo，header 类可有可无）。`VIEW_TYPE_PRIVATE_SPACE_APP_ICON` 与 `VIEW_TYPE_ICON` 分离，因为私密空间图标的点击行为不同（弹 PopupContainerWithArrow 而非直接启动）。

### 5.3 onCreateViewHolder / onBindViewHolder 类型分发

```java
// 源码：BaseAllAppsAdapter.java
@Override
public ViewHolder onCreateViewHolder(ViewGroup parent, int viewType) {
    switch (viewType) {
        case VIEW_TYPE_ICON:
            return new ViewHolder(getIconOnCreateSetup(parent)); // 普通 BubbleTextView
        case VIEW_TYPE_PRIVATE_SPACE_APP_ICON:
            BubbleTextView icon = getIconOnCreateSetup(parent);
            // 私密图标：点击/长按都弹 PopupContainerWithArrow（需先解锁）
            icon.setOnClickListener(v -> PopupContainerWithArrow.showForPrivateSpaceApp(icon));
            icon.setOnLongClickListener(v -> {
                PopupContainerWithArrow.showForPrivateSpaceApp(icon);
                return true;
            });
            return new ViewHolder(icon);
        case VIEW_TYPE_EMPTY_SEARCH:
            return new ViewHolder(mLayoutInflater.inflate(R.layout.all_apps_empty_search, parent, false));
        case VIEW_TYPE_ALL_APPS_DIVIDER, VIEW_TYPE_PRIVATE_SPACE_SYS_APPS_DIVIDER:
            return new ViewHolder(mLayoutInflater.inflate(R.layout.private_space_divider, parent, false));
        case VIEW_TYPE_WORK_EDU_CARD:
            return new ViewHolder(mLayoutInflater.inflate(R.layout.work_apps_edu, parent, false));
        case VIEW_TYPE_WORK_DISABLED_CARD:
            return new ViewHolder(mLayoutInflater.inflate(R.layout.work_apps_paused, parent, false));
        case VIEW_TYPE_PRIVATE_SPACE_HEADER:
            return new ViewHolder(mLayoutInflater.inflate(R.layout.private_space_header, parent, false));
        case VIEW_TYPE_BOTTOM_VIEW_TO_SCROLL_TO:
            return new ViewHolder(new View(mActivityContext.asContext())); // 空 View，仅占位
        default:
            // 插件扩展的 ViewType 交给 SearchAdapterProvider
            if (mAdapterProvider.isViewSupported(viewType)) {
                return mAdapterProvider.onCreateViewHolder(mLayoutInflater, parent, viewType);
            }
            throw new RuntimeException("Unexpected view type" + viewType);
    }
}
```

`onBindViewHolder` 按类型分发绑定逻辑：

```java
// 源码：BaseAllAppsAdapter.java
@Override
public void onBindViewHolder(ViewHolder holder, int position) {
    holder.itemView.setVisibility(View.VISIBLE);
    switch (holder.getItemViewType()) {
        case VIEW_TYPE_PRIVATE_SPACE_APP_ICON:
        case VIEW_TYPE_ICON: {
            AdapterItem adapterItem = mApps.getAdapterItems().get(position);
            BubbleTextView icon = (BubbleTextView) holder.itemView;
            icon.reset(); // 清空旧状态（复用 ViewHolder 必须）
            icon.applyFromApplicationInfo(adapterItem.itemInfo); // 应用 AppInfo
            icon.setOnFocusChangeListener(mIconFocusListener);
            icon.configureMinimalPopup(holder.getItemViewType() == VIEW_TYPE_PRIVATE_SPACE_APP_ICON);
            // 私密空间过渡动画：展开时图标 alpha 从 0 渐显
            PrivateProfileManager ppm = mApps.getPrivateProfileManager();
            if (ppm != null) {
                boolean isPrivateSpaceItem = ppm.isPrivateSpaceItem(adapterItem);
                if (icon.getAlpha() == 0 || icon.getAlpha() == 1) {
                    icon.setAlpha(isPrivateSpaceItem && ppm.isStateTransitioning()
                            && (ppm.isScrolling() || ppm.getReadyToAnimate())
                            && ppm.getCurrentState() == STATE_ENABLED ? 0 : 1);
                }
                // 锁定时隐藏私密图标
                if (ppm.getCurrentState() == STATE_DISABLED && isPrivateSpaceItem) {
                    adapterItem.decorationInfo = null;
                    icon.setVisibility(GONE);
                }
            }
            break;
        }
        case VIEW_TYPE_EMPTY_SEARCH: {
            AppInfo info = mApps.getAdapterItems().get(position).itemInfo;
            if (info != null) {
                // 用 query 作为标题显示"未找到 'query'"
                ((TextView) holder.itemView).setText(mActivityContext.asContext().getString(
                        R.string.all_apps_no_search_results, info.title));
            }
            break;
        }
        case VIEW_TYPE_PRIVATE_SPACE_HEADER: {
            RelativeLayout psHeaderLayout = holder.itemView.findViewById(R.id.ps_header_layout);
            mApps.getPrivateProfileManager().bindPrivateSpaceHeaderViewElements(psHeaderLayout);
            AdapterItem adapterItem = mApps.getAdapterItems().get(position);
            // header 的圆角：锁定时四角全圆，解锁时只顶部圆
            int roundRegions = ROUND_TOP_LEFT | ROUND_TOP_RIGHT;
            if (mApps.getPrivateProfileManager().getCurrentState() == STATE_DISABLED) {
                roundRegions |= (ROUND_BOTTOM_LEFT | ROUND_BOTTOM_RIGHT);
            }
            adapterItem.decorationInfo = new SectionDecorationInfo(mActivityContext.asContext(), roundRegions);
            break;
        }
        case VIEW_TYPE_BOTTOM_VIEW_TO_SCROLL_TO:
        case VIEW_TYPE_ALL_APPS_DIVIDER:
        case VIEW_TYPE_WORK_DISABLED_CARD:
            break; // 这些 View 无需绑定数据
        case VIEW_TYPE_WORK_EDU_CARD:
            ((WorkEduCard) holder.itemView).setPosition(position); // 教育卡片记录位置（滑动后消失）
            break;
        default:
            if (mAdapterProvider.isViewSupported(holder.getItemViewType())) {
                mAdapterProvider.onBindView(holder, position); // 插件绑定
            }
    }
}
```

图标 View 的创建：

```java
// 源码：BaseAllAppsAdapter.java
private BubbleTextView getIconOnCreateSetup(ViewGroup parent) {
    // 两行标题开关（设备配置）
    int layout = mActivityContext.getDeviceProfile().inv.enableTwoLinesInAllApps
            ? R.layout.all_apps_icon_twoline : R.layout.all_apps_icon;
    BubbleTextView icon = (BubbleTextView) mLayoutInflater.inflate(layout, parent, false);
    icon.setLongPressTimeoutFactor(1f); // 长按超时系数 1（不延长）
    icon.setOnFocusChangeListener(mIconFocusListener);
    icon.setOnClickListener(mOnIconClickListener);    // 来自 ActivityContext
    icon.setOnLongClickListener(mOnIconLongClickListener);
    // 图标高度对齐 workspace 图标
    icon.getLayoutParams().height =
            mActivityContext.getDeviceProfile().getAllAppsProfile().getCellHeightPx();
    return icon;
}
```

`onFailedToRecycleView` 强制返回 true：

```java
// 源码：BaseAllAppsAdapter.java
@Override
public boolean onFailedToRecycleView(ViewHolder holder) {
    return true; // 总是回收，bind 时 reset() 清状态
}
```

设计意图：默认 RecyclerView 在 ViewHolder 状态不确定时会丢弃而非回收。这里强制回收，靠 `icon.reset()` 在 `onBindViewHolder` 清理状态，减少 inflate。

### 5.4 GridSpanSizer 跨列布局

```java
// 源码：AllAppsGridAdapter.java
public class GridSpanSizer extends GridLayoutManager.SpanSizeLookup {
    public GridSpanSizer() {
        super();
        setSpanIndexCacheEnabled(true); // 缓存 span index，避免重复计算
    }

    @Override
    public int getSpanSize(int position) {
        int totalSpans = mGridLayoutMgr.getSpanCount();
        List<AdapterItem> items = mApps.getAdapterItems();
        if (position >= items.size()) return totalSpans;
        int viewType = items.get(position).viewType;
        if (isIconViewType(viewType)) {
            return totalSpans / mAppsPerRow; // 图标占 1 列（totalSpans / 列数）
        } else {
            if (mAdapterProvider.isViewSupported(viewType)) {
                return totalSpans / mAdapterProvider.getItemsPerRow(viewType, mAppsPerRow);
            }
            return totalSpans; // 非 icon（header/divider）占满整行
        }
    }
}
```

`totalSpans` 的计算考虑插件的多列需求：

```java
// 源码：AllAppsGridAdapter.java
@Override
public void setAppsPerRow(int appsPerRow) {
    mAppsPerRow = appsPerRow;
    int totalSpans = mAppsPerRow;
    for (int itemPerRow : mAdapterProvider.getSupportedItemsPerRowArray()) {
        if (totalSpans % itemPerRow != 0) {
            totalSpans *= itemPerRow; // 取最小公倍数，让插件行也能整除
        }
    }
    mGridLayoutMgr.setSpanCount(totalSpans);
}
```

为什么取最小公倍数：假设每行 4 个 app，插件搜索结果想每行 2 个。若 `totalSpans=4`，插件的 `getSpanSize` 返回 `4/2=2`，app 返回 `4/4=1`，都能整除。但如果插件想每行 3 个，`4%3!=0`，`totalSpans=12`，app 返回 `12/4=3`，插件返回 `12/3=4`，都能整除。最小公倍数保证所有行类型都能正确分配 span。

`setSpanIndexCacheEnabled(true)`：`SpanSizeLookup.getSpanIndex` 计算复杂（需回溯累加 span），缓存后避免每次布局重算。

### 5.5 AppsGridLayoutManager 的无障碍处理

```java
// 源码：AllAppsGridAdapter.java
public class AppsGridLayoutManager extends ScrollableLayoutManager {
    @Override
    public void onInitializeAccessibilityEvent(AccessibilityEvent event) {
        super.onInitializeAccessibilityEvent(event);
        final AccessibilityRecordCompat record = AccessibilityEventCompat.asRecord(event);
        record.setItemCount(mApps.getNumFilteredApps()); // 只报告 app 数，不含 header/divider
        // 索引偏移：减去非 app 行，让无障碍服务报告的索引与用户感知一致
        record.setFromIndex(Math.max(0,
                record.getFromIndex() - getRowsNotForAccessibility(record.getFromIndex())));
        record.setToIndex(Math.max(0,
                record.getToIndex() - getRowsNotForAccessibility(record.getToIndex())));
    }

    private int getRowsNotForAccessibility(int adapterPosition) {
        List<AdapterItem> items = mApps.getAdapterItems();
        int extraRows = 0;
        for (int i = 0; i <= adapterPosition && i < items.size(); i++) {
            if (!isViewType(items.get(i).viewType, VIEW_TYPE_MASK_ICON)) {
                extraRows++; // 非 icon 行不计入无障碍索引
            }
        }
        return extraRows;
    }

    @Override
    protected int incrementTotalHeight(Adapter adapter, int position, int heightUntilLastPos) {
        AllAppsGridAdapter.AdapterItem item = mApps.getAdapterItems().get(position);
        // 同一行的 app 只算一次高度（行内图标等高）
        return (isIconViewType(item.viewType) && item.rowAppIndex != 0)
                ? heightUntilLastPos
                : (heightUntilLastPos + mCachedSizes.get(item.viewType));
    }
}
```

设计意图：无障碍服务（TalkBack）报告"第 3 个项目，共 50 个"时，用户感知的是第 3 个 app，但实际 adapter position 可能因 header/divider 而偏移。`getRowsNotForAccessibility` 减去非 app 行数，让报告的索引与用户心智模型一致。`incrementTotalHeight` 避免同行 icon 重复累加高度，用于快速滚动的总高度估算。

### 面试深问

1. **`VIEW_TYPE_ICON` 和 `VIEW_TYPE_PRIVATE_SPACE_APP_ICON` 为什么分开？**
   两者布局相同（都是 `BubbleTextView`），但点击行为不同：私密图标需先解锁才能启动，点击/长按都弹 `PopupContainerWithArrow.showForPrivateSpaceApp`。分开 ViewType 让 `onCreateViewHolder` 能挂不同监听器，且 `VIEW_TYPE_MASK_ICON` 掩码让两者共享同一套"是图标"的判断逻辑。

2. **`setSpanIndexCacheEnabled(true)` 有什么副作用？**
   缓存假设 span size 不随位置变化（除非数据集变了）。DiffUtil 增量更新后，新增/删除 item 会导致 span index 失效，但 RecyclerView 在 `notifyItemInserted/Removed` 时会自动失效缓存。只要不绕过 Adapter 通知直接改数据集，缓存是安全的。

3. **为什么 `onBindViewHolder` 里要对私密图标设 alpha 0？**
   私密空间从锁定展开到解锁时，图标应有"渐显"动画。`onBindViewHolder` 在过渡期间把 alpha 设为 0，由 `PrivateProfileManager` 的动画逻辑渐变到 1。这是"绑定即准备动画初始态"的模式，避免动画开始前图标已可见。

---

## 6. RecyclerView 与快速滚动

### 6.1 AllAppsRecyclerView 结构

```java
// 源码：AllAppsRecyclerView.java
public class AllAppsRecyclerView extends FastScrollRecyclerView {
    protected final int mNumAppsPerRow;
    private final AllAppsFastScrollHelper mFastScrollHelper;
    private int mCumulativeVerticalScroll; // 累计滚动量（用于埋点方向判断）
    private ConstraintLayout mLetterList;  // 字母列表（letterFastScroller）
    protected AlphabeticalAppsList mApps;

    public AllAppsRecyclerView(Context context, AttributeSet attrs, int defStyleAttr, int defStyleRes) {
        super(context, attrs, defStyleAttr);
        mNumAppsPerRow = LauncherAppState.getIDP(context).numColumns; // 设备列数
        mFastScrollHelper = new AllAppsFastScrollHelper(this);
    }

    public void setApps(AlphabeticalAppsList apps) {
        mApps = apps; // 持有列表引擎，用于查 section/row
    }
```

`onSearchResultsChanged` 搜索结果变化时滚到顶部：

```java
// 源码：AllAppsRecyclerView.java
public void onSearchResultsChanged() {
    scrollToTop(); // 让用户看到最新结果
}
```

滚动状态埋点：

```java
// 源码：AllAppsRecyclerView.java
@Override
public void onScrollStateChanged(int state) {
    super.onScrollStateChanged(state);
    StatsLogManager mgr = ActivityContext.lookupContext(getContext()).getStatsLogManager();
    switch (state) {
        case SCROLL_STATE_DRAGGING:
            mCumulativeVerticalScroll = 0; // 重置累计
            requestFocus();
            mgr.logger().sendToInteractionJankMonitor(LAUNCHER_ALLAPPS_VERTICAL_SWIPE_BEGIN, this);
            ActivityContext.lookupContext(getContext()).hideKeyboard(); // 滚动时收键盘
            break;
        case SCROLL_STATE_IDLE:
            mgr.logger().sendToInteractionJankMonitor(LAUNCHER_ALLAPPS_VERTICAL_SWIPE_END, this);
            logCumulativeVerticalScroll(); // 记录滚动方向埋点
            break;
    }
}

@Override
public void onScrolled(int dx, int dy) {
    super.onScrolled(dx, dy);
    mCumulativeVerticalScroll += dy; // 累加（dy 正=向下，负=向上）
}
```

### 6.2 scrollToPositionAtProgress：触摸 fraction → section

快速滚动的核心映射：

```java
// 源码：AllAppsRecyclerView.java
@Override
public CharSequence scrollToPositionAtProgress(float touchFraction) {
    int rowCount = mApps.getNumAppRows();
    if (rowCount == 0) return "";

    List<AlphabeticalAppsList.FastScrollSectionInfo> fastScrollSections =
            mApps.getFastScrollerSections();
    int count = fastScrollSections.size();
    if (count == 0) return "";
    // fraction [0,1] 映射到 section 索引 [0, count-1]
    int index = Utilities.boundToRange((int) (touchFraction * count), 0, count - 1);
    AlphabeticalAppsList.FastScrollSectionInfo section = fastScrollSections.get(index);
    mFastScrollHelper.smoothScrollToSection(section); // 平滑滚动
    return section.sectionName; // 返回 section 名给快速滚动条显示
}
```

映射原理：`touchFraction` 是手指在快速滚动条上的相对位置（0=顶部，1=底部）。`section` 数量固定（A-Z 约 26 个），直接线性映射 `index = fraction * count`。每个 section 记录了 `position`（adapter position），`smoothScrollToSection` 滚到该 position。

为什么按 section 索引线性映射而非按 app 数量：
- section 数量少（约 26），手指移动 1/26 屏幕高度就跳一个字母，符合直觉。
- 若按 app 数量映射，app 多的 section（如 S 开头几十个 app）占快速滚动条比例过大，手指需大幅移动才能跳过稀疏字母，体验差。按 section 映射保证每个字母占等量快速滚动条空间。

### 6.3 AllAppsFastScrollHelper：平滑滚动与高亮

```java
// 源码：AllAppsFastScrollHelper.java
public class AllAppsFastScrollHelper {
    private static final int NO_POSITION = -1;
    private int mTargetFastScrollPosition = NO_POSITION;
    private AllAppsRecyclerView mRv;
    private ViewHolder mLastSelectedViewHolder; // 上一个高亮的 ViewHolder

    public void smoothScrollToSection(FastScrollSectionInfo info) {
        if (mTargetFastScrollPosition == info.position) {
            return; // 已在目标位置，不重复滚动
        }
        mTargetFastScrollPosition = info.position;
        mRv.getLayoutManager().startSmoothScroll(new MyScroller(mTargetFastScrollPosition));
    }

    public void onFastScrollCompleted() {
        mTargetFastScrollPosition = NO_POSITION;
        setLastHolderSelected(false); // 清除高亮
        mLastSelectedViewHolder = null;
    }

    private void setLastHolderSelected(boolean isSelected) {
        if (mLastSelectedViewHolder != null) {
            mLastSelectedViewHolder.itemView.setActivated(isSelected); // 触发 selector 高亮
            mLastSelectedViewHolder.setIsRecyclable(!isSelected); // 高亮时不允许回收
        }
    }
```

`MyScroller` 是自定义 `LinearSmoothScroller`：

```java
// 源码：AllAppsFastScrollHelper.java
private class MyScroller extends LinearSmoothScroller {
    private final int mTargetPosition;

    public MyScroller(int targetPosition) {
        super(mRv.getContext());
        mTargetPosition = targetPosition;
        setTargetPosition(targetPosition);
    }

    @Override
    protected int getVerticalSnapPreference() {
        mRv.performHapticFeedback(CLOCK_TICK); // 滚动到位时震动反馈
        return SNAP_TO_ANY;
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (mTargetPosition != mTargetFastScrollPosition) {
            return; // 目标已变（用户继续拖动快速滚动条），不处理旧滚动结束
        }
        ViewHolder currentHolder = mRv.findViewHolderForAdapterPosition(mTargetPosition);
        if (currentHolder == mLastSelectedViewHolder) return;
        setLastHolderSelected(false); // 清旧高亮
        mLastSelectedViewHolder = currentHolder;
        setLastHolderSelected(true); // 设新高亮
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (mTargetPosition != mTargetFastScrollPosition) {
            setLastHolderSelected(false);
            mLastSelectedViewHolder = null;
        }
    }
}
```

设计要点：
- `setIsRecyclable(false)`：高亮的 ViewHolder 在动画期间不允许被回收，否则高亮会随回收消失。滚动结束后 `onFastScrollCompleted` 恢复可回收。
- `CLOCK_TICK` 震动：每次 snap 到目标位置给触觉反馈，模拟"刻度感"。
- 目标变化检测：用户快速拖动快速滚动条时，会连续触发多次 `smoothScrollToSection`，`MyScroller.onStop` 检查 `mTargetPosition != mTargetFastScrollPosition` 判断是否已被新目标取代，避免旧滚动的高亮覆盖新滚动。

### 6.4 onUpdateScrollbar：滚动条位置同步

```java
// 源码：AllAppsRecyclerView.java
@Override
public void onUpdateScrollbar(int dy) {
    if (mApps == null) return;
    List<AllAppsGridAdapter.AdapterItem> items = mApps.getAdapterItems();
    if (items.isEmpty() || mNumAppsPerRow == 0 || getChildCount() == 0) {
        mScrollbar.setThumbOffsetY(-1); // -1 表示隐藏
        return;
    }
    int scrollY = computeVerticalScrollOffset();
    if (scrollY < 0) {
        mScrollbar.setThumbOffsetY(-1);
        return;
    }
    if (Flags.letterFastScroller() && !mScrollbar.isDraggingThumb()) {
        setLettersToScrollLayout(mApps.getFastScrollerSections()); // 更新字母列表
    }
    int availableScrollBarHeight = getAvailableScrollBarHeight();
    int availableScrollHeight = getAvailableScrollHeight();
    if (availableScrollHeight <= 0) {
        mScrollbar.setThumbOffsetY(-1);
        return;
    }
    if (mScrollbar.isThumbDetached()) {
        // 拇指脱离模式：快速滚动后拇指需追赶实际滚动位置
        if (!mScrollbar.isDraggingThumb()) {
            int scrollBarY = (int)
                    (((float) scrollY / availableScrollHeight) * availableScrollBarHeight);
            int thumbScrollY = mScrollbar.getThumbOffsetY();
            int diffScrollY = scrollBarY - thumbScrollY;
            if (diffScrollY * dy > 0f) {
                // 同向追赶：按比例移动拇指
                if (dy < 0) {
                    int offset = (int) ((dy * thumbScrollY) / (float) scrollBarY);
                    thumbScrollY += Math.max(offset, diffScrollY);
                } else {
                    int offset = (int) ((dy * (availableScrollBarHeight - thumbScrollY)) /
                            (float) (availableScrollBarHeight - scrollBarY));
                    thumbScrollY += Math.min(offset, diffScrollY);
                }
                thumbScrollY = Math.max(0, Math.min(availableScrollBarHeight, thumbScrollY));
                mScrollbar.setThumbOffsetY(thumbScrollY);
                if (scrollBarY == thumbScrollY) {
                    mScrollbar.reattachThumbToScroll(); // 追上后重新吸附
                }
            } else {
                mScrollbar.setThumbOffsetY(thumbScrollY); // 反向，不动
            }
        }
    } else {
        synchronizeScrollBarThumbOffsetToViewScroll(scrollY, availableScrollHeight); // 正常吸附
    }
}
```

"拇指脱离"模式：快速滚动结束后，拇指（thumb）位置与实际滚动位置可能有偏差（因为快速滚动是按 section 跳转，而正常滚动是连续的）。用户随后正常滑动时，拇指需要"追赶"到实际位置。算法按 `dy` 方向和距离比例移动拇指，直到追上后 `reattachThumbToScroll` 恢复吸附。

### 6.5 字母列表（letterFastScroller）

```java
// 源码：AllAppsRecyclerView.java
public void setLettersToScrollLayout(
        List<AlphabeticalAppsList.FastScrollSectionInfo> fastScrollSections) {
    if (fastScrollSections.isEmpty()) return;
    if (mLetterList != null) mLetterList.removeAllViews();
    Context context = getContext();
    ActivityAllAppsContainerView<?> allAppsContainerView =
            ActivityContext.lookupContext(context).getAppsView();
    mLetterList = allAppsContainerView.getFastScrollerLetterList();
    mLetterList.setPadding(0, getScrollBarTop(), 0, getScrollBarMarginBottom());
    List<LetterListTextView> textViews = new ArrayList<>();
    for (int i = 0; i < fastScrollSections.size(); i++) {
        AlphabeticalAppsList.FastScrollSectionInfo sectionInfo = fastScrollSections.get(i);
        LetterListTextView textView = (LetterListTextView) LayoutInflater.from(context).inflate(
                R.layout.fast_scroller_letter_list_text_view, mLetterList, false);
        int viewId = View.generateViewId();
        textView.apply(sectionInfo, viewId);
        sectionInfo.setId(viewId); // 反向记录 id 给 section（用于高亮联动）
        if (i == fastScrollSections.size() - 1) {
            textView.setVisibility(INVISIBLE); // 最后一个是占位，不可见
        }
        textViews.add(textView);
        mLetterList.addView(textView);
    }
    // 额外加一个不可见的 TextView 用于 ConstraintLayout 链对齐
    LetterListTextView lastLetterListTextView = new LetterListTextView(context);
    lastLetterListTextView.setVisibility(INVISIBLE);
    textViews.add(lastLetterListTextView);
    mLetterList.addView(lastLetterListTextView);
    constraintTextViewsVertically(mLetterList, textViews); // 垂直链式约束
    mLetterList.setVisibility(VISIBLE);
    mLetterList.setAlpha(0); // 初始透明，由滚动逻辑控制显隐
}
```

`constraintTextViewsVertically` 用 ConstraintSet 建立垂直链：

```java
// 源码：AllAppsRecyclerView.java
private void constraintTextViewsVertically(ConstraintLayout constraintLayout,
        List<LetterListTextView> textViews) {
    ConstraintSet chain = new ConstraintSet();
    chain.clone(constraintLayout);
    for (int i = 0; i < textViews.size(); i++) {
        LetterListTextView currentView = textViews.get(i);
        if (i == 0) {
            chain.connect(currentView.getId(), ConstraintSet.TOP, ConstraintSet.PARENT_ID, ConstraintSet.TOP);
        } else {
            chain.connect(currentView.getId(), ConstraintSet.TOP, textViews.get(i - 1).getId(), ConstraintSet.BOTTOM);
        }
        chain.connect(currentView.getId(), ConstraintSet.START, constraintLayout.getId(), ConstraintSet.START);
        chain.connect(currentView.getId(), ConstraintSet.END, constraintLayout.getId(), ConstraintSet.END);
    }
    int[] viewIds = textViews.stream().mapToInt(TextView::getId).toArray();
    float[] weights = new float[textViews.size()];
    Arrays.fill(weights, 1); // 等权重，每个字母均分高度
    chain.createVerticalChain(constraintLayout.getId(), ConstraintSet.TOP,
            constraintLayout.getId(), ConstraintSet.BOTTOM, viewIds, weights, ConstraintSet.CHAIN_SPREAD);
    chain.applyTo(constraintLayout);
}
```

设计意图：用 ConstraintLayout 垂直链让 26 个字母均分屏幕高度，手指在任何字母位置都能精确对应。`CHAIN_SPREAD` + 等权重保证间距均匀。字母列表初始 `alpha=0`，只在快速滚动时显示，避免静态干扰。

### 面试深问

1. **快速滚动为什么按 section 线性映射而不是按 adapter position？**
   section 数量固定（约 26），每个字母占快速滚动条等量空间，手指移动距离与字母跳转线性相关，符合直觉。按 position 映射时，app 密集的字母（如 S）占空间过大，稀疏字母几乎无法触及。

2. **`mLastSelectedViewHolder.setIsRecyclable(false)` 为什么必要？**
   高亮的 ViewHolder 若被回收，高亮状态丢失且可能被复用绑定到其他位置导致错误高亮。设为不可回收，保证动画期间该 ViewHolder 稳定。`onFastScrollCompleted` 后恢复可回收，避免内存泄漏。

3. **拇指脱离模式（thumb detached）解决什么问题？**
   快速滚动按 section 跳转，跳跃式；正常滚动连续。快速滚动后拇指位置与实际 scrollY 不严格对应，若立即吸附会产生跳变。脱离模式下拇指按 `dy` 比例平滑追赶，追上后再吸附，视觉更自然。

---

## 7. 搜索体系

### 7.1 搜索完整链路

搜索从用户输入到结果刷新的完整链路：

```
用户输入
  │  TextWatcher.afterTextChanged (AllAppsSearchBarController)
  ▼
mSearchAlgorithm.doSearch(query, callback)
  │  DefaultAppSearchAlgorithm.doSearch
  ▼
enqueueModelUpdateTask (切到 Model 后台线程)
  │  getTitleMatchResult (StringMatcherUtility.matches)
  ▼
mResultHandler.post (切回主线程，MAIN_EXECUTOR.getLooper())
  │  callback.onSearchResult (AppsSearchContainerLayout)
  ▼
mAppsView.setSearchResults(items)
  │  AlphabeticalAppsList.setSearchResults → updateAdapterItems
  ▼
SearchRecyclerView 渲染 + animateToSearchState (过渡动画)
```

### 7.2 AppsSearchContainerLayout：搜索框与回调

```java
// 源码：search/AppsSearchContainerLayout.java
public class AppsSearchContainerLayout extends ExtendedEditText
        implements SearchUiManager, SearchCallback<AdapterItem>,
        AllAppsStore.OnUpdateListener, Insettable {

    private final ActivityContext mLauncher;
    private final AllAppsSearchBarController mSearchBarController;
    private final SpannableStringBuilder mSearchQueryBuilder; // 查询构造器（处理按键输入）

    private ActivityAllAppsContainerView<?> mAppsView;
    private final int mContentOverlap; // 与下方内容的重叠像素

    public AppsSearchContainerLayout(Context context, AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
        mLauncher = ActivityContext.lookupContext(context);
        mSearchBarController = new AllAppsSearchBarController();
        mSearchQueryBuilder = new SpannableStringBuilder();
        Selection.setSelection(mSearchQueryBuilder, 0);
        setHint(prefixTextWithIcon(getContext(), R.drawable.ic_allapps_search, getHint())); // hint 带搜索图标
        mContentOverlap = getResources().getDimensionPixelSize(R.dimen.all_apps_search_bar_content_overlap);
    }

    @Override
    public void initializeSearch(ActivityAllAppsContainerView<?> appsView) {
        mAppsView = appsView;
        // 绑定搜索算法、输入框、宿主、回调（this）
        mSearchBarController.initialize(
                new DefaultAppSearchAlgorithm(getContext(), true /* addNoResultsMessage */),
                this, mLauncher, this);
    }

    // SearchCallback 实现：收到搜索结果
    @Override
    public void onSearchResult(String query, ArrayList<AdapterItem> items) {
        if (items != null) {
            mAppsView.setSearchResults(items); // 推给容器
        }
    }

    // SearchCallback 实现：清空结果
    @Override
    public void clearSearchResult() {
        mSearchQueryBuilder.clear();
        mSearchQueryBuilder.clearSpans();
        Selection.setSelection(mSearchQueryBuilder, 0);
        mAppsView.onClearSearchResult(); // 触发返回 A-Z 动画
    }

    // Store 更新时刷新搜索结果（app 增删后重新搜）
    @Override
    public void onAppsUpdated() {
        mSearchBarController.refreshSearchResult();
    }
```

为什么 `AppsSearchContainerLayout` 同时是 `SearchUiManager` 和 `SearchCallback`：
- `SearchUiManager`：对外暴露搜索控制接口（`resetSearch`、`getEditText`），让容器统一调度。
- `SearchCallback`：作为搜索算法的回调接收者，收到结果后转给 `mAppsView`。
- 两者合一减少中间层，搜索框既是 UI 又是控制器。

`preDispatchKeyEvent` 处理物理键盘输入：

```java
// 源码：search/AppsSearchContainerLayout.java
@Override
public void preDispatchKeyEvent(KeyEvent event) {
    // 未聚焦搜索框时，物理键盘输入自动聚焦并填入
    if (!mSearchBarController.isSearchFieldFocused() &&
            event.getAction() == KeyEvent.ACTION_DOWN) {
        final int unicodeChar = event.getUnicodeChar();
        final boolean isKeyNotWhitespace = unicodeChar > 0 &&
                !Character.isWhitespace(unicodeChar) && !Character.isSpaceChar(unicodeChar);
        if (isKeyNotWhitespace) {
            boolean gotKey = TextKeyListener.getInstance().onKeyDown(this, mSearchQueryBuilder,
                    event.getKeyCode(), event);
            if (gotKey && mSearchQueryBuilder.length() > 0) {
                mSearchBarController.focusSearchField(); // 聚焦并显示键盘
            }
        }
    }
}
```

### 7.3 AllAppsSearchBarController：TextWatcher 驱动

```java
// 源码：search/AllAppsSearchBarController.java
public class AllAppsSearchBarController
        implements TextWatcher, OnEditorActionListener, ExtendedEditText.OnBackKeyListener {

    protected SearchCallback<AdapterItem> mCallback;
    protected ExtendedEditText mInput;
    protected String mQuery;
    private String[] mTextConversions; // 输入法的候选词转换（拼音→汉字）
    protected SearchAlgorithm<AdapterItem> mSearchAlgorithm;

    public final void initialize(SearchAlgorithm<AdapterItem> searchAlgorithm, ExtendedEditText input,
            ActivityContext launcher, SearchCallback<AdapterItem> callback) {
        mCallback = callback;
        mLauncher = launcher;
        mInput = input;
        mInput.addTextChangedListener(this); // 监听文本变化
        mInput.setOnEditorActionListener(this); // 监听 IME 搜索键
        mInput.setOnBackKeyListener(this); // 监听返回键
        mSearchAlgorithm = searchAlgorithm;
    }

    @Override
    public void onTextChanged(CharSequence s, int start, int before, int count) {
        mTextConversions = extractTextConversions(s); // 提取输入法候选词
    }

    // 从拼音输入法的 SuggestionSpan 提取候选汉字
    public static String[] extractTextConversions(CharSequence text) {
        if (text instanceof SpannableStringBuilder) {
            SpannableStringBuilder spanned = (SpannableStringBuilder) text;
            SuggestionSpan[] suggestionSpans = spanned.getSpans(0, text.length(), SuggestionSpan.class);
            if (suggestionSpans != null && suggestionSpans.length > 0) {
                spanned.removeSpan(suggestionSpans[0]); // 取出后移除，避免重复
                return suggestionSpans[0].getSuggestions(); // 返回候选词数组
            }
        }
        return null;
    }

    @Override
    public void afterTextChanged(final Editable s) {
        mQuery = s.toString();
        if (mQuery.isEmpty()) {
            mSearchAlgorithm.cancel(true /* interruptActiveRequests */); // 清空时中断进行中的搜索
            mCallback.clearSearchResult(); // 清结果，回 A-Z
        } else {
            mSearchAlgorithm.cancel(false); // 不中断，让旧结果先回来（避免闪烁）
            mSearchAlgorithm.doSearch(mQuery, mTextConversions, mCallback); // 发起新搜索
        }
    }
```

`extractTextConversions` 的设计意图：拼音输入法（如 Gboard 拼音）在用户输入拼音字母时，`SuggestionSpan` 携带候选汉字。提取后传给搜索算法，可以同时匹配拼音和汉字，提升中文搜索体验。

`afterTextChanged` 的 cancel 策略：
- 清空 query 时 `cancel(true)`：中断进行中的搜索，避免延迟回来的旧结果污染空状态。
- 有新 query 时 `cancel(false)`：不中断旧搜索，因为中断+重启开销可能比让旧搜索自然完成更大，且旧结果若先到会被新搜索覆盖。

```java
    // IME 搜索键 / 回车
    @Override
    public boolean onEditorAction(TextView v, int actionId, KeyEvent event) {
        if (actionId == EditorInfo.IME_ACTION_SEARCH || actionId == EditorInfo.IME_ACTION_GO || (
                actionId == EditorInfo.IME_NULL && event != null
                        && event.getAction() == KeyEvent.ACTION_DOWN)) {
            // 启动高亮的结果项（第一个结果）
            return mLauncher.getAppsView().getMainAdapterProvider().launchHighlightedItem();
        }
        return false;
    }

    // 返回键：有 query 清 query，无 query 退出搜索
    @Override
    public boolean onBackKey() {
        String query = Utilities.trim(mInput.getEditableText().toString());
        if (query.isEmpty()) {
            reset();
            return true;
        }
        return false;
    }
```

### 7.4 DefaultAppSearchAlgorithm：后台搜索

```java
// 源码：search/DefaultAppSearchAlgorithm.java
public class DefaultAppSearchAlgorithm implements SearchAlgorithm<AdapterItem> {
    private static final int MAX_RESULTS_COUNT = 5; // 最多 5 条结果

    private final LauncherAppState mAppState;
    private final Handler mResultHandler; // 主线程 Handler，用于回调切线程
    private final boolean mAddNoResultsMessage;

    public DefaultAppSearchAlgorithm(Context context, boolean addNoResultsMessage) {
        mAppState = LauncherAppState.getInstance(context);
        mResultHandler = new Handler(MAIN_EXECUTOR.getLooper()); // 绑定主线程 Looper
        mAddNoResultsMessage = addNoResultsMessage;
    }

    @Override
    public void cancel(boolean interruptActiveRequests) {
        if (interruptActiveRequests) {
            mResultHandler.removeCallbacksAndMessages(null); // 清空待回调
        }
    }

    @Override
    public void doSearch(String query, SearchCallback<AdapterItem> callback) {
        // 提交到 Model 后台线程执行（AllAppsList 所在线程）
        mAppState.getModel().enqueueModelUpdateTask((taskController, dataModel, apps) -> {
            ArrayList<AdapterItem> result = getTitleMatchResult(apps.data, query);
            if (mAddNoResultsMessage && result.isEmpty()) {
                result.add(getEmptyMessageAdapterItem(query)); // 无结果时加空提示
            }
            mResultHandler.post(() -> callback.onSearchResult(query, result)); // 切回主线程回调
        });
    }

    // 标题前缀匹配
    @AnyThread
    public static ArrayList<AdapterItem> getTitleMatchResult(List<AppInfo> apps, String query) {
        final String queryTextLower = query.toLowerCase();
        final ArrayList<AdapterItem> result = new ArrayList<>();
        StringMatcherUtility.StringMatcher matcher = StringMatcherUtility.StringMatcher.getInstance();
        int resultCount = 0;
        int total = apps.size();
        for (int i = 0; i < total && resultCount < MAX_RESULTS_COUNT; i++) {
            AppInfo info = apps.get(i);
            if (StringMatcherUtility.matches(queryTextLower, info.title.toString(), matcher)) {
                result.add(AdapterItem.asApp(info));
                resultCount++;
            }
        }
        return result;
    }
}
```

为什么搜索在 Model 后台线程：
- `apps.data` 是 Model 持有的全量 app 列表，访问需在 Model 线程保证一致性。
- 搜索遍历全部 app（可能几百个）做字符串匹配，在主线程会卡 UI。
- `enqueueModelUpdateTask` 把搜索任务排入 Model 线程队列，与数据加载等任务串行，避免并发访问 `apps.data`。

`mResultHandler.post` 切回主线程：`onSearchResult` 会触发 UI 刷新（`setSearchResults`），必须在主线程。

### 7.5 StringMatcherUtility：断点切词与中文优化

```java
// 源码：search/StringMatcherUtility.java
public static boolean matches(String query, String target, StringMatcher matcher) {
    int queryLength = query.length();
    int targetLength = target.length();
    if (targetLength < queryLength || queryLength <= 0) return false;

    // 中文优化：直接 contains
    if (requestSimpleFuzzySearch(query)) {
        return target.toLowerCase().contains(query);
    }

    // 非中文：按字符类型断点切词，在断点处做前缀匹配
    int lastType, thisType = Character.UNASSIGNED;
    int nextType = Character.getType(target.codePointAt(0));
    int end = targetLength - queryLength;
    for (int i = 0; i <= end; i++) {
        lastType = thisType;
        thisType = nextType;
        nextType = i < (targetLength - 1)
                ? Character.getType(target.codePointAt(i + 1)) : Character.UNASSIGNED;
        // 只在断点位置尝试匹配（如单词开头、大写字母开头）
        if (matcher.isBreak(thisType, lastType, nextType)
                && matcher.matches(query, target.substring(i, i + queryLength))) {
            return true;
        }
    }
    return false;
}
```

断点切词的原理：把 target 字符串按字符类型变化切成"词"，只在词的开头尝试匹配。例如 "Play Store" 的断点在空格后的 'S'，输入 "sto" 能匹配 "Store" 但 "lay" 不能匹配（因为 "Play" 整词已过）。

`isBreak` 判断哪些位置是词的开头：

```java
// 源码：search/StringMatcherUtility.java StringMatcher
protected boolean isBreak(int thisType, int prevType, int nextType) {
    switch (prevType) {
        case Character.UNASSIGNED:
        case Character.SPACE_SEPARATOR:
        case Character.LINE_SEPARATOR:
        case Character.PARAGRAPH_SEPARATOR:
            return true; // 空格/分隔符之后是断点
    }
    switch (thisType) {
        case Character.UPPERCASE_LETTER:
            // 大写字母后跟小写/非字母=驼峰断点（如 "YouTube" 的 T）
            if (nextType != Character.UPPERCASE_LETTER && nextType != Character.OTHER_SYMBOL
                    && nextType != Character.DECIMAL_DIGIT_NUMBER
                    && nextType != Character.UNASSIGNED) {
                return true;
            }
        case Character.TITLECASE_LETTER:
            return prevType != Character.UPPERCASE_LETTER;
        case Character.LOWERCASE_LETTER:
            return prevType > Character.OTHER_LETTER || prevType <= Character.UNASSIGNED;
        case Character.DECIMAL_DIGIT_NUMBER:
        case Character.LETTER_NUMBER:
        case Character.OTHER_NUMBER:
            return !(prevType == Character.DECIMAL_DIGIT_NUMBER // 数字前非数字=断点
                    || prevType == Character.LETTER_NUMBER
                    || prevType == Character.OTHER_NUMBER);
        case Character.MATH_SYMBOL:
        case Character.CURRENCY_SYMBOL:
        case Character.OTHER_PUNCTUATION:
        case Character.DASH_PUNCTUATION:
            return true; // 符号总是断点（如 "t-mobile" 的 -）
        default:
            return false;
    }
}
```

经典例子：`"YouTube"` 输入 `"you"` 匹配（Y 是断点），输入 `"tube"` 匹配（T 是驼峰断点），输入 `"out"` 不匹配（o 不是断点，无法从中间词开始）。

中文优化：

```java
// 源码：search/StringMatcherUtility.java
private static boolean requestSimpleFuzzySearch(String s) {
    for (int i = 0; i < s.length(); ) {
        int codepoint = s.codePointAt(i);
        i += Character.charCount(codepoint);
        switch (Character.UnicodeScript.of(codepoint)) {
            case HAN:
                return true; // 查询含汉字，走简单 contains
        }
    }
    return false;
}
```

为什么中文走 contains 而非断点：
- 中文字符都是 `LOWERCASE_LETTER` 或 `OTHER_LETTER`，断点规则对中文几乎不产生断点（除非前面有空格/符号），断点匹配退化为只能匹配首字。
- 中文搜索语义是"包含任意子串"（搜"信"匹配"微信"），`contains` 更符合用户预期。
- 检测 `HAN` script（汉字统一表意文字）后切到 `contains`，兼顾性能和体验。

`StringMatcher.matches` 本身用 Collator 做本地化前缀判断：

```java
// 源码：search/StringMatcherUtility.java
public static class StringMatcher {
    private static final char MAX_UNICODE = '\uFFFF';
    private final Collator mCollator;

    StringMatcher() {
        mCollator = Collator.getInstance();
        mCollator.setStrength(Collator.PRIMARY); // 忽略大小写和重音
        mCollator.setDecomposition(Collator.CANONICAL_DECOMPOSITION); // 规范分解
    }

    public boolean matches(String query, String target) {
        if (query == null || target == null) return false;
        int compare = mCollator.compare(query, target);
        if (compare == 0) return true; // 完全相等
        else if (compare < 0) {
            // query < target：追加 MAX_UNICODE 后若 query >= target，说明 query 是 target 前缀
            return mCollator.compare(query + MAX_UNICODE, target) >= 0;
        } else {
            return false; // query > target，不可能是前缀
        }
    }
}
```

`PRIMARY` 强度：忽略大小写（A=a）和重音（é=e）。`CANONICAL_DECOMPOSITION`：把组合字符分解（如 à 分解为 a + `）。前缀判断的技巧：`query + MAX_UNICODE` 后比较，若 `query` 是 `target` 前缀，追加最大字符后 `query+MAX` 应 >= `target`。

### 7.6 搜索结果的复用与过渡

搜索结果推送到容器：

```java
// 源码：ActivityAllAppsContainerView.java
public void setSearchResults(ArrayList<AdapterItem> results) {
    getMainAdapterProvider().clearHighlightedItem();
    if (getSearchResultList().setSearchResults(results)) { // 推给 SEARCH 的 AlphabeticalAppsList
        getSearchRecyclerView().onSearchResultsChanged(); // 滚到顶部
    }
    if (results != null) {
        animateToSearchState(true); // 触发 A-Z → 搜索过渡动画
    }
}
```

`AlphabeticalAppsList.setSearchResults`：

```java
// 源码：AlphabeticalAppsList.java
public boolean setSearchResults(ArrayList<AdapterItem> results) {
    if (Objects.equals(results, mSearchResults)) return false; // 相同不刷新
    mSearchResults.clear();
    if (results != null) mSearchResults.addAll(results);
    updateAdapterItems(); // 重建（这次走 hasSearchResults 分支，直接用 mSearchResults）
    return true;
}
```

搜索态下 `updateAdapterItems` 走 `hasSearchResults()` 分支，直接 `mAdapterItems.addAll(mSearchResults)`，跳过 section 计算和私密空间逻辑——搜索结果是平铺列表，不分字母 section。

`animateToSearchState` 触发过渡动画：

```java
// 源码：ActivityAllAppsContainerView.java
void animateToSearchState(boolean goingToSearch, long durationMs) {
    if (!mSearchTransitionController.isRunning() && goingToSearch == isSearching()) {
        return; // 状态未变且无动画，直接返回
    }
    mFastScroller.setVisibility(goingToSearch ? INVISIBLE : VISIBLE); // 搜索时隐藏快速滚动条
    if (goingToSearch) {
        mWorkManager.onActivePageChanged(SEARCH); // 通知工作资料切到搜索态
    } else if (mAllAppsTransitionController != null) {
        mAllAppsTransitionController.animateAllAppsToNoScale(); // 退出搜索时恢复缩放
    }
    mSearchTransitionController.animateToState(goingToSearch, durationMs, () -> {
        mIsSearching = goingToSearch;
        updateSearchResultsVisibility(); // 切换 RV 可见性
        int previousPage = getCurrentPage();
        if (mRebindAdaptersAfterSearchAnimation) {
            rebindAdapters(false); // 动画期间积压的 rebind 在此执行
            mRebindAdaptersAfterSearchAnimation = false;
        }
        if (goingToSearch) {
            mSearchUiDelegate.onAnimateToSearchStateCompleted();
        } else {
            setSearchResults(null); // 清结果
            if (mViewPager != null) mViewPager.setCurrentPage(previousPage); // 恢复 Tab
            onActivePageChanged(previousPage);
        }
    });
}
```

`updateSearchResultsVisibility` 切换可见性：

```java
// 源码：ActivityAllAppsContainerView.java
protected void updateSearchResultsVisibility() {
    if (isSearching()) {
        getSearchRecyclerView().setVisibility(VISIBLE);
        getAppsRecyclerViewContainer().setVisibility(GONE); // 隐藏 A-Z
        mHeader.setVisibility(GONE); // 隐藏悬浮 header
    } else {
        getSearchRecyclerView().setVisibility(GONE);
        getAppsRecyclerViewContainer().setVisibility(VISIBLE);
        mHeader.setVisibility(VISIBLE);
    }
    if (mHeader.isSetUp()) {
        mHeader.setActiveRV(getCurrentPage());
    }
}
```

### 7.7 SearchTransitionController：A-Z ↔ 搜索过渡

```java
// 源码：SearchTransitionController.java
public class SearchTransitionController extends RecyclerViewAnimationController {
    private static final Interpolator INTERPOLATOR_WITHIN_ALL_APPS = DECELERATE_1_7; // All Apps 内点搜索
    private static final Interpolator INTERPOLATOR_TRANSITIONING_TO_ALL_APPS = INSTANT; // 从桌面进 All Apps 同时搜
    private boolean mSkipNextAnimationWithinAllApps;

    @Override
    protected void animateToState(boolean goingToSearch, long duration, Runnable onEndRunnable) {
        super.animateToState(goingToSearch, duration, onEndRunnable);
        if (!goingToSearch) {
            // 退出搜索：动画结束后重置 header 折叠状态和位移
            mAnimator.addListener(forSuccessCallback(() -> {
                mAllAppsContainerView.getFloatingHeaderView().setFloatingRowsCollapsed(false);
                mAllAppsContainerView.getFloatingHeaderView().reset(false);
                mAllAppsContainerView.getAppsRecyclerViewContainer().setTranslationY(0);
            }));
        }
        // 过渡期间保持 header 和容器可见（动画靠 alpha/translation 实现）
        mAllAppsContainerView.getFloatingHeaderView().setFloatingRowsCollapsed(true);
        mAllAppsContainerView.getFloatingHeaderView().setVisibility(VISIBLE);
        mAllAppsContainerView.getFloatingHeaderView().maybeSetTabVisibility(VISIBLE);
        mAllAppsContainerView.getAppsRecyclerViewContainer().setVisibility(VISIBLE);
        getRecyclerView().setVisibility(VISIBLE);
    }

    @Override
    protected int onProgressUpdated(float searchToAzProgress) {
        int searchHeight = super.onProgressUpdated(searchToAzProgress); // 搜索 RV 的位移/动画
        FloatingHeaderView headerView = mAllAppsContainerView.getFloatingHeaderView();
        int appsTranslationY = searchHeight + headerView.getFloatingRowsHeight();
        if (headerView.usingTabs()) {
            // 有 Tab：header 下移并淡出（后 20% 时间淡出）
            headerView.setTranslationY(searchHeight);
            headerView.setAlpha(clampToProgress(searchToAzProgress, 0.8f, 1f));
            appsTranslationY += headerView.getTabsAdditionalPaddingBottom()
                    + mAllAppsContainerView.getResources().getDimensionPixelOffset(R.dimen.all_apps_tabs_margin_top)
                    - headerView.getPaddingTop();
        }
        View appsContainer = mAllAppsContainerView.getAppsRecyclerViewContainer();
        appsContainer.setTranslationY(appsTranslationY); // A-Z 容器下移，露出搜索 RV
        appsContainer.setAlpha(clampToProgress(searchToAzProgress, 0.8f, 1f)); // A-Z 淡出
        return searchHeight;
    }
```

`searchToAzProgress` 从 1（完全 A-Z）到 0（完全搜索）。过渡时 A-Z 容器下移并淡出，搜索 RV 从下方滑入。`clampToProgress(progress, 0.8, 1)` 表示只在 progress 的后 20% 范围内做 alpha 变化，让淡出发生在动画末段，前期先位移。

```java
    @Override
    protected boolean shouldAnimate(View view, boolean hasDecorationInfo, boolean appRowComplete) {
        return !isAppIcon(view) || appRowComplete; // 只动画完整行或非图标
    }

    @Override
    protected TimeInterpolator getInterpolator() {
        // All Apps 内部点搜索用减速插值；从桌面进入时用瞬时（因为同时有进 All Apps 动画）
        TimeInterpolator timeInterpolator = mAllAppsContainerView.isInAllApps()
                ? INTERPOLATOR_WITHIN_ALL_APPS : INTERPOLATOR_TRANSITIONING_TO_ALL_APPS;
        if (mSkipNextAnimationWithinAllApps) {
            timeInterpolator = INSTANT;
            mSkipNextAnimationWithinAllApps = false;
        }
        return timeInterpolator;
    }
```

### 面试深问

1. **搜索为什么限制 `MAX_RESULTS_COUNT = 5`？**
   默认本地搜索是标题前缀匹配，结果相关性高，前 5 条已覆盖绝大多数意图。更多结果增加渲染开销且用户很少滚动查看。插件化搜索（如 Google App Search）可覆盖更多结果。

2. **`requestSimpleFuzzySearch` 检测到中文后走 contains，为什么不也用断点匹配？**
   中文字符类型几乎都是 `OTHER_LETTER`，断点规则只在"前一个字符是空格/符号"时产生断点，对纯中文标题几乎无断点，断点匹配退化为只能匹配首字。中文搜索语义是子串包含，contains 更符合预期且实现简单。

3. **`animateToSearchState` 为什么在动画结束的回调里才 `setSearchResults(null)`？**
   退出搜索时若立即清结果，搜索 RV 会瞬间空掉，过渡动画无内容可渲染。在回调里清，保证动画期间搜索 RV 仍有旧结果，动画结束后再清，视觉连贯。

---

## 8. AllAppsTransitionController：Workspace ↔ All Apps 切换

### 8.1 状态机：mProgress

```java
// 源码：AllAppsTransitionController.java
public class AllAppsTransitionController
        implements StateHandler<LauncherState>, OnDeviceProfileChangeListener {
    public static final float INTERP_COEFF = 1.7f; // 二阶导系数，与减速插值匹配
    private static final float NAV_BAR_COLOR_FORCE_UPDATE_THRESHOLD = 0.1f;
    private static final float SWIPE_DRAG_COMMIT_THRESHOLD =
            1 - AllAppsSwipeController.ALL_APPS_STATE_TRANSITION_MANUAL;

    // 核心：用属性动画驱动 mProgress [0,1]
    public static final FloatProperty<AllAppsTransitionController> ALL_APPS_PROGRESS =
            new FloatProperty<AllAppsTransitionController>("allAppsProgress") {
                @Override
                public Float get(AllAppsTransitionController controller) {
                    return controller.mProgress;
                }
                @Override
                public void setValue(AllAppsTransitionController controller, float progress) {
                    controller.setProgress(progress);
                }
            };

    private ActivityAllAppsContainerView<Launcher> mAppsView;
    private final Launcher mLauncher;
    private final AnimatedFloat mAllAppScale; // predictive back 缩放
    private boolean mIsVerticalLayout;        // 竖直布局（手机竖屏）
    private boolean mShouldShowAllAppsOnSheet; // 大屏 sheet 模式

    // mProgress: 0 = All Apps 完全展开，1 = Workspace（All Apps 完全下拉隐藏）
    private float mShiftRange;  // 位移范围（屏幕高度或 sheet 高度）
    private float mProgress;    // [0,1]

    public AllAppsTransitionController(Launcher l) {
        mLauncher = l;
        DeviceProfile dp = mLauncher.getDeviceProfile();
        mProgress = 1f; // 初始 Workspace 态
        mIsVerticalLayout = dp.isVerticalBarLayout();
        mShouldShowAllAppsOnSheet = dp.shouldShowAllAppsOnSheet();
        setShiftRange(dp.allAppsShiftRange);
        mLauncher.addOnDeviceProfileChangeListener(this);
    }
```

### 8.2 setProgress：位移与联动

```java
// 源码：AllAppsTransitionController.java
public void setProgress(float progress) {
    mProgress = progress;
    // 从其他 app 返回时允许全屏位移
    boolean fromBackground = mLauncher.getStateManager().getCurrentStableState() == BACKGROUND_APP;
    float shiftRange = fromBackground
            ? mLauncher.getDeviceProfile().getDeviceProperties().getHeightPx() : mShiftRange;
    getAppsViewProgressTranslationY().setValue(mProgress * shiftRange); // All Apps 容器 Y 位移
    mLauncher.onAllAppsTransition(1 - progress); // 通知 Launcher（处理 Workspace 缩放等）

    // 导航栏颜色：progress < 0.1 时强制更新
    boolean hasScrim = progress < NAV_BAR_COLOR_FORCE_UPDATE_THRESHOLD
            && mLauncher.getAppsView().getNavBarScrimHeight() > 0;
    mLauncher.getSystemUiController().updateUiState(
            UI_STATE_ALL_APPS, hasScrim ? mNavScrimFlag : 0);
}
```

位移逻辑：`mProgress * shiftRange` = All Apps 容器相对顶部的 Y 偏移。`progress=0` 时偏移 0（All Apps 贴顶展开），`progress=1` 时偏移 `shiftRange`（All Apps 完全下移出屏幕，露出 Workspace）。

`mShiftRange` 来自 `DeviceProfile.allAppsShiftRange`：
- 手机竖屏：`shiftRange` ≈ 屏幕高度（All Apps 从底部上滑覆盖全屏）。
- 大屏 sheet：`shiftRange` ≈ sheet 高度（All Apps 作为底部 sheet，不全屏覆盖）。

### 8.3 手机上滑 vs 大屏 sheet 的差异

```java
// 源码：AllAppsTransitionController.java
// pull back 位移（松手后回弹）
public static final FloatProperty<AllAppsTransitionController> ALL_APPS_PULL_BACK_TRANSLATION =
        new FloatProperty<AllAppsTransitionController>("allAppsPullBackTranslation") {
            @Override
            public Float get(AllAppsTransitionController controller) {
                if (controller.mShouldShowAllAppsOnSheet) {
                    return controller.mAppsView.getActiveRecyclerView().getTranslationY(); // sheet: RV 位移
                } else {
                    return controller.getAppsViewPullbackTranslationY().getValue(); // 手机: 整个 AppsView 位移
                }
            }
            @Override
            public void setValue(AllAppsTransitionController controller, float translation) {
                if (controller.mShouldShowAllAppsOnSheet) {
                    controller.mAppsView.getActiveRecyclerView().setTranslationY(translation);
                    controller.getAppsViewPullbackTranslationY().setValue(ALL_APPS_PULL_BACK_TRANSLATION_DEFAULT);
                } else {
                    controller.getAppsViewPullbackTranslationY().setValue(translation);
                    controller.mAppsView.getActiveRecyclerView().setTranslationY(ALL_APPS_PULL_BACK_TRANSLATION_DEFAULT);
                }
            }
        };
```

差异本质：
- 手机（非 sheet）：位移作用于整个 `AppsView` 容器，`mProgress` 直接控制容器 Y。`ALL_APPS_PULL_BACK_TRANSLATION_DEFAULT = 0`，pull back 时 RV 位移归零。
- 大屏 sheet：`mProgress` 控制 sheet（即 `AppsView`）整体，但 pull back（用户拖拽 sheet 时的弹性）作用于 RV 内部，因为 sheet 本身是定位的，弹性反馈体现在内容 RV 上。

`mShouldShowAllAppsOnSheet` 在 `onDeviceProfileChanged` 时更新：

```java
// 源码：AllAppsTransitionController.java
@Override
public void onDeviceProfileChanged(DeviceProfile dp) {
    mIsVerticalLayout = dp.isVerticalBarLayout();
    setShiftRange(dp.allAppsShiftRange);
    if (mIsVerticalLayout) {
        mLauncher.getHotseat().setTranslationY(0); // 横向布局时 hotseat 不位移
        mLauncher.getWorkspace().getPageIndicator().setTranslationY(0);
    }
    mShouldShowAllAppsOnSheet = dp.shouldShowAllAppsOnSheet();
}
```

### 8.4 MultiProperty：多源位移叠加

```java
// 源码：AllAppsTransitionController.java
private static final int INDEX_APPS_VIEW_PROGRESS = 0;  // 状态机驱动的位移
private static final int INDEX_APPS_VIEW_PULLBACK = 1;  // pull back 弹性位移
private static final int APPS_VIEW_INDEX_COUNT = 2;

private MultiValueAlpha mAppsViewAlpha;                          // 多源 alpha
private MultiPropertyFactory<View> mAppsViewTranslationY;        // 多源 Y 位移

public void setupViews(ScrimView scrimView, ActivityAllAppsContainerView<Launcher> appsView) {
    mScrimView = scrimView;
    mAppsView = appsView;
    mAppsView.setScrimView(scrimView);
    // 两个 alpha 源：progress（状态动画）+ pullback（弹性）
    mAppsViewAlpha = new MultiValueAlpha(mAppsView, APPS_VIEW_INDEX_COUNT, View.GONE);
    mAppsViewAlpha.setUpdateVisibility(true);
    // 两个位移源，最终值 = 两源之和（Float::sum）
    mAppsViewTranslationY = new MultiPropertyFactory<>(
            mAppsView, VIEW_TRANSLATE_Y, APPS_VIEW_INDEX_COUNT, Float::sum);
}
```

为什么用多源叠加：
- 状态动画（`INDEX_APPS_VIEW_PROGRESS`）和手势弹性（`INDEX_APPS_VIEW_PULLBACK`）可能同时作用于位移。若用单一变量，手势松手时需先把弹性值合并回 progress，逻辑复杂且易错。
- `MultiPropertyFactory` 让每个源独立设值，最终 `translationY = progressValue + pullbackValue`，互不干扰。松手后 pullback 归零，progress 接管完成剩余动画。

`setAlphas` 控制可见性：

```java
// 源码：AllAppsTransitionController.java
public void setAlphas(LauncherState state, StateAnimationConfig config, PropertySetter setter) {
    int visibleElements = state.getVisibleElements(mLauncher.getLauncherUiState());
    boolean hasAllAppsContent = (visibleElements & ALL_APPS_CONTENT) != 0;
    Interpolator allAppsFade = config.getInterpolator(ANIM_ALL_APPS_FADE, LINEAR);
    setter.setFloat(getAppsViewProgressAlpha(), MultiPropertyFactory.MULTI_PROPERTY_VALUE,
            hasAllAppsContent ? 1 : 0, allAppsFade);
    setter.setFloat(getAppsViewPullbackAlpha(), MultiPropertyFactory.MULTI_PROPERTY_VALUE,
            hasAllAppsContent ? 1 : 0, allAppsFade);

    boolean shouldProtectHeader = !config.hasAnimationFlag(StateAnimationConfig.SKIP_SCRIM)
            && (ALL_APPS == state || mLauncher.getStateManager().getState() == ALL_APPS);
    mScrimView.setDrawingController(shouldProtectHeader ? mAppsView : null); // header 保护色绘制委托
}
```

### 8.5 setStateWithAnimation：状态切换动画

```java
// 源码：AllAppsTransitionController.java
@Override
public void setStateWithAnimation(LauncherState toState,
        StateAnimationConfig config, PendingAnimation builder) {
    // 从 All Apps 离开时，动画结束后重置 pull back
    if (mLauncher.isInState(ALL_APPS) && !ALL_APPS.equals(toState)) {
        builder.addEndListener(success -> {
            ALL_APPS_PULL_BACK_TRANSLATION.set(this, ALL_APPS_PULL_BACK_TRANSLATION_DEFAULT);
            ALL_APPS_PULL_BACK_ALPHA.set(this, ALL_APPS_PULL_BACK_ALPHA_DEFAULT);
            mAllAppScale.updateValue(1f);
        });
    }

    float targetProgress = toState.getVerticalProgress(mLauncher);
    if (Float.compare(mProgress, targetProgress) == 0) {
        setAlphas(toState, config, builder); // 已在目标位置，只调 alpha
        return;
    }

    // 插值器：用户手势用 LINEAR，程序触发用 DECELERATE_1_7
    Interpolator verticalProgressInterpolator = config.getInterpolator(ANIM_VERTICAL_PROGRESS,
            config.isUserControlled() ? LINEAR : DECELERATE_1_7);
    Animator anim = createSpringAnimation(mProgress, targetProgress); // ObjectAnimator 驱动 ALL_APPS_PROGRESS
    anim.addListener(new AnimatorListenerAdapter() {
        @Override
        public void onAnimationCancel(Animator animation) {
            setProgress(targetProgress); // 取消时直接设到目标
        }
    });
    anim.setInterpolator(verticalProgressInterpolator);
    builder.add(anim);

    setAlphas(toState, config, builder);
    // 触觉反馈：从 NORMAL 到 ALL_APPS
    if (ALL_APPS.equals(toState) && mLauncher.isInState(NORMAL)) {
        if (Flags.msdlFeedback()) {
            if (config.isUserControlled()) {
                mMSDLPlayerWrapper.playToken(MSDLToken.SWIPE_THRESHOLD_INDICATOR); // 手势：滑动阈值
            } else {
                mMSDLPlayerWrapper.playToken(MSDLToken.TAP_HIGH_EMPHASIS); // 点击 QSB：重击
            }
        } else {
            mLauncher.getAppsView().performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY,
                    HapticFeedbackConstants.FLAG_IGNORE_VIEW_SETTING);
        }
    }
}

public Animator createSpringAnimation(float... progressValues) {
    return ObjectAnimator.ofFloat(this, ALL_APPS_PROGRESS, progressValues); // 属性动画驱动 mProgress
}
```

### 8.6 Predictive Back 缩放

Android 14+ 的预测性返回手势会让 All Apps 缩放：

```java
// 源码：AllAppsTransitionController.java
@Override
public void onBackStarted(LauncherState toState) {
    setShouldScaleHeader(!mLauncher.getAppsView().shouldBackExitSearch()); // 搜索态不缩 header
}

@Override
public void onBackProgressed(LauncherState toState, float backProgress) {
    if (!mLauncher.isInState(ALL_APPS) || !NORMAL.equals(toState)) return;
    // 从 PREDICTIVE_BACK_MIN_SCALE 缩放到 1，随 backProgress 反向
    float scaleProgress = ScrollableLayoutManager.PREDICTIVE_BACK_MIN_SCALE
            + (1 - ScrollableLayoutManager.PREDICTIVE_BACK_MIN_SCALE) * (1 - backProgress);
    mAllAppScale.updateValue(scaleProgress);
}

private void onScaleProgressChanged() {
    final float scaleProgress = mAllAppScale.value;
    SCALE_PROPERTY.set(mLauncher.getAppsView(), scaleProgress); // 缩放整个 AppsView
    if (mShouldScaleHeader || !mShouldShowAllAppsOnSheet) {
        mLauncher.getScrimView().setScrimHeaderScale(scaleProgress); // 联动 scrim header 缩放
    }
    AllAppsRecyclerView rv = mLauncher.getAppsView().getActiveRecyclerView();
    // 缩放时禁用 View 裁剪，显示预计算的额外 icon 行（calculateExtraLayoutSpace）
    boolean hasScaleEffect = scaleProgress < 1f;
    if (hasScaleEffect != mHasScaleEffect) {
        mHasScaleEffect = hasScaleEffect;
        if (mHasScaleEffect) {
            modifyAttributesOnViewTree(rv, mLauncher.getAppsView(), CLIP_CHILDREN_FALSE_MODIFIER);
        } else {
            restoreAttributesOnViewTree(rv, mLauncher.getAppsView(), CLIP_CHILDREN_FALSE_MODIFIER);
        }
    }
}

public void animateAllAppsToNoScale() {
    if (mAllAppScale.isAnimating()) mAllAppScale.cancelAnimation();
    Animator animator = mAllAppScale.animateToValue(1f)
            .setDuration(REVERT_SWIPE_ALL_APPS_TO_HOME_ANIMATION_DURATION_MS); // 200ms
    if (mAllAppsSearchBackAnimationListener != null) {
        animator.addListener(mAllAppsSearchBackAnimationListener);
    }
    animator.start();
}
```

禁用裁剪的原因：缩放时 View 边缘会放大，若启用 `clipChildren`，放大露出的额外 icon 行会被裁掉。`modifyAttributesOnViewTree` 从 RV 到 AppsView 整棵树禁用裁剪，让预计算的额外 icon（`AppsGridLayoutManager.calculateExtraLayoutSpace`）可见，缩放动画不出现黑边。

### 8.7 Spring 物理回弹

`ActivityAllAppsContainerView` 继承 `SpringRelativeLayout`，提供手势松手后的弹性回弹：

```java
// 源码：ActivityAllAppsContainerView.java
public static final float PULL_MULTIPLIER = .02f;
public static final float FLING_VELOCITY_MULTIPLIER = 1200f;

public void addSpringFromFlingUpdateListener(ValueAnimator animator, float velocity, float progress) {
    animator.addListener(new AnimatorListenerAdapter() {
        @Override
        public void onAnimationStart(Animator animator) {
            float distance = (1 - progress) * getHeight(); // 剩余距离
            float settleVelocity = Math.min(0, distance
                    / (AllAppsTransitionController.INTERP_COEFF * animator.getDuration()) + velocity);
            absorbSwipeUpVelocity(Math.max(1000, Math.abs(
                    Math.round(settleVelocity * FLING_VELOCITY_MULTIPLIER))));
        }
    });
}

public void onPull(float deltaDistance, float displacement) {
    absorbPullDeltaDistance(PULL_MULTIPLIER * deltaDistance, PULL_MULTIPLIER * displacement);
}
```

`INTERP_COEFF = 1.7f` 是 `DECELERATE_1_7` 插值器的二阶导特征值，用于估算松手时的 settle velocity，让弹性回弹与状态动画速度衔接自然。

### 面试深问

1. **`mProgress` 为什么 0 是展开、1 是隐藏，与直觉相反？**
   `mProgress * mShiftRange = translationY`，展开时 translationY=0（贴顶），故 progress=0。隐藏时 translationY=shiftRange（下移出屏幕），故 progress=1。这与"进度"语义一致：progress 越大，离开 All Apps 的进度越深。`LauncherState.getVerticalProgress()` 返回值与此对应（ALL_APPS 返回 0，NORMAL 返回 1）。

2. **手机和大屏 sheet 的位移差异为什么需要两套 `ALL_APPS_PULL_BACK_TRANSLATION` 逻辑？**
   手机上 All Apps 全屏，pull back 是整个容器的弹性位移。大屏 sheet 上 sheet 位置固定（贴底），弹性反馈只能体现在内容 RV 上。同一个属性根据 `mShouldShowAllAppsOnSheet` 分流到不同 View，避免 sheet 模式下整个 sheet 弹跳。

3. **`MultiPropertyFactory` 为什么用 `Float::sum` 聚合？**
   progress 和 pullback 是两个独立的位移来源，可能同时非零（手势拖拽期间 progress 在变，pullback 也在积累）。取和让两者叠加：手势期间总位移 = 状态位移 + 弹性位移，松手后 pullback 归零，progress 接管。若取 max 或覆盖，弹性与状态会互相吞噬，视觉不连贯。
