---
title: Launcher3 源码精读（06）：状态机
category: client
platform: android
tags: ["AOSP", "Launcher3", "源码", "Framework"]
readTime: 21分钟
featured: true
date: 2026-08-02
---

# 06 · Launcher3 状态机（LauncherState / StateManager / StateHandler）

Launcher3 把「桌面 / All Apps / 最近任务 / 拖拽编辑」之间的切换抽象成一台状态机。状态本身是纯数据（不含任何 View 引用、不含任何动画逻辑），切换由引擎 `StateManager` 统一调度，落到具体 UI 上的位移/缩放/透明由各 `StateHandler` 自行解释。这种「纯数据状态 + 引擎 + 解释器」的三层切分是整套机制的核心。

> 源码路径
> - `packages/apps/Launcher3/src/com/android/launcher3/LauncherState.java`（顶层基类 + NORMAL 静态实例）
> - `packages/apps/Launcher3/src/com/android/launcher3/statemanager/`（BaseState / StateManager / StatefulActivity / StatefulContainer）
> - `packages/apps/Launcher3/src/com/android/launcher3/states/`（SpringLoadedState / EditModeState / StateAnimationConfig / RotationHelper）
> - `packages/apps/Launcher3/quickstep/src/com/android/launcher3/uioverrides/states/`（AllAppsState / HintState / OverviewState 及四个子态）
> - `packages/apps/Launcher3/src/com/android/launcher3/anim/`（PendingAnimation / AnimatorPlaybackController / PropertySetter）

---

## 一、整体架构：三层职责切分

```
┌──────────────────────────────────────────────────────────────┐
│                  LauncherState（纯数据状态）                   │
│  - flags（位掩码：MULTI_PAGE / WORKSPACE_INACCESSIBLE ...）   │
│  - 一组 get*()：getWorkspaceScaleAndTranslation /             │
│    getVisibleElements / getVerticalProgress / getDepth ...   │
│  - 不持有任何 View，只回答「这个状态下 UI 应该长什么样」        │
└──────────────────────────────────────────────────────────────┘
                            ▲
                            │ 查询
┌──────────────────────────────────────────────────────────────┐
│              StateManager<S extends BaseState, T>             │
│  - mState / mToState / mCurrentStableState / mLastStableState │
│  - mStateHandlers[]（延迟从 container 收集）                   │
│  - mConfig（AnimationState：当前动画 + 配置 + 目标态）         │
│  - goToState(...) 重载链 / createAnimationToNewWorkspace(...)  │
│  - onStateTransitionStart / End（回调监听器）                  │
└──────────────────────────────────────────────────────────────┘
                            ▲ 派发
                            │
┌──────────────────────┬──────────────────────────────────────┐
│  Workspace           │  AllAppsTransitionController         │
│  (StateHandler)      │  (StateHandler)                      │
│  setState            │  setState                            │
│  setStateWithAnimation│  setStateWithAnimation              │
└──────────────────────┴──────────────────────────────────────┘
```

### 为什么是三层，而不是一个大 switch

如果用一个巨型 `switch(state)` 集中处理所有 UI，会立刻撞上三件事：

1. **状态定义与 UI 耦合**。状态本身需要在没有 Activity 实例时被构造、被序列化、被测试。LauncherState 在静态初始化阶段就 new 出全部实例（`sAllStates[11]`），此时 Launcher 还不存在。纯数据 + 无 View 引用是前提。
2. **多个 View 各自解释同一个状态**。Workspace 关心缩放和位移，AllApps 容器关心 `verticalProgress`，Hotseat 关心 alpha，Taskbar 关心是否 stashed。同一个 `ALL_APPS` 状态在 Workspace 眼里是「缩小 + 上移」，在 AllAppsTransitionController 眼里是「progress 从 1 → 0」。把这些解释逻辑分散到各自的 `StateHandler` 里，比塞进一个上帝类更可控。
3. **手势 / 动画复用同一份状态语义**。手势跟随（用户手指拖动）和点击触发（自动播放动画）面对的是同一组目标属性值，区别只在于是「按进度施加」还是「按时间播放」。三层切分让 `AnimatorPlaybackController` 这套进度控制器可以无差别复用。

`StateManager` 作为引擎只负责：状态字段维护、动画生命周期（启动 / 取消 / 收尾）、监听器派发。它不知道 Workspace 长什么样，也不知道 AllApps 怎么转场——它只把目标态丢给所有 handler，让 handler 自己决定怎么画。

---

## 二、状态清单（全部精读源码）

### 2.1 全部状态与 ordinal

LauncherState 静态持有 11 个实例，ordinal 在 `TestProtocol.java` 中定义（用于测试序列化）：

```java
// shared/.../TestProtocol.java
public static final int NORMAL_STATE_ORDINAL = 0;              // 默认桌面
public static final int SPRING_LOADED_STATE_ORDINAL = 1;       // 拖拽/编辑态
public static final int OVERVIEW_STATE_ORDINAL = 2;            // 最近任务
public static final int OVERVIEW_MODAL_TASK_STATE_ORDINAL = 3; // Overview 单任务模态
public static final int QUICK_SWITCH_STATE_ORDINAL = 4;        // 快速切换
public static final int ALL_APPS_STATE_ORDINAL = 5;            // 应用抽屉
public static final int BACKGROUND_APP_STATE_ORDINAL = 6;      // Launcher 退到 app 后方
public static final int HINT_STATE_ORDINAL = 7;                // 手势提示态（上滑预览）
public static final int HINT_STATE_TWO_BUTTON_ORDINAL = 8;     // 三键导航的提示态
public static final int OVERVIEW_SPLIT_SELECT_ORDINAL = 9;     // 分屏选择第二应用
public static final int EDIT_MODE_STATE_ORDINAL = 10;          // 桌面多选编辑
```

静态实例在 `LauncherState.java` 中创建，并写入 `sAllStates[id]`：

```java
// LauncherState.java
private static final LauncherState[] sAllStates = new LauncherState[11]; // 容量 11

// NORMAL 是匿名子类，覆写了 getTransitionDuration 返回 0
public static final LauncherState NORMAL = new LauncherState(NORMAL_STATE_ORDINAL,
        LAUNCHER_STATE_HOME,
        FLAG_DISABLE_RESTORE | FLAG_WORKSPACE_ICONS_CAN_BE_DRAGGED | FLAG_HAS_SYS_UI_SCRIM) {
    @Override
    public int getTransitionDuration(ActivityContext context, boolean isToState) {
        return 0; // 进入 NORMAL 的时长由来源态决定，见 goToStateAnimated
    }
};

public static final LauncherState SPRING_LOADED = new SpringLoadedState(SPRING_LOADED_STATE_ORDINAL);
public static final LauncherState EDIT_MODE    = new EditModeState(EDIT_MODE_STATE_ORDINAL);
public static final LauncherState ALL_APPS     = new AllAppsState(ALL_APPS_STATE_ORDINAL);
public static final LauncherState HINT_STATE   = new HintState(HINT_STATE_ORDINAL);
public static final LauncherState HINT_STATE_TWO_BUTTON = new HintState(
        HINT_STATE_TWO_BUTTON_ORDINAL, LAUNCHER_STATE_OVERVIEW); // 二键导航提示，statsLog 记 Overview

public static final LauncherState OVERVIEW = new OverviewState(OVERVIEW_STATE_ORDINAL);
public static final LauncherState OVERVIEW_MODAL_TASK = OverviewState.newModalTaskState(
        OVERVIEW_MODAL_TASK_STATE_ORDINAL);
public static final LauncherState QUICK_SWITCH_FROM_HOME = OverviewState.newSwitchState(
        QUICK_SWITCH_STATE_ORDINAL);
public static final LauncherState BACKGROUND_APP = OverviewState.newBackgroundState(
        BACKGROUND_APP_STATE_ORDINAL);
public static final LauncherState OVERVIEW_SPLIT_SELECT = OverviewState.newSplitSelectState(
        OVERVIEW_SPLIT_SELECT_ORDINAL);
```

构造函数把 flags 写入 `mFlags`，并把 `this` 注册到全局数组：

```java
// LauncherState.java
public LauncherState(int id, int statsLogOrdinal, int flags) {
    this.statsLogOrdinal = statsLogOrdinal;     // 给 StatsLogManager 上报用
    this.mFlags = flags;                          // 位掩码，决定状态行为
    this.isRecentsViewVisible = (flags & FLAG_RECENTS_VIEW_VISIBLE) != 0; // 是否显示 RecentsView
    this.ordinal = id;                            // 测试/序列化用的序号
    sAllStates[id] = this;                        // 注册到全局表
}
```

### 2.2 NORMAL（默认桌面）

匿名子类，flags = `FLAG_DISABLE_RESTORE | FLAG_WORKSPACE_ICONS_CAN_BE_DRAGGED | FLAG_HAS_SYS_UI_SCRIM`。

含义：
- `FLAG_DISABLE_RESTORE`：Activity 重建时不恢复到此状态以外的东西，重建后强制归位。
- `FLAG_WORKSPACE_ICONS_CAN_BE_DRAGGED`：桌面图标可拖。
- `FLAG_HAS_SYS_UI_SCRIM`：保留状态栏/导航栏遮罩。

继承默认实现，UI 上：Workspace 不缩放（`NO_SCALE=1`）、不位移（`NO_OFFSET=0`）、`getVisibleElements` 返回 `HOTSEAT_ICONS | WORKSPACE_PAGE_INDICATOR | VERTICAL_SWIPE_INDICATOR | FLOATING_SEARCH_BAR`（手机横屏除外 QSB）、`getVerticalProgress=1`（AllApps 完全收起）、`getDepth=0`（壁纸无模糊）。

### 2.3 SPRING_LOADED（拖拽/编辑态）

`SpringLoadedState.java`，长按图标进入拖拽时使用。flags：

```java
private static final int STATE_FLAGS = FLAG_MULTI_PAGE            // 多页同时可见（拖拽时可跨页）
        | FLAG_WORKSPACE_INACCESSIBLE                             // Workspace 不可交互（避免误触）
        | FLAG_DISABLE_RESTORE                                    // 不持久化
        | FLAG_WORKSPACE_ICONS_CAN_BE_DRAGGED                     // 可拖拽
        | FLAG_WORKSPACE_HAS_BACKGROUNDS;                         // 绘制页面背景
```

关键覆写：

```java
@Override public int getTransitionDuration(...) { return 150; }        // 进/出都 150ms

@Override public ScaleAndTranslation getWorkspaceScaleAndTranslation(Launcher launcher) {
    // 把 Workspace 缩小到 spring load 比例，并上移让顶部腾出空间放 dragged icon
    float shrunkTop = grid.getCellLayoutSpringLoadShrunkTop();
    float scale = grid.getWorkspaceSpringLoadScale(launcher);
    // 中心对齐计算，保证缩放后顶部对齐 shrunkTop
    ...
    return new ScaleAndTranslation(scale, 0, shrunkTop - actualCellTop);
}

@Override public ScaleAndTranslation getHotseatScaleAndTranslation(Launcher launcher) {
    return new ScaleAndTranslation(1, 0, 0); // hotseat 不跟随缩放
}

@Override public float getWorkspaceBackgroundAlpha(Launcher launcher) { return 0.2f; }
@Override protected float getDepthUnchecked(Context context) { return DEPTH_15_PERCENT; } // 0.15 模糊
```

### 2.4 EDIT_MODE（桌面多选编辑）

`EditModeState.kt`，桌面「整理/多选」模式。flags 与 SPRING_LOADED 几乎一致：

```kotlin
private val STATE_FLAGS = FLAG_MULTI_PAGE or
        FLAG_WORKSPACE_INACCESSIBLE or
        FLAG_DISABLE_RESTORE or
        FLAG_WORKSPACE_ICONS_CAN_BE_DRAGGED or
        FLAG_WORKSPACE_HAS_BACKGROUNDS
```

差别在视觉：Workspace 缩放但**不平移**（`ScaleAndTranslation(scale, 0f, 0f)`），hotseat 也跟随缩放。`onLeavingState` 是清理钩子。

### 2.5 ALL_APPS（应用抽屉）

`AllAppsState.java`（quickstep 源码集）。flags：

```java
private static final int STATE_FLAGS =
        FLAG_WORKSPACE_INACCESSIBLE      // 桌面不可交互
        | FLAG_CLOSE_POPUPS              // 进入时关闭所有浮层
        | FLAG_HOTSEAT_INACCESSIBLE;     // hotseat 不可交互
```

关键覆写：

```java
@Override public float getVerticalProgress(Launcher launcher) { return 0f; }
// progress=0 表示 AllApps 完全展开；progress=1 表示完全收起（NORMAL）

@Override public ScaleAndTranslation getWorkspaceScaleAndTranslation(Launcher launcher) {
    // Workspace 缩到内容比例（mWorkspaceProfile.getWorkspaceContentScale）
    return new ScaleAndTranslation(
            launcher.getDeviceProfile().mWorkspaceProfile.getWorkspaceContentScale(),
            NO_OFFSET, NO_OFFSET);
}

@Override protected float getDepthUnchecked(...) {
    // 非 sheet 模式下用 60% 深度；scrim 在手势 50% 处出现，所以 depth 取两倍
    return BaseDepthController.DEPTH_60_PERCENT;
}

@Override public int getVisibleElements(LauncherUiState launcherUiState) {
    int elements = ALL_APPS_CONTENT | FLOATING_SEARCH_BAR; // 主内容 + 搜索栏
    if (isWorkspaceVisible(deviceProfile)) elements |= HOTSEAT_ICONS; // 平板/sheet 模式下 hotseat 仍可见
    return elements;
}

@Override public boolean shouldBlurWorkspace(LauncherState targetState) {
    return targetState == ALL_APPS || targetState == NORMAL; // 进/出 AllApps 时模糊桌面
}
```

`getTransitionDuration` 取 `dp.allAppsOpenDuration` / `allAppsCloseDuration`（设备相关）。还实现了预测式返回（predictive back）的 jank 监测：`onBackStarted` 开始 CUJ、`onBackAnimationCompleted(success)` 决定 end/cancel。

### 2.6 HINT_STATE（手势提示态）

`HintState.java`。用户从桌面底部上滑但**还没到阈值**时，桌面微微缩小+变深，提示「继续滑会进 Overview」。flags：

```java
private static final int STATE_FLAGS = FLAG_WORKSPACE_INACCESSIBLE | FLAG_DISABLE_RESTORE
        | FLAG_HAS_SYS_UI_SCRIM;
```

```java
@Override public int getTransitionDuration(...) { return 80; }            // 极短
@Override protected float getDepthUnchecked(Context context) { return DEPTH_5_PERCENT; } // 0.05
@Override public ScaleAndTranslation getWorkspaceScaleAndTranslation(...) {
    return new ScaleAndTranslation(0.92f, 0, 0); // 缩到 0.92，不位移
}
```

`HINT_STATE_TWO_BUTTON` 是三键导航模式下的变体，statsLog 记为 Overview。

### 2.7 OVERVIEW（最近任务）

`OverviewState.java`（quickstep 源码集）。flags：

```java
private static final int STATE_FLAGS = FLAG_WORKSPACE_ICONS_CAN_BE_DRAGGED
        | FLAG_DISABLE_RESTORE | FLAG_RECENTS_VIEW_VISIBLE    // RecentsView 可见
        | FLAG_WORKSPACE_INACCESSIBLE | FLAG_CLOSE_POPUPS;
```

关键覆写：

```java
@Override public int getTransitionDuration(Context context, boolean isToState) {
    if (isToState) {
        // 手势模式从侧面滑入，给更长时间；三键模式直接 pop in
        return hasGestures ? OVERVIEW_SLIDE_IN_DURATION /*380*/ : OVERVIEW_POP_IN_DURATION /*250*/;
    }
    return OVERVIEW_EXIT_DURATION; // 退出 250ms
}

@Override public ScaleAndTranslation getWorkspaceScaleAndTranslation(Launcher launcher) {
    // Workspace 缩到 task 大小，并上移半个滑动高度（视差）
    float scale = taskWidth / cellLayoutWidth;
    return new ScaleAndTranslation(scale, 0, -getDefaultSwipeHeight(launcher) * 0.5f);
}

@Override public float[] getOverviewScaleAndOffset(Launcher launcher) {
    return new float[] {NO_SCALE, NO_OFFSET}; // RecentsView 原尺寸、不偏移
}

@Override public PageAlphaProvider getWorkspacePageAlphaProvider(...) {
    // Workspace 完全透明，只显示 RecentsView
    return new PageAlphaProvider(DECELERATE_2) {
        public float getPageAlpha(int pageIndex) { return 0; }
    };
}

@Override public int getVisibleElements(...) {
    int elements = CLEAR_ALL_BUTTON | OVERVIEW_ACTIONS | ADD_DESK_BUTTON; // 清除按钮 + 操作栏 + 桌面按钮
    // 按设备决定是否显示搜索栏；分屏选择中隐藏 clearAll/addDesk
    ...
}

@Override public boolean isTaskbarAlignedWithHotseat() { return false; } // taskbar 不对齐 hotseat
@Override protected float getDepthUnchecked(...) {
    return SystemProperties.getBoolean("ro.launcher.depth.overview", true)
            ? DEPTH_70_PERCENT : DEPTH_0_PERCENT; // 70% 模糊（可被 prop 关闭）
}
```

### 2.8 Overview 的四个子态

均继承 `OverviewState`，通过工厂方法创建：

```java
public static OverviewState newBackgroundState(int id)     { return new BackgroundAppState(id); }
public static OverviewState newSwitchState(int id)         { return new QuickSwitchState(id); }
public static OverviewState newModalTaskState(int id)      { return new OverviewModalTaskState(id); }
public static OverviewState newSplitSelectState(int id)    { return new SplitScreenSelectState(id); }
```

#### 2.8.1 OVERVIEW_MODAL_TASK（单任务模态）

`OverviewModalTaskState.java`：用户在 Overview 里上滑某个任务卡，让它单独放大显示。

```java
private static final int STATE_FLAGS = FLAG_DISABLE_RESTORE | FLAG_RECENTS_VIEW_VISIBLE
        | FLAG_WORKSPACE_INACCESSIBLE;

@Override public int getVisibleElements(...) { return OVERVIEW_ACTIONS; } // 只留操作栏
@Override public float getOverviewModalness() { return 1.0f; }            // 完全模态（其余任务淡出）
@Override public int getTransitionDuration(...) { return 300; }
```

#### 2.8.2 QUICK_SWITCH（快速切换）

`QuickSwitchState.java` 继承 `BackgroundAppState`。从桌面快速切到最近 app 的中间态：

```java
@Override public ScaleAndTranslation getWorkspaceScaleAndTranslation(Launcher launcher) {
    float translationY = (getVerticalProgress(launcher) - NORMAL.getVerticalProgress(launcher))
            * shiftRange;
    return new ScaleAndTranslation(0.9f, 0, translationY); // 缩 0.9，按 progress 位移
}
@Override public float getVerticalProgress(Launcher launcher) { return 1f; } // AllApps shelf 不动，只淡出
@Override public int getVisibleElements(...) { return NONE; }                // 全部隐藏
@Override public boolean isTaskbarStashed(DeviceProfile dp) {
    return !dp.isTaskbarPresentInApps; // app 内 taskbar 行为
}
@Override public boolean detachDesktopCarousel() { return true; }
```

#### 2.8.3 BACKGROUND_APP（Launcher 在 app 后方）

`BackgroundAppState.java`：用户从 Launcher 启动 app 后，Launcher 仍在但退到背景。

```java
private static final int STATE_FLAGS = FLAG_DISABLE_RESTORE | FLAG_RECENTS_VIEW_VISIBLE
        | FLAG_WORKSPACE_INACCESSIBLE | FLAG_NON_INTERACTIVE        // 不可交互
        | FLAG_CLOSE_POPUPS | FLAG_SKIP_STATE_ANNOUNCEMENT;          // Talkback 不播报

@Override public float getOverviewFullscreenProgress() { return 1; } // 任务卡全屏
@Override public int getVisibleElements(...) {
    return super.getVisibleElements(...) & ~OVERVIEW_ACTIONS & ~CLEAR_ALL_BUTTON
            & ~VERTICAL_SWIPE_INDICATOR & ~ADD_DESK_BUTTON; // 隐藏所有 Overview 控件
}
@Override public boolean showTaskThumbnailSplash() { return true; } // 显示缩略图闪屏
@Override protected float getDepthUnchecked(...) {
    return areDesktopTasksVisible() ? DEPTH_0_PERCENT : DEPTH_70_PERCENT; // 桌面任务可见时不模糊
}
@Override public ScrimColors getWorkspaceScrimColor(...) {
    return new ScrimColors(Color.TRANSPARENT, Color.TRANSPARENT); // 无遮罩
}
```

#### 2.8.4 OVERVIEW_SPLIT_SELECT（分屏选择第二应用）

`SplitScreenSelectState.java`：用户已选定分屏第一个 app，正在选第二个。

```java
@Override public int getVisibleElements(...) { return SPLIT_PLACHOLDER_VIEW; } // 只显示分屏占位
@Override public float getSplitSelectTranslation(Launcher launcher) {
    return recentsView.getSplitSelectTranslation();
}
@Override public int getTransitionDuration(..., boolean isToState) {
    if (isToState) return isTablet ? TABLET_ENTER_DURATION : PHONE_ENTER_DURATION;
    return ABORT_DURATION;
}
@Override public boolean shouldPreserveDataStateOnReapply() { return true; }
// 关键：配置变化时保留数据状态（已选的第一个 app），不重置
```

### 面试深问

**Q1：为什么 NORMAL 用匿名子类而不是独立类？**
源码注释 `TODO: Create a separate class for NORMAL state` 表明这是历史遗留。NORMAL 行为简单（基本全是默认值），匿名子类只覆写 `getTransitionDuration` 返回 0（让引擎用来源态时长），其他状态因行为复杂都独立成类。

**Q2：SPRING_LOADED 和 EDIT_MODE 的 flags 几乎一样，为什么不合并？**
flags 相同但视觉不同：SPRING_LOADED 把 Workspace 上移腾出拖拽空间，EDIT_MODE 不位移只缩放。语义上一个是「正在拖一个 icon」、一个是「多选整理模式」，触发入口和清理逻辑（`onLeavingState`）也不同，分开更清晰。

**Q3：为什么 BACKGROUND_APP 要 `FLAG_NON_INTERACTIVE` + `FLAG_SKIP_STATE_ANNOUNCEMENT`？**
此态下用户实际在操作前台 app，Launcher 不可见也不应响应触摸；跳过 Talkback 播报避免「最近应用」这类语音打断用户。`FLAG_DISABLE_RESTORE` 保证回到 Launcher 时不会停在背景态。

---

## 三、LauncherState 基类：flag 体系与纯数据契约

### 3.1 两套位掩码

LauncherState 维护两套独立位掩码，**职责完全不同**：

#### 第一套：可见元素掩码（`getVisibleElements` 返回值）

```java
// LauncherState.java —— 这些是「UI 元素位」，由 getVisibleElements() 返回
public static final int NONE = 0;
public static final int HOTSEAT_ICONS          = 1 << 0; // hotseat 图标
public static final int ALL_APPS_CONTENT       = 1 << 1; // AllApps 内容
public static final int VERTICAL_SWIPE_INDICATOR = 1 << 2; // 手势指示条
public static final int OVERVIEW_ACTIONS       = 1 << 3; // Overview 操作栏
public static final int CLEAR_ALL_BUTTON       = 1 << 4; // 清除全部
public static final int WORKSPACE_PAGE_INDICATOR = 1 << 5; // 分页指示器
public static final int SPLIT_PLACHOLDER_VIEW  = 1 << 6; // 分屏占位（注意拼写：PLACHOLDER）
public static final int FLOATING_SEARCH_BAR    = 1 << 7; // 浮动搜索栏
public static final int ADD_DESK_BUTTON        = 1 << 8; // 添加桌面按钮
```

查询助手：

```java
public boolean areElementsVisible(LauncherUiState launcherUiState, int elements) {
    return (getVisibleElements(launcherUiState) & elements) == elements; // 全包含才 true
}
```

#### 第二套：状态行为 flags（构造时传入 `mFlags`）

来自两处。`BaseState.java` 定义基类 flags（低 2 位保留）：

```java
// BaseState.java
int FLAG_NON_INTERACTIVE  = 1 << 0; // 状态不可交互
int FLAG_DISABLE_RESTORE  = 1 << 1; // Activity 重建时不恢复

static int getFlag(int index) {
    return 1 << (index + 2); // 子类 flags 从第 2 位开始
}
```

`LauncherState.java` 定义具体 flags（用 `BaseState.getFlag(index)`）：

```java
public static final int FLAG_MULTI_PAGE                  = BaseState.getFlag(0); // 1<<2，多页可见
public static final int FLAG_WORKSPACE_INACCESSIBLE       = BaseState.getFlag(1); // 1<<3
public static final int FLAG_WORKSPACE_ICONS_CAN_BE_DRAGGED = BaseState.getFlag(2); // 1<<4
public static final int FLAG_WORKSPACE_HAS_BACKGROUNDS   = BaseState.getFlag(3); // 1<<5
public static final int FLAG_HAS_SYS_UI_SCRIM            = BaseState.getFlag(4); // 1<<6
public static final int FLAG_CLOSE_POPUPS                = BaseState.getFlag(5); // 1<<7
public static final int FLAG_RECENTS_VIEW_VISIBLE        = BaseState.getFlag(6); // 1<<8
public static final int FLAG_HOTSEAT_INACCESSIBLE        = BaseState.getFlag(7); // 1<<9
public static final int FLAG_SKIP_STATE_ANNOUNCEMENT     = BaseState.getFlag(8); // 1<<10
```

`hasFlag` 是 final，子类不能改判定逻辑：

```java
@Override public final boolean hasFlag(int mask) {
    return (mFlags & mask) != 0;
}
```

`isRecentsViewVisible` 在构造时就算好缓存（频繁查询）：

```java
this.isRecentsViewVisible = (flags & FLAG_RECENTS_VIEW_VISIBLE) != 0;
```

### 3.2 纯数据契约：状态只回答「应该是什么样」

LauncherState 全是 getter，没有任何 setter、没有任何 View 操作。核心契约方法：

| 方法 | 回答的问题 |
|------|-----------|
| `getWorkspaceScaleAndTranslation` | Workspace 该缩到多少、位移多少 |
| `getHotseatScaleAndTranslation` | Hotseat 该缩到多少、位移多少（默认跟 Workspace） |
| `getOverviewScaleAndOffset` | RecentsView 的缩放和水平偏移（offset=1 表示完全滑出屏幕） |
| `getVerticalProgress` | AllApps 容器的垂直进度（1=收起，0=展开） |
| `getVisibleElements` | 哪些 UI 元素该显示（位掩码） |
| `getWorkspaceBackgroundAlpha` | Workspace 背景透明度 |
| `getWorkspaceScrimColor` | Workspace 遮罩颜色（前后景） |
| `getOverviewModalness` | Overview 模态程度（0=全部任务，1=仅当前任务） |
| `getOverviewFullscreenProgress` | 任务卡全屏进度（0=缩略，1=全屏） |
| `getDepth` | 壁纸模糊/缩放深度（0~1） |
| `getSplitSelectTranslation` | 分屏选择的额外位移 |
| `getWorkspacePageAlphaProvider` | 每页 alpha（用于相邻页淡出） |
| `getWorkspacePageTranslationProvider` | 每页位移（双面板设备的视差） |
| `getFloatingSearchBarRestingMargin*` | 浮动搜索栏的静止边距（Start/End/Bottom） |
| `getTransitionDuration` | 进入此状态的动画时长 |
| `isTaskbarStashed` / `isTaskbarAlignedWithHotseat` | Taskbar 行为 |
| `getHistoryForState` | 从此态返回时该回到哪个态（默认 NORMAL） |

`ScaleAndTranslation` 是简单值对象：

```java
public static class ScaleAndTranslation {
    public float scale;
    public float translationX;
    public float translationY;
}
```

`PageAlphaProvider` / `PageTranslationProvider` 是抽象类，每个状态可返回自定义的逐页逻辑。基类提供默认实现（全 1 alpha、全 0 位移）：

```java
protected static final PageAlphaProvider DEFAULT_ALPHA_PROVIDER =
        new PageAlphaProvider(ACCELERATE_2) {
            @Override public float getPageAlpha(int pageIndex) { return 1; }
        };
```

### 3.3 返回键处理：状态自治

LauncherState 直接处理返回手势，把 `StateManager` 的 `getLastState()` 当作返回目标：

```java
public void onBackInvoked(Launcher launcher) {
    if (this != NORMAL) {
        StateManager<LauncherState, Launcher> lsm = launcher.getStateManager();
        LauncherState lastState = lsm.getLastState();                  // 上一个稳定态
        lsm.goToState(lastState, forEndCallback(this::onBackAnimationCompleted));
    }
}
```

`onBackProgressed` 把预测式返回的进度（0~1）透传给 `StateManager.onBackProgressed`，由各 handler 解释（如 AllApps 的 `onBackProgressed` 据此缩放内容）。

### 面试深问

**Q1：`getVisibleElements` 的位掩码和 `mFlags` 为什么不合并？**
两者语义不同：`getVisibleElements` 描述「UI 元素显隐」，可由子类动态计算（如 ALL_APPS 在平板上多加 `HOTSEAT_ICONS`）；`mFlags` 是构造时固化的「状态行为」，决定可拖拽/可交互/是否持久化等不变属性。合并会让动态计算和行为标记混在一起。

**Q2：为什么 `hasFlag` 是 final？**
防止子类覆写判定逻辑破坏位掩码语义。flags 是状态行为的唯一事实来源，所有查询（如 `shouldDisableRestore`、`onStateSetStart` 里检查 `FLAG_CLOSE_POPUPS`）都依赖 `(mFlags & mask) != 0` 这个确定语义。

**Q3：`getHistoryForState` 默认返回 NORMAL，有什么用？**
状态机要回答「从此态按返回该去哪」。Overview 系返回 NORMAL，但某些状态可能有更合理的回退目标（如分屏选择中断后回 Overview 而非桌面）。默认 NORMAL 是安全兜底。

---

## 四、StateManager：状态机引擎

`StateManager<S extends BaseState<S>, T extends StatefulContainer<S>>` 是泛型引擎，Launcher 的具体类型是 `StateManager<LauncherState, Launcher>`。

### 4.1 核心字段

```java
public class StateManager<S extends BaseState<S>, T extends StatefulContainer<S>> {

    private final AnimationState<S> mConfig = new AnimationState<>(); // 当前动画配置（见 4.5）
    private final Handler mUiHandler;                                  // 主线程 Handler
    private final T mContainer;                                        // Launcher 实例
    private final ArrayList<StateListener<S>> mListeners = new ArrayList<>(); // 状态监听器
    private final S mBaseState;                                        // 基态（NORMAL）
    private @Nullable LauncherUiState mLauncherUiState;                // UI 状态（设备配置等）

    private final AtomicAnimationFactory<S> mAtomicAnimationFactory;   // 原子动画工厂

    private StateHandler<S>[] mStateHandlers; // 延迟初始化：首次 getStateHandlers() 时从 container 收集
    private S mState;                         // 当前态（动画进行中也实时更新）

    private S mLastStableState;               // 上一个稳定态（返回键目标）
    private S mCurrentStableState;            // 当前稳定态（动画结束后才更新）

    private S mRestState;                     // onStop 时回到的态（默认 null→baseState）
}
```

构造时三者都初始化为 baseState：

```java
public StateManager(T container, S baseState) {
    mUiHandler = new Handler(Looper.getMainLooper());
    mContainer = container;
    mBaseState = baseState;                                   // Launcher 传 NORMAL
    mState = mLastStableState = mCurrentStableState = baseState;
    mAtomicAnimationFactory = container.createAtomicAnimationFactory();
}
```

`Launcher` 构造时：

```java
// Launcher.java
mStateManager = new StateManager<>(this, NORMAL);
```

### 4.2 为什么要区分 stable / current / last

这是整套状态机最容易混淆的地方。三个字段的更新时机不同：

| 字段 | 更新时机 | 含义 |
|------|---------|------|
| `mState` | 动画**开始**时（`onStateTransitionStart`） | 当前显示的状态（动画进行中也是目标态） |
| `mCurrentStableState` | 动画**结束**时（`onStateTransitionEnd`） | 最近一次完整到达的稳定态 |
| `mLastStableState` | 动画**结束**时，更新为「进入当前态之前的稳定态」 | 返回键目标 |

```java
private void onStateTransitionStart(S state) {
    mState = state;                              // 立即更新当前态
    if (mLauncherUiState != null && mState instanceof LauncherState launcherState) {
        mLauncherUiState.setLauncherState(launcherState); // 同步给 LauncherUiState
    }
    mContainer.onStateSetStart(mState);          // 容器钩子（关浮层等）
    for (int i = mListeners.size() - 1; i >= 0; i--) {
        mListeners.get(i).onStateTransitionStart(state); // 通知监听器
    }
}

private void onStateTransitionEnd(S state) {
    // 只有过渡完成才更新稳定态
    if (state != mCurrentStableState) {
        mLastStableState = state.getHistoryForState(mCurrentStableState); // 记录回退目标
        mCurrentStableState = state;
    }
    mContainer.onStateSetEnd(state);
    if (state == mBaseState) setRestState(null); // 回到 baseState 清空 restState
    for (int i = mListeners.size() - 1; i >= 0; i--) {
        mListeners.get(i).onStateTransitionComplete(state);
    }
}
```

为什么要分开？

1. **动画可被取消**。用户从 NORMAL 滑向 ALL_APPS 到一半松手取消，`mState` 会先变 ALL_APPS 再被 `cancelAnimation` 重置回 `mCurrentStableState`（仍是 NORMAL）。如果只有一个字段，取消时无法知道回哪。
2. **返回键需要历史**。`onBackInvoked` 用 `getLastState()` 拿 `mLastStableState`。从 Overview 返回应回 NORMAL，从 AllApps 返回也应回 NORMAL——这依赖 `onStateTransitionEnd` 在进入 Overview 前把 `mLastStableState` 设为 NORMAL。
3. **`isInStableState` 的判定**：

```java
public boolean isInStableState(S state) {
    return mState == state                                       // 当前态匹配
            && mCurrentStableState == state                     // 稳定态也匹配
            && (mConfig.targetState == null || mConfig.targetState == state); // 无进行中过渡或过渡目标也是它
}
```

只有三者都对齐，才算「真正稳定在此态」。`moveToRestState`、`onStop` 等都用它判断是否需要归位。

### 4.3 goToState 重载链

StateManager 暴露 7 个 goToState 重载，全部收敛到私有方法 `goToState(state, animated, delay, listener)`：

```java
public void goToState(S state) {                                  goToState(state, shouldAnimateStateChange()); }
public void goToState(S state, AnimatorListener listener) {       goToState(state, shouldAnimateStateChange(), listener); }
public void goToState(S state, boolean animated) {                goToState(state, animated, 0, null); }
public void goToState(S state, boolean animated, AnimatorListener listener) {
                                                                   goToState(state, animated, 0, listener); }
public void goToState(S state, long delay, AnimatorListener listener) { goToState(state, true, delay, listener); }
public void goToState(S state, long delay) {                      goToState(state, true, delay, null); }
```

核心实现（精简）：

```java
private void goToState(S state, boolean animated, long delay, AnimatorListener listener) {
    animated &= areAnimatorsEnabled(); // 系统关闭动画时强制不动画（无障碍设置）

    // 1) 已经在目标态
    if (getState() == state) {
        if (mConfig.currentAnimation == null) {
            // 没有进行中动画：直接跑回调，触发 onRepeatStateSetAborted
            if (listener != null) listener.onAnimationEnd(new AnimatorSet());
            onRepeatStateSetAborted(state);
            return;
        } else if ((!mConfig.isUserControlled() && animated && mConfig.targetState == state)
                || mState.shouldPreserveDataStateOnReapply()) {
            // 正在跑同一个目标态的动画：让它跑完，不取消（避免打断手势）
            if (listener != null) mConfig.currentAnimation.addListener(listener);
            onRepeatStateSetAborted(state);
            return;
        }
        // 否则继续走取消流程
    }

    // 2) 取消当前动画（会重置 mState 到 mCurrentStableState，所以先存 fromState）
    S fromState = mState;
    cancelAnimation();

    // 3) 不带动画：直接 setState 全部 handler
    if (!animated) {
        mAtomicAnimationFactory.cancelAllStateElementAnimation();
        onStateTransitionStart(state);
        for (StateHandler<S> handler : getStateHandlers()) handler.setState(state);
        onStateTransitionEnd(state);
        if (listener != null) listener.onAnimationEnd(new AnimatorSet());
        return;
    }

    // 4) 带动画：延迟或立即
    if (delay > 0) {
        int startChangeId = mConfig.changeId; // 用 changeId 防止延迟期间状态被改
        mUiHandler.postDelayed(() -> {
            if (mConfig.changeId == startChangeId) goToStateAnimated(state, fromState, listener);
        }, delay);
    } else {
        goToStateAnimated(state, fromState, listener);
    }
}
```

动画分支：

```java
private void goToStateAnimated(S state, S fromState, AnimatorListener listener) {
    // 关键：进入 baseState(NORMAL) 时，用来源态的时长（反向播放语义）
    mConfig.duration = state == mBaseState
            ? fromState.getTransitionDuration(mContainer, false /* isToState */)
            : state.getTransitionDuration(mContainer, true /* isToState */);
    prepareForAtomicAnimation(fromState, state, mConfig); // 设置插值器、预备缩放等
    AnimatorSet animation = createAnimationToNewWorkspaceInternal(state).buildAnim();
    if (listener != null) animation.addListener(listener);
    mUiHandler.post(new StartAnimRunnable(animation)); // 下一帧启动
}
```

`StartAnimRunnable` 在启动前二次校验动画身份：

```java
private class StartAnimRunnable implements Runnable {
    private final AnimatorSet mAnim;
    public void run() {
        if (mConfig.currentAnimation != mAnim) return; // 期间被换掉，不启动
        mAnim.start();
    }
}
```

### 4.4 StateHandler 收集

handler 数组延迟初始化：

```java
public StateHandler<S>[] getStateHandlers() {
    if (mStateHandlers == null) {
        ArrayList<StateHandler<S>> handlers = new ArrayList<>();
        mContainer.collectStateHandlers(handlers); // 让 container 自己提供
        mStateHandlers = handlers.toArray(new StateHandler[handlers.size()]);
    }
    return mStateHandlers;
}
```

Launcher 的实现只注册两个 handler：

```java
// Launcher.java
@Override public void collectStateHandlers(List<StateHandler<LauncherState>> out) {
    out.add(getAllAppsController()); // AllAppsTransitionController
    out.add(getWorkspace());         // Workspace（内部委托给 WorkspaceStateTransitionAnimation）
}
```

顺序有意义：AllApps 先处理（控制垂直 progress），Workspace 后处理（控制缩放/位移/alpha）。两者都把动画加到同一个 `PendingAnimation`，最终一起播放。

### 4.5 AnimationState：动画运行时

`AnimationState` 继承 `StateAnimationConfig`，同时实现 `AnimatorListener`，是「当前动画 + 配置 + 目标态」的聚合体：

```java
private static class AnimationState<STATE_TYPE> extends StateAnimationConfig
        implements AnimatorListener {

    public AnimatorPlaybackController playbackController; // 手势控制时用
    public AnimatorSet currentAnimation;                   // 当前 AnimatorSet
    public STATE_TYPE targetState;                         // 目标态（null 表示无过渡）
    public int changeId = 0;                               // 配置变更计数器（防延迟竞态）

    public void reset() {
        AnimatorSet anim = currentAnimation;
        AnimatorPlaybackController pc = playbackController;

        DEFAULT.copyTo(this);          // 复位配置（duration/flags/props/插值器）
        targetState = null;
        currentAnimation = null;
        playbackController = null;
        changeId++;                    // 触发延迟中的 goToState 失效

        if (pc != null) {
            pc.getAnimationPlayer().cancel();
            pc.dispatchOnCancel().dispatchOnEnd();
        } else if (anim != null) {
            anim.setDuration(0);       // 跳到结尾
            if (!anim.isStarted()) {
                // 未 start 的 AnimatorSet cancel 不会通知 listener，手动通知
                callListenerCommandRecursively(anim, AnimatorListener::onAnimationCancel);
                callListenerCommandRecursively(anim, AnimatorListener::onAnimationEnd);
            }
            anim.cancel();
        }
    }

    @Override public void onAnimationEnd(Animator animation) {
        if (playbackController != null && playbackController.getTarget() == animation) {
            playbackController = null;
        }
        if (currentAnimation == animation) currentAnimation = null;
    }

    public void setAnimation(AnimatorSet animation, STATE_TYPE targetState) {
        currentAnimation = animation;
        this.targetState = targetState;
        currentAnimation.addListener(this); // 自己监听结束以清理
    }
}
```

### 4.6 cancelAnimation 与 reapplyState

```java
public void cancelAnimation() {
    mConfig.reset();
    // reset 可能触发 listener 的 end 回调，回调里又 set 了新动画，循环直到全空
    while (mConfig.currentAnimation != null || mConfig.playbackController != null) {
        mConfig.reset();
    }
}
```

`reapplyState` 用于配置变化（旋转、inset 变化）后重新把当前态施加到 UI：

```java
public void reapplyState(boolean cancelCurrentAnimation) {
    boolean wasInAnimation = mConfig.currentAnimation != null;
    if (cancelCurrentAnimation && (mConfig.animProps & HANDLE_STATE_APPLY) == 0) {
        // 注意：对于 shouldPreserveDataStateOnReapply 的状态（如分屏选择），
        // 不能直接 cancel（会丢数据），而是把动画快进到结尾
        if (mState.shouldPreserveDataStateOnReapply() && mConfig.currentAnimation != null) {
            mConfig.currentAnimation.end();
        }
        mAtomicAnimationFactory.cancelAllStateElementAnimation();
        cancelAnimation();
    }
    if (mConfig.currentAnimation == null) {
        for (StateHandler<S> handler : getStateHandlers()) handler.setState(mState); // 无动画重施
        if (wasInAnimation) onStateTransitionEnd(mState);
    }
}
```

### 4.7 createAnimationToNewWorkspace：手势动画的入口

goToState 走的是「自动播放」路径，手势跟随走另一条路径：

```java
public AnimatorPlaybackController createAnimationToNewWorkspace(
        S state, StateAnimationConfig config) {
    config.animProps |= StateAnimationConfig.USER_CONTROLLED; // 标记为用户控制
    cancelAnimation();
    config.copyTo(mConfig);
    mConfig.playbackController = createAnimationToNewWorkspaceInternal(state)
            .createPlaybackController(); // 关键：包装成 PlaybackController 而非直接 start
    return mConfig.playbackController;
}
```

内部都走 `createAnimationToNewWorkspaceInternal`：

```java
private PendingAnimation createAnimationToNewWorkspaceInternal(final S state) {
    PendingAnimation builder = new PendingAnimation(mConfig.duration);
    if (!mConfig.hasAnimationFlag(SKIP_ALL_ANIMATIONS)) {
        for (StateHandler<S> handler : getStateHandlers()) {
            handler.setStateWithAnimation(state, mConfig, builder); // 每个 handler 往 builder 里加动画
        }
    }
    builder.addListener(createStateAnimationListener(state)); // 绑定 start/end 回调
    mConfig.setAnimation(builder.buildAnim(), state);
    return builder;
}
```

`createStateAnimationListener` 把动画生命周期 hook 回 `onStateTransitionStart/End`：

```java
private AnimatorListener createStateAnimationListener(S state) {
    return new AnimationSuccessListener() {
        @Override public void onAnimationStart(Animator animation) {
            onStateTransitionStart(state); // 动画真正开始时才切 mState
        }
        @Override public void onAnimationSuccess(Animator animator) {
            onStateTransitionEnd(state);   // 成功结束才更新稳定态
        }
    };
}
```

注意用 `AnimationSuccessListener`：`onAnimationCancel` 不会触发 `onAnimationSuccess`，所以取消时不会误更新稳定态。

### 4.8 moveToRestState / getRestState

onStop 时调用，把 Launcher 归位：

```java
public void moveToRestState(boolean isAnimated) {
    if (mConfig.currentAnimation != null && mConfig.isUserControlled()) return; // 用户在操作，不打断
    if (mState.shouldDisableRestore()) {        // FLAG_DISABLE_RESTORE 的状态才需要归位
        goToState(getRestState(), isAnimated);
        mLastStableState = mBaseState;          // 重置历史
    }
}

public S getRestState() {
    return mRestState == null ? mBaseState : mRestState; // 默认回 NORMAL
}
```

StatefulActivity.onStop 调用它：

```java
// StatefulActivity.java
@Override protected void onStop() {
    ...
    if (!isChangingConfigurations()) getStateManager().moveToRestState();
    onTrimMemory(TRIM_MEMORY_UI_HIDDEN);
    ...
}
```

### 面试深问

**Q1：goToState 已在目标态且有动画时，什么情况下「让动画跑完」而不是取消？**
两个条件之一：(1) 当前动画非用户控制、要求动画、且目标态相同——重复请求视为「确认方向」，跑完更顺滑；(2) 当前态 `shouldPreserveDataStateOnReapply()`（如分屏选择）——取消会丢失已选 app 数据，必须跑完。否则一律取消重开。

**Q2：changeId 解决什么竞态？**
带 delay 的 goToState 把启动任务 postDelayed。延迟期间用户可能又触发新 goToState，旧的启动任务若仍执行会覆盖新动画。`changeId` 在每次 reset 时自增，延迟任务执行前比对 id，不匹配就放弃。这是典型的「乐观提交」防竞态。

**Q3：为什么 onStateTransitionStart 里要同步 LauncherUiState？**
LauncherUiState 是新引入的「UI 配置快照」（设备 profile、是否分屏选择等），状态子类用 `getVisibleElements(LauncherUiState)` 等方法查询它。动画开始时 mState 已变，但 LauncherUiState 必须同步指向新状态，否则后续 handler 用旧 uiState 算出错误的可见元素。

---

## 五、StateHandler 接口：状态的解释器

### 5.1 接口契约

`StateHandler` 是 StateManager 的内部接口，极其精简：

```java
public interface StateHandler<STATE_TYPE> {
    /** 无动画地把 UI 更新到 state */
    void setState(STATE_TYPE state);

    /** 用动画把 UI 切换到 toState，把产生的动画塞进 animation（PendingAnimation） */
    void setStateWithAnimation(
            STATE_TYPE toState, StateAnimationConfig config, PendingAnimation animation);

    /** 预测式返回手势开始（默认空实现） */
    default void onBackStarted(STATE_TYPE toState) {}

    /** 预测式返回手势进度（0~1，默认空） */
    default void onBackProgressed(
            STATE_TYPE toState, @FloatRange(from = 0.0, to = 1.0) float backProgress) {}

    /** 预测式返回手势取消（默认空） */
    default void onBackCancelled(STATE_TYPE toState) {}
}
```

只有两个核心方法。`setState` 用于「立刻应用」（无动画分支、reapplyState），`setStateWithAnimation` 用于「带动画应用」。两者读同一份状态数据，保证动画终点和无动画应用的结果一致。

### 5.2 实现 1：Workspace（委托给 WorkspaceStateTransitionAnimation）

Workspace 自己实现 StateHandler，但实际逻辑委托：

```java
// Workspace.java
@Override public void setState(LauncherState toState) {
    onStartStateTransition();
    mLauncher.getStateManager().getState().onLeavingState(mLauncher, toState); // 旧态离开钩子
    mStateTransitionAnimation.setState(toState);
    onEndStateTransition();
}

@Override public void setStateWithAnimation(
        LauncherState toState, StateAnimationConfig config, PendingAnimation animation) {
    StateTransitionListener listener = new StateTransitionListener();
    mLauncher.getStateManager().getState().onLeavingState(mLauncher, toState);
    mStateTransitionAnimation.setStateWithAnimation(toState, config, animation);

    // MULTI_PAGE 状态强制多页可见（拖拽跨页用）
    if (toState.hasFlag(FLAG_MULTI_PAGE)) mForceDrawAdjacentPages = true;
    invalidate();

    // 加一个步进 animator，让 listener 每帧收到回调（用于 invalidate 等）
    ValueAnimator stepAnimator = ValueAnimator.ofFloat(0, 1);
    stepAnimator.addUpdateListener(listener);
    stepAnimator.addListener(listener);
    animation.add(stepAnimator);
}
```

`WorkspaceStateTransitionAnimation.setStateWithAnimation` 委托给 `setWorkspaceProperty`，这是 Workspace 解释状态的核心：

```java
// WorkspaceStateTransitionAnimation.java
public void setStateWithAnimation(LauncherState toState, StateAnimationConfig config,
        PendingAnimation animation) {
    setWorkspaceProperty(toState, animation, config);
}

private void setWorkspaceProperty(LauncherState state, PropertySetter propertySetter,
        StateAnimationConfig config) {
    ScaleAndTranslation scaleAndTranslation = state.getWorkspaceScaleAndTranslation(mLauncher);
    ScaleAndTranslation hotseatScaleAndTranslation = state.getHotseatScaleAndTranslation(mLauncher);
    mNewScale = scaleAndTranslation.scale;
    PageAlphaProvider pageAlphaProvider = state.getWorkspacePageAlphaProvider(mLauncher);

    // 1) 逐页设置 alpha（用 propertySetter，自动区分有/无动画）
    for (int i = 0; i < childCount; i++) {
        applyChildState(state, (CellLayout) mWorkspace.getChildAt(i), i, pageAlphaProvider,
                propertySetter, config);
    }

    int elements = state.getVisibleElements(mLauncher.getLauncherUiState());
    Hotseat hotseat = mWorkspace.getHotseat();
    LauncherState fromState = mLauncher.getStateManager().getState();

    // 2) HINT_STATE → NORMAL 用弹簧动画（SpringAnimation），其余用普通属性动画
    boolean shouldSpring = propertySetter instanceof PendingAnimation
            && fromState == HINT_STATE && state == NORMAL;
    if (shouldSpring) {
        ((PendingAnimation) propertySetter).add(getSpringScaleAnimator(
                mLauncher, mWorkspace, mNewScale, WORKSPACE_SCALE_PROPERTY));
    } else {
        propertySetter.setFloat(mWorkspace, WORKSPACE_SCALE_PROPERTY, mNewScale,
                config.getInterpolator(ANIM_WORKSPACE_SCALE, ZOOM_OUT));
    }

    // 3) Hotseat 跟随 Workspace 缩放（pivot 同步）
    mWorkspace.setPivotToScaleWithSelf(hotseat);
    ...

    // 4) 页面指示器、hotseat 图标的 alpha（按可见元素位掩码决定 0 或 1）
    float workspacePageIndicatorAlpha = (elements & WORKSPACE_PAGE_INDICATOR) != 0 ? 1 : 0;
    propertySetter.setViewAlpha(mLauncher.getWorkspace().getPageIndicator(),
            workspacePageIndicatorAlpha, workspaceFadeInterpolator);
    float hotseatIconsAlpha = (elements & HOTSEAT_ICONS) != 0 ? 1 : 0;
    propertySetter.setViewAlpha(hotseat, hotseatIconsAlpha, hotseatFadeInterpolator);

    // 5) HOTSEAT_INACCESSIBLE 时屏蔽无障碍焦点
    hotseat.setImportantForAccessibility(
            state.hasFlag(FLAG_HOTSEAT_INACCESSIBLE)
                    ? View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
                    : View.IMPORTANT_FOR_ACCESSIBILITY_AUTO);

    // 6) Workspace 位移
    propertySetter.setFloat(mWorkspace, VIEW_TRANSLATE_X, scaleAndTranslation.translationX, ...);
    propertySetter.setFloat(mWorkspace, VIEW_TRANSLATE_Y, scaleAndTranslation.translationY, ...);

    // 7) 逐页位移（双面板视差）
    PageTranslationProvider pageTranslationProvider = state.getWorkspacePageTranslationProvider(mLauncher);
    for (int i = 0; i < childCount; i++) {
        applyPageTranslation((CellLayout) mWorkspace.getChildAt(i), i, pageTranslationProvider,
                propertySetter, config);
    }
}
```

注意第三参数 `PropertySetter`：
- `setState` 传 `NO_ANIM_PROPERTY_SETTER`（直接 setValue，无动画）。
- `setStateWithAnimation` 传 `PendingAnimation`（构造 ObjectAnimator 加入集合）。

同一个 `setWorkspaceProperty` 方法，靠 PropertySetter 多态自动切换有/无动画——避免了「动画版」和「无动画版」两套重复代码。

### 5.3 实现 2：AllAppsTransitionController

控制 AllApps 容器的垂直滑动：

```java
// AllAppsTransitionController.java
public class AllAppsTransitionController
        implements StateHandler<LauncherState>, OnDeviceProfileChangeListener {

    public static final FloatProperty<AllAppsTransitionController> ALL_APPS_PROGRESS =
            new FloatProperty<AllAppsTransitionController>("allAppsProgress") {
                @Override public Float get(AllAppsTransitionController controller) { return controller.mProgress; }
                @Override public void setValue(AllAppsTransitionController controller, float progress) {
                    controller.setProgress(progress);
                }
            };

    @Override public void setState(LauncherState state) {
        setProgress(state.getVerticalProgress(mLauncher)); // 直接设 progress
        setAlphas(state, new StateAnimationConfig(), NO_ANIM_PROPERTY_SETTER);
    }

    @Override public void setStateWithAnimation(LauncherState toState,
            StateAnimationConfig config, PendingAnimation builder) {
        // 从 ALL_APPS 离开时，结束时重置 pull-back 属性
        if (mLauncher.isInState(ALL_APPS) && !ALL_APPS.equals(toState)) {
            builder.addEndListener(success -> {
                ALL_APPS_PULL_BACK_TRANSLATION.set(this, ALL_APPS_PULL_BACK_TRANSLATION_DEFAULT);
                ALL_APPS_PULL_BACK_ALPHA.set(this, ALL_APPS_PULL_BACK_ALPHA_DEFAULT);
                mAllAppScale.updateValue(1f);
            });
        }

        float targetProgress = toState.getVerticalProgress(mLauncher);
        if (Float.compare(mProgress, targetProgress) == 0) {
            setAlphas(toState, config, builder); // progress 没变，只更新 alpha
            return;
        }

        // progress 动画：用户控制用 LINEAR，自动播放用 DECELERATE_1_7（弹性）
        Interpolator verticalProgressInterpolator = config.getInterpolator(ANIM_VERTICAL_PROGRESS,
                config.isUserControlled() ? LINEAR : DECELERATE_1_7);
        Animator anim = createSpringAnimation(mProgress, targetProgress);
        anim.setInterpolator(verticalProgressInterpolator);
        builder.add(anim);

        setAlphas(toState, config, builder);
        // 进入 ALL_APPS（从 NORMAL）时播放触觉反馈
        if (ALL_APPS.equals(toState) && mLauncher.isInState(NORMAL)) {
            mLauncher.getAppsView().performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY, ...);
        }
    }

    public Animator createSpringAnimation(float... progressValues) {
        return ObjectAnimator.ofFloat(this, ALL_APPS_PROGRESS, progressValues);
    }

    public void setProgress(float progress) {
        mProgress = progress;
        // progress=1 显示桌面，progress=0 显示 AllApps
        float shiftRange = fromBackground ? heightPx : mShiftRange;
        getAppsViewProgressTranslationY().setValue(mProgress * shiftRange); // 容器位移
        mLauncher.onAllAppsTransition(1 - progress);                        // 通知 Launcher
        ...
    }
}
```

`setProgress` 是核心：`progress` 从 1（NORMAL）线性映射到容器位移，实现 AllApps 的上滑/下滑。

### 面试深问

**Q1：为什么 Workspace 的 setStateWithAnimation 要加一个空的 stepAnimator？**
Workspace 需要在动画每一帧 `invalidate()`（重算可见页、重绘拖拽高亮等），但 `PendingAnimation` 的子动画是各自的 ObjectAnimator，没有统一帧回调。加一个 `ValueAnimator.ofFloat(0,1)` 并绑定 `StateTransitionListener`，借它的 update 回调每帧触发 invalidate，是一个轻量的「全局帧钩子」。

**Q2：AllAppsTransitionController 为什么把 progress 做成 FloatProperty？**
`ALL_APPS_PROGRESS` 是属性对象，`ObjectAnimator.ofFloat(this, ALL_APPS_PROGRESS, ...)` 能直接驱动它。属性化后 progress 既能被动画驱动（自动播放），也能被 `AnimatorPlaybackController` 按进度施加（手势跟随），复用同一套设值路径，避免双份代码。

**Q3：`onLeavingState` 在哪里调用，有什么用？**
在 Workspace.setState / setStateWithAnimation 开头调用 `mLauncher.getStateManager().getState().onLeavingState(...)`。基类默认空操作，`EditModeState` 覆写它做清理（如退出多选时取消选中）。把「离开态」的清理钩子放在状态自己身上，比放在 handler 里更内聚。

---

## 六、StateAnimationConfig：动画配置总线

`StateAnimationConfig` 是状态切换动画的「配置总线」，决定时长、插值器、跳过项、用户控制标记。

### 6.1 三组位掩码

```java
// states/StateAnimationConfig.java

// AnimationFlags：跳过哪些动画
@AnimationFlags int animFlags;
public static final int SKIP_ALL_ANIMATIONS    = 1 << 0; // 全跳过（无动画）
public static final int SKIP_OVERVIEW         = 1 << 1; // 跳过 Overview 相关
public static final int SKIP_DEPTH_CONTROLLER = 1 << 2; // 跳过深度模糊
public static final int SKIP_SCRIM            = 1 << 3; // 跳过遮罩

// AnimationPropertyFlags：动画属性
@AnimationPropertyFlags int animProps;
public static final int USER_CONTROLLED    = 1 << 0; // 用户手势控制（不可被 goToState 取消）
public static final int HANDLE_STATE_APPLY = 1 << 1; // 能在 UI 重置（inset/配置变）中存活
```

### 6.2 动画类型与插值器表

`AnimType` 是 21 种动画类型的枚举，每种类型可单独配插值器：

```java
public static final int ANIM_VERTICAL_PROGRESS = 0;   // AllApps 垂直进度
public static final int ANIM_WORKSPACE_SCALE = 1;     // Workspace 缩放
public static final int ANIM_WORKSPACE_TRANSLATE = 2; // Workspace 位移
public static final int ANIM_WORKSPACE_FADE = 3;      // Workspace 淡入淡出
public static final int ANIM_HOTSEAT_SCALE = 4;       // Hotseat 缩放
public static final int ANIM_HOTSEAT_TRANSLATE = 5;
public static final int ANIM_OVERVIEW_SCALE = 6;      // Overview 缩放
public static final int ANIM_OVERVIEW_TRANSLATE_X = 7;
public static final int ANIM_OVERVIEW_TRANSLATE_Y = 8;
public static final int ANIM_OVERVIEW_FADE = 9;
public static final int ANIM_ALL_APPS_FADE = 10;
public static final int ANIM_SCRIM_FADE = 11;         // 遮罩淡入淡出
public static final int ANIM_OVERVIEW_MODAL = 12;     // Overview 模态
public static final int ANIM_DEPTH = 13;              // 深度模糊
public static final int ANIM_OVERVIEW_ACTIONS_FADE = 14;
public static final int ANIM_WORKSPACE_PAGE_TRANSLATE_X = 15;
public static final int ANIM_HOTSEAT_FADE = 16;
public static final int ANIM_OVERVIEW_SPLIT_SELECT_FLOATING_TASK_TRANSLATE_OFFSCREEN = 17;
public static final int ANIM_OVERVIEW_SPLIT_SELECT_INSTRUCTIONS_FADE = 18;
public static final int ANIM_ALL_APPS_KEYBOARD_FADE = 19;
private static final int ANIM_TYPES_COUNT = 21;

protected final Interpolator[] mInterpolators = new Interpolator[ANIM_TYPES_COUNT]; // 按类型索引
```

存取：

```java
public Interpolator getInterpolator(@AnimType int animId, Interpolator fallback) {
    return mInterpolators[animId] == null ? fallback : mInterpolators[animId]; // 没设就用默认
}

public void setInterpolator(@AnimType int animId, Interpolator interpolator) {
    mInterpolators[animId] = interpolator;
}
```

### 6.3 prepareForAtomicAnimation：插值器预置

`StateManager.prepareForAtomicAnimation` 委托给 `AtomicAnimationFactory`，由 Quickstep 的 `QuickstepAtomicAnimationFactory` 覆写。它在动画创建前为不同转换方向设置插值器和预备值。例如 Overview → Home 时，如果 Workspace 不可见，预先把它缩到 `WORKSPACE_PREPARE_SCALE = 0.92f`，避免动画开始时跳变：

```java
// QuickstepAtomicAnimationFactory.java
@Override protected void applyOverviewToHomeAnimConfig(...) {
    super.applyOverviewToHomeAnimConfig(...);
    Workspace<?> workspace = getContainer().getWorkspace();
    boolean isWorkspaceVisible = workspace.getVisibility() == VISIBLE && ...;
    if (!isWorkspaceVisible) {
        workspace.setScaleX(WORKSPACE_PREPARE_SCALE); // 预备缩放
        workspace.setScaleY(WORKSPACE_PREPARE_SCALE);
    }
    ...
}
```

这种「预先设好起点」的设计让动画从隐藏态滑入时不会闪现。

### 面试深问

**Q1：为什么用数组而不是 Map 存插值器？**
`AnimType` 是连续整数（0~20），数组索引访问 O(1) 且无装箱。状态切换动画在每帧都可能查插值器，性能敏感。`ANIM_TYPES_COUNT = 21` 固定，数组大小确定，没有动态扩容开销。

**Q2：USER_CONTROLLED 和 HANDLE_STATE_APPLY 各解决什么问题？**
USER_CONTROLLED：标记动画由手势驱动，goToState 检测到时不会取消它（避免手势中途被打断）。HANDLE_STATE_APPLY：标记动画能在 `reapplyState(cancelCurrentAnimation=true)` 中存活——配置变化时其他动画被取消重施，但这种动画（通常是关键过渡）继续跑完。

**Q3：`prepareForAtomicAnimation` 为什么要预先设缩放？**
某些状态下 Workspace 不可见（alpha=0 或被遮罩盖住），从这种状态切回 NORMAL 时，若动画起点是默认 scale=1，第一帧会先显示满屏再缩小，产生跳变。预先设到 0.92 让动画从「即将出现」的状态开始，视觉上是从无到有平滑放大。

---

## 七、动画机制：PendingAnimation / PropertySetter / AnimatorPlaybackController

### 7.1 三者关系

```
                     ┌─────────────────────────────────┐
                     │     PropertySetter（抽象）        │
                     │  setFloat / setViewAlpha /       │  ← 统一接口
                     │  setInt / setColor / add         │
                     └─────────────────────────────────┘
                       ▲                          ▲
                       │                          │
          ┌────────────┴───────────┐   ┌──────────┴──────────────┐
          │  NO_ANIM_PROPERTY_SETTER│   │  PendingAnimation        │
          │  （直接 setValue）       │   │  （构造 ObjectAnimator    │
          │  无动画分支用            │   │   塞进 AnimatorSet）      │
          └────────────────────────┘   │  继承 AnimatedPropertySetter│
                                       │  buildAnim() → AnimatorSet │
                                       │  createPlaybackController()│
                                       └──────────┬────────────────┘
                                                  │
                                                  ▼
                                       ┌──────────────────────────┐
                                       │ AnimatorPlaybackController│
                                       │  wrap(AnimatorSet)        │  ← 把 AnimatorSet
                                       │  setPlayFraction(f)       │   变成可按进度控制的
                                       │  start() / reverse()      │   「进度动画」
                                       └──────────────────────────┘
```

### 7.2 PropertySetter：统一有/无动画

`PropertySetter` 是抽象类，定义设值接口。无动画实现直接 setValue：

```java
// PropertySetter.java
public static final PropertySetter NO_ANIM_PROPERTY_SETTER = new PropertySetter() {
    @Override public void add(Animator animatorSet) {
        animatorSet.setDuration(0); // 0 时长
        animatorSet.start();
        animatorSet.end();          // 立即结束（应用终值）
    }
};

// 默认实现都是直接 setValue
public <T> Animator setFloat(T target, FloatProperty<T> property, float value,
        TimeInterpolator interpolator) {
    property.setValue(target, value); // 直接设
    return NO_OP;
}
```

`AnimatedPropertySetter`（PendingAnimation 的父类）覆写为构造 ObjectAnimator：

```java
// AnimatedPropertySetter.java
@Override public <T> Animator setFloat(T target, FloatProperty<T> property, float value,
        TimeInterpolator interpolator) {
    if (property.get(target) == value) return NO_OP; // 值未变，短路
    Animator anim = ObjectAnimator.ofFloat(target, property, value); // 构造动画
    anim.setInterpolator(interpolator);
    add(anim); // 加入 AnimatorSet
    return anim;
}

protected final AnimatorSet mAnim = new AnimatorSet();

@Override public void add(Animator a) {
    mAnim.play(a); // 全部并行播放
}

public AnimatorSet buildAnim() {
    if (mProgressAnimator != null) { add(mProgressAnimator); mProgressAnimator = null; }
    return mAnim;
}
```

**设计意图**：handler 用同一份 `propertySetter.setFloat(workspace, SCALE, newScale, interpolator)` 代码，靠传入的 setter 多态自动决定是「直接设」还是「加动画」。这避免了 setState 和 setStateWithAnimation 写两遍逻辑。

### 7.3 PendingAnimation：声明式动画拼装

`PendingAnimation extends AnimatedPropertySetter`，是「动画构建器」。每个 handler 把自己负责的动画 `add` 进去，最后 `buildAnim()` 合成一个 AnimatorSet：

```java
// PendingAnimation.java
public class PendingAnimation extends AnimatedPropertySetter {

    private final ArrayList<Holder> mAnimHolders = new ArrayList<>(); // 子动画包装
    private final long mDuration;

    public PendingAnimation(long duration) {
        mDuration = duration;
    }

    @Override public void add(Animator anim) {
        add(anim, SpringProperty.DEFAULT);
    }

    public void add(Animator a, SpringProperty springProperty) {
        mAnim.play(a.setDuration(mDuration));                          // 统一时长
        addAnimationHoldersRecur(a, mDuration, springProperty, mAnimHolders); // 递归包装
    }

    public <T> void addFloat(T target, FloatProperty<T> property, float from, float to,
            TimeInterpolator interpolator) {
        Animator anim = ObjectAnimator.ofFloat(target, property, from, to);
        anim.setInterpolator(interpolator);
        add(anim);
    }

    public void addAnimatedFloat(AnimatedFloat target, float from, float to,
            TimeInterpolator interpolator) {
        // 用 AnimatedFloat 自己的 animateToValue，便于从 AnimatedFloat 侧取消
        Animator anim = target.animateToValue(from, to);
        anim.setInterpolator(interpolator);
        add(anim);
    }

    @Override public AnimatorSet buildAnim() {
        if (mAnimHolders.isEmpty()) {
            add(ValueAnimator.ofFloat(0, 1).setDuration(mDuration)); // 空动画占位，保证时长
        }
        return super.buildAnim();
    }

    public AnimatorPlaybackController createPlaybackController() {
        return new AnimatorPlaybackController(buildAnim(), mDuration, mAnimHolders);
    }
}
```

**为什么是声明式**：handler 调用 `builder.add(anim)` 时**不立即执行**，只是登记。StateManager 收集完所有 handler 的动画后，一次性 `buildAnim()` → `start()`。这允许：
1. 多个 handler 的动画并行播放（都在同一个 AnimatorSet）。
2. 中途可被 `cancelAnimation` 整体取消（一个 AnimatorSet.cancel 取消所有子动画）。
3. 可包装成 `AnimatorPlaybackController` 转为进度驱动（手势用）。

`addAnimationHoldersRecur` 递归把 AnimatorSet 拆成单个 ValueAnimator，每个用 Holder 包装，记录它在整体进度中的起止区间：

```java
// AnimatorPlaybackController.java
static class Holder {
    public final ValueAnimator anim;
    public final SpringProperty springProperty;
    public final TimeInterpolator interpolator;
    public final float globalEndProgress; // 该子动画在整体进度中的结束点（anim.duration / globalDuration）
    public ProgressMapper mapper;

    public void setProgress(float progress) {
        anim.setCurrentFraction(mapper.getProgress(progress, globalEndProgress)); // 按整体进度算子进度
    }
}
```

### 7.4 AnimatorPlaybackController：手势跟随的核心

这是最巧妙的部分。问题：用户手指拖动时，需要把「整段状态切换动画」按手指位移比例施加——既不是从头播放到尾，也不是简单的 setValue。

`AnimatorPlaybackController` 把一个 AnimatorSet 包装成「按进度施加」的控制器：

```java
// AnimatorPlaybackController.java
public class AnimatorPlaybackController implements ValueAnimator.AnimatorUpdateListener {

    private final ValueAnimator mAnimationPlayer; // 0→1 的进度驱动器
    private final long mDuration;
    private final AnimatorSet mAnim;              // 被包装的动画集
    private final Holder[] mChildAnimations;      // 拆解后的子动画
    protected float mCurrentFraction;             // 当前进度 0~1

    AnimatorPlaybackController(AnimatorSet anim, long duration, ArrayList<Holder> childAnims) {
        mAnim = anim;
        mDuration = duration;
        mAnimationPlayer = ValueAnimator.ofFloat(0, 1);            // 0→1 的线性驱动
        mAnimationPlayer.setInterpolator(LINEAR);
        mAnimationPlayer.addListener(new OnAnimationEndDispatcher());
        mAnimationPlayer.addUpdateListener(this);                  // 每帧回调 onAnimationUpdate
        mChildAnimations = childAnims.toArray(new Holder[childAnims.size()]);
    }

    @Override public void onAnimationUpdate(ValueAnimator valueAnimator) {
        setPlayFraction((float) valueAnimator.getAnimatedValue()); // 进度透传
    }

    public void setPlayFraction(float fraction) {
        mCurrentFraction = fraction;
        if (mTargetCancelled) return; // 被取消后不再施加
        float progress = boundToRange(fraction, 0, 1);
        for (Holder holder : mChildAnimations) {
            holder.setProgress(progress); // 每个子动画按整体进度算自己的子进度
        }
    }
}
```

手势调用方式：

```java
public AnimatorPlaybackController createAnimationToNewWorkspace(
        S state, StateAnimationConfig config) {
    config.animProps |= StateAnimationConfig.USER_CONTROLLED;
    cancelAnimation();
    config.copyTo(mConfig);
    mConfig.playbackController = createAnimationToNewWorkspaceInternal(state)
            .createPlaybackController(); // 不 start，只返回控制器
    return mConfig.playbackController;
}
```

返回后手势处理器（如 `AllAppsSwipeController`）在 `onDrag` 中调用：

```java
controller.setPlayFraction(dragDelta / totalDistance); // 把位移映射到 0~1 进度
```

松手时根据速度决定：

```java
controller.start();  // 正向播完（达到目标态）
controller.reverse(); // 反向播回（取消）
```

`start()` / `reverse()` 从当前进度继续：

```java
public void start() {
    mAnimationPlayer.setFloatValues(mCurrentFraction, 1); // 从当前进度到 1
    mAnimationPlayer.setDuration(clampDuration(1 - mCurrentFraction)); // 剩余时长
    mAnimationPlayer.start();
}

public void reverse() {
    mAnimationPlayer.setFloatValues(mCurrentFraction, 0); // 从当前进度回 0
    mAnimationPlayer.setDuration(clampDuration(mCurrentFraction));
    mAnimationPlayer.start();
}
```

**为什么用 AnimatorPlaybackController 而不是直接调 setValue**：
1. **复用动画定义**。手势和点击走同一个 `setStateWithAnimation` 构建的动画，只是施加方式不同（进度 vs 时间）。无需为手势写第二套属性计算。
2. **插值器保留**。子动画各自的插值器在进度施加时仍然生效（Holder 记录了 interpolator）。手势拖动到 0.5 进度时，每个子动画按自己的插值器算出当前值，视觉效果与自动播放一致。
3. **弹簧支持**。`startWithVelocity` 能在松手时把部分子动画切换成 SpringAnimation（物理弹簧），其余仍用进度动画，混合出自然的甩动效果。

### 面试深问

**Q1：PendingAnimation 的 buildAnim 为什么空时要加占位动画？**
AnimatorSet 没有子动画时 duration 为 0，立即结束。但状态切换需要「时长」来触发 `onStateTransitionStart/End` 的回调时序（start 在动画开始、end 在动画结束）。占位的 `ValueAnimator.ofFloat(0,1).setDuration(mDuration)` 保证即使没有实际属性动画，时长和回调时序仍然正确。

**Q2：AnimatorPlaybackController 的进度是如何映射到子动画的？**
每个 Holder 记录 `globalEndProgress = anim.getDuration() / globalDuration`。施加整体进度 `p` 时，默认 mapper 是 `p > globalEndProgress ? 1 : p / globalEndProgress`——子动画在自己的时间区间内线性推进。这支持子动画时长不同（某些属性动画比整体短），各自在自己的区间内跑完。

**Q3：手势跟随时为什么用 USER_CONTROLLED 标记？**
goToState 检测到正在跑的动画是 USER_CONTROLLED 时，不会取消它（见 4.3 的「已经在目标态」分支）。手势进行中用户可能触发其他 goToState（如点击），若取消手势动画会导致视觉跳变。USER_CONTROLLED 让手势动画「独占」状态机，直到手势结束或调用方主动让出。

---

## 八、典型切换流程串讲

### 8.1 NORMAL → ALL_APPS（点击 QSB 或上滑）

入口（点击搜索栏）：

```java
// Launcher.java
getStateManager().goToState(ALL_APPS, alreadyHome /* animated */);
```

执行链：

1. `goToState(ALL_APPS, true)` → `goToState(ALL_APPS, true, 0, null)`。
2. `getState()==NORMAL != ALL_APPS`，跳过「已在目标态」分支。
3. `fromState = mState (NORMAL)`，`cancelAnimation()`（无当前动画，reset 即可）。
4. `animated=true`，进入 `goToStateAnimated(ALL_APPS, NORMAL, null)`。
5. `mConfig.duration = ALL_APPS.getTransitionDuration(context, true)` = `dp.allAppsOpenDuration`。
6. `prepareForAtomicAnimation(NORMAL, ALL_APPS, mConfig)`：设置 AllApps 相关插值器（如 `ANIM_VERTICAL_PROGRESS` 用 DECELERATE）。
7. `createAnimationToNewWorkspaceInternal(ALL_APPS)`：
   - 新建 `PendingAnimation(duration)`。
   - 遍历 handlers：
     - `AllAppsTransitionController.setStateWithAnimation(ALL_APPS, config, builder)`：
       - `targetProgress = ALL_APPS.getVerticalProgress() = 0`。
       - `createSpringAnimation(mProgress(1.0), 0)` → ObjectAnimator 驱动 `ALL_APPS_PROGRESS` 从 1 到 0。
       - 设 `DECELERATE_1_7` 插值器。
       - `builder.add(anim)`。
       - `setAlphas(ALL_APPS, config, builder)`：根据 `getVisibleElements` 算出 `ALL_APPS_CONTENT` 可见，AllApps 内容 alpha→1。
       - 触发 `performHapticFeedback`（点击 QSB 的触觉）。
     - `Workspace.setStateWithAnimation(ALL_APPS, config, builder)`：
       - `setWorkspaceProperty(ALL_APPS, builder, config)`：
         - `scaleAndTranslation = ALL_APPS.getWorkspaceScaleAndTranslation()` → scale = `getWorkspaceContentScale()`（缩小）。
         - `propertySetter.setFloat(workspace, WORKSPACE_SCALE_PROPERTY, scale, ZOOM_OUT)` → PendingAnimation 构造 ObjectAnimator 加入。
         - hotseat alpha→0（`HOTSEAT_ICONS` 在 ALL_APPS 平板模式外不可见）。
         - Workspace 位移、页面 alpha 同理。
   - `builder.addListener(createStateAnimationListener(ALL_APPS))`：绑定 start/end 回调。
   - `mConfig.setAnimation(builder.buildAnim(), ALL_APPS)`。
8. `mUiHandler.post(new StartAnimRunnable(animation))`：下一帧启动。
9. 动画 start → `onStateTransitionStart(ALL_APPS)`：`mState = ALL_APPS`，同步 LauncherUiState，通知监听器。
10. 每帧：`ALL_APPS_PROGRESS` 从 1→0，`setProgress` 把容器上移（`shiftRange * progress`），Workspace 缩小、hotseat 淡出。
11. 动画 end → `onStateTransitionEnd(ALL_APPS)`：`mLastStableState = NORMAL`（ALL_APPS.getHistoryForState 返回 NORMAL），`mCurrentStableState = ALL_APPS`。

### 8.2 NORMAL → SPRING_LOADED（长按图标）

长按触发拖拽，进入编辑态：

```java
// Launcher.java（拖拽开始时）
mStateManager.goToState(SPRING_LOADED);
```

执行链：

1. `goToState(SPRING_LOADED, shouldAnimateStateChange())`。
2. `fromState = NORMAL`，`cancelAnimation()`。
3. `goToStateAnimated(SPRING_LOADED, NORMAL, null)`。
4. `mConfig.duration = SPRING_LOADED.getTransitionDuration(context, true)` = `150`。
5. `prepareForAtomicAnimation(NORMAL, SPRING_LOADED, mConfig)`。
6. 构建 PendingAnimation：
   - `AllAppsTransitionController.setStateWithAnimation`：`targetProgress = SPRING_LOADED.getVerticalProgress() = 1`（与当前相同），`Float.compare(mProgress, targetProgress)==0` → 只 `setAlphas`，fail fast。
   - `Workspace.setStateWithAnimation(SPRING_LOADED, config, builder)`：
     - `scaleAndTranslation = SPRING_LOADED.getWorkspaceScaleAndTranslation()` → scale = springLoadScale，translationY = shrunkTop - actualCellTop（上移）。
     - Workspace 缩放动画 + 位移动画加入 builder。
     - `FLAG_MULTI_PAGE` → `mForceDrawAdjacentPages = true`（相邻页可见，方便跨页拖拽）。
     - 页面背景 alpha = 0.2（`FLAG_WORKSPACE_HAS_BACKGROUNDS`）。
7. 动画 start → `mState = SPRING_LOADED`。
8. 150ms 后 end → `mCurrentStableState = SPRING_LOADED`，`mLastStableState = NORMAL`。

### 8.3 SPRING_LOADED → NORMAL（取消编辑）

松手未拖到有效位置，或按返回键：

```java
// Launcher.java（拖拽取消）
() -> mStateManager.goToState(NORMAL, SPRING_LOADED_EXIT_DELAY);
```

执行链：

1. `goToState(NORMAL, true, SPRING_LOADED_EXIT_DELAY, null)`。
2. `getState()==SPRING_LOADED != NORMAL`。
3. `fromState = SPRING_LOADED`，`cancelAnimation()`。
4. `animated=true`，`delay>0`：
   - `startChangeId = mConfig.changeId`。
   - `mUiHandler.postDelayed(() -> { if (mConfig.changeId == startChangeId) goToStateAnimated(...); }, SPRING_LOADED_EXIT_DELAY)`。
5. 延迟后 `goToStateAnimated(NORMAL, SPRING_LOADED, null)`。
6. **关键**：`state == mBaseState (NORMAL)`，所以 `mConfig.duration = fromState.getTransitionDuration(context, false)` = `SPRING_LOADED.getTransitionDuration(..., false)` = 150（用来源态时长）。
7. 构建 PendingAnimation：Workspace 缩放回 1、位移回 0、hotseat alpha 回 1。
8. 动画 end → `mCurrentStableState = NORMAL`。因为 `state == mBaseState`，`setRestState(null)`。

### 面试深问

**Q1：NORMAL→ALL_APPS 时 AllApps 和 Workspace 的动画为什么能并行？**
两者都把动画 `add` 进同一个 PendingAnimation，最终 `buildAnim()` 返回一个 AnimatorSet，里面包含 AllApps 的 progress 动画 + Workspace 的 scale/translate/alpha 动画。AnimatorSet 默认并行播放所有子动画，所以 150ms 内 AllApps 上滑和 Workspace 缩小同时进行，视觉上是一个连贯的「桌面下沉、抽屉升起」。

**Q2：SPRING_LOADED 进入时 AllApps handler 为什么 fail fast？**
`SPRING_LOADED.getVerticalProgress() = 1`，与 NORMAL 相同（AllApps 收起）。`setStateWithAnimation` 检测到 `mProgress == targetProgress`，只更新 alpha 不加 progress 动画。避免无意义的「从 1 到 1」动画，但仍要让 alpha 逻辑跑（某些元素显隐可能变）。

**Q3：返回 NORMAL 时为什么用来源态的 duration 而不是 NORMAL 自己的？**
NORMAL 的 `getTransitionDuration` 返回 0（匿名子类覆写）。如果用 0，动画瞬间结束，视觉突兀。StateManager 在 `goToStateAnimated` 里特判 `state == mBaseState` 时改用 `fromState.getTransitionDuration(context, false)`——「从哪来回哪」用来源态的时长，保证往返时长对称（进 AllApps 200ms，出 AllApps 也 200ms）。

---

## 九、补充机制

### 9.1 StatefulContainer / StatefulActivity：容器契约

`StatefulContainer` 是接口，定义容器必须实现的能力：

```java
public interface StatefulContainer<STATE_TYPE extends BaseState<STATE_TYPE>> extends ActivityContext {
    // 创建原子动画工厂（默认空实现，0 个共享元素动画）
    default StateManager.AtomicAnimationFactory<STATE_TYPE> createAtomicAnimationFactory() {
        return new StateManager.AtomicAnimationFactory<>(0);
    }

    // 提供 state handlers
    void collectStateHandlers(List<StateManager.StateHandler<STATE_TYPE>> out);

    // 拿到 state manager
    StateManager<STATE_TYPE, ?> getStateManager();

    // 状态切换开始/结束/重复中止的钩子
    default void onStateSetEnd(STATE_TYPE state) {}
    default void onRepeatStateSetAborted(STATE_TYPE state) {}

    @CallSuper default void onStateSetStart(STATE_TYPE state) {
        if (state.hasFlag(FLAG_CLOSE_POPUPS)) {                       // 自动关浮层
            AbstractFloatingView.closeAllOpenViews(this, !state.hasFlag(FLAG_NON_INTERACTIVE));
        }
    }

    default boolean isInState(STATE_TYPE state) {
        return getStateManager().getState() == state;
    }

    boolean shouldAnimateStateChange();
}
```

`StatefulActivity` 是抽象 Activity，实现 `StatefulContainer`，处理生命周期与状态机的联动：

```java
// StatefulActivity.java
@Override public boolean shouldAnimateStateChange() {
    return !isForceInvisible() && isStarted(); // Activity 未启动或强制不可见时不动画
}

@Override public void reapplyUi() {
    getRootView().dispatchInsets();
    getStateManager().reapplyState(true /* cancelCurrentAnimation */); // inset 变化重施状态
}

@Override protected void onStop() {
    ...
    if (!isChangingConfigurations()) getStateManager().moveToRestState(); // onStop 归位
    onTrimMemory(TRIM_MEMORY_UI_HIDDEN);
    ...
}
```

### 9.2 AtomicAnimationFactory：原子动画与共享元素

`AtomicAnimationFactory` 管理两类东西：

1. **`prepareForAtomicAnimation`**：在动画创建前配置插值器和预备值（由 QuickstepAtomicAnimationFactory 覆写）。
2. **`mStateElementAnimators`**：共享元素动画数组。某些动画既独立运行又可能是状态切换的一部分（如 hotseat 的弹出），用 `createStateElementAnimation(index, values)` 创建并登记，`cancelAllStateElementAnimation` 统一取消。

```java
public static class AtomicAnimationFactory<STATE_TYPE> {
    protected static final int NEXT_INDEX = 0;
    private final Animator[] mStateElementAnimators; // 按 index 存

    public AtomicAnimationFactory(int sharedElementAnimCount) {
        mStateElementAnimators = new Animator[sharedElementAnimCount];
    }

    void cancelAllStateElementAnimation() {
        for (Animator animator : mStateElementAnimators) {
            if (animator != null) animator.cancel();
        }
    }

    public Animator createStateElementAnimation(int index, float... values) {
        throw new RuntimeException("Unknown gesture animation " + index); // 子类覆写
    }

    public void prepareForAtomicAnimation(
            STATE_TYPE fromState, STATE_TYPE toState, StateAnimationConfig config) { }
}
```

### 9.3 监听器：StateListener

```java
public interface StateListener<STATE_TYPE> {
    default void onStateTransitionStart(STATE_TYPE toState) {}
    default void onStateTransitionComplete(STATE_TYPE finalState) {}
}
```

外部代码通过 `addStateListener` / `removeStateListener` 订阅状态切换。`onStateTransitionStart` 在动画开始（或无动画施加）时触发，`onStateTransitionComplete` 在动画成功结束（取消不触发）时触发。监听器列表在 start/end 时倒序遍历（允许遍历中移除）。

### 9.4 预测式返回（Predictive Back）

Android 14+ 的预测式返回手势要求应用能在用户滑动过程中实时预览返回效果。StateManager 提供：

```java
public void onBackStarted(S toState) {
    for (StateHandler<S> handler : getStateHandlers()) handler.onBackStarted(toState);
}

public void onBackProgressed(S toState, float backProgress) {
    for (StateHandler<S> handler : getStateHandlers()) handler.onBackProgressed(toState, backProgress);
}

public void onBackCancelled(S toState) {
    for (StateHandler<S> handler : getStateHandlers()) handler.onBackCancelled(toState);
}
```

LauncherState 把这些透传给 StateManager：

```java
// LauncherState.java
public void onBackProgressed(Launcher launcher, float backProgress) {
    StateManager<LauncherState, Launcher> lsm = launcher.getStateManager();
    LauncherState toState = lsm.getLastState(); // 返回目标 = 上一个稳定态
    lsm.onBackProgressed(toState, backProgress);
}
```

handler 实现按进度施加效果，例如 AllAppsTransitionController 的预测式缩放：

```java
// AllAppsTransitionController.java
@Override public void onBackProgressed(LauncherState toState, float backProgress) {
    if (!mLauncher.isInState(ALL_APPS) || !NORMAL.equals(toState)) return;
    float scaleProgress = PREDICTIVE_BACK_MIN_SCALE
            + (1 - PREDICTIVE_BACK_MIN_SCALE) * (1 - backProgress); // 进度越大缩越小
    mAllAppScale.updateValue(scaleProgress);
}
```

### 面试深问

**Q1：`onStateSetStart` 里自动关浮层的设计意图？**
状态带 `FLAG_CLOSE_POPUPS`（如 ALL_APPS、OVERVIEW）意味着进入一个「主场景」，此时残留的浮层（文件夹、菜单、widget picker）会遮挡。`StatefulContainer.onStateSetStart` 用 `@CallSuper` 强制所有实现都执行关浮层逻辑，避免子类遗忘。`FLAG_NON_INTERACTIVE` 状态则不关（无动画关闭避免突兀）。

**Q2：`shouldAnimateStateChange` 为什么在 Activity 未 started 时返回 false？**
onCreate / onResume 期间触发的状态切换（如从 savedState 恢复）此时界面还没显示，动画无意义且可能因 View 未 measure 而异常。返回 false 让 `goToState` 走无动画分支，直接 setState。`moveToRestState` 也用它判断是否动画归位。

**Q3：预测式返回为什么用 handler 的 onBackProgressed 而不是 AnimatorPlaybackController？**
预测式返回需要的是「按手势进度施加局部效果」（如 AllApps 缩放），不是完整的状态切换动画。handler 的 onBackProgressed 可以只施加自己关心的属性，不触发完整 PendingAnimation 构建。松手提交（`onBackInvoked`）时才走完整 goToState 动画，分工清晰。
