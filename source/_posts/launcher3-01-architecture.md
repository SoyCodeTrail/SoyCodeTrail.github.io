---
title: Launcher3 源码精读（01）：核心架构
category: client
platform: android
tags: ["AOSP", "Launcher3", "源码", "Framework"]
readTime: 22分钟
featured: true
date: 2026-08-02
---

Launcher3 核心架构源码精读

源码基线 aosp-r4，路径 `packages/apps/Launcher3/src/com/android/launcher3/`。本文精读六个核心类：`Launcher`、`LauncherAppState`、`LauncherModel`、`LauncherProvider`、`ModelDbController`、`InvariantDeviceProfile`，以及它们依赖的 `LoaderTask`、`BgDataModel`、`DatabaseHelper`、`LauncherSettings`。本仓库已用 Dagger Hilt 风格依赖注入替代旧版的全局单例门面，`LauncherAppState` 退化为标了 `@Deprecated` 的 data class，DB 管理从 `LauncherProvider` 下沉到 `ModelDbController`。所有代码块均为真实源码裁剪，逐行注中文。

## Launcher.java 主 Activity 与总控

`Launcher` 继承 `StatefulActivity<LauncherState>`，实现 `BgDataModel.Callbacks` 和 `InvariantDeviceProfile.OnIDPChangeListener`。它是 MVC 的 View + Controller 合体：持有整个 View 树（Workspace / Hotseat / AllApps / DragLayer），同时通过 `Callbacks` 接收 Model 层数据。

```java
// Launcher.java
public class Launcher extends StatefulActivity<LauncherState>
        implements Callbacks, InvariantDeviceProfile.OnIDPChangeListener,
                LauncherOverlayCallbacks, ... {
```

### onCreate 按顺序做了哪些事

`onCreate` 是启动主链路，每一步顺序敏感。下面是源码裁剪，保留真实调用顺序：

```java
// Launcher.java onCreate (第 436 行起)
@Override
protected void onCreate(Bundle savedInstanceState) {
    TraceHelper.INSTANCE.beginSection(ON_CREATE_EVT);          // 开 systrace 段, 测启动耗时
    super.onCreate(savedInstanceState);
    mWallpaperThemeManager = new WallpaperThemeManager(this);  // 取壁纸主色驱动主题

    LauncherAppState app = LauncherAppState.getInstance(this); // 拿依赖聚合壳(Dagger 注入)
    mModel = app.getModel();                                   // 取全局 LauncherModel

    mRotationHelper = new RotationHelper(this);               // 旋转控制
    InvariantDeviceProfile idp = app.getInvariantDeviceProfile();
    initDeviceProfile(idp);                                    // 计算本机 DeviceProfile + 建 ModelWriter
    idp.addOnChangeListener(this);                            // 注册 IDP 变化回调
    mSharedPrefs = LauncherPrefs.getPrefs(this);
    mAccessibilityDelegate = createAccessibilityDelegate();

    initDragController();                                      // 建拖拽控制器
    mAllAppsController = new AllAppsTransitionController(this);
    mStateManager = new StateManager<>(this, NORMAL);          // 状态机, 初始 NORMAL(桌面)

    mAppWidgetManager = new WidgetManagerHelper(this);
    mAppWidgetHolder = LauncherWidgetHolder.newInstance(this); // Widget 宿主
    mAppWidgetHolder.setAppWidgetRemovedCallback(
            appWidgetId -> getWorkspace().removeWidget(appWidgetId));

    setupViews();                                              // inflate launcher.xml, 组装 View 树
    updateDisallowBack();

    mAppWidgetHolder.startListening();                         // 开始监听 Widget 更新
    mAppWidgetHolder.addProviderChangeListener(
            () -> refreshAndBindWidgetsForPackageUser(null));
    mWidgetVisibilityTracker = new WidgetVisibilityTracker(this, mAppWidgetHolder, mWorkspace,
        mStateManager);

    // ... PopupController / WidgetPickerDataProvider / SystemDragController 初始化 ...

    boolean internalStateHandled = ACTIVITY_TRACKER.handleCreate(this); // 处理外部拉起的目标状态
    restoreState(savedInstanceState);                          // 从 savedInstanceState 恢复状态
    mStateManager.reapplyState();                              // 把状态机的状态重新应用到 UI

    if (savedInstanceState != null) {
        int[] pageIds = savedInstanceState.getIntArray(RUNTIME_STATE_CURRENT_SCREEN_IDS);
        if (pageIds != null) {
            mModelCallbacks.setPagesToBindSynchronously(IntSet.wrap(pageIds)); // 告诉 Model 哪些屏要同步 bind
        }
    }

    // 核心握手: 把自己注册为 Callbacks 并触发数据加载
    if (!mModel.addCallbacksAndLoad(this)) {                   // 返回 false = 没同步 bind, 走异步
        if (!internalStateHandled) {
            // 数据没就绪, 暂停绘制, 让系统继续显示 loading 提示
            mOnInitialBindListener = Boolean.FALSE::booleanValue;
        }
    }

    setContentView(getRootView());                             // 设置根 View

    if (mOnInitialBindListener != null) {
        // 挂在 ViewTreeObserver 上, 首次 bind 完成前拦截 onPreDraw, 不绘制
        getRootView().getViewTreeObserver().addOnPreDrawListener(mOnInitialBindListener);
    }
    getRootView().dispatchInsets();

    // ... SettingsCache / ScreenOnTracker / OverlayManager 注册 ...

    mOverlayManager = getDefaultOverlay();                     // 默认空 Overlay(-1 屏/feed)
    mRotationHelper.initialize();
    getWindow().setSoftInputMode(LayoutParams.SOFT_INPUT_ADJUST_NOTHING);
}
```

`addCallbacksAndLoad(this)` 返回值的语义是整个启动时序的关键：返回 `true` 表示数据已加载且已同步 bind（快路径，桌面立即可见）；返回 `false` 表示数据未就绪，Model 启动了 `LoaderTask` 异步加载。异步路径下，`mOnInitialBindListener` 返回 `false` 拦截 `onPreDraw`，使首帧延迟到首次 bind 完成，避免显示空白桌面。

`initDeviceProfile` 的真实实现：

```java
// Launcher.java initDeviceProfile (第 724 行)
protected boolean initDeviceProfile(InvariantDeviceProfile idp) {
    DeviceProfile deviceProfile = idp.getDeviceProfile(this);  // 根据当前屏幕从 supportedProfiles 选一个
    if (mDeviceProfile == deviceProfile) {
        return false;                                          // 没变化(重建时复用)
    }
    mDeviceProfile = deviceProfile;

    // 坐标映射器: 模型坐标(screenId/cellX/cellY) ↔ 视图坐标
    // 双屏折叠用 TwoPanelCellPosMapper, 普通用 CellPosMapper
    if (FOLDABLE_SINGLE_PAGE.get() && mDeviceProfile.getDeviceProperties().isTwoPanels()) {
        mCellPosMapper = new TwoPanelCellPosMapper(mDeviceProfile.inv.numColumns);
    } else {
        mCellPosMapper = new CellPosMapper(mDeviceProfile.isVerticalBarLayout(),
                mDeviceProfile.numShownHotseatIcons);
    }
    mModelWriter = mModel.getWriter(true, mCellPosMapper, this); // 拿写库入口(拖拽后写回用)
    updateFixedLandscape();
    return true;
}
```

### setupViews 组装 View 树

```java
// Launcher.java setupViews (第 1275 行)
protected void setupViews() {
    if (allAppsBlur()) {
        getTheme().applyStyle(getAllAppsBlurStyleResId(), true); // AllApps 毛玻璃主题
    }
    inflateRootView(R.layout.launcher);                        // inflate launcher.xml

    mDragLayer = findViewById(R.id.drag_layer);                // 拖拽层, 所有内容的容器
    mFocusHandler = mDragLayer.getFocusIndicatorHelper();
    mWorkspace = mDragLayer.findViewById(R.id.workspace);      // 工作区(多页桌面)
    mWorkspace.initParentViews(mDragLayer);
    mOverviewPanel = findViewById(R.id.overview_panel);        // Overview 面板
    mHotseat = findViewById(R.id.hotseat);                     // 底部快捷栏
    mHotseat.setWorkspace(mWorkspace);

    mLeftArrow = findViewById(R.id.left_indicator_arrow);      // 翻页箭头
    mRightArrow = findViewById(R.id.right_indicator_arrow);

    mDragLayer.setup(mDragController, mWorkspace);
    mWorkspace.setup(mDragController);
    mWorkspace.lockWallpaperToDefaultPage();                   // bind 前锁壁纸偏移, 避免 RTL 错位
    mWorkspace.bindAndInitFirstWorkspaceScreen();              // 建第一屏(含 QSB 占位)
    mDragController.addDragListener(mWorkspace);

    mDropTargetBar = mDragLayer.findViewById(R.id.drop_target_bar); // 删除/卸载/信息 拖放目标栏
    mAppsView = findViewById(R.id.apps_view);                  // AllApps 容器
    mAppsView.setAllAppsTransitionController(mAllAppsController);
    mScrimView = findViewById(R.id.scrim_view);                // 背景遮罩
    mDropTargetBar.setup(mDragController);
    mAllAppsController.setupViews(mScrimView, mAppsView);

    mItemInflater = new ItemInflater<>(this, mAppWidgetHolder, getItemOnClickListener(),
            mFocusHandler, new CellLayout(mWorkspace.getContext(), mWorkspace));
}
```

### onResume / onPause / onNewIntent 实际逻辑

```java
// Launcher.java onResume (第 1203 行)
@Override
protected void onResume() {
    super.onResume();
    if (mDeferOverlayCallbacks) {
        scheduleDeferredCheck();                               // Overlay 回调延后(启动早期)
    } else {
        mOverlayManager.onActivityResumed();
    }
    DragView.removeAllViews(this);                             // 清残留 DragView
}

@Override
protected void onPause() {
    // 暂停期间新装的 App 先排队, resume 时再推到桌面
    ItemInstallQueue.INSTANCE.get(this).pauseModelPush(FLAG_ACTIVITY_PAUSED);
    super.onPause();
    mDragController.cancelDrag();                              // 取消进行中的拖拽
    mLastTouchUpTime = -1;
    mDropTargetBar.animateToVisibility(false);                 // 隐藏删除栏
    if (!mDeferOverlayCallbacks) {
        mOverlayManager.onActivityPaused();
    }
    mAppWidgetHolder.setActivityResumed(false);
}
```

真正的 resume 后处理在 `onDeferredResumed`（等空闲后执行）：

```java
// Launcher.java onDeferredResumed (第 1021 行)
@Override
protected void onDeferredResumed() {
    logStopAndResume(true /* isResume */);
    ItemInstallQueue.INSTANCE.get(this).resumeModelPush(FLAG_ACTIVITY_PAUSED); // 把排队的新 App 推入桌面
    mModel.validateModelDataOnResume();                        // 校验快捷方式权限是否变化
    DiscoveryBounce.showForHomeIfNeeded(this);                 // 引导动画
    mAppWidgetHolder.setActivityResumed(true);
}
```

`onNewIntent` 处理 HOME 键、ALL_APPS intent 等。关键变量 `alreadyOnHome`：判断是否已有窗口焦点且不是 BROUGHT_TO_FRONT，决定要不要把当前屏滑回默认屏。

```java
// Launcher.java onNewIntent (第 1539 行)
@Override
protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    boolean alreadyOnHome = hasWindowFocus() && ((intent.getFlags()
            & Intent.FLAG_ACTIVITY_BROUGHT_TO_FRONT) != Intent.FLAG_ACTIVITY_BROUGHT_TO_FRONT);
    boolean shouldMoveToDefaultScreen = alreadyOnHome && isInState(NORMAL)
            && AbstractFloatingView.getTopOpenView(this) == null;
    boolean isActionMain = Intent.ACTION_MAIN.equals(intent.getAction());
    boolean internalStateHandled = ACTIVITY_TRACKER.handleNewIntent(this);

    if (isActionMain) {
        if (!internalStateHandled) {
            AbstractFloatingView.closeAllOpenViewsExcept(this, isStarted(), ...); // 关浮层
            if (!isInState(NORMAL)) {
                mStateManager.goToState(NORMAL, mStateManager.shouldAnimateStateChange());
            }
            if (!alreadyOnHome) {
                mAppsView.reset(mStateManager.shouldAnimateStateChange(), false);
            }
            if (shouldMoveToDefaultScreen && !mWorkspace.isHandlingTouch()) {
                mWorkspace.post(mWorkspace::moveToDefaultScreen); // 回到默认屏
            }
        }
        mOverlayManager.hideOverlay(isStarted());
    } else if (Intent.ACTION_ALL_APPS.equals(intent.getAction())) {
        showAllAppsFromIntent(alreadyOnHome);
    } else if (INTENT_ACTION_ALL_APPS_TOGGLE.equals(intent.getAction())) {
        toggleAllApps(alreadyOnHome, true);
    } else if (Intent.ACTION_SHOW_WORK_APPS.equals(intent.getAction())) {
        showAllAppsWithSelectedTabFromIntent(alreadyOnHome, ...WORK);
    }
}
```

### 状态恢复 onSaveInstanceState

```java
// Launcher.java onSaveInstanceState (第 1680 行)
@Override
protected void onSaveInstanceState(Bundle outState) {
    outState.putIntArray(RUNTIME_STATE_CURRENT_SCREEN_IDS,             // 当前各屏 screenId
            mWorkspace.getCurrentPageScreenIds().getArray().toArray());
    outState.putInt(RUNTIME_STATE, mStateManager.getState().ordinal);  // 状态机序号(NORMAL/ALL_APPS...)

    AbstractFloatingView widgets = AbstractFloatingView
            .getOpenView(this, AbstractFloatingView.TYPE_WIDGETS_FULL_SHEET);
    if (widgets != null) {
        SparseArray<Parcelable> widgetsState = new SparseArray<>();
        widgets.saveHierarchyState(widgetsState);                       // Widget 选择面板状态
        outState.putSparseParcelableArray(RUNTIME_STATE_WIDGET_PANEL, widgetsState);
    }

    // 关闭非 rebind-safe 的浮层(打开的文件夹等), 避免重建后状态错乱
    AbstractFloatingView.closeAllOpenViewsExcept(this, isStarted() && !isForceInvisible(), TYPE_REBIND_SAFE);

    if (mPendingRequestArgs != null) {
        outState.putParcelable(RUNTIME_STATE_PENDING_REQUEST_ARGS, mPendingRequestArgs); // 待处理添加请求
    }
    outState.putInt(RUNTIME_STATE_PENDING_REQUEST_CODE, mPendingActivityRequestCode);
    if (mPendingActivityResult != null) {
        outState.putParcelable(RUNTIME_STATE_PENDING_ACTIVITY_RESULT, mPendingActivityResult);
    }
    super.onSaveInstanceState(outState);
}
```

`RUNTIME_STATE_CURRENT_SCREEN_IDS` 恢复后传给 `mModelCallbacks.setPagesToBindSynchronously`，让 LoaderTask 优先同步绑定用户当前看的屏，加速首屏可见。

### onDestroy 解绑

```java
// Launcher.java onDestroy (第 1714 行)
@Override
public void onDestroy() {
    super.onDestroy();
    ACTIVITY_TRACKER.onContextDestroyed(this);
    SettingsCache.INSTANCE.get(this).unregister(TOUCHPAD_NATURAL_SCROLLING, mNaturalScrollingChangedListener);
    ScreenOnTracker.INSTANCE.get(this).removeListener(mScreenOnListener);
    PluginManagerWrapper.INSTANCE.get(this).removePluginListener(this);

    mModel.removeCallbacks(this);                              // 从 Model 注销, 不再收 bind
    mRotationHelper.destroy();
    mAppWidgetHolder.stopListening();
    mAppWidgetHolder.destroy();
    mWidgetVisibilityTracker.destroy();
    mModelCallbacks.clearPendingBinds();                       // 丢弃未处理的 bind
    LauncherAppState.getIDP(this).removeOnChangeListener(this);
    mOverlayManager.onActivityDestroyed();
}
```

### onIdpChanged 配置变化

```java
// Launcher.java onIdpChanged / onHandleConfigurationChanged (第 674 行)
@Override
public void onIdpChanged(boolean modelPropertiesChanged) {
    onHandleConfigurationChanged();
}

@Override
protected void onHandleConfigurationChanged() {
    Trace.beginSection("Launcher#onHandleconfigurationChanged");
    try {
        if (!initDeviceProfile(mDeviceProfile.inv)) {          // DeviceProfile 没变就不处理
            return;
        }
        dispatchDeviceProfileChanged();
        reapplyUi();                                           // 重新应用主题
        mDragLayer.recreateControllers();
        onSaveInstanceState(new Bundle());                     // 初始化 listWidgets 静态缓存
        mModel.rebindCallbacks();                              // 重新跑 LoaderTask 把新网格数据 bind
        updateDisallowBack();
    } finally {
        Trace.endSection();
    }
}
```

### Launcher 接收数据的 Callbacks 转发

Launcher 实现了 `Callbacks`，但几乎所有 `bind*` 方法都转交给 `mModelCallbacks`（`ModelCallbacks` 对象）。Launcher 只负责生命周期与状态，数据→视图的具体填充被抽到 `ModelCallbacks`。

### 面试深问

**为什么 onCreate 里要先 `addCallbacksAndLoad` 再 `setContentView`？**
顺序无关绑定时机（Callback 只是注册），但 `mOnInitialBindListener` 必须在 `setContentView` 后挂到 ViewTreeObserver。真正原因是 `addCallbacksAndLoad` 可能触发同步 bind，此时 View 树已建好（setupViews 已 inflate），数据才能直接灌进去。

**为什么 `onPause` 要 `pauseModelPush`？**
Launcher 不可见时新装的 App 不该立刻出现在桌面（用户看不到，且可能打断正在进行的拖拽）。`ItemInstallQueue` 把这些安装事件排队，`onDeferredResumed` 时统一 `resumeModelPush` 批量推入，减少重复 bind。

**`mOnInitialBindListener` 拦截绘制为什么不会卡死？**
它是 `OnPreDrawListener` 返回 `false`，在首次 bind 完成后会被移除并触发重绘。`Boolean.FALSE::booleanValue` 是方法引用，首次 bind 完成调用 `clearPendingBinds`/`finishBindingItems` 时会把它置空并 `removeOnPreDrawListener`。

## LauncherAppState.kt 已废弃的依赖聚合壳

```kotlin
// LauncherAppState.kt (完整 48 行)
@Deprecated("Inject the specific targets directly instead of using LauncherAppState")
data class LauncherAppState
@Inject
constructor(
    @ApplicationContext val context: Context,
    val iconProvider: LauncherIconProvider,
    val iconCache: IconCache,
    val model: LauncherModel,
    val invariantDeviceProfile: InvariantDeviceProfile,
    @Named("SAFE_MODE") val isSafeModeEnabled: Boolean,
) {
    companion object {
        @JvmField var INSTANCE = DaggerSingletonObject { it.launcherAppState }
        @JvmStatic fun getInstance(context: Context) = INSTANCE[context]
        @JvmStatic fun getIDP(context: Context) = InvariantDeviceProfile.INSTANCE[context]
    }
}
```

### 为什么废弃，现在怎么注入

旧版 AOSP 里 `LauncherAppState` 是"上帝对象"单例：它 `new LauncherModel()`、`new IconCache()`、注册包广播，所有核心依赖都从它取。问题：单例硬编码依赖，无法替换、难测试、循环依赖风险高。

当前实现：`@Inject constructor` + Dagger。所有依赖（`IconCache`、`LauncherModel`、`InvariantDeviceProfile`、`ModelDbController`…）都标 `@LauncherAppSingleton`，由 Dagger 组件管理生命周期。`LauncherAppState` 退化成 `data class`，只是把一组常用依赖打包，方便 `Launcher.onCreate` 一行 `LauncherAppState.getInstance(this)` 全拿到。类注释 `@Deprecated` 明确建议新代码直接 `@Inject` 具体依赖。

`DaggerSingletonObject` 包装：`INSTANCE` 是一个 lambda `it.launcherAppState`，`it` 是 `LauncherAppComponent`。`getInstance(context)` 调用 `INSTANCE[context]` 会先取 Dagger 组件（`LauncherComponentProvider.get(context)`，内部双重检查锁懒加载），再从组件取实例。为什么用反射拿组件？因为 ContentProvider 可能在 Application.onCreate 之前就被访问，此时必须懒加载。

### 和 Launcher 的关系

Launcher 在 `onCreate` 通过 `LauncherAppState.getInstance(this)` 一次性拿到 `mModel`（LauncherModel）和 `idp`（InvariantDeviceProfile），之后所有操作都用这两个引用。AppState 本身不持有 Launcher，关系是单向的：Launcher → AppState（取依赖）。

### 面试深问

**为什么 `LauncherAppState` 是 data class 而不是普通 class？**
data class 自动生成 `equals`/`hashCode`/`toString`/`copy`，便于测试时构造不同的依赖组合。它的字段全是 val（不可变），没有可变状态，纯依赖容器。

**`DaggerSingletonObject` 解决什么问题？**
它把"从 Dagger 组件取单例"包装成静态访问（`INSTANCE[context]`），让 Java 代码（Launcher.java）无需改造成 `@Inject` 字段就能拿到 Kotlin 注入的对象。这是 Dagger 与遗留 Java 代码共存的桥接模式。

**如果新代码都该直接 `@Inject`，为什么还保留 `getInstance`？**
兼容。Launcher3 还有很多 Java 类（LauncherProvider、LoaderTask 的部分调用路径）通过静态方式取依赖，全改造成 `@Inject` 工作量大且影响范围广。`getInstance` 保留是为了渐进迁移。

## LauncherModel.kt Model 层核心

`LauncherModel` 是 MVC 的 Model：维护内存状态（`BgDataModel` + `AllAppsList`），调度异步加载（`LoaderTask`），处理增量更新（`ModelUpdateTask`）。标 `@LauncherAppSingleton`，整个进程一份。

### 关键状态字段

```kotlin
// LauncherModel.kt
@LauncherAppSingleton
class LauncherModel @Inject constructor(...) : LauncherDumpable {
    private val mCallbacksList = ArrayList<BgDataModel.Callbacks>(1) // 注册的回调(Launcher 等)
    private val mLock = Any()                                      // 所有状态字段的同步锁
    private var mLoaderTask: LoaderTask? = null                    // 当前加载任务
    private var mIsLoaderTaskRunning = false
    private var mShouldReloadWorkProfile = true                    // 每次重启只 reload 一次工作资料
    private var mModelLoaded = false                               // 数据是否已加载且有效
    private var mModelDestroyed = false

    fun isModelLoaded() = synchronized(mLock) {
        mModelLoaded && mLoaderTask == null && !mModelDestroyed    // 三条件全满足才算就绪
    }

    var lastLoadId: Int = -1                                       // 加载版本号, 丢弃过期 bind 用
        private set
}
```

`mModelLoaded` 注释明确：启动时为 false，加载完成后设 true，假设后续靠 PackageManager 监听做增量更新，不再 requery。`isModelLoaded()` 三个条件是"数据已加载 + 没有正在跑的 LoaderTask + 未销毁"。

### addCallbacksAndLoad 快慢双路径

Launcher 通过 `addCallbacksAndLoad(this)` 与 Model 建立关系。返回值决定走快路径（同步 bind）还是慢路径（LoaderTask 异步）。

```kotlin
// LauncherModel.kt
fun addCallbacksAndLoad(callbacks: BgDataModel.Callbacks): Boolean {
    synchronized(mLock) {
        addCallbacks(callbacks)
        return startLoader(arrayOf(callbacks))
    }
}

private fun startLoader(newCallbacks: Array<BgDataModel.Callbacks>): Boolean {
    // 加载期间暂停"新装 App 入桌", commit/close 时恢复
    installQueue.pauseModelPush(ItemInstallQueue.FLAG_LOADER_RUNNING)
    synchronized(mLock) {
        val wasRunning = stopLoader()                             // 停掉旧 LoaderTask
        val bindDirectly = mModelLoaded && !mIsLoaderTaskRunning  // 快路径条件: 已加载且无任务在跑
        val bindAllCallbacks = wasRunning || !bindDirectly || newCallbacks.isEmpty()
        val callbacksList = if (bindAllCallbacks) callbacks else newCallbacks
        if (callbacksList.isNotEmpty()) {
            val launcherBinder = binderFactory.createBinder(callbacksList)
            if (bindDirectly) {
                // 快路径: 数据已在内存, 直接同步 bind
                launcherBinder.bindWorkspace(bindAllCallbacks, /* isBindSync= */ true)
                launcherBinder.bindAllApps()
                launcherBinder.bindWidgets()
                return true                                        // 返回 true = 同步绑定成功
            } else {
                // 慢路径: 启动 LoaderTask 异步加载
                val task = loaderFactory.newLoaderTask(launcherBinder)
                mLoaderTask = task
                // 必须 post 而非直接 run, 为了退出嵌套 synchronized 块
                MODEL_EXECUTOR.post(task)
            }
        }
    }
    return false                                                   // 返回 false = 异步加载中
}
```

快路径发生在：进程没死、数据已加载（如配置变化导致 Activity 重建）。此时 `mModelLoaded == true`，直接用内存数据同步 bind，无需查 DB。慢路径发生在冷启动或 `forceReload` 后，必须跑 LoaderTask 从头查 DB + 系统服务。

### LoaderTransaction 版本号机制

LoaderTask 通过 `LoaderTransaction` 与 Model 交互，保证状态一致。`try-with-resources` 包裹：

```kotlin
// LauncherModel.kt
inner class LoaderTransaction(task: LoaderTask) : AutoCloseable {
    private var mTask: LoaderTask? = null

    init {
        synchronized(mLock) {
            if (mLoaderTask !== task) {
                throw CancellationException("Loader already stopped") // 已被新任务替换, 直接取消
            }
            this@LauncherModel.lastLoadId++                       // 加载版本号自增
            mTask = task
            mIsLoaderTaskRunning = true
            mModelLoaded = false                                  // 加载期间数据视为无效
        }
    }

    fun commit() {
        synchronized(mLock) {
            mModelLoaded = true                                   // 加载完成, 标记有效
        }
    }

    override fun close() {
        synchronized(mLock) {
            if (mLoaderTask === mTask) {
                mLoaderTask = null                                // 清理任务引用
            }
            mIsLoaderTaskRunning = false
        }
    }
}
```

`lastLoadId` 配合 `BgDataModel.lastBindId` 解决"快速切换网格导致 UI 数据错乱"。每次 LoaderTask 开始 `lastLoadId++`，bind 时把当前 `lastLoadId` 存入 `BgDataModel.lastLoadId`。若中途有新 LoaderTask 启动（`lastLoadId` 又变），旧任务的 bind 在 `BaseLauncherBinder.executeCallbacksTask` 里发现 `mMyBindingId != mBgDataModel.lastBindId`，直接丢弃（打印 "Too many consecutive reloads, skipping obsolete data-bind"）。

### forceReload 与 rebindCallbacks

```kotlin
// LauncherModel.kt
fun forceReload() {
    synchronized(mLock) {
        stopLoader()                  // 先停旧任务, 防止它之后把 mModelLoaded 设回 true
        mModelLoaded = false          // 标记数据失效
    }
    rebindCallbacks()                 // 重启加载
}

fun rebindCallbacks() {
    if (hasCallbacks()) startLoader()
}
```

`LauncherProvider` 外部改数据后就调 `forceReload`。`stopLoader` 的顺序很关键：必须先停旧任务再置 `mModelLoaded = false`，否则旧任务 commit 时会把 `mModelLoaded` 设回 true。

### enqueueModelUpdateTask 增量更新

不是所有变化都要全量重载。包安装/卸载/图标更新等通过 `ModelUpdateTask` 投到后台线程，增量改 `BgDataModel` 后增量 bind：

```kotlin
// LauncherModel.kt
fun enqueueModelUpdateTask(task: ModelUpdateTask) {
    if (mModelDestroyed) return
    MODEL_EXECUTOR.execute {
        if (!isModelLoaded()) {
            return@execute          // 必须先全量加载完, 否则丢弃(等 LoaderTask 跑完)
        }
        task.execute(taskControllerProvider.get(), mBgDataModel, mBgAllAppsList)
    }
}

fun interface ModelUpdateTask {
    fun execute(taskController: ModelTaskController, dataModel: BgDataModel, apps: AllAppsList)
}
```

典型 `ModelUpdateTask` 实现：`CacheDataUpdatedTask`（包图标更新）、`UserAvailabilityChangedTask`（工作资料可用性变化）、`UserLockStateChangedTask`（用户锁定/解锁）。这些只改对应条目，比 `forceReload` 全量重载高效得多。

### onUserEvent 用户变化分级处理

```kotlin
// LauncherModel.kt onUserEvent
fun onUserEvent(user: UserHandle, action: String) {
    when (action) {
        Intent.ACTION_MANAGED_PROFILE_AVAILABLE -> {
            if (mShouldReloadWorkProfile) {
                forceReload()                              // 大变化: 全量重载
            } else {
                enqueueModelUpdateTask(UserAvailabilityChangedTask(user)) // 增量
            }
            mShouldReloadWorkProfile = false               // 每次重启只全量 reload 一次
        }
        Intent.ACTION_MANAGED_PROFILE_UNAVAILABLE ->
            enqueueModelUpdateTask(UserAvailabilityChangedTask(user))
        UserCache.ACTION_PROFILE_LOCKED ->
            enqueueModelUpdateTask(UserLockStateChangedTask(user, false))
        UserCache.ACTION_PROFILE_UNLOCKED ->
            enqueueModelUpdateTask(UserLockStateChangedTask(user, true))
        Intent.ACTION_MANAGED_PROFILE_REMOVED -> {
            prefs.put(LauncherPrefs.WORK_EDU_STEP, 0)
            forceReload()
        }
        UserCache.ACTION_PROFILE_ADDED, UserCache.ACTION_PROFILE_REMOVED -> forceReload()
    }
}
```

策略：资料增删/移除走全量重载（结构变化大），锁定/解锁/可用性变化走增量（只改可见性）。`mShouldReloadWorkProfile` 保证每次设备重启只全量 reload 一次工作资料，避免重复开销。

### ModelWriter 用户操作的写库入口

```kotlin
// LauncherModel.kt
fun getWriter(verifyChanges: Boolean, cellPosMapper: CellPosMapper?, owner: BgDataModel.Callbacks?) =
    ModelWriter(context, this, mBgDataModel, verifyChanges, cellPosMapper, owner)
```

用户拖拽图标/添加 Widget 后，Launcher 持有的 `mModelWriter` 调 `addItemToDatabase`：先在 MODEL_EXECUTOR 改内存 `BgDataModel`，再写 favorites 表。这是 UI → Model → DB 的反向链路。

### 面试深问

**为什么 LauncherModel 加载用 LoaderTask 而不是 LiveData/协程？**
Launcher3 起步早于 Jetpack 成熟期，且加载涉及跨多个系统服务（LauncherApps/AppWidgetManager/ShortcutManager）、分步 bind、waitForIdle 等复杂时序，用 Runnable + Executor 更可控。LiveData 是主线程生命周期感知的响应式数据，不适合"后台构造、分步推送、版本化丢弃"这种重型流水线。协程理论上可行，但迁移成本高且老代码稳定。

**`LoaderTransaction` 用 try-with-resources 而不是手动 commit 有什么好处？**
异常或取消时 `close()` 自动清理 `mIsLoaderTaskRunning` 和 `mLoaderTask` 引用，避免任务崩了后 Model 卡在"加载中"状态。`commit()` 必须显式调用——只有成功完成才置 `mModelLoaded = true`，中途异常不会误标已加载。

**`lastLoadId` 为什么不直接复用 `lastBindId`？**
`lastLoadId` 是加载级别的版本号（每次 LoaderTask 开始自增），`lastBindId` 是 bind 级别的（每次 `bindWorkspace(incrementBindId=true)` 自增）。一次加载可能触发多次 bind（Workspace、AllApps、Widgets 分开），两个版本号粒度不同，绑定层校验用 `lastBindId` 更精确。

## LauncherProvider + ModelDbController 数据存储

### LauncherProvider ContentProvider 跨进程门面

`LauncherProvider` 是外部应用操作 Launcher 数据的唯一合法通道。类注释明确：只有系统分区应用或平台签名应用能访问。`onCreate` 极轻（直接返回 true），所有 CRUD 委托给 `ModelDbController`。

```java
// LauncherProvider.java
@Override
public Cursor query(Uri uri, String[] projection, String selection,
        String[] selectionArgs, String sortOrder) {
    Pair<String, String[]> args = parseUri(uri, selection, selectionArgs);
    Cursor[] result = new Cursor[1];
    executeControllerTask(controller -> {
        result[0] = controller.query(projection, args.first, args.second, sortOrder);
        return 0;
    });
    return result[0];
}
```

`executeControllerTask` 是关键调度逻辑：

```java
// LauncherProvider.java
private int executeControllerTask(ToIntFunction<ModelDbController> task) {
    if (Binder.getCallingPid() == Process.myPid()) {
        throw new IllegalArgumentException("Same process should call model directly");
        // 同进程直接抛异常, 强制走 ModelDbController, 避免无谓 binder+线程切换开销
    }
    try {
        return MODEL_EXECUTOR.submit(() -> {
            LauncherModel model = LauncherAppState.getInstance(getContext()).getModel();
            int count = task.applyAsInt(model.getModelDbController());
            if (count > 0) {
                MAIN_EXECUTOR.submit(model::forceReload);    // 数据变了, 强制重新加载+bind
            }
            return count;
        }).get();                                             // 同步等结果(binder 线程)
    } catch (Exception e) {
        throw new IllegalStateException(e);
    }
}
```

设计精妙点：同进程拦截（强制走 Controller 省 binder 开销）、跨进程投到 MODEL_EXECUTOR（保证线程安全）、写后通知 forceReload（UI 自动更新）。

### call() XML 导入导出

类注释明确不推荐直接 `insert/query`（加载中调用会出问题、非原子），推荐用 `call()` 的 XML 方式：

```java
// LauncherProvider.java
@Override
public Bundle call(String method, String arg, Bundle extras) {
    Bundle b = new Bundle();
    switch(method) {
        case METHOD_EXPORT_LAYOUT_XML:
            // 校验读权限
            CompletableFuture<String> resultFuture = LauncherComponentProvider
                    .get(getContext()).getLayoutImportExportHelper().exportModelDbAsXmlFuture();
            b.putString(KEY_LAYOUT, resultFuture.get());
            b.putString(KEY_RESULT, SUCCESS);
            return b;
        case METHOD_IMPORT_LAYOUT_XML:
            // 校验写权限
            LauncherComponentProvider.get(getContext())
                    .getLayoutImportExportHelper().importModelFromXml(arg); // 原子: 清旧+写新
            b.putString(KEY_RESULT, SUCCESS);
            return b;
        default:
            return null;
    }
}
```

XML 方式原子（一次清空 + 一次写入，2 次 binder 内完成）、支持自定义标签、加载中调用更安全。

### ModelDbController DB 管理器

```java
// ModelDbController.java
@LauncherAppSingleton
public class ModelDbController {
    protected DatabaseHelper mOpenHelper;                     // SQLiteOpenHelper

    @Inject
    ModelDbController(Context context, InvariantDeviceProfile idp, LauncherPrefs prefs,
            UserCache userCache, LayoutParserFactory layoutParserFactory,
            Provider<GridSizeMigrationLogic> migrationLogicFactory) { ... }

    // 懒加载打开 DB
    private synchronized void createDbIfNotExists() {
        if (mOpenHelper == null) {
            Consumer<ModelDbController> restoreTask = RestoreDbTask.createRestoreTask(mContext);
            String dbFile = mPrefs.get(DB_FILE);
            if (dbFile.isEmpty()) {
                dbFile = mIdp.dbFile;                         // 取 IDP 指定的网格 db
            }
            mOpenHelper = createDatabaseHelper(false, dbFile);
            restoreTask.accept(this);                         // 恢复备份任务
        }
    }

    @WorkerThread
    public Cursor query(String[] projection, String selection,
            String[] selectionArgs, String sortOrder) {
        createDbIfNotExists();
        SQLiteDatabase db = mOpenHelper.getWritableDatabase();
        Cursor result = db.query(TABLE_NAME, projection, selection, selectionArgs, null, null, sortOrder);
        final Bundle extra = new Bundle();
        extra.putString(EXTRA_DB_NAME, mOpenHelper.getDatabaseName()); // 把 db 名塞 Cursor extras
        result.setExtras(extra);
        return result;
    }

    @WorkerThread
    public int insert(ContentValues initialValues) {
        createDbIfNotExists();
        SQLiteDatabase db = mOpenHelper.getWritableDatabase();
        addModifiedTime(initialValues);                       // 自动加 modified 时间戳
        int rowId = mOpenHelper.dbInsertAndCheck(db, TABLE_NAME, initialValues);
        if (rowId >= 0) {
            onAddOrDeleteOp(db);                              // 增删后清理 hybrid hotseat 备份表
        }
        return rowId;
    }
}
```

所有 CRUD 都先 `createDbIfNotExists()` 懒加载，保证 DB 在首次访问时才打开。`EXTRA_DB_NAME` 通过 Cursor extras 传回当前 db 文件名，LoaderTask 用它判断是否在主 db 上做 sanitize。

#### 默认布局加载

```java
// ModelDbController.java
// 优先级: app限制 > Play 提供的布局 > OEM 伴侣 APK > 本机默认 XML
@WorkerThread
public synchronized void loadDefaultFavoritesIfNecessary() {
    createDbIfNotExists();
    if (mPrefs.get(getEmptyDbCreatedKey())) {                 // 仅空库才加载
        LauncherWidgetHolder widgetHolder = mOpenHelper.newLauncherWidgetHolder();
        try {
            AutoInstallsLayout loader =
                    mLayoutParserFactory.createExternalLayoutParser(widgetHolder, mOpenHelper);
            final boolean usingExternallyProvidedLayout = loader != null;
            if (loader == null) {
                loader = getDefaultLayoutParser(widgetHolder); // fallback: default_workspace_*.xml
            }
            mOpenHelper.createEmptyDB(mOpenHelper.getWritableDatabase()); // 清半恢复的脏数据
            if ((mOpenHelper.loadFavorites(mOpenHelper.getWritableDatabase(), loader) <= 0)
                    && usingExternallyProvidedLayout) {
                // 外部布局加载失败, 清空再加载内部默认布局
                mOpenHelper.createEmptyDB(mOpenHelper.getWritableDatabase());
                mOpenHelper.loadFavorites(mOpenHelper.getWritableDatabase(),
                        getDefaultLayoutParser(widgetHolder));
            }
            clearFlagEmptyDbCreated();
        } finally {
            widgetHolder.destroy();
        }
    }
}
```

#### 网格迁移 attemptMigrateDb

切换网格时，判断源/目标网格能否迁移（`GridMigrationOption.canMigrate`），能则调 `GridSizeMigrationLogic.migrateGrid` 把旧 db 的 item 重排到新网格 db；不能迁移或迁移失败则 `resetLauncherDb`（清空重建）。

```java
// ModelDbController.java
public void attemptMigrateDb(LauncherRestoreEventLogger restoreEventLogger,
        ModelDelegate modelDelegate) throws Exception {
    createDbIfNotExists();
    if (shouldResetDb()) {
        resetLauncherDb(restoreEventLogger);                  // 直接重置
        return;
    }
    DatabaseHelper oldHelper = mOpenHelper;
    List<String> existingDBs = LauncherFiles.GRID_DB_FILES.stream()
            .filter(dbName -> mContext.getDatabasePath(dbName).exists())
            .collect(Collectors.toList());
    try {
        DeviceGridState srcDeviceState = new DeviceGridState(mContext);
        DeviceGridState destDeviceState = new DeviceGridState(mIdp);
        boolean isDestNewDb = !existingDBs.contains(destDeviceState.getDbFile());
        GridMigrationOption sourceGridMigrationOption = GridMigrationOption.Companion.from(
                srcDeviceState.getColumns(), srcDeviceState.getRows());
        GridMigrationOption destinationGridMigrationOption = GridMigrationOption.Companion.from(
                destDeviceState.getColumns(), destDeviceState.getRows());
        if (sourceGridMigrationOption != null && destinationGridMigrationOption != null
                && sourceGridMigrationOption.canMigrate(destinationGridMigrationOption, isAfterRestore)) {
            mOpenHelper = createDatabaseHelper(true, new DeviceGridState(mIdp).getDbFile());
            gridSizeMigrationLogic.migrateGrid(srcDeviceState, destDeviceState,
                    mOpenHelper, oldHelper.getWritableDatabase(), isDestNewDb, modelDelegate);
        }
    } catch (Exception e) {
        resetLauncherDb(restoreEventLogger);
        throw new Exception("attemptMigrateDb: Failed to migrate grid", e);
    } finally {
        if (mOpenHelper != oldHelper) {
            oldHelper.close();
        }
    }
}
```

#### 数据清洗保持一致性

ModelDbController 提供三个清洗方法，保证 favorites 表引用完整性：

```java
// ModelDbController.java
// 删除没有子 item 的空文件夹
public IntArray deleteEmptyFolders() {
    // SELECT _id WHERE itemType=FOLDER AND _id NOT IN (SELECT container FROM favorites)
}

// 删除成员数 ≠ 2 的 App Pair
public IntArray deleteBadAppPairs() {
    // SELECT _id WHERE itemType=APP_PAIR AND _id NOT IN
    //   (SELECT container FROM favorites GROUP BY container HAVING COUNT(*) = 2)
}

// 删除 container 指向不存在文件夹的孤儿 app
public IntArray deleteUnparentedApps() {
    // SELECT _id WHERE container >= 0 AND container NOT IN (SELECT _id FROM favorites)
}
```

### favorites 表 Schema

favorites 是唯一用户数据表，每行 = 桌面一个 item。建表 SQL 由 `LauncherSettings.Favorites.addTableToDb` 生成，列定义在 `getColumnsToTypes`：

```java
// LauncherSettings.java
public static void addTableToDb(SQLiteDatabase db, long myProfileId, boolean optional,
        String tableName) {
    db.execSQL("CREATE TABLE " + (optional ? " IF NOT EXISTS " : "") + tableName + " ("
            + getJoinedColumnsToTypes(myProfileId) + ");");
}

@NonNull
private static LinkedHashMap<String, String> getColumnsToTypes(long profileId) {
    final LinkedHashMap<String, String> columnsToTypes = new LinkedHashMap<>();
    columnsToTypes.put(_ID, "INTEGER PRIMARY KEY");
    columnsToTypes.put(TITLE, "TEXT");
    columnsToTypes.put(INTENT, "TEXT");              // 启动 Intent (URI 形式)
    columnsToTypes.put(CONTAINER, "INTEGER");        // 容器(桌面/Hotseat/文件夹ID)
    columnsToTypes.put(SCREEN, "INTEGER");           // 所在屏幕页(Hotseat 下=rank)
    columnsToTypes.put(CELLX, "INTEGER");            // 单元格 X
    columnsToTypes.put(CELLY, "INTEGER");            // 单元格 Y
    columnsToTypes.put(SPANX, "INTEGER");            // X 跨度(Widget 用)
    columnsToTypes.put(SPANY, "INTEGER");            // Y 跨度
    columnsToTypes.put(ITEM_TYPE, "INTEGER");        // item 类型
    columnsToTypes.put(APPWIDGET_ID, "INTEGER NOT NULL DEFAULT -1");
    columnsToTypes.put(ICON, "BLOB");                // 自定义图标二进制
    columnsToTypes.put(APPWIDGET_PROVIDER, "TEXT");  // Widget provider ComponentName
    columnsToTypes.put(MODIFIED, "INTEGER NOT NULL DEFAULT 0");
    columnsToTypes.put(RESTORED, "INTEGER NOT NULL DEFAULT 0");
    columnsToTypes.put(PROFILE_ID, "INTEGER DEFAULT " + profileId); // 多用户/工作资料
    columnsToTypes.put(RANK, "INTEGER NOT NULL DEFAULT 0");         // 文件夹内/hotseat 顺序
    columnsToTypes.put(OPTIONS, "INTEGER NOT NULL DEFAULT 0");      // 通用 flag 位
    columnsToTypes.put(APPWIDGET_SOURCE, "INTEGER NOT NULL DEFAULT -1"); // Widget 来源容器
    return columnsToTypes;
}
```

用 `LinkedHashMap` 保持列插入顺序，`getJoinedColumnsToTypes` 拼成 `"col1 type1, col2 type2, ..."`。

#### favorites 表列定义

| 列名 | 类型 | 含义 |
|---|---|---|
| `_id` | INTEGER PRIMARY KEY | 行 ID，全局唯一，引用基础 |
| `title` | TEXT | 显示名称 |
| `intent` | TEXT | 启动 Intent 的 URI（`Intent.parseUri` 还原） |
| `container` | INTEGER | 容器：负数常量=桌面/Hotseat，正数=文件夹行 `_id` |
| `screen` | INTEGER | 桌面页码；Hotseat 下=rank |
| `cellX` / `cellY` | INTEGER | 单元格坐标 |
| `spanX` / `spanY` | INTEGER | 跨度（Widget 用） |
| `itemType` | INTEGER | item 类型（见下表） |
| `appWidgetId` | INTEGER | Widget 系统分配的 id，默认 -1 |
| `icon` | BLOB | 自定义图标二进制 |
| `appWidgetProvider` | TEXT | Widget provider ComponentName |
| `modified` | INTEGER | 最后修改时间戳 |
| `restored` | INTEGER | 恢复状态标志位 |
| `profileId` | INTEGER | 用户/工作资料 serial number |
| `rank` | INTEGER | 文件夹内/hotseat 内顺序 |
| `options` | INTEGER | 通用 flag 位 |
| `appWidgetSource` | INTEGER | Widget 来源容器 |

#### ITEM_TYPE 取值

| 常量 | 值 | 含义 |
|---|---|---|
| `ITEM_TYPE_NON_ACTIONABLE` | -1 | 不可点击 |
| `ITEM_TYPE_APPLICATION` | 0 | 普通应用 |
| `ITEM_TYPE_SHORTCUT` | 1 | 旧式快捷方式（@Deprecated） |
| `ITEM_TYPE_FOLDER` | 2 | 文件夹 |
| `ITEM_TYPE_APPWIDGET` | 4 | App Widget |
| `ITEM_TYPE_CUSTOM_APPWIDGET` | 5 | Launcher 自定义 Widget（如时钟） |
| `ITEM_TYPE_DEEP_SHORTCUT` | 6 | 深度快捷方式（长按弹出） |
| `ITEM_TYPE_TASK` | 7 | Recents 任务（仅 metrics，不入库） |
| `ITEM_TYPE_QSB` | 8 | 搜索栏（仅 metrics） |
| `ITEM_TYPE_SEARCH_ACTION` | 9 | 搜索动作（仅 metrics） |
| `ITEM_TYPE_APP_PAIR` | 10 | 分屏应用对 |

#### CONTAINER 取值

| 常量 | 值 | 含义 |
|---|---|---|
| `CONTAINER_DESKTOP` | -100 | 桌面工作区 |
| `CONTAINER_HOTSEAT` | -101 | 底部 Hotseat |
| `CONTAINER_ALL_APPS_PREDICTION` | -102 | AllApps 预测 |
| `CONTAINER_HOTSEAT_PREDICTION` | -103 | Hotseat 预测 |
| `CONTAINER_ALL_APPS` | -104 | AllApps |
| `CONTAINER_WIDGETS_TRAY` | -105 | Widget 托盘 |
| `CONTAINER_SHORTCUTS` | -107 | 快捷方式容器 |
| `CONTAINER_SETTINGS` | -108 | 设置 |
| `CONTAINER_TASKSWITCHER` | -109 | 任务切换器 |
| `CONTAINER_PRIVATESPACE` | -110 | 私密空间 |
| `CONTAINER_WIDGETS_PREDICTION` | -111 | Widget 预测 |
| `CONTAINER_BOTTOM_WIDGETS_TRAY` | -112 | 底部 Widget 托盘 |
| `CONTAINER_PIN_WIDGETS` | -113 | 固定 Widget |
| `CONTAINER_WALLPAPERS` | -114 | 壁纸 |
| `EXTENDED_CONTAINERS` | -200 | 非 AOSP 扩展容器 |
| `CONTAINER_UNKNOWN` | -1 | 未知 |
| ≥ 0 | 正数 | 在某文件夹内（值为该 folder 行的 `_id`） |

设计精髓：负数常量表示固定容器，正数表示文件夹 ID，一个 `CONTAINER` 字段表达"在桌面/在 Hotseat/在哪个文件夹"。

坐标语义（Provider 类注释强调）：item 在 Hotseat 时 `SCREEN` 表示 rank；item 在文件夹内时 `RANK` 列决定顺序；item 在桌面工作区时 `SCREEN` 表示工作区页码。

### DatabaseHelper SQLiteOpenHelper

```java
// DatabaseHelper.java
public class DatabaseHelper extends SQLiteOpenHelper implements LayoutParserCallback {
    // schema 版本, 改表结构就 +1; downgrade_schema.json 必须同步更新
    public static final int SCHEMA_VERSION = Flags.enableLauncherIconShapes() ? 34 : 32;
    private final AtomicInteger mMaxItemId = new AtomicInteger(-1); // 缓存最大 _id, 避免每次查 DB

    @Override
    public void onCreate(SQLiteDatabase db) {
        mMaxItemId.set(1);
        addTableToDb(db, getDefaultUserSerial(), false /* optional */); // 建 favorites 表
        mMaxItemId.set(initializeMaxItemId(db));                       // 从 DB 读 max(_id) 初始化
        mOnEmptyDbCreateCallback.run();                                // 通知空库已建
    }

    @Override
    public int generateNewItemId() {
        if (mMaxItemId.get() < 0) {
            throw new RuntimeException("Error: max item id was not initialized");
        }
        return mMaxItemId.incrementAndGet();                           // 自增, 线程安全
    }

    public int getNewScreenId() {
        // 桌面 screenId = MAX(SCREEN WHERE CONTAINER=DESKTOP AND SCREEN>=0) + 1
        return getMaxId(getWritableDatabase(),
                "SELECT MAX(%1$s) FROM %2$s WHERE %3$s = %4$d AND %1$s >= 0",
                Favorites.SCREEN, Favorites.TABLE_NAME, Favorites.CONTAINER,
                Favorites.CONTAINER_DESKTOP) + 1;
    }
}
```

#### 数据库升级 onUpgrade

```java
// DatabaseHelper.java onUpgrade (fall-through switch 链式增量迁移)
@Override
public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
    switch (oldVersion) {
        case 12: // No-op
        case 13: {
            try (SQLiteTransaction t = new SQLiteTransaction(db)) {
                db.execSQL("ALTER TABLE favorites ADD COLUMN appWidgetProvider TEXT;");
                t.commit();
            } catch (SQLException ex) { break; }   // 失败则跳出, 后面会清空重建
        }
        case 14: { if (!addIntegerColumn(db, Favorites.MODIFIED, 0)) break; }
        case 15: { if (!addIntegerColumn(db, Favorites.RESTORED, 0)) break; }
        // ... 每个 case 是一次增量迁移, fall-through 到目标版本 ...
        case 25: convertShortcutsToLauncherActivities(db);   // 把老快捷方式转成应用
        case 27: { /* 重排 workspace screen id, 删 workspaceScreens 表 */ }
        case 28: { addIntegerColumn(db, Favorites.APPWIDGET_SOURCE, Favorites.CONTAINER_UNKNOWN); }
        case 29: { /* 删 widget panel 残留 */ }
        case 30: { /* 清 screen 0 首行垃圾数据 */ }
        case 31: { LauncherDbUtils.migrateLegacyShortcuts(mContext, db); }
        case 32:
        case 33: {
            // 备份图标裁剪成默认形状, 处理降级备份
            LauncherDbUtils.updateBackupIcons(mContext, db, true);
        }
        case 34: {
            return;                                // 已是最新
        }
    }
    Log.w(TAG, "Destroying all old data.");
    createEmptyDB(db);                             // 任何中途失败兜底: 清空重建
}
```

`onDowngrade` 用 `downgrade_schema.json` 描述"目标版本应有的列"，降级时按需 drop（SQLite 不支持直接删列）。失败则 `createEmptyDB`。

```java
// DatabaseHelper.java
@Override
public void onDowngrade(SQLiteDatabase db, int oldVersion, int newVersion) {
    try {
        DbDowngradeHelper.parse(mContext.getFileStreamPath(DOWNGRADE_SCHEMA_FILE))
                .onDowngrade(db, oldVersion, newVersion);
    } catch (Exception e) {
        createEmptyDB(db);                         // 降级失败兜底
    }
}
```

### 面试深问

**为什么 DB 管理要从 ContentProvider 下沉到 ModelDbController？**
职责分离。ContentProvider 的本职是跨进程契约（URI 解析、权限校验、binder 调度），不该混入建表、迁移、ID 分配等业务逻辑。下沉后 Provider 只剩门面，Controller 被进程内直接持有（LauncherModel 持有），同进程调用零 binder 开销，且 Controller 可被 LoaderTask/ModelUpdateTask 直接复用。

**为什么 favorites 只有一张表？**
桌面 item 的共性（位置、容器、类型）远多于差异，单表 + `itemType` 区分比多表 JOIN 简单。Widget 多 `appWidgetId`/`appWidgetProvider`，文件夹多子 item（靠 `container` 引用），这些差异用列+标志位吸收，避免多表关联开销。读取时 `LoaderCursor` 按 `itemType` 分发到不同 `ItemInfo` 子类。

**`onUpgrade` 的 fall-through switch 有什么陷阱？**
必须保证每个 case 的迁移是幂等且顺序正确的，漏掉一个 case 或顺序写错会导致数据损坏。SQLite 的 `ALTER TABLE ADD COLUMN` 不带 IF NOT EXISTS，重复执行会抛异常，所以用 try-catch + break 兜底，break 后跳到 `createEmptyDB` 清空重建（数据丢失但能恢复运行）。

## InvariantDeviceProfile.java 设备配置

IDP 是"不随 Activity 重建而变化"的设备级配置：网格行列、图标尺寸、hotseat 数、对应 db 文件名、默认布局 XML。标 `@LauncherAppSingleton`，整个进程一份。

### 核心字段

```java
// InvariantDeviceProfile.java
public static final String GRID_NAME_PREFS_KEY = "idp_grid_name";         // 用户选的网格名
private static final float KNEARESTNEIGHBOR = 3;                          // 反距离加权的近邻数
private static final float WEIGHT_POWER = 5;                              // 权重幂次

public int numRows, numColumns;                                           // 工作区行列
public int numSearchContainerColumns;
public float[] iconSize;                                                  // 各方向图标尺寸(默认/横屏/双屏)
public float[] iconTextSize;                                              // 各方向文字尺寸
public @DeviceType int deviceType;                                        // PHONE/TABLET/MULTI_DISPLAY/DESKTOP
public int numShownHotseatIcons;                                          // 显示的 hotseat 图标数
public int numDatabaseHotseatIcons;                                       // DB 里存的 hotseat 数(≥显示数, 兼容多网格)
public String dbFile;                                                     // 该网格对应的数据库文件名
public int defaultLayoutId;                                               // 首次启动填充桌面的默认布局 XML
public boolean isScalable;                                                // 是否可缩放网格
```

### device_profiles.xml 解析

IDP 从 `res/xml/device_profiles.xml` 读取候选网格。每个 `<grid-option>` 定义一种网格，内含若干 `<display-option>`（不同屏幕尺寸的参数桶）：

```xml
<!-- res/xml/device_profiles.xml -->
<profiles xmlns:launcher="http://schemas.android.com/apk/res-auto">
  <grid-option
      launcher:name="3_by_3"
      launcher:numRows="3" launcher:numColumns="3"
      launcher:numFolderRows="2" launcher:numFolderColumns="3"
      launcher:numHotseatIcons="3"
      launcher:dbFile="launcher_3_by_3.db"                       <!-- 指定数据库文件 -->
      launcher:defaultLayoutId="@xml/default_workspace_3x3"
      launcher:deviceCategory="phone">
    <display-option launcher:name="Super Short Stubby"
        launcher:minWidthDps="255" launcher:minHeightDps="300"
        launcher:iconImageSize="48" launcher:iconTextSize="13.0"
        launcher:allAppsBorderSpace="16" launcher:allAppsCellHeight="104"
        launcher:canBeDefault="true" />
    <display-option launcher:name="Shorter Stubby" .../>
  </grid-option>

  <grid-option launcher:name="4_by_4"
      launcher:numHotseatIcons="4" launcher:numExtendedHotseatIcons="6"
      launcher:dbFile="launcher_4_by_4.db" .../>
</profiles>
```

`dbFile` 决定 `ModelDbController` 打开哪个数据库（不同网格用不同 db，切换网格时做迁移）；`defaultLayoutId` 在首次启动（空库）时由 `loadDefaultFavoritesIfNecessary` 解析，把默认图标/Widget 写入 favorites 表。

### 构造与 initGrid

```java
// InvariantDeviceProfile.java 构造 (第 277 行)
@Inject
InvariantDeviceProfile(@ApplicationContext Context context, LauncherPrefs prefs,
        DisplayController dc, WindowManagerProxy wmProxy, ThemeManager themeManager,
        DaggerSingletonTracker lifeCycle, TaskbarModeUtil taskbarModeUtil,
        @Ui final LooperExecutor mainExecutor) {
    mDisplayController = dc;
    mPrefs = prefs;
    mMainExecutor = mainExecutor;

    String gridName = prefs.get(GRID_NAME);                   // 用户上次选的网格
    initGrid(gridName);
    mThemeManager.generateIconShape(iconBitmapSize);

    // 监听密度/分辨率/导航模式/任务栏/桌面模式变化 → onConfigChanged
    dc.setPriorityListener((displayContext, info, flags) -> {
        if ((flags & (CHANGE_DENSITY | CHANGE_SUPPORTED_BOUNDS
                | CHANGE_NAVIGATION_MODE | CHANGE_TASKBAR_PINNING
                | CHANGE_DESKTOP_MODE)) != 0) {
            onConfigChanged();
        }
    });

    // 监听 prefs 变化(横屏锁定/双行AllApps)
    LauncherPrefChangeListener prefListener = key -> {
        if (FIXED_LANDSCAPE_MODE.getSharedPrefKey().equals(key) ...) {
            onConfigChanged();
        }
    };
    prefs.addListener(prefListener, FIXED_LANDSCAPE_MODE, ENABLE_TWOLINE_ALLAPPS_TOGGLE);

    // 监听语言变化
    SimpleBroadcastReceiver localeReceiver = new SimpleBroadcastReceiver(context,
            mMainExecutor, i -> onConfigChanged());
    localeReceiver.register(actionsFilter(Intent.ACTION_LOCALE_CHANGED));
}

private void initGrid(String gridName) {
    Info displayInfo = mDisplayController.getInfo();
    List<DisplayOption> allOptions = getPredefinedDeviceProfiles( // 解析 device_profiles.xml
            displayInfo, gridName, ...);

    // 按用户偏好的列数过滤候选
    DeviceGridState deviceGridState = new DeviceGridState(mPrefs);
    List<DisplayOption> allOptionsFilteredByColCount =
            filterByColumnCount(allOptions, deviceGridState.getColumns());

    // 反距离加权插值, 选出最接近当前屏幕的参数
    DisplayOption displayOption =
            invDistWeightedInterpolate(displayInfo, allOptionsFilteredByColCount.isEmpty()
                            ? new ArrayList<>(allOptions)
                            : new ArrayList<>(allOptionsFilteredByColCount),
                    displayInfo.getDeviceType());

    if (!displayOption.grid.name.equals(gridName)) {
        mPrefs.put(GRID_NAME, displayOption.grid.name);       // 持久化选中的网格名
    }
    initGridForDisplayOption(displayInfo, displayOption);
}
```

### invDistWeightedInterpolate 反距离加权插值

这是 IDP 适配多分辨率的核心算法。不是简单选最近邻，而是在最近邻之间插值，算出本机精确的图标/文字尺寸。

```java
// InvariantDeviceProfile.java invDistWeightedInterpolate (第 882 行)
private static DisplayOption invDistWeightedInterpolate(
        Info displayInfo, List<DisplayOption> points, @DeviceType int deviceType) {
    int minWidthPx = Integer.MAX_VALUE;
    int minHeightPx = Integer.MAX_VALUE;
    for (WindowBounds bounds : displayInfo.supportedBounds) {
        boolean isTablet = displayInfo.isTablet(bounds);
        if (isTablet && deviceType == TYPE_MULTI_DISPLAY) {
            minWidthPx = Math.min(minWidthPx, bounds.availableSize.x / 2); // 分屏取半宽
            minHeightPx = Math.min(minHeightPx, bounds.availableSize.y);
        } else if (!isTablet && bounds.isLandscape()) {
            minWidthPx = Math.min(minWidthPx, bounds.availableSize.y); // 横屏手机用转置布局
            minHeightPx = Math.min(minHeightPx, bounds.availableSize.x);
        } else {
            minWidthPx = Math.min(minWidthPx, bounds.availableSize.x);
            minHeightPx = Math.min(minHeightPx, bounds.availableSize.y);
        }
    }

    float width = dpiFromPx(minWidthPx, displayInfo.getDensityDpi());  // 转 dp
    float height = dpiFromPx(minHeightPx, displayInfo.getDensityDpi());

    // 按到设备尺寸的距离排序候选
    points.sort((a, b) ->
            Float.compare(dist(width, height, a.minWidthDps, a.minHeightDps),
                    dist(width, height, b.minWidthDps, b.minHeightDps)));

    DisplayOption closestPoint = points.get(0);
    if (dist(width, height, closestPoint.minWidthDps, closestPoint.minHeightDps) == 0) {
        return closestPoint;                                  // 完全匹配, 直接返回
    }

    DisplayOption out = new DisplayOption(closestPoint.grid);
    for (int i = 0; i < points.size() && i < KNEARESTNEIGHBOR; ++i) { // 取最近 KNEARESTNEIGHBOR=3 个
        DisplayOption p = points.get(i);
        float w = weight(width, height, p.minWidthDps, p.minHeightDps, WEIGHT_POWER); // 权重 = 1/dist^5
        weights += w;
        out.add(new DisplayOption().add(p).multiply(w));      // 加权累加各参数
    }
    out.multiply(1.0f / weights);                             // 归一化

    // 图标 bitmap 尺寸持久化, 不能超过预定义值, 避免缓存失效
    for (int i = INDEX_DEFAULT; i < COUNT_SIZES; i++) {
        out.iconSizes[i] = Math.min(out.iconSizes[i], closestPoint.iconSizes[i]);
    }
    return out;
}
```

`weight` 函数：距离越近权重越大（`WEIGHT_POWER=5` 次方），3 个最近邻加权平均，得到本机精确的 iconSize/iconTextSize/minCellSize 等。这就是为什么不同分辨率手机图标大小都"恰到好处"——不是查表取固定值，而是插值算出来的连续值。

### initGridForDisplayOption 应用插值结果

```java
// InvariantDeviceProfile.java initGridForDisplayOption (第 382 行)
private void initGridForDisplayOption(Info displayInfo, DisplayOption displayOption) {
    GridOption closestProfile = displayOption.grid;
    numRows = closestProfile.numRows;                         // 网格行列来自 GridOption(离散)
    numColumns = closestProfile.numColumns;
    dbFile = closestProfile.dbFile;
    defaultLayoutId = closestProfile.defaultLayoutId;
    isScalable = closestProfile.isScalable;
    this.deviceType = displayInfo.getDeviceType();

    iconSize = displayOption.iconSizes;                       // 图标尺寸来自插值结果(连续)
    float maxIconSize = iconSize[0];
    for (int i = 1; i < iconSize.length; i++) {
        maxIconSize = Math.max(maxIconSize, iconSize[i]);
    }
    iconBitmapSize = ResourceUtils.pxFromDp(maxIconSize, metrics); // 图标 bitmap 像素尺寸
    fillResIconDpi = getLauncherIconDensity(iconBitmapSize);       // 对应 DPI

    iconTextSize = displayOption.textSizes;
    numShownHotseatIcons = closestProfile.numHotseatIcons;    // hotseat 数来自 GridOption
    numDatabaseHotseatIcons = deviceType == TYPE_MULTI_DISPLAY
            ? closestProfile.numDatabaseHotseatIcons : closestProfile.numHotseatIcons;

    // 为每个 supportedBounds 构建一个 DeviceProfile
    final List<DeviceProfile> localSupportedProfiles = new ArrayList<>();
    for (WindowBounds bounds : displayInfo.supportedBounds) {
        localSupportedProfiles.add(newDPBuilder(displayInfo)
                .setIsMultiDisplay(deviceType == TYPE_MULTI_DISPLAY)
                .setWindowBounds(bounds)
                .build());
    }
    supportedProfiles = Collections.unmodifiableList(localSupportedProfiles);

    applyPartnerDeviceProfileOverrides(context, metrics);     // OEM APK 可覆盖行列/图标尺寸
}
```

`getDeviceProfile(context)` 运行时根据当前屏幕从 `supportedProfiles` 选最匹配的（按宽高差最小）：

```java
// InvariantDeviceProfile.java
public DeviceProfile getDeviceProfile(Context context) {
    Rect bounds = mWMProxy.getCurrentBounds(context);
    int rotation = mWMProxy.getRotation(context);
    return getBestMatch(bounds.width(), bounds.height(), rotation);
}
```

### 多设备适配逻辑

`deviceType` 区分 PHONE / TABLET / MULTI_DISPLAY / DESKTOP。`<grid-option>` 的 `deviceCategory` 属性决定该网格启用在哪些设备类型（`phone|multi_display`）。`numDatabaseHotseatIcons` 仅在 `TYPE_MULTI_DISPLAY` 下与 `numShownHotseatIcons` 不同（兼容多网格迁移时的历史数据）。横屏手机用转置布局（`!isTablet && bounds.isLandscape()` 时交换宽高）。

### onConfigChanged 通知 Launcher

```java
// InvariantDeviceProfile.java
private void onConfigChanged() {
    // 重新 initGrid 并通知所有 OnIDPChangeListener(Launcher)
    // Launcher.onIdpChanged → onHandleConfigurationChanged → mModel.rebindCallbacks
}
```

IDP 变化触发 Launcher 重建 DeviceProfile 并重新跑 LoaderTask。

### 面试深问

**为什么用反距离加权插值而不是直接查表选最近邻？**
查表只能在预定义的 display-option 里二选一，两个相邻屏幕尺寸会选到同一个网格但图标显得偏大或偏小。插值能在最近邻之间算出连续的 iconSize/iconTextSize，适配任意分辨率。`WEIGHT_POWER=5` 让权重快速衰减，只有最近的几个候选影响结果，避免远处的候选拉偏插值。

**为什么 `iconBitmapSize` 要限制不超过 `closestPoint.iconSizes`？**
图标 bitmap 持久化在 IconCache 和 DB 的 `ICON` BLOB 里。如果插值算出的尺寸比预定义大，会生成更大 bitmap，下次启动读到旧缓存尺寸不匹配导致失效。限制在预定义值内保证缓存兼容性。

**`numShownHotseatIcons` 和 `numDatabaseHotseatIcons` 为什么分开？**
显示数可能因设备类型动态变（如多显示器模式下 hotseat 显示数减少），但 DB 存储数要稳定（迁移网格时按 DB 数计算容量）。`TYPE_MULTI_DISPLAY` 时两者不同，其他情况相同。分开避免迁移时的数据丢失。

## LoaderTask 异步加载流水线

`LoaderTask implements Runnable`，在 `MODEL_EXECUTOR`（后台单线程）执行。把"加载桌面所有数据"拆成有序五步，每步之间 bind 到 UI 并 `waitForIdle`（等 UI 线程空闲，避免主线程卡顿）。

### run() 主流程

```java
// LoaderTask.java
public void run() {
    synchronized (this) {
        if (mStopped) return;                                 // 启动前就被取消, 直接退出
    }

    TraceHelper.INSTANCE.beginSection(TAG);
    MODEL_EXECUTOR.elevatePriority(CALLER_LOADER_TASK);       // 临时提升线程优先级(加载是启动关键路径)
    LoaderMemoryLogger memoryLogger = new LoaderMemoryLogger();
    mIsRestoreFromBackup = LauncherPrefs.get(mContext).get(IS_FIRST_LOAD_AFTER_RESTORE);
    LauncherRestoreEventLogger restoreEventLogger = null;
    if (enableLauncherBrMetricsFixed()) {
        restoreEventLogger = mRestoreEventLoggerProvider.get();
    }
    try (LauncherModel.LoaderTransaction transaction = mModel.beginLoader(this)) {
        // beginLoader 内: lastLoadId++, mIsLoaderTaskRunning=true, mModelLoaded=false
        loadAllSurfacesOrdered(memoryLogger, restoreEventLogger);
        transaction.commit();                                 // mModelLoaded = true
        memoryLogger.clearLogs();
        if (mIsRestoreFromBackup) {
            mIsRestoreFromBackup = false;
            LauncherPrefs.get(mContext).putSync(IS_FIRST_LOAD_AFTER_RESTORE.to(false));
            if (restoreEventLogger != null) {
                restoreEventLogger.reportLauncherRestoreResults();
            }
        }
    } catch (CancellationException e) {
        FileLog.w(TAG, "LoaderTask cancelled");               // 被新 LoaderTask 取消
    } catch (Exception e) {
        memoryLogger.printLogs();
        throw e;
    }
    MODEL_EXECUTOR.restorePriority(CALLER_LOADER_TASK);       // 恢复优先级
}
```

### loadAllSurfacesOrdered 有序五步

```java
// LoaderTask.java loadAllSurfacesOrdered
private void loadAllSurfacesOrdered(
        LoaderMemoryLogger memoryLogger, LauncherRestoreEventLogger restoreEventLogger) {

    List<CacheableShortcutInfo> allShortcuts = new ArrayList<>();
    // ===== 第 1 步: 加载 Workspace(从 DB 读 favorites 行) =====
    Trace.beginSection("LoadWorkspace");
    try {
        loadWorkspaceImpl(allShortcuts, mParams.getWorkspaceSelection(), memoryLogger,
                restoreEventLogger);
    } finally {
        Trace.endSection();
    }

    // sanitize: 清理幽灵 Widget, 对齐 pinned shortcut(仅主 db)
    if (Objects.equals(mIDP.dbFile, mDbName) && mParams.getSanitizeData()) {
        verifyNotStopped();
        sanitizeWidgetsShortcutsAndPackages();
    }

    verifyNotStopped();
    mLauncherBinder.bindWorkspace(true /* incrementBindId */, false); // bind 到 Workspace UI
    if (!mParams.getLoadNonWorkspaceItems()) return;

    mModelDelegate.workspaceLoadComplete();
    sendFirstScreenActiveInstallsBroadcast();                 // 通知商店首屏已安装 App
    waitForIdle();                                            // 等 UI 空闲再继续
    verifyNotStopped();

    // ===== 第 2 步: 加载 All Apps(从 LauncherApps 查所有 Activity) =====
    Trace.beginSection("LoadAllApps");
    List<LauncherActivityInfo> allActivityList;
    try {
        allActivityList = loadAllApps();
    } finally {
        Trace.endSection();
    }
    verifyNotStopped();
    mLauncherBinder.bindAllApps();

    // 批量更新图标缓存(避免每个 App 单独查 IPC)
    IconCacheUpdateHandler updateHandler = mIconCache.getUpdateHandler();
    setIgnorePackages(updateHandler);                         // promise icon 的包跳过缓存更新
    updateHandler.updateIcons(allActivityList, LauncherActivityCachingLogic.INSTANCE,
            mModel::onPackageIconsUpdated);
    updateHandler.updateIcons(allShortcuts, CacheableShortcutCachingLogic.INSTANCE,
            mModel::onPackageIconsUpdated);
    waitForIdle();
    verifyNotStopped();

    // ===== 第 3 步: 加载深度快捷方式(长按弹出的) =====
    List<ShortcutInfo> allDeepShortcuts = loadDeepShortcuts();
    updateHandler.updateIcons(
            convertShortcutsToCacheableShortcuts(allDeepShortcuts, allActivityList),
            CacheableShortcutCachingLogic.INSTANCE, (pkgs, user) -> { });
    waitForIdle();
    verifyNotStopped();

    // ===== 第 4 步: 加载 Widget 列表 =====
    WidgetsModel widgetsModel = mBgDataModel.widgetsModel;
    List<CachedObject> allWidgetsList = widgetsModel.update(null); // 查 AppWidgetManager 所有 provider
    verifyNotStopped();
    mLauncherBinder.bindWidgets();
    updateHandler.updateIcons(allWidgetsList, CachedObjectCachingLogic.INSTANCE,
            mModel::onWidgetLabelsUpdated);

    // ===== 第 5 步: 加载文件夹名称建议 =====
    loadFolderNames();
    verifyNotStopped();
    updateHandler.finish();                                   // 等所有图标缓存更新完成
    mModelDelegate.modelLoadComplete();
}
```

设计精髓：

1. **优先级排序**：先 Workspace（用户最先看到），再 AllApps（上滑才见），最后 Widget/快捷方式/文件夹名。保证桌面最快可见。
2. **分步 bind + waitForIdle**：每步 bind 后等 UI 线程空闲（`LooperIdleLock`），避免后台疯狂 bind 把主线程消息队列塞满。
3. **批量图标缓存**：`IconCacheUpdateHandler` 攒一批 icon 请求统一查，减少 IPC。
4. **取消感知**：每步前后 `verifyNotStopped()`，被新 LoaderTask 取消时立即抛 `CancellationException` 停止。

`waitForIdle` 的实现：用 `LooperIdleLock` 阻塞等待主线程 Looper 空闲，最长 1 秒一次循环（防止永远等不到）：

```java
// LoaderTask.java
protected synchronized void waitForIdle() {
    LooperIdleLock idleLock = mLauncherBinder.newIdleLock(this);
    while (!mStopped && idleLock.awaitLocked(1000));           // 最多等 1 秒就重新检查
}
```

### loadWorkspaceImpl 读 DB 的核心

```java
// LoaderTask.java loadWorkspaceImpl (第 431 行)
private void loadWorkspaceImpl(List<CacheableShortcutInfo> allDeepShortcuts, String selection,
        LoaderMemoryLogger memoryLogger, LauncherRestoreEventLogger restoreEventLogger) {
    final boolean isSdCardReady = Utilities.isBootCompleted();
    final WidgetInflater widgetInflater = new WidgetInflater(mContext, mIsSafeModeEnabled);
    ModelDbController dbController = mModel.getModelDbController();

    try {
        dbController.attemptMigrateDb(restoreEventLogger, mModelDelegate); // 网格迁移
    } catch (Exception e) {
        FileLog.e(TAG, "Failed to migrate grid", e);
    }
    dbController.loadDefaultFavoritesIfNecessary();           // 空库时填默认桌面

    synchronized (mBgDataModel) {
        mBgDataModel.clear();
        mPendingPackages.clear();

        final HashMap<PackageUserKey, SessionInfo> installingPkgs =
                mSessionHelper.getActiveSessions();           // 查安装中的包(promise icon 用)
        installingPkgs.forEach(mIconCache::updateSessionCache);

        mShortcutKeyToPinnedShortcuts = new HashMap<>();
        final LoaderCursor c = mLoaderCursorFactory.createLoaderCursor(
                dbController.query(null, selection, null,
                        LauncherDbUtils.getLoaderCursorQuerySortOrder()), // 查 favorites 表
                mUserManagerState,
                mIsRestoreFromBackup ? restoreEventLogger : null);
        final Bundle extras = c.getExtras();
        mDbName = extras == null ? null : extras.getString(ModelDbController.EXTRA_DB_NAME);

        WorkspaceItemProcessor itemProcessor;
        try {
            final LongSparseArray<Boolean> unlockedUsers = new LongSparseArray<>();
            queryPinnedShortcutsForUnlockedUsers(mContext, unlockedUsers); // 查各用户 pinned shortcut

            mWorkspaceIconRequestInfos = new ArrayList<>();
            itemProcessor = new WorkspaceItemProcessor(c, memoryLogger, ...);

            if (mStopped) {
                Log.w(TAG, "loadWorkspaceImpl: Loader stopped, skipping item processing");
            } else {
                if (Flags.injectableModelItems()) {
                    itemProcessor.processPreloadedItems(mExtraItemsProvider.get()); // 注入预加载 item
                }
                while (!mStopped && c.moveToNext()) {
                    itemProcessor.processItem();              // 逐行: DB 行 → ItemInfo, 校验, 放入 itemsIdMap
                }
            }
            tryLoadWorkspaceIconsInBulk(mWorkspaceIconRequestInfos); // 批量拿图标
        } finally {
            IOUtils.closeSilently(c);
        }

        if (mStopped) {
            mBgDataModel.clear();                             // 中途取消, 清空已加载的部分
            return;
        }
        mBgDataModel.updateStringCache(mContext);              // 更新字符串缓存(本地化标签)
        mBgDataModel.dataLoadComplete(itemProcessor.finalizeData(mModelDelegate, mModel.getModelDbController()));
    }
}
```

`WorkspaceItemProcessor.processItem()` 是"行→ItemInfo"的核心：根据 `ITEM_TYPE` 把行转成 `WorkspaceItemInfo`/`LauncherAppWidgetInfo`/`FolderInfo`，并做大量有效性校验——intent 无效？包已卸载？widget 尺寸非法？容器不存在？任一不满足就丢弃该行（对应 LauncherProvider 类注释那张"删除条件"清单）。

### loadAllApps 查系统所有 Activity

```java
// LoaderTask.java loadAllApps
private List<LauncherActivityInfo> loadAllApps() {
    List<LauncherActivityInfo> allActivityList = new ArrayList<>();
    mBgAllAppsList.clear();
    List<IconRequestInfo<AppInfo>> allAppsItemRequestInfos = new ArrayList<>();
    for (CachedUserInfo cachedUserInfo : mUserManagerState.getAllCachedInfos()) {
        UserHandle user = cachedUserInfo.getIconInfo().user;
        final List<LauncherActivityInfo> apps = mLauncherApps.getActivityList(null, user); // 查系统
        if (apps == null || apps.isEmpty()) {
            return allActivityList;
        }
        for (int i = 0; i < apps.size(); i++) {
            LauncherActivityInfo app = apps.get(i);
            AppInfo appInfo = new AppInfo(app, cachedUserInfo, ApiWrapper.INSTANCE.get(mContext), mPmHelper);
            // archived app: 带 pending install session 进度
            if (Flags.enableSupportForArchiving() && app.getApplicationInfo().isArchived) {
                SessionInfo si = mInstallingPkgsCached.get(new PackageUserKey(...));
                if (si != null) {
                    appInfo.runtimeStatusFlags |= FLAG_INSTALL_SESSION_ACTIVE;
                    appInfo.setProgressLevel((int) (si.getProgress() * 100), PackageInstallInfo.STATUS_INSTALLING);
                }
            }
            allAppsItemRequestInfos.add(getAppInfoIconRequestInfo(appInfo, app, ...));
            mBgAllAppsList.add(appInfo, app, false);
        }
        allActivityList.addAll(apps);
    }
    // 批量拿图标 + 更新 section 名
    mIconCache.getTitlesAndIconsInBulk(allAppsItemRequestInfos);
    allAppsItemRequestInfos.forEach(iconRequestInfo ->
            mBgAllAppsList.updateSectionName(iconRequestInfo.itemInfo));
    // 设置工作资料/私密空间静音模式标志
    mBgAllAppsList.setFlags(FLAG_WORK_PROFILE_QUIET_MODE_ENABLED, isWorkProfileQuiet);
    mBgAllAppsList.setFlags(FLAG_HAS_SHORTCUT_PERMISSION, hasShortcutsPermission(mContext));
    return allActivityList;
}
```

### LoaderTask 用 AssistedInject

```java
// LoaderTask.java
@AssistedInject
protected LoaderTask(
        @ApplicationContext Context context,
        InvariantDeviceProfile idp,
        LauncherModel model,
        // ... 一堆 @Inject 的依赖 ...
        @Assisted @NonNull BaseLauncherBinder launcherBinder,  // 运行时参数, AssistedInject 提供
        // ...
        ) { ... }

@AssistedFactory
public interface LoaderTaskFactory {
    LoaderTask newLoaderTask(BaseLauncherBinder binder);      // 工厂方法, 只接受运行时参数
}
```

为什么用 AssistedInject 而非普通 `@Inject`：LoaderTask 大部分依赖是固定的单例（Context、IconCache、LauncherModel 等），但 `BaseLauncherBinder` 是每次创建 LoaderTask 时动态构造的（携带当前 callbacks 列表）。`@AssistedFactory` 让 Dagger 生成工厂，自动注入固定依赖，运行时只传 assisted 参数。

### 面试深问

**为什么 LoaderTask 分五步、还要 waitForIdle？**
用户体验：Workspace 是最先看到的，必须最先 bind 出来；AllApps 上滑才看得到，可以晚点。`waitForIdle` 让主线程处理完上一批 bind 再塞下一批，避免消息队列堆积、首帧延迟。本质是"背压"——生产者（后台加载）速度快于消费者（主线程 bind），用 idle 等待做流控。

**LoaderTask 为什么用 `MODEL_EXECUTOR.post(task)` 而不是直接 `run()`？**
注释明确：必须 post 而非直接 run，为了退出嵌套 synchronized 块。`startLoader` 在 `synchronized(mLock)` 内创建 task，若直接 run 会持有锁执行整个加载，阻塞其他同步操作。post 让当前线程先释放锁，task 在 MODEL_EXECUTOR 上独立运行。

**`verifyNotStopped()` 为什么放在每步之间而不是循环里？**
每步之间检查一次足够（单步耗时可控），太频繁检查浪费性能。关键是"加载完一部分 bind 前"检查——如果被取消，已加载的数据不 bind，避免无效的 UI 刷新。`loadWorkspaceImpl` 内部用 `while (!mStopped && c.moveToNext())` 保证读 DB 循环也能及时退出。

## BgDataModel 内存数据与 BaseLauncherBinder bind 桥梁

### BgDataModel 后台线程的内存数据

`@LauncherAppSingleton`，所有数据只在 MODEL_EXECUTOR 访问，访问时 `synchronized`。

```kotlin
// BgDataModel.kt
@LauncherAppSingleton
class BgDataModel @Inject constructor(
    @JvmField val widgetsModel: WidgetsModel,                 // Widget 列表
    private val repo: Provider<HomeScreenRepository>,
    dumpManager: DumpManager, lifeCycle: DaggerSingletonTracker,
) : LauncherDumpable {

    private val mutableWorkspaceData = MutableWorkspaceData()

    /** 所有 ItemInfo(图标/文件夹/Widget) 的 id→item 映射 */
    @JvmField val itemsIdMap: WorkspaceData = mutableWorkspaceData

    /** 额外容器项(预测等) */
    @Deprecated("Use independent repository for each extra item")
    @JvmField val extraItems = IntSparseArrayMap<FixedContainerItems>()

    /** 每个 LauncherActivity 的 shortcut 计数 */
    var deepShortcutMap: Map<ComponentKey, Int> = emptyMap()
        private set

    /** 字符串缓存(系统标签本地化) */
    var stringCache = StringCache.EMPTY
        private set

    @JvmField var lastBindId: Int = 0                         // bind 版本号, 丢弃过期 bind
    @JvmField var lastLoadId: Int = -1                        // load 版本号
}
```

### WorkspaceData 用 sealed class 的设计意图

`itemsIdMap` 的类型 `WorkspaceData` 是 `sealed class`，有两个实现：`MutableWorkspaceData`（可变，后台线程持有）和不可变快照（bind 时拷贝）。

```kotlin
// WorkspaceData.kt
sealed class WorkspaceData : Iterable<ItemInfo> {
    abstract operator fun get(id: Int): ItemInfo?
    abstract val version: Int                                  // 版本号, 每次 load cycle 唯一
    abstract val modificationId: Int                           // 修改次数
    abstract fun copy(): WorkspaceData                         // 返回不可变快照

    /** 可变实现 */
    class MutableWorkspaceData : WorkspaceData() {
        val itemsIdMap = SparseArray<ItemInfo>()               // 真实存储
        override var version: Int = VERSION_COUNTER.incrementAndGet()
        // ...
    }
}
```

为什么用 sealed class：保证"要么可变要么不可变"的穷尽性，编译期就明确所有子类型。`copy()` 返回不可变快照，主线程消费快照时不会与后台线程修改竞争。这是"写时复制"（copy-on-write）模式——后台构造快照、主线程消费，无需加锁保护整个 bind 过程。

### Callbacks UI 接收数据的接口

```kotlin
// BgDataModel.kt
interface Callbacks {
    @AnyThread
    fun bindCompleteModelAsync(itemIdMap: WorkspaceData, isBindingSync: Boolean) {
        Executors.MAIN_EXECUTOR.execute { bindCompleteModel(itemIdMap, isBindingSync) }
    }
    fun bindCompleteModel(itemIdMap: WorkspaceData, isBindingSync: Boolean) {}
    fun bindItemsAdded(items: List<ItemInfo>) {}
    fun bindItemsUpdated(updates: Set<ItemInfo>) {}
    fun bindWorkspaceComponentsRemoved(matcher: Predicate<ItemInfo?>) {}
    fun bindAllWidgets(widgets: List<WidgetsListBaseEntry>) {}
    fun bindExtraContainerItems(item: FixedContainerItems) {}
    fun bindAllApplications(apps: Array<AppInfo>, flags: Int, packageUserKeytoUidMap: Map<PackageUserKey, Int>) {}
    fun bindStringCache(cache: StringCache) {}
}
```

`bindCompleteModelAsync` 默认实现切到主线程，调用方可任意线程调用。Launcher 实现这个接口，转交给 `ModelCallbacks` 真正填充 View。

### BaseLauncherBinder bind 的桥梁

```java
// BaseLauncherBinder.java
public class BaseLauncherBinder {
    final Callbacks[] mCallbacksList;
    private int mMyBindingId;                                  // 本次 bind 的版本号快照

    @AssistedInject
    public BaseLauncherBinder(Context context, LauncherModel model, BgDataModel dataModel,
            AllAppsList allAppsList, @Assisted Callbacks[] callbacksList) { ... }

    public void bindWorkspace(boolean incrementBindId, boolean isBindSync) {
        WorkspaceData itemsIdMap;
        ArrayList<FixedContainerItems> extraItems = new ArrayList<>();
        StringCache stringCache;

        synchronized (mBgDataModel) {
            itemsIdMap = mBgDataModel.itemsIdMap.copy();       // 拷贝快照(后台构造, 主线程消费)
            mBgDataModel.extraItems.forEach(extraItems::add);
            if (incrementBindId) {
                mBgDataModel.lastBindId++;                     // bind 版本号自增
                mBgDataModel.lastLoadId = mModel.getLastLoadId(); // 同步当前 load 版本
            }
            mMyBindingId = mBgDataModel.lastBindId;            // 记住本次 bind 的版本号
            stringCache = mBgDataModel.getStringCache();
        }

        for (Callbacks cb : mCallbacksList) {
            cb.bindCompleteModelAsync(itemsIdMap, isBindSync); // 切到主线程执行
        }
        executeCallbacksTask(c -> c.bindStringCache(stringCache), mUiExecutor);
        for (FixedContainerItems extraItem: extraItems) {
            executeCallbacksTask(c -> c.bindExtraContainerItems(extraItem), mUiExecutor);
        }
    }

    protected void executeCallbacksTask(CallbackTask task, Executor executor) {
        executor.execute(() -> {
            if (mMyBindingId != mBgDataModel.lastBindId) {
                Log.d(TAG, "Too many consecutive reloads, skipping obsolete data-bind");
                return;                                        // 版本号过期, 丢弃, 避免旧 bind 覆盖新数据
            }
            for (Callbacks cb : mCallbacksList) {
                task.execute(cb);
            }
        });
    }
}
```

两个关键机制：

1. **快照拷贝**：bind 前在后台线程 `copy()` 一份 `itemsIdMap`，主线程消费快照时不会与后台修改竞争（写时复制）。
2. **bindId 版本号**：连续 reload 时，过期的 bind 直接丢弃（`mMyBindingId != mBgDataModel.lastBindId`）——解决"快速来回切网格导致 UI 数据错乱"。

`newIdleLock` 给 LoaderTask 的 `waitForIdle` 用：监听主线程 Looper 空闲状态，主线程 bind 完处理完消息后唤醒 LoaderTask 继续。

### 面试深问

**为什么 `WorkspaceData` 用 sealed class 而不是 interface？**
sealed class 保证子类型封闭（编译期穷尽），配合 `when` 表达式能做穷尽匹配。interface 允许任意外部实现，无法保证"要么可变要么不可变"的约束。这里要的是"内部可控的两种实现"，sealed class 比 interface 更精确表达意图。另外 sealed class 可携带状态（version、modificationId），interface 在 Kotlin 里不适合做状态载体。

**bind 前为什么要 `copy()` 而不是直接传引用？**
后台线程持续修改 `itemsIdMap`（增量更新），主线程 bind 时若直接引用，遍历过程会 `ConcurrentModificationException`。copy 出快照后，主线程消费快照、后台改原件，互不干扰。代价是内存翻倍，但桌面 item 通常几百个，可接受。

**`executeCallbacksTask` 的版本号校验为什么能丢弃过期 bind？**
假设快速切网格：LoaderTask A 开始（lastBindId=1），bind 前用户又切网格，LoaderTask B 启动（stopLoader 停了 A，lastBindId=2）。A 的 `bindCompleteModelAsync` 已投递到主线程队列，但 `executeCallbacksTask` 执行时发现 `mMyBindingId(1) != lastBindId(2)`，直接 return，A 的旧数据不会覆盖 B 的新数据。

## 完整数据流向

### 启动加载流程（DB → UI）

```
Launcher.onCreate()
  └─ mModel.addCallbacksAndLoad(this)
       └─ startLoader([this])
            ├─ 快路径(mModelLoaded): BaseLauncherBinder.bindWorkspace/AllApps/Widgets (同步)
            └─ 慢路径: MODEL_EXECUTOR.post(LoaderTask)
                 └─ LoaderTask.run()
                      ├─ beginLoader(this)  // LoaderTransaction: lastLoadId++, mModelLoaded=false
                      ├─ loadAllSurfacesOrdered():
                      │    1. loadWorkspaceImpl → attemptMigrateDb + loadDefaultFavoritesIfNecessary
                      │         → ModelDbController.query(favorites)
                      │         → WorkspaceItemProcessor 逐行转 ItemInfo → BgDataModel.itemsIdMap
                      │         → sanitizeWidgets → bindWorkspace() [主线程] → waitForIdle()
                      │    2. loadAllApps → LauncherApps.getActivityList → AllAppsList
                      │         → bindAllApps() [主线程] → 批量图标缓存 → waitForIdle()
                      │    3. loadDeepShortcuts → deepShortcutMap → 图标缓存 → waitForIdle()
                      │    4. WidgetsModel.update → bindWidgets() → 图标缓存
                      │    5. loadFolderNames → updateHandler.finish()
                      └─ transaction.commit()  // mModelLoaded=true
```

### 用户拖拽写回流程（UI → DB）

```
用户拖拽图标 → Workspace 拖放
  └─ DropTargetHandler / LauncherDragController
       └─ ModelWriter.addItemToDatabase(itemInfo)   // mModel.getWriter(...) 返回
            ├─ 写内存 BgDataModel (MODEL_EXECUTOR)
            └─ 写 DB: ModelDbController.insert() → DatabaseHelper.dbInsertAndCheck()
```

### 外部应用改数据流程（跨进程 → DB → UI）

```
OEM 应用 ContentResolver.insert(LauncherProvider)
  └─ LauncherProvider.insert(uri, values)
       └─ executeControllerTask(controller -> controller.insert(values))
            ├─ MODEL_EXECUTOR.submit:
            │    └─ ModelDbController.insert() → 写 favorites 表
            └─ count > 0 → MAIN_EXECUTOR.submit(model::forceReload)
                 └─ forceReload() → stopLoader + mModelLoaded=false → rebindCallbacks
                      └─ startLoader → LoaderTask 全量重载 → bind
```

### 包安装/更新流程（系统广播 → UI）

```
PackageInstaller / PackageManager 广播
  └─ LauncherApps.Callback / 包监听器
       └─ LauncherModel.enqueueModelUpdateTask(PackageUpdatedTask)
            └─ MODEL_EXECUTOR: 操作 BgDataModel → ModelTaskController.bindUpdatedWorkspaceItems
                 └─ Callbacks.bindItemsAdded/bindWorkspaceComponentsRemoved [主线程]
```

## 线程模型

三个核心 Executor 严格分工：

| Executor | 角色 | 典型操作 |
|---|---|---|
| `MAIN_EXECUTOR` | 主线程（UI） | bind* 回调、View 操作、用户交互 |
| `MODEL_EXECUTOR` | 后台单线程（Model） | DB 读写、LoaderTask、BgDataModel 修改、ModelUpdateTask |
| `UI_HELPER_EXECUTOR` | 后台辅助线程 | icon 解码、文件 IO 等不阻塞 Model 的杂活 |

铁律：`BgDataModel`、`AllAppsList` 的数据只在 MODEL_EXECUTOR 修改；跨线程交接通过 `bind` 回调（投到 MAIN_EXECUTOR）；`BgDataModel` 的访问必须 `synchronized`。LoaderTask 在 MODEL_EXECUTOR 上跑，bind 时通过 `bindCompleteModelAsync` 切到 MAIN_EXECUTOR，`waitForIdle` 等主线程空闲后再加载下一部分——形成"加载→bind→等空闲→加载"的背压循环。
