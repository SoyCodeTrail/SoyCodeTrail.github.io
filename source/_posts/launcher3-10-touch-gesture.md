---
title: Launcher3 源码精读（10）：触摸与手势
category: client
platform: android
tags: ["AOSP", "Launcher3", "源码", "Framework", "Touch", "Gesture"]
readTime: 18分钟
featured: true
date: 2026-08-02
---

Launcher3 的触摸系统由两层骨架撑起：顶层 `BaseDragLayer` 用一条 `TouchController` 责任链拦截与路由事件，下层每个 `TouchController` 拿到事件后再交给 `SingleAxisSwipeDetector` / `BothAxesSwipeDetector` 这类手势识别器做"够不够 slop、是不是 fling"的判定。所有状态切换（NORMAL↔ALL_APPS、NORMAL↔OVERVIEW）都走 `AbstractStateChangeTouchController` 这一个模板方法，把"手指位移 px"线性映射成"状态动画进度 0~1"，松手时按 fling 阈值和过线阈值二选一决定落点。

这套设计的精髓在于**职责切分**：拦截/分发与"是不是手势"完全解耦——`BaseDragLayer` 只管"按顺序问哪个 Controller 接"，Detector 只管"算位移与速度"，Controller 只管"位移→动画进度"，最终落点交给 `LauncherStateManager` 收尾。文档按这条链路从外向内铺开。

---

## 一、触摸事件分发总览

Launcher3 的根 View 是 `DragLayer`，继承自 `BaseDragLayer<Launcher>`。所有原始 `MotionEvent` 先进入 `BaseDragLayer.dispatchTouchEvent`，再决定是否在 `onInterceptTouchEvent` 里被某个 Controller 抢走。一旦被抢，子 View（Workspace、AllAppsContainerView）就拿不到后续 MOVE/UP 了。

整条链路的关键字段集中在 `BaseDragLayer`：

```java
// BaseDragLayer.java
protected TouchController[] mControllers;          // 当前注册的所有控制器，按顺序遍历
protected TouchController mActiveController;       // 当前手势的接管者，一次手势只会有一个
protected TouchController mProxyTouchController;   // 来自系统手势区域的代理控制器
```

`mControllers` 由容器自己决定：

```java
// Launcher.java（go/三键版基线）
public TouchController[] createTouchControllers() {
    return new TouchController[] {getDragController(), new AllAppsSwipeController(this)};
}
```

```java
// QuickstepLauncher.java（全屏手势机型）
public TouchController[] createTouchControllers() {
    NavigationMode mode = DisplayController.getNavigationMode(this);
    ArrayList<TouchController> list = new ArrayList<>();
    list.add(getDragController());                 // 拖拽控制器永远第一个
    switch (mode) {
        case NO_BUTTON:                            // 全屏手势
            list.add(new NoButtonQuickSwitchTouchController(this));
            list.add(new NavBarToHomeTouchController(this, splitAnimator));
            list.add(new NoButtonNavbarToOverviewTouchController(this, splitAnimator));
            break;
        case TWO_BUTTONS:                          // 两键机型
            list.add(new TwoButtonNavbarTouchController(this));
            // ...略
            break;
        // THREE_BUTTONS 走 Launcher 基线那条
    }
    return list.toArray(new TouchController[0]);
}
```

设计意图：把"哪些手势可用"和"Launcher 主流程"解耦——三键、两键、全屏手势三种 NavigationMode 各自拼装自己的 Controller 数组，互不污染。这就是责任链的价值——单个 Controller 不需要知道全局状态，它只回答"这事件我接不接"。

### 面试深问

**Q1：为什么用数组按顺序问，而不是让每个 Controller 注册自己感兴趣的事件类型？**
顺序问保证一次手势只会被一个 Controller 接管，避免两个 Controller 同时改动画进度造成抖动。注册式需要解决冲突仲裁，复杂度高且容易出 bug。

**Q2：`mActiveController` 为什么是字段而不是局部变量？**
因为 `onInterceptTouchEvent`（DOWN 时确定）和 `onTouchEvent`（MOVE/UP 时消费）是两次独立回调，必须跨调用记住"这次手势归谁"。

**Q3：`getDragController()` 为什么永远排第一？**
拖拽是用户已明确按住某个 Item 的强意图，优先级最高。如果让翻页控制器先判，拖拽过程中的轻微位移会被误判成翻页。

---

## 二、TouchController 责任链：BaseDragLayer 的拦截与分发

`TouchController` 只有两个方法，极其克制：

```java
// TouchController.java
public interface TouchController {
    boolean onControllerTouchEvent(MotionEvent ev);            // 消费事件
    boolean onControllerInterceptTouchEvent(MotionEvent ev);   // 是否接管
    default String dump() { ... }                              // 调试用
    default void onTouchControllerDestroyed() { }              // recreate 时回调
}
```

`BaseDragLayer` 的两个核心入口：

```java
// BaseDragLayer.java
@Override
public boolean onInterceptTouchEvent(MotionEvent ev) {
    int action = ev.getAction();
    if (action == ACTION_UP || action == ACTION_CANCEL) {
        if (mTouchCompleteListener != null) mTouchCompleteListener.onTouchComplete();
        mTouchCompleteListener = null;
    } else if (action == MotionEvent.ACTION_DOWN) {
        mContainer.finishAutoCancelActionMode();               // DOWN 时关掉 ActionMode
    }
    return findActiveController(ev);                            // 找到接管者就拦截
}

private TouchController findControllerToHandleTouch(MotionEvent ev) {
    // 第一步：浮层（Folder/Popup/WidgetSheet）优先，但仅在系统手势区域内
    AbstractFloatingView topView = AbstractFloatingView.getTopOpenView(mContainer);
    if (topView != null
            && (isEventWithinSystemGestureRegion(ev)
                || topView.canInterceptEventsInSystemGestureRegion())
            && topView.onControllerInterceptTouchEvent(ev)) {
        return topView;
    }
    // 第二步：按数组顺序问每个 Controller
    for (TouchController controller : mControllers) {
        if (controller.onControllerInterceptTouchEvent(ev)) {
            return controller;
        }
    }
    return null;
}
```

被拦截后，后续 MOVE/UP 不再走 `onInterceptTouchEvent`，直接进 `onTouchEvent`：

```java
// BaseDragLayer.java
@Override
public boolean onTouchEvent(MotionEvent ev) {
    int action = ev.getAction();
    if (action == ACTION_UP || action == ACTION_CANCEL) {
        if (mTouchCompleteListener != null) mTouchCompleteListener.onTouchComplete();
        mTouchCompleteListener = null;
    }
    if (mActiveController != null && ev.getAction() != ACTION_OUTSIDE) {
        // 正常路径：交给已经选中的 Controller
        return mActiveController.onControllerTouchEvent(ev);
    } else {
        // 没拦截过（子 View 没消费），补救式再找一次
        return findActiveController(ev);
    }
}
```

注意 `ACTION_OUTSIDE` 的特殊处理——它是从屏幕外（系统手势区域）来的事件，`onInterceptTouchEvent` 收不到，所以要在 `onTouchEvent` 里再 `findActiveController` 一次。

设计意图：**两阶段提问**。DOWN 时一次性确定接管者，避免每次 MOVE 都遍历整个数组（性能）；同时保留"补救式查找"兜底边缘 case（`ACTION_OUTSIDE`、子 View 不消费）。

### 面试深问

**Q1：浮层为什么优先于普通 Controller？**
Folder、WidgetPicker 这类浮层是模态 UI，用户点在外面期望关闭它而不是触发底层翻页。把浮层放前面，让"点外关闭"自然成立。

**Q2：`findControllerToHandleTouch` 会被多次调用吗？**
DOWN 时调一次定 `mActiveController`。如果子 View 完全没消费（`onTouchEvent` 返回 false），`onTouchEvent` 里会再调一次兜底。

**Q3：为什么 `canFindActiveController` 要屏蔽 Proxy 分发？**
当事件来自系统手势代理（`proxyTouchEvent`）时，主链路不应再抢，否则两套分发会打架。用 `mTouchDispatchState` 位标志隔离两条通道。

---

## 三、BaseSwipeDetector 与状态机：IDLE/DRAGGING/SETTLING

所有滑动手势识别器（`SingleAxisSwipeDetector`、`BothAxesSwipeDetector`）都继承自 `BaseSwipeDetector`。它定义了三个状态的小型状态机：

```java
// BaseSwipeDetector.java
private enum ScrollState {
    IDLE,
    DRAGGING,      // 已超过 slop，回调 onDragStart / onDrag
    SETTLING       // 用户松手，动画正在 settle
}

// 状态迁移注释（源码原话）：
// IDLE -> (mDisplacement > mTouchSlop) -> DRAGGING
// DRAGGING -> (ACTION_UP / ACTION_CANCEL) -> SETTLING
// SETTLING -> (ACTION_DOWN) -> DRAGGING       // 用户在 settle 中途又按住，"接住"动画
// SETTLING -> (View settled) -> IDLE
```

关键阈值与字段：

```java
// BaseSwipeDetector.java
private static final float ANIMATION_DURATION = 1200;          // settle 时长计算的基准常量
protected final float mTouchSlop;                              // = ViewConfiguration.getScaledTouchSlop()
protected final float mMaxVelocity;                            // 最大 fling 速度上限
private final float mReleaseVelocity;                          // 判定 fling 的最小释放速度，来自 R.dimen.base_swift_detector_fling_release_velocity
```

`onTouchEvent` 是状态机的总驱动：

```java
// BaseSwipeDetector.java
public boolean onTouchEvent(MotionEvent ev) {
    int actionMasked = ev.getActionMasked();
    if (actionMasked == MotionEvent.ACTION_DOWN && mVelocityTracker != null) {
        mVelocityTracker.clear();                              // DOWN 时清速度
    }
    if (mVelocityTracker == null) mVelocityTracker = VelocityTracker.obtain();
    mVelocityTracker.addMovement(ev);

    switch (actionMasked) {
        case MotionEvent.ACTION_DOWN:
            mActivePointerId = ev.getPointerId(0);
            mDownPos.set(ev.getX(), ev.getY());                // 记下按下点
            mLastPos.set(mDownPos);
            mDisplacement.set(0, 0);
            mIsTrackpadGesture = isTrackpadMotionEvent(ev);    // 触控板识别
            if (mState == ScrollState.SETTLING && mIgnoreSlopWhenSettling) {
                setState(ScrollState.DRAGGING);                // settle 中途按下，跳过 slop
            }
            break;
        case MotionEvent.ACTION_POINTER_UP:                    // 多指抬起，换主指
            int ptrIdx = ev.getActionIndex();
            int ptrId = ev.getPointerId(ptrIdx);
            if (ptrId == mActivePointerId) {
                final int newPointerIdx = ptrIdx == 0 ? 1 : 0;
                // 平移按下点，使位移连续不跳变
                mDownPos.set(ev.getX(newPointerIdx) - (mLastPos.x - mDownPos.x),
                             ev.getY(newPointerIdx) - (mLastPos.y - mDownPos.y));
                mLastPos.set(ev.getX(newPointerIdx), ev.getY(newPointerIdx));
                mActivePointerId = ev.getPointerId(newPointerIdx);
            }
            break;
        case MotionEvent.ACTION_MOVE:
            int pointerIndex = ev.findPointerIndex(mActivePointerId);
            if (pointerIndex == INVALID_POINTER_ID) break;
            mDisplacement.set(ev.getX(pointerIndex) - mDownPos.x,
                              ev.getY(pointerIndex) - mDownPos.y);
            if (mIsRtl) mDisplacement.x = -mDisplacement.x;    // RTL 下水平翻转
            if (mState != ScrollState.DRAGGING && shouldScrollStart(mDisplacement)) {
                setState(ScrollState.DRAGGING);                // 达标进 DRAGGING
            }
            if (mState == ScrollState.DRAGGING) {
                reportDragging(ev);                             // 回调 onDrag
            }
            mLastPos.set(ev.getX(pointerIndex), ev.getY(pointerIndex));
            break;
        case MotionEvent.ACTION_CANCEL:
        case MotionEvent.ACTION_UP:
            if (mState == ScrollState.DRAGGING) setState(ScrollState.SETTLING);
            mVelocityTracker.recycle();
            mVelocityTracker = null;
            break;
    }
    return true;
}
```

状态切换在 `setState`：

```java
// BaseSwipeDetector.java
private void setState(ScrollState newState) {
    if (mIsSettingState) {                                     // 防重入
        mSetStateQueue.add(() -> setState(newState));
        return;
    }
    mIsSettingState = true;
    // 仅在状态迁移时回调
    if (newState == ScrollState.DRAGGING) {
        initializeDragging();                                  // 计算减去 slop 的初始位移
        if (mState == ScrollState.IDLE) reportDragStart(false /* recatch */);
        else if (mState == ScrollState.SETTLING) reportDragStart(true /* recatch */);
    }
    if (newState == ScrollState.SETTLING) reportDragEnd();     // UP 时回调 onDragEnd
    mState = newState;
    mIsSettingState = false;
    if (!mSetStateQueue.isEmpty()) mSetStateQueue.remove().run();
}
```

设计意图：**`recatch` 参数**区分"全新手势"和"settle 中途被接住"。前者从 0 进度开始，后者沿用当前动画进度——这就是 Launcher 滑 AllApps 时松手又迅速按住能"接住"动画的根因。

fling 判定极简：

```java
// BaseSwipeDetector.java
public boolean isFling(float velocity) {
    return Math.abs(velocity) > mReleaseVelocity;              // 超过释放速度阈值就算 fling
}
```

settle 时长公式（用户感受的关键）：

```java
// BaseSwipeDetector.java
public static long calculateDuration(float velocity, float progressNeeded) {
    float velocityDivisor = Math.max(2f, Math.abs(0.5f * velocity));   // 速度越快，时长越短
    float travelDistance = Math.max(0.2f, progressNeeded);             // 至少 0.2 的进度
    long duration = (long) Math.max(100, ANIMATION_DURATION / velocityDivisor * travelDistance);
    return duration;
}
```

`velocity` 是手指释放速度，`progressNeeded` 是"从当前进度到目标进度还差多少"。两者乘除后给出一个 100ms~1200ms 之间的合理动画时长。

### 面试深问

**Q1：为什么 `setState` 要防重入（`mIsSettingState`）？**
`onDragStart` 回调里 Controller 可能反过来调 Detector 的方法（比如 `finishedScrolling`），形成递归。用队列化保证状态严格串行。

**Q2：`initializeDragging` 里减去 `mTouchSlop` 是干什么？**
`slop` 是"识别手势用"的判定距离，但用户希望手指动了多少 Workspace 就跟多少。所以在进入 DRAGGING 那一刻，把已经消耗的 slop 从位移里减掉，让"视觉跟随"和"手指位置"对齐。

**Q3：多指切换时为什么要平移 `mDownPos`？**
新指头的坐标和原按下点不同，如果直接用会导致位移突变。把 `mDownPos` 平移到"假设新指头从一开始就按下"的位置，保证 `mDisplacement` 连续。

---

## 四、SingleAxisSwipeDetector：单轴滑动的角度与方向判定

`SingleAxisSwipeDetector` 把"二维位移"压缩成"一维位移"，让上层 Controller 只关心一个数字。核心是 `Direction` 抽象：

```java
// SingleAxisSwipeDetector.java
public static final int DIRECTION_POSITIVE = 1 << 0;   // 正方向
public static final int DIRECTION_NEGATIVE = 1 << 1;   // 负方向
public static final int DIRECTION_BOTH = DIRECTION_NEGATIVE | DIRECTION_POSITIVE;

public static final Direction VERTICAL = new Direction() {
    @Override
    boolean isPositive(float displacement) { return displacement < 0; }   // 屏幕坐标 Y 向下为正，"上滑"位移是负值，记为 positive
    @Override
    boolean isNegative(float displacement) { return displacement > 0; }   // 下滑
    @Override
    float extractDirection(PointF direction) { return direction.y; }
    @Override
    float extractOrthogonalDirection(PointF direction) { return direction.x; }   // 正交分量用于角度判定
};

public static final Direction HORIZONTAL = new Direction() {
    @Override
    boolean isPositive(float displacement) { return displacement > 0; }   // 向右
    @Override
    boolean isNegative(float displacement) { return displacement < 0; }   // 向左
    @Override
    float extractDirection(PointF direction) { return direction.x; }
    @Override
    float extractOrthogonalDirection(PointF direction) { return direction.y; }
};
```

`shouldScrollStart` 是"够不够格开始滑动"的核心判定，做两件事：**角度过滤**和**方向过滤**。

```java
// SingleAxisSwipeDetector.java
@Override
protected boolean shouldScrollStart(PointF displacement) {
    // 角度过滤：主轴位移必须 ≥ max(slop, 正交位移)
    // 这就保证"明显斜着划"时不会误触发单轴滑动
    float minDisplacement = Math.max(mTouchSlop * mTouchSlopMultiplier,
            Math.abs(mDir.extractOrthogonalDirection(displacement)));
    if (Math.abs(mDir.extractDirection(displacement)) < minDisplacement) {
        return false;
    }
    // 方向过滤：客户只关心某个方向的滑动
    float displacementComponent = mDir.extractDirection(displacement);
    return canScrollNegative(displacementComponent) || canScrollPositive(displacementComponent);
}

private boolean canScrollNegative(float displacement) {
    return (mScrollDirections & DIRECTION_NEGATIVE) > 0 && mDir.isNegative(displacement);
}
private boolean canScrollPositive(float displacement) {
    return (mScrollDirections & DIRECTION_POSITIVE) > 0 && mDir.isPositive(displacement);
}
```

`mTouchSlopMultiplier` 是窗口变小（比如分屏）时的补偿：

```java
// SingleAxisSwipeDetector.java
public void setTouchSlopMultiplier(float touchSlopMultiplier) {
    mTouchSlopMultiplier = touchSlopMultiplier;
}
```

设计意图：**为什么专门做一个 Detector 而不是用系统 `GestureDetector`？**
- 系统 `GestureDetector` 的 `onScroll` 不区分轴、不暴露 slop 阶段，无法做"角度过滤"。
- Launcher 需要"X/Y 谁先达标谁接管"的精细控制，自研 Detector 能拿到原始 `mDisplacement`。
- 自研能精确控制 settle 中途的 recatch 行为，系统 Detector 做不到。

回调契约干净：

```java
// SingleAxisSwipeDetector.java
public interface Listener {
    void onDragStart(boolean start, float startDisplacement);
    boolean onDrag(float displacement);                                       // 简化版
    default boolean onDrag(float displacement, MotionEvent event) {           // 带事件
        return onDrag(displacement);
    }
    default boolean onDrag(float displacement, float orthogonalDisplacement, MotionEvent ev) {
        return onDrag(displacement, ev);
    }
    void onDragEnd(float velocity);
}
```

### 面试深问

**Q1：为什么 VERTICAL 的 `isPositive` 是 `displacement < 0`？**
屏幕坐标系 Y 向下为正。用户"上滑"手指实际位移是负的（往屏幕上方走），但语义上"上滑打开 AllApps"是 positive 方向。这是约定俗成的"语义正方向"，方便上层写业务。

**Q2：`minDisplacement = max(slop, |正交分量|)` 这个公式解决什么？**
假设 slop=24px，用户斜 45° 划 30px，主轴和正交都是 21px——主轴没过 slop，但斜得厉害。公式要求主轴必须 ≥ 正交分量，逼用户划得"够直"才算单轴手势。

**Q3：`setDetectableScrollConditions(0, false)` 把方向设为 0 是什么效果？**
任何方向都不会触发 `shouldScrollStart` 返回 true，等于临时禁用这个 Detector。Controller 用它在动画期间冻结手势。

---

## 五、AbstractStateChangeTouchController：状态切换骨架

`AbstractStateChangeTouchController` 是所有"滑一下进/出某个状态"的 Controller 的模板基类。它实现了 `SingleAxisSwipeDetector.Listener`，把 Detector 的位移回调翻译成状态动画进度。

关键字段：

```java
// AbstractStateChangeTouchController.java
protected final Launcher mLauncher;
protected final SingleAxisSwipeDetector mDetector;             // 内嵌的滑动检测器
protected final SingleAxisSwipeDetector.Direction mSwipeDirection;

protected LauncherState mStartState;                            // 手势开始时的状态
protected LauncherState mFromState;                             // 动画起点状态
protected LauncherState mToState;                               // 动画终点状态
protected AnimatorPlaybackController mCurrentAnimation;        // 当前驱动的那条动画
protected float mProgressMultiplier;                            // 位移 px → 进度的换算系数
private boolean mNoIntercept;                                   // 本次手势是否放弃拦截
private float mStartProgress;                                   // recatch 时的起点进度
private float mDisplacementShift;                               // 方向反转时的位移修正
private boolean mCanBlockFling;                                 // 是否允许"反向阻断 fling"
```

拦截入口：

```java
// AbstractStateChangeTouchController.java
@Override
public boolean onControllerInterceptTouchEvent(MotionEvent ev) {
    if (ev.getAction() == MotionEvent.ACTION_DOWN) {
        mNoIntercept = !canInterceptTouch(ev);                 // 子类决定能否接
        if (mNoIntercept) return false;

        mIsTrackpadReverseScroll = !mLauncher.isNaturalScrollingEnabled()
                && isTrackpadScroll(ev);                        // 触控板反向滚动

        final int directionsToDetectScroll;
        boolean ignoreSlopWhenSettling = false;
        if (mCurrentAnimation != null) {
            // 正在 settle 中，允许双向接，跳过 slop
            directionsToDetectScroll = SingleAxisSwipeDetector.DIRECTION_BOTH;
            ignoreSlopWhenSettling = true;
        } else {
            directionsToDetectScroll = getSwipeDirection();    // 根据当前状态算可滑方向
            // 鼠标滚动、桌面后方显示等场景直接放弃
            if (directionsToDetectScroll == 0 || ignoreMouseScroll || ignoreWhenShownBehindDesktop) {
                mNoIntercept = true;
                return false;
            }
        }
        mDetector.setDetectableScrollConditions(directionsToDetectScroll, ignoreSlopWhenSettling);
    }
    if (mNoIntercept) return false;

    onControllerTouchEvent(ev);                                 // 喂给 Detector
    return mDetector.isDraggingOrSettling();                    // Detector 进 DRAGGING/SETTLING 才算接管
}
```

`getSwipeDirection` 根据"从当前状态往正/负方向划有没有目标状态"动态决定可滑方向：

```java
// AbstractStateChangeTouchController.java
private int getSwipeDirection() {
    LauncherState fromState = mLauncher.getStateManager().getState();
    int swipeDirection = 0;
    if (getTargetState(fromState, true /* isDragTowardPositive */) != fromState) {
        swipeDirection |= SingleAxisSwipeDetector.DIRECTION_POSITIVE;
    }
    if (getTargetState(fromState, false /* isDragTowardPositive */) != fromState) {
        swipeDirection |= SingleAxisSwipeDetector.DIRECTION_NEGATIVE;
    }
    return swipeDirection;
}
```

`onDragStart` 在手势开始时初始化动画：

```java
// AbstractStateChangeTouchController.java
@Override
public void onDragStart(boolean start, float startDisplacement) {
    mStartState = mLauncher.getStateManager().getState();
    mIsLogContainerSet = false;

    if (mCurrentAnimation == null) {
        // 全新手势：建一条 fromState → toState 的动画
        mFromState = mStartState;
        mToState = null;
        cancelAnimationControllers();
        reinitCurrentAnimation(false, mDetector.wasInitialTouchPositive());
        mDisplacementShift = 0;
    } else {
        // recatch：暂停动画，记下当前进度
        mCurrentAnimation.pause();
        mStartProgress = mCurrentAnimation.getProgressFraction();
    }
    mCanBlockFling = mFromState == NORMAL;                      // 从 NORMAL 出发允许 block fling
    mFlingBlockCheck.unblockFling();
}
```

`onDrag` 把位移翻译成进度：

```java
// AbstractStateChangeTouchController.java
@Override
public boolean onDrag(float displacement) {
    float deltaProgress = mProgressMultiplier * (displacement - mDisplacementShift);
    float progress = deltaProgress + mStartProgress;
    updateProgress(progress);                                   // 设置动画播放进度

    boolean isDragTowardPositive = mSwipeDirection.isPositive(displacement - mDisplacementShift);
    if (progress <= 0) {
        // 拉过头了（比如在 NORMAL 往下划），重新初始化成反方向动画
        if (reinitCurrentAnimation(false, isDragTowardPositive)) {
            mDisplacementShift = displacement;
            if (mCanBlockFling) mFlingBlockCheck.blockFling();
        }
        if (mFromState == LauncherState.ALL_APPS) {
            mAllAppsOvershootStarted = true;
            mLauncher.getAppsView().onPull(-progress, -progress);   // Overscroll 拉伸
        }
    } else if (progress >= 1) {
        // 推过头了（比如在 ALL_APPS 顶部继续上划）
        if (reinitCurrentAnimation(true, isDragTowardPositive)) {
            mDisplacementShift = displacement;
            if (mCanBlockFling) mFlingBlockCheck.blockFling();
        }
        if (mToState == LauncherState.ALL_APPS) {
            mAllAppsOvershootStarted = true;
            mLauncher.getAppsView().onPull(progress - 1f, progress - 1f);
        }
    } else {
        mFlingBlockCheck.onEvent();                             // 正常区间，喂给 fling 阻断检测
    }
    return true;
}
```

设计意图：**`reinitCurrentAnimation` 实现"中途换方向"**。用户从 NORMAL 上划到一半又往下划回来，进度会从正变负，触发 `reinit` 把 from/to 对调，动画连续不跳变。这是状态机式动画的关键技巧。

`onDragEnd` 决定落点，是整个手势系统最复杂的方法：

```java
// AbstractStateChangeTouchController.java
@Override
public void onDragEnd(float velocity) {
    if (mCurrentAnimation == null) return;                      // 已被取消

    if (mIsTrackpadReverseScroll && mStartState == NORMAL) velocity = -velocity;
    boolean fling = mDetector.isFling(velocity);
    boolean blockedFling = fling && mFlingBlockCheck.isBlocked();
    if (blockedFling) fling = false;                            // 被 block 的 fling 当普通松手处理

    final LauncherState targetState;
    final float progress = mCurrentAnimation.getProgressFraction();
    final float progressVelocity = velocity * mProgressMultiplier;
    final float interpolatedProgress = mCurrentAnimation.getInterpolatedProgress();
    if (fling) {
        // fling：速度方向决定落点（速度和进度系数同号 → 去 toState，否则去 fromState）
        targetState = Float.compare(Math.signum(velocity), Math.signum(mProgressMultiplier)) == 0
                ? mToState : mFromState;
    } else {
        // 非 fling：用过线阈值判定
        float successTransitionProgress = SUCCESS_TRANSITION_PROGRESS;   // 默认 0.5f
        // 平板、手机 AllApps 用不同阈值
        if (isTablet && (mToState == ALL_APPS || mFromState == ALL_APPS)) {
            successTransitionProgress = TABLET_BOTTOM_SHEET_SUCCESS_TRANSITION_PROGRESS;
        } else if (!isTablet && mToState == ALL_APPS && mFromState == NORMAL) {
            successTransitionProgress = AllAppsSwipeController.ALL_APPS_STATE_TRANSITION_MANUAL;  // 0.4f
        } else if (!isTablet && mToState == NORMAL && mFromState == ALL_APPS) {
            successTransitionProgress = 1 - AllAppsSwipeController.ALL_APPS_STATE_TRANSITION_MANUAL;
        }
        targetState = (interpolatedProgress > successTransitionProgress) ? mToState : mFromState;
    }
    // ... 计算 startProgress/endProgress/duration，启动动画
}
```

落点判定有两套规则：

| 情形 | 判定方式 | 阈值 |
|---|---|---|
| fling（速度够大） | 看速度方向 | `velocity` 与 `mProgressMultiplier` 同号去 `mToState` |
| 非 fling | 看当前进度是否过线 | 默认 0.5；手机 AllApps 用 0.4/0.6 |

设计意图：**fling 优先于进度**。即使用户只划了 20% 但松手速度极快，也应当完成切换——这是符合直觉的"甩一下就过"的手感。非 fling 时才用过线阈值，并且手机/平板用不同阈值（平板 bottom sheet 更难触发，防误触）。

### 面试深问

**Q1：`FlingBlockCheck` 解决什么问题？**
用户从 NORMAL 慢慢上划到 80%，然后突然加速松手。如果不阻断，fling 会把他甩到 ALL_APPS；但中途已经触发过 `reinit` 反转，意图其实是想"刹住"。`FlingBlockCheck` 在 reinit 后阻断一段时间内的 fling，把快速松手当成普通松手用过线阈值判定。

**Q2：为什么 `mProgressMultiplier` 用 `1 / totalShift` 而不是固定值？**
不同机型 `getShiftRange()` 不同（屏幕高度相关）。用 `1/totalShift` 保证"划满整屏"恰好对应进度 1.0，跨机型手感一致。

**Q3：`mDisplacementShift` 在 reinit 后为什么要更新？**
reinit 后 from/to 对调，原来的进度参考系失效。把当前位移存进 `mDisplacementShift`，后续 `deltaProgress = mProgressMultiplier * (displacement - mDisplacementShift)` 从 0 重新计算，避免进度跳变。

---

## 六、AllAppsSwipeController：上下滑进入/退出 AllApps

`AllAppsSwipeController` 是手机三键模式下"桌面 ↔ 抽屉"的总控，继承 `AbstractStateChangeTouchController`，方向锁死为 VERTICAL：

```java
// AllAppsSwipeController.java
public AllAppsSwipeController(Launcher l) {
    super(l, SingleAxisSwipeDetector.VERTICAL);
}
```

`canInterceptTouch` 决定能不能接：

```java
// AllAppsSwipeController.java
@Override
protected boolean canInterceptTouch(MotionEvent ev) {
    if (mCurrentAnimation != null) return true;                // settle 中允许接（双滑场景）
    if (AbstractFloatingView.getTopOpenView(mLauncher) != null) return false;  // 有浮层不接
    if (!mLauncher.isInState(NORMAL) && !mLauncher.isInState(ALL_APPS)) return false;
    if (mLauncher.isInState(ALL_APPS) && !mLauncher.getAppsView().shouldContainerScroll(ev)) {
        return false;                                          // AllApps 列表还能滚，让给它
    }
    return true;
}
```

设计意图：**`shouldContainerScroll(ev)` 是和列表滚动的协商**。在 ALL_APPS 顶部继续往下滑时，列表自己应该滚；只有滚到顶了再往下拉，才应该退出 AllApps 回桌面。这个判定让"列表滚动"和"退出 AllApps"两个手势不打架。

`getTargetState` 翻译方向：

```java
// AllAppsSwipeController.java
@Override
protected LauncherState getTargetState(LauncherState fromState, boolean isDragTowardPositive) {
    if (fromState == NORMAL && shouldOpenAllApps(isDragTowardPositive)) {
        return ALL_APPS;                                       // 桌面上划 → 抽屉
    } else if (fromState == ALL_APPS && !isDragTowardPositive) {
        return NORMAL;                                         // 抽屉下划 → 桌面
    }
    return fromState;                                          // 没目标，原地
}
```

`initCurrentAnimation` 构建状态切换动画并算出 `mProgressMultiplier`：

```java
// AllAppsSwipeController.java
@Override
protected float initCurrentAnimation() {
    float range = getShiftRange();                             // AllApps 容器要移动的总距离
    StateAnimationConfig config = getConfigForStates(mFromState, mToState);
    config.duration = (long) (2 * range);                      // 用位移当伪时长
    mCurrentAnimation = mLauncher.getStateManager()
            .createAnimationToNewWorkspace(mToState, config);
    float startVerticalShift = mFromState.getVerticalProgress(mLauncher) * range;
    float endVerticalShift = mToState.getVerticalProgress(mLauncher) * range;
    float totalShift = endVerticalShift - startVerticalShift;
    return 1 / totalShift;                                     // 返回给基类当 mProgressMultiplier
}
```

这个类最重头戏的是动画插值器配置。Launcher 为 NORMAL↔ALL_APPS 准备了两套插值器：`*_ATOMIC`（系统主动切换，比如点按钮）和 `*_MANUAL`（用户手指控制）。区别在于 `*_MANUAL` 把变化压在前 40%（`ALL_APPS_STATE_TRANSITION_MANUAL = 0.4f`），让手指一动就有反馈；`*_ATOMIC` 用 `EMPHASIZED` 缓动显得更"有弹性"。

```java
// AllAppsSwipeController.java
public static final float ALL_APPS_STATE_TRANSITION_ATOMIC = 0.3333f;
public static final float ALL_APPS_STATE_TRANSITION_MANUAL = 0.4f;

// 各种属性的双版本插值器
public static final Interpolator WORKSPACE_SCALE_ATOMIC =
        Interpolators.clampToProgress(EMPHASIZED_ACCELERATE, WORKSPACE_MOTION_START_ATOMIC,
                ALL_APPS_STATE_TRANSITION_ATOMIC);
public static final Interpolator WORKSPACE_SCALE_MANUAL = LINEAR_EARLY_MANUAL;
// ... 一长串类似的

public static void applyNormalToAllAppsAnimConfig(Launcher launcher, StateAnimationConfig config) {
    if (launcher.getDeviceProfile().shouldShowAllAppsOnSheet()) {
        // 平板：AllApps 作为 bottom sheet，配置简单
        config.setInterpolator(ANIM_ALL_APPS_FADE, INSTANT);
        config.setInterpolator(ANIM_SCRIM_FADE, ALL_APPS_SCRIM_RESPONDER);
        // ...
    } else {
        // 手机：用 MANUAL 或 ATOMIC 双套插值器
        config.setInterpolator(ANIM_DEPTH, config.isUserControlled() ? BLUR_MANUAL : BLUR_ATOMIC);
        config.setInterpolator(ANIM_WORKSPACE_FADE,
                config.isUserControlled() ? WORKSPACE_FADE_MANUAL : WORKSPACE_FADE_ATOMIC);
        // ... 一一对应
    }
}
```

设计意图：**用户控制时插值器要"线性早响应"**。手指拖动期间，进度已经直接跟手了，再套一个非线性插值器会导致"跟手不跟手"的诡异感。所以 `*_MANUAL` 版本基本是 `LINEAR` 或早期 clamp，让视觉变化和手指位移严格线性对应。

### 面试深问

**Q1：为什么平板用 `shouldShowAllAppsOnSheet()` 走另一套配置？**
平板屏幕大，AllApps 以 bottom sheet 形式从底部升起，不需要桌面整体淡出/缩放/模糊。配置里把 WORKSPACE/HOTSEAT 的 scale 用 `ALL_APPS_SHEET_DEPTH`（轻微下沉），显得 sheet 是浮在桌面上。

**Q2：`config.duration = (long)(2 * range)` 用位移当时长是什么意思？**
这不是真实时长，是给 `AnimatorPlaybackController` 用的"伪时长"。`Apc` 会把这条动画当成 2*range 毫秒长，然后基类用 `setPlayFraction(progress)` 控制实际播放位置——`duration` 只影响内部插值，真实播放速度由手指决定。

**Q3：手机退出 AllApps 的过线阈值为什么是 0.6 而不是 0.5？**
`successTransitionProgress = 1 - 0.4 = 0.6`。退出比进入更难触发一点，因为用户在抽屉里浏览时不小心下划就退出很烦。0.6 让退出需要划过 60% 才生效，降低误触。

---

## 七、PortraitStatesTouchController：三键模式下的状态总控

`PortraitStatesTouchController`（quickstep 模块）是两键/三键机型在竖屏下的状态切换总控，比 `AllAppsSwipeController` 多处理 OVERVIEW 态。同样继承 `AbstractStateChangeTouchController`，方向也是 VERTICAL：

```java
// PortraitStatesTouchController.java
public PortraitStatesTouchController(Launcher l) {
    super(l, SingleAxisSwipeDetector.VERTICAL);
    mOverviewPortraitStateTouchHelper = new PortraitOverviewStateTouchHelper(l);
}
```

`canInterceptTouch` 的判定更复杂，要区分三种当前状态：

```java
// PortraitStatesTouchController.java
@Override
protected boolean canInterceptTouch(MotionEvent ev) {
    boolean interceptAnywhere = mLauncher.isInState(NORMAL);   // NORMAL 态允许任意位置起手
    if (mCurrentAnimation != null) {
        // settle 中：只在 AllApps 当前进度下方接（支持双滑）
        AllAppsTransitionController allAppsController = mLauncher.getAllAppsController();
        if (ev.getY() >= allAppsController.getShiftRange() * allAppsController.getProgress()
                || interceptAnywhere) {
            return true;
        }
        return false;
    }
    if (mLauncher.isInState(ALL_APPS)) {
        // AllApps 态：列表滚不动了才接
        if (!mLauncher.getAppsView().shouldContainerScroll(ev)) return false;
    } else if (mLauncher.isInState(OVERVIEW)) {
        // Overview 态：委托给 helper 判断
        if (!mOverviewPortraitStateTouchHelper.canInterceptTouch(ev)) return false;
    } else {
        // 其他态（如 EDIT）：只在 hotseat 区域起手才接，避免误触
        if (!interceptAnywhere && !isTouchOverHotseat(mLauncher, ev)) return false;
    }
    if (getTopOpenViewWithType(mLauncher, TYPE_TOUCH_CONTROLLER_NO_INTERCEPT) != null) return false;
    return true;
}
```

设计意图：**`isTouchOverHotseat` 限制起手区域**。在 OVERVIEW/EDIT 这种非桌面态，用户在屏幕中上方的滑动是要操作任务卡/编辑模式，只有从 hotseat 区域（底部那排图标）起手才认为是"想回桌面/进 AllApps"。这是"区域+方向"的双重判定，避免手势冲突。

`getTargetState` 处理 NORMAL/ALL_APPS 双向：

```java
// PortraitStatesTouchController.java
@Override
protected LauncherState getTargetState(LauncherState fromState, boolean isDragTowardPositive) {
    if (fromState == ALL_APPS && !isDragTowardPositive) return NORMAL;
    else if (fromState == NORMAL && shouldOpenAllApps(isDragTowardPositive)) return ALL_APPS;
    return fromState;
}
```

`getConfigForStates` 直接复用 `AllAppsSwipeController` 的两套插值器配置方法——这就是为什么前面那些 `*_MANUAL`/`*_ATOMIC` 常量定义在 `AllAppsSwipeController` 里：它们是共享资源。

### 面试深问

**Q1：为什么 `PortraitStatesTouchController` 不像 `AllAppsSwipeController` 一样直接放在 `touch/` 目录？**
它在 `quickstep` 模块，依赖 `PortraitOverviewStateTouchHelper` 等 quickstep 专属类。`touch/` 目录放的是不依赖 quickstep 的核心手势识别，模块边界清晰。

**Q2：`TYPE_TOUCH_CONTROLLER_NO_INTERCEPT` 是什么？**
某些浮层（如任务锁定的 ActionMode）声明"不允许被 TouchController 抢事件"。看到这种浮层在前就直接 return false，让事件穿透给浮层。

**Q3：三键模式下全屏手势 Controller（NoButtonQuickSwitchTouchController 等）和这个并存吗？**
不并存。`createTouchControllers` 按 `NavigationMode` switch，三键模式走基线 `Launcher` 的实现（只有 `AllAppsSwipeController`），全屏手势走 `QuickstepLauncher` 的实现（含 PortraitStatesTouchController 等）。一次只有一个数组生效。

---

## 八、WorkspaceTouchListener：空白区域的长按与点击

注意：用户提到的"WorkspaceTouchController"在源码里实际叫 `WorkspaceTouchListener`——它不是 `TouchController` 接口的实现，而是 `Workspace.setOnTouchListener` 设置的 `OnTouchListener`，走的是 ViewGroup 自己的 touch 事件分发，**不**经过 `BaseDragLayer` 的责任链。两者机制完全不同。

它的职责：处理 Workspace 空白区域的**长按出菜单**和**点击关 AllApps sheet**。

```java
// WorkspaceTouchListener.java
public class WorkspaceTouchListener extends GestureDetector.SimpleOnGestureListener
        implements OnTouchListener {

    // 长按状态机
    private static final int STATE_CANCELLED = 0;              // 已取消
    private static final int STATE_REQUESTED = 1;              // 已请求，等 GestureDetector 回调
    private static final int STATE_PENDING_PARENT_INFORM = 2;  // 长按已触发，等下个事件通知父 View
    private static final int STATE_COMPLETED = 3;              // 完成，吞掉后续事件

    private final Launcher mLauncher;
    private final Workspace<?> mWorkspace;
    private final float mTouchSlop;                            // = 2 * ViewConfiguration.getScaledTouchSlop()
    private int mLongPressState = STATE_CANCELLED;
    private final GestureDetector mGestureDetector;
}
```

`mTouchSlop` 故意放大到 2 倍——长按容易伴随轻微手抖，普通 slop 会误判成移动而取消长按。

`onTouch` 是主逻辑：

```java
// WorkspaceTouchListener.java
@Override
public boolean onTouch(View view, MotionEvent ev) {
    mGestureDetector.onTouchEvent(ev);                          // 先喂给 GestureDetector 检测长按
    int action = ev.getActionMasked();

    if (action == ACTION_DOWN) {
        boolean handleLongPress = canHandleLongPress();
        if (handleLongPress) {
            // 检查是否在屏幕边缘（边缘留给系统手势）
            DeviceProfile dp = mLauncher.getDeviceProfile();
            DragLayer dl = mLauncher.getDragLayer();
            Rect insets = dp.getInsets();
            mTempRect.set(insets.left, insets.top, dl.getWidth() - insets.right,
                    dl.getHeight() - insets.bottom);
            mTempRect.inset(dp.mWorkspaceProfile.getEdgeMarginPx(),
                    dp.mWorkspaceProfile.getEdgeMarginPx());
            handleLongPress = mTempRect.contains((int) ev.getX(), (int) ev.getY());
        }
        if (handleLongPress) {
            mLongPressState = STATE_REQUESTED;
            mTouchDownPoint.set(ev.getX(), ev.getY());
            // 鼠标右键 DOWN 直接弹菜单
            if (TouchUtil.isMouseRightClickDownOrMove(ev)) {
                maybeShowMenu();
                return true;
            }
        }
        mWorkspace.onTouchEvent(ev);                            // 同时让 Workspace 处理（翻页等）
        return true;
    }

    // 长按已触发，需要给父 View 发 CANCEL 让它清理临时滚动状态
    if (mLongPressState == STATE_PENDING_PARENT_INFORM) {
        ev.setAction(ACTION_CANCEL);
        mWorkspace.onTouchEvent(ev);
        ev.setAction(action);                                   // 还原 action
        mLongPressState = STATE_COMPLETED;
    }

    boolean isInAllAppsBottomSheet = mLauncher.isInState(ALL_APPS)
            && mLauncher.getDeviceProfile().shouldShowAllAppsOnSheet();

    final boolean result;
    if (mLongPressState == STATE_COMPLETED) {
        result = true;                                          // 长按已处理，吞掉所有后续
    } else if (mLongPressState == STATE_REQUESTED) {
        mWorkspace.onTouchEvent(ev);
        if (mWorkspace.isHandlingTouch()) {
            cancelLongPress();                                  // Workspace 自己在处理（翻页中），取消长按
        } else if (action == ACTION_MOVE && PointF.length(
                mTouchDownPoint.x - ev.getX(), mTouchDownPoint.y - ev.getY()) > mTouchSlop) {
            cancelLongPress();                                  // 移动超过 slop，取消长按
        }
        result = true;
    } else {
        // 非 AllApps sheet 态：让 Workspace 自己处理
        result = isInAllAppsBottomSheet && action != ACTION_CANCEL && action != ACTION_UP;
    }

    if (action == ACTION_UP || action == ACTION_POINTER_UP) {
        if (!mWorkspace.isHandlingTouch()) {
            // 空白处点击：触发壁纸点击（双击缩放等）
            CellLayout currentPage = (CellLayout) mWorkspace.getChildAt(mWorkspace.getCurrentPage());
            if (currentPage != null) mWorkspace.onWallpaperTap(ev);
        }
    }
    if (action == ACTION_UP && isInAllAppsBottomSheet) {
        // 平板：点击空白关掉 AllApps sheet
        mLauncher.getStateManager().goToState(NORMAL);
        // ... 打点
    }
    return result;
}
```

长按实际触发：

```java
// WorkspaceTouchListener.java
@Override
public void onLongPress(MotionEvent event) {
    if (event.getSource() == InputDevice.SOURCE_MOUSE && shouldEnableMouseInteractionChanges(
            mWorkspace.getContext())) return;                   // 鼠标长按不弹菜单
    maybeShowMenu();
}

private void maybeShowMenu() {
    if (mLongPressState == STATE_REQUESTED) {
        if (canHandleLongPress()) {
            mLongPressState = STATE_PENDING_PARENT_INFORM;
            mWorkspace.getParent().requestDisallowInterceptTouchEvent(true);  // 阻止父 View 拦截
            mWorkspace.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS,
                    HapticFeedbackConstants.FLAG_IGNORE_VIEW_SETTING);        // 震动反馈
            mLauncher.showDefaultOptions(mTouchDownPoint.x, mTouchDownPoint.y); // 弹出选项菜单
            // ... 分屏选中态退出
        } else {
            cancelLongPress();
        }
    }
}
```

设计意图：**`STATE_PENDING_PARENT_INFORM` 这个中间态**解决一个时序问题——`GestureDetector.onLongPress` 回调发生在 MOVE 事件之间，此时 Workspace 可能正处于临时滚动状态。直接弹菜单会让滚动状态残留。所以设置中间态，等下一个事件来时给它发 `ACTION_CANCEL` 清理，再进 `COMPLETED`。

### 面试深问

**Q1：为什么 `WorkspaceTouchListener` 不走 TouchController 责任链？**
责任链用于"全局手势"（翻页、状态切换）。Workspace 空白区域的点击/长按是 Workspace 自己的局部交互，由 Workspace 的 `OnTouchListener` 处理更内聚。强行塞进责任链会让所有 Controller 都要判断"是不是点在 Workspace 空白"。

**Q2：`requestDisallowInterceptTouchEvent(true)` 在长按触发时调用的作用？**
阻止 DragLayer 在长按后拦截后续 MOVE——长按弹菜单后用户手指还在屏幕上滑动选菜单项，不能让上层翻页控制器抢走。

**Q3：边缘 `edgeMarginPx` 内不响应长按，为什么？**
屏幕边缘是系统手势区域（如左侧返回、底部上滑 Home）。在这些区域起长按会和系统手势打架，Launcher 主动让出。

---

## 九、ItemLongClickListener：长按起拖

`ItemLongClickListener` 是图标的长按监听器，作用是把"长按图标"翻译成"开始拖拽"。提供两个静态实例，用方法引用实现 `OnLongClickListener`：

```java
// ItemLongClickListener.java
public static final OnLongClickListener INSTANCE_WORKSPACE =
        ItemLongClickListener::onWorkspaceItemLongClick;
public static final OnLongClickListener INSTANCE_ALL_APPS =
        ItemLongClickListener::onAllAppsItemLongClick;
```

Workspace 图标长按：

```java
// ItemLongClickListener.java
private static boolean onWorkspaceItemLongClick(View v) {
    if (v instanceof LauncherAppWidgetHostView) {
        TestLogging.recordEvent(TestProtocol.SEQUENCE_MAIN, "Widgets.onLongClick");
    } else {
        TestLogging.recordEvent(TestProtocol.SEQUENCE_MAIN, "onWorkspaceItemLongClick");
    }
    Launcher launcher = Launcher.getLauncher(v.getContext());
    if (!canStartDrag(launcher)) return false;                  // 前置校验
    if (!launcher.isInState(NORMAL)
            && !launcher.isInState(OVERVIEW)
            && !launcher.isInState(EDIT_MODE)) {
        return false;                                           // 状态不对（如 AllApps 中）不起拖
    }
    if (!(v.getTag() instanceof ItemInfo)) return false;        // 必须是有效 Item

    launcher.setWaitingForResult(null);
    beginDrag(v, launcher, (ItemInfo) v.getTag(), new DragOptions());
    return true;
}
```

`canStartDrag` 是全局拖拽前置校验：

```java
// ItemLongClickListener.java
public static boolean canStartDrag(Launcher launcher) {
    if (launcher == null) return false;
    if (launcher.isWorkspaceLocked()) return false;            // 桌面正在加载，可能 View 即将被移除
    if (launcher.getDragController().isDragging()) return false;  // 已经在拖了（双指长按两个）
    if (launcher.isSplitSelectionActive()) return false;        // 分屏选择中
    return true;
}
```

`beginDrag` 处理"图标在文件夹内"的特殊情况：

```java
// ItemLongClickListener.java
public static void beginDrag(View v, Launcher launcher, ItemInfo info, DragOptions dragOptions) {
    if (info.container >= 0) {                                  // 在文件夹内
        Folder folder = Folder.getOpen(launcher);
        if (folder != null) {
            if (!folder.getIconsInReadingOrder().contains(v)) {
                folder.close(true);                             // 不属于当前打开的文件夹，关掉它
            } else {
                folder.startDrag(v, dragOptions);               // 文件夹内起拖
                return;
            }
        }
    }
    // 普通桌面图标起拖
    CellInfo longClickCellInfo = new CellInfo(v, info,
            launcher.getCellPosMapper().mapModelToPresenter(info));
    launcher.getWorkspace().startDrag(longClickCellInfo, dragOptions);
}
```

AllApps 图标长按逻辑更复杂，要处理拖拽期间隐藏原 View：

```java
// ItemLongClickListener.java
private static boolean onAllAppsItemLongClick(View view) {
    if (view instanceof WidgetCell wc) return onWidgetItemLongClick(wc);  // Widget 选择器
    view.cancelLongPress();                                     // 取消后续长按重复触发
    View v = (view instanceof BubbleTextHolder)
            ? ((BubbleTextHolder) view).getBubbleText() : view;
    Launcher launcher = Launcher.getLauncher(v.getContext());
    if (!canStartDrag(launcher)) return false;
    if (!launcher.isInState(ALL_APPS) && !launcher.isInState(OVERVIEW)) return false;
    if (launcher.getWorkspace().isSwitchingState()) return false;  // 状态切换中不起拖

    // 打点
    StatsLogger logger = launcher.getStatsLogManager().logger();
    if (v.getTag() instanceof ItemInfo itemInfo) {
        if (itemInfo instanceof PrivateSpaceInstallAppButtonInfo) return false;  // 私密空间按钮不起拖
        logger.withItemInfo((ItemInfo) v.getTag());
    }
    logger.log(LAUNCHER_ALLAPPS_ITEM_LONG_PRESSED);

    // 拖拽开始时隐藏原 View，结束时恢复
    final DragController dragController = launcher.getDragController();
    dragController.addDragListener(new DragController.DragListener() {
        @Override
        public void onDragStart(DropTarget.DragObject dragObject, DragOptions options) {
            v.setVisibility(INVISIBLE);                         // 起拖瞬间隐藏
        }
        @Override
        public void onDragEnd() {
            v.setVisibility(VISIBLE);                           // 结束恢复
            dragController.removeDragListener(this);
        }
    });

    launcher.getWorkspace().beginDragShared(v, launcher.getAppsView(), new DragOptions());
    return false;
}
```

设计意图：**起拖时 `setVisibility(INVISIBLE)`**。DragController 会生成一个 `DragView`（图标副本）跟手移动，原 View 隐藏避免视觉重复。结束时恢复可见。这是拖拽系统的视觉契约。

### 面试深问

**Q1：为什么 `onAllAppsItemLongClick` 返回 `false` 而不是 `true`？**
长按回调返回值不影响后续事件分发（长按已经触发）。返回 false 让 `View.onLongClickListener` 处理完不消费事件，避免影响 touch chain。Workspace 版返回 true 是因为要消费。

**Q2：`isSwitchingState()` 时为什么不起拖？**
状态切换（如正在进入 AllApps）期间图标位置/可见性在变，起拖会基于过期的位置信息，导致拖拽错位。

**Q3：`PrivateSpaceInstallAppButtonInfo` 为什么单独排除？**
私密空间"安装应用"按钮是功能性按钮不是可拖拽图标，长按它没意义，直接返回 false 不起拖。

---

## 十、ItemClickHandler：短按启动 App

`ItemClickHandler` 处理图标的短按点击，是 `OnClickListener` 的方法引用实现：

```java
// ItemClickHandler.java
public static final OnClickListener INSTANCE = ItemClickHandler::onClick;
```

短按和长按怎么区分？这是 Android 系统层的事——`View` 内部用 `CheckForLongPress` 这个 Runnable 在 `ViewConfiguration.getLongPressTimeout()`（默认 500ms）后触发 `OnLongClickListener`；如果在这之前 UP 了，就触发 `OnClickListener`。Launcher 不需要自己计时。

`onClick` 主分发：

```java
// ItemClickHandler.java
private static void onClick(View v) {
    if (v.getWindowToken() == null) return;                     // View 已分离，忽略野点击
    Launcher launcher = Launcher.getLauncher(v.getContext());
    if (!launcher.getWorkspace().isFinishedSwitchingState()) return;  // 状态切换中忽略

    Object tag = v.getTag();
    if (tag instanceof WorkspaceItemInfo) {
        onClickAppShortcut(v, (WorkspaceItemInfo) tag, launcher);     // 桌面快捷方式
    } else if (tag instanceof FolderInfo) {
        onClickFolderIcon(v);                                   // 文件夹图标
    } else if (tag instanceof AppPairInfo) {
        onClickAppPairIcon(v);                                  // 应用对（分屏快捷）
    } else if (tag instanceof AppInfo) {
        startAppShortcutOrInfoActivity(v, (AppInfo) tag, launcher);  // AllApps 列表项
    } else if (tag instanceof LauncherAppWidgetInfo) {
        if (v instanceof PendingAppWidgetHostView) {
            onClickPendingWidget((PendingAppWidgetHostView) v, launcher);  // 待安装 Widget
        }
    } else if (tag instanceof ItemClickProxy) {
        ((ItemClickProxy) tag).onItemClicked(v);                // 自处理代理
    }
}
```

启动 App 的核心：

```java
// ItemClickHandler.java
private static void startAppShortcutOrInfoActivity(View v, ItemInfo item, Launcher launcher) {
    TestLogging.recordEvent(TestProtocol.SEQUENCE_MAIN, "start: startAppShortcutOrInfoActivity");
    Intent intent = item.getIntent();
    if (item instanceof ItemInfoWithIcon itemInfoWithIcon) {
        // 正在安装中的图标，跳应用商店
        if ((itemInfoWithIcon.runtimeStatusFlags & ItemInfoWithIcon.FLAG_INSTALL_SESSION_ACTIVE) != 0) {
            intent = ApiWrapper.INSTANCE.get(launcher).getAppMarketActivityIntent(
                    itemInfoWithIcon.getTargetComponent().getPackageName(),
                    Process.myUserHandle());
        }
        // ... 私密空间安装按钮
    }
    if (intent == null) throw new IllegalArgumentException("Input must have a valid intent");

    if (item instanceof WorkspaceItemInfo) {
        WorkspaceItemInfo si = (WorkspaceItemInfo) item;
        // Web UI 兼容：包名置空让系统 fallback 到浏览器
        if (si.hasStatusFlag(WorkspaceItemInfo.FLAG_SUPPORTS_WEB_UI)
                && Intent.ACTION_VIEW.equals(intent.getAction())) {
            intent = new Intent(intent);
            intent.setPackage(null);
        }
        // startActivityForResult 类型的快捷方式
        if ((si.options & WorkspaceItemInfo.FLAG_START_FOR_RESULT) != 0) {
            launcher.startActivityForResult(item.getIntent(), 0);
            // ... 打点
            return;
        }
    }
    // 预加载图标，降低浮动图标替换延迟
    if (v != null && launcher.supportsAdaptiveIconAnimation(v)
            && !item.shouldUseBackgroundAnimation()) {
        FloatingIconView.fetchIcon(launcher, v, item, true /* isOpening */);
    }
    launcher.startActivitySafely(v, intent, item);              // 实际启动
}
```

设计意图：**`FloatingIconView.fetchIcon` 是启动动画的关键预备**。Launcher 的"图标放大成 App"过渡动画需要一个浮动图标 View，提前在点击瞬间预加载它的 drawable，能省掉 App 启动后绘制首帧时的图标加载延迟，让动画看起来"无缝"。

禁用项的处理也在这层：

```java
// ItemClickHandler.java
public static boolean handleDisabledItemClicked(WorkspaceItemInfo shortcut, Context context) {
    final int disabledFlags = shortcut.runtimeStatusFlags & WorkspaceItemInfo.FLAG_DISABLED_MASK;
    if (maybeCreateAlertDialogForShortcut(shortcut, context)) return true;  // 版本过低弹更新框
    if ((disabledFlags & ~FLAG_DISABLED_SUSPENDED & ~FLAG_DISABLED_QUIET_USER) == 0) {
        return false;                                           // 仅被暂停/静音，照常启动交给 framework 提示
    } else {
        if (!TextUtils.isEmpty(shortcut.disabledMessage)) {
            Toast.makeText(context, shortcut.disabledMessage, Toast.LENGTH_SHORT).show();
            return true;
        }
        // 按 safemode/publisher/locked 给不同 Toast
        int error = R.string.activity_not_available;
        if ((shortcut.runtimeStatusFlags & FLAG_DISABLED_SAFEMODE) != 0) error = R.string.safemode_shortcut_error;
        // ...
        Toast.makeText(context, error, Toast.LENGTH_SHORT).show();
        return true;
    }
}
```

### 面试深问

**Q1：长按和短按在 Launcher 层是怎么区分的？**
Launcher 不区分——`View` 系统层用 `postDelayed(CheckForLongPress, longPressTimeout)` 区分。500ms 内 UP 走 `OnClickListener`（短按启动），超过 500ms 不 UP 走 `OnLongClickListener`（起拖）。Launcher 只挂两个监听器。

**Q2：`isFinishedSwitchingState()` 检查解决什么？**
状态切换动画进行中点击图标会基于过期状态启动 App，可能导致动画错乱。等切换完成才允许点击。

**Q3：`ItemClickProxy` 这个接口解决什么？**
某些图标点击不想走默认分发（如"添加应用到桌面"的占位图标），实现 `ItemClickProxy` 接口挂在 tag 上，onClick 时转交给它自己处理。是开闭原则的扩展点。

---

## 十一、BothAxesSwipeDetector：双轴滑动

`SingleAxisSwipeDetector` 只关心一个轴，但 Overview 的任务卡拖拽需要同时跟踪 X 和 Y（往两侧滑删除、往上滑全部清除）。`BothAxesSwipeDetector` 填补这个空缺：

```java
// BothAxesSwipeDetector.java
public static final int DIRECTION_UP = 1 << 0;
public static final int DIRECTION_RIGHT = 1 << 1;             // 注意 RTL 下追踪 left
public static final int DIRECTION_DOWN = 1 << 2;
public static final int DIRECTION_LEFT = 1 << 3;              // 注意 RTL 下追踪 right
```

`shouldScrollStart` 直接判定四个方向，不做角度过滤（双轴都需要）：

```java
// BothAxesSwipeDetector.java
@Override
protected boolean shouldScrollStart(PointF displacement) {
    boolean canScrollUp = (mScrollDirections & DIRECTION_UP) > 0 && displacement.y <= -mTouchSlop;
    boolean canScrollRight = (mScrollDirections & DIRECTION_RIGHT) > 0 && displacement.x >= mTouchSlop;
    boolean canScrollDown = (mScrollDirections & DIRECTION_DOWN) > 0 && displacement.y >= mTouchSlop;
    boolean canScrollLeft = (mScrollDirections & DIRECTION_LEFT) > 0 && displacement.x <= -mTouchSlop;
    return canScrollUp || canScrollRight || canScrollDown || canScrollLeft;
}
```

回调把完整 `PointF` 传出，不压缩：

```java
// BothAxesSwipeDetector.java
public interface Listener {
    void onDragStart(boolean start);
    boolean onDrag(PointF displacement, MotionEvent motionEvent);
    void onDragEnd(PointF velocity);
}
```

设计意图：**为什么需要双轴 Detector？**
任务卡的"上滑清除全部"和"左右滑删除单个"是两个手势但共享同一组 touch 事件。用 `SingleAxisSwipeDetector` 只能选一个轴，会丢失另一个轴信息。双轴 Detector 把位移完整传出，让上层自己判断意图。

### 面试深问

**Q1：为什么 `DIRECTION_RIGHT` 在 RTL 下追踪 left？**
RTL 布局下"右"和"左"的视觉含义对调。代码注释明说："Note that this will track left instead of right in RTL."——保证视觉上的"右滑"在不同布局方向下都映射到同一个 flag。

**Q2：双轴 Detector 为什么不做角度过滤？**
单轴 Detector 要在 X/Y 之间二选一，所以需要角度过滤决定归属。双轴 Detector 接收所有方向，不需要过滤，任意方向达标即触发。

**Q3：这个 Detector 在 Launcher3 哪里使用？**
主要在 quickstep 的 Overview 任务卡相关 Controller（如 `PortraitOverviewStateTouchHelper`）。基线 Launcher3 不用它——桌面只需要单轴翻页和上下滑进 AllApps。

---

## 十二、OverScroll：越界阻尼

`OverScroll` 是个工具类，把"超出可滚动范围的位移"按一条曲线衰减，模拟橡皮筋效果：

```java
// OverScroll.java
public static final float OVERSCROLL_DAMP_FACTOR = 0.07f;     // 最大阻尼系数，最多拉 7%

private static float overScrollInfluenceCurve(float f) {
    f -= 1.0f;
    return f * f * f + 1.0f;                                    // 三次曲线，越拉越费劲
}

public static int dampedScroll(float amount, int max) {
    if (Float.compare(amount, 0) == 0) return 0;
    float f = amount / max;                                     // 归一化到 [0,1]+
    f = f / (Math.abs(f)) * (overScrollInfluenceCurve(Math.abs(f)));  // 套曲线
    if (Math.abs(f) >= 1) f /= Math.abs(f);                    // 钳制到 [-1,1]
    return Math.round(OVERSCROLL_DAMP_FACTOR * f * max);        // 最终 ≤ 7% * max
}
```

曲线形状：`f=0` 时返回 1，`f=1` 时返回 1，中间是 S 形——意味着刚开始越界时阻尼小（手指轻拉就动），拉得越远阻尼越大，最终封顶在 7%。

设计意图：**`OVERSCROLL_DAMP_FACTOR = 0.07f`** 是经验值。太大（如 0.3）会让用户轻易把页面拉出大半屏，破坏"边界感"；太小（如 0.02）会让越界反馈几乎不可见。0.07 在"明显反馈"和"边界约束"之间取得平衡。

### 面试深问

**Q1：为什么用三次曲线而不是线性？**
线性阻尼下拉起来手感一致，没有"越拉越费劲"的物理直觉。三次曲线 `(f-1)³+1` 在 f=0 处导数为 0，斜率小，越往后越费劲，符合橡皮筋的弹性直觉。

**Q2：这个阻尼在 Workspace 哪里用？**
`PagedView` 在已经滑到第一页/最后一页还继续划时调用 `OverScroll.dampedScroll` 计算实际位移，实现"桌面边界橡皮筋"。

**Q3：为什么钳制到 `[-1,1]`？**
`overScrollInfluenceCurve` 输入超过 1 会返回负值（因为 `f-1` 的立方）。钳制保证 `f` 始终在合理范围，阻尼输出有界。

---

## 十三、PagedOrientationHandler：方向抽象

`PagedOrientationHandler` 是个接口，把 PagedView 的所有方向相关操作抽象成"主轴/次轴"两个概念。默认实现 `DefaultPagedViewHandler` 是横向翻页：

```java
// PagedOrientationHandler.java
public interface PagedOrientationHandler {
    PagedOrientationHandler DEFAULT = new DefaultPagedViewHandler();

    // 各种"主轴操作"抽象
    <T> void setPrimary(T target, Int2DAction<T> action, int param);
    float getPrimaryDirection(MotionEvent event, int pointerIndex);
    int getMeasuredSize(View view);
    int getPrimaryScroll(View view);
    int getChildStart(View view);
    // ...
}
```

默认实现把"主轴"映射到 X：

```java
// DefaultPagedViewHandler.java
@Override
public int getPrimaryValue(int x, int y) { return x; }          // 主轴取 X
@Override
public int getSecondaryValue(int x, int y) { return y; }        // 次轴取 Y

@Override
public <T> void setPrimary(T target, Int2DAction<T> action, int param) {
    action.call(target, param, 0);                              // scrollBy(param, 0)
}

@Override
public float getPrimaryDirection(MotionEvent event, int pointerIndex) {
    return event.getX(pointerIndex);                            // 主轴位移用 X
}

@Override
public int getMeasuredSize(View view) { return view.getMeasuredWidth(); }

@Override
public int getPrimaryScroll(View view) { return view.getScrollX(); }
```

设计意图：**为什么抽这一层？**
Launcher3 的 PagedView 默认横向翻页，但在某些形态（如 Overview 在某些设备上竖向滚动任务卡）需要竖向。把"主轴是 X 还是 Y"抽象出来，业务代码写"主轴位移""主轴滚动"等无方向概念，由 Handler 决定具体调 `getX` 还是 `getY`。

接口里的 `Int2DAction` / `Float2DAction` 是函数式接口，把"两参数方法调用"包装成可传递的对象：

```java
// PagedOrientationHandler.java
interface Int2DAction<T> { void call(T target, int x, int y); }
interface Float2DAction<T> { void call(T target, float x, float y); }
Int2DAction<View> VIEW_SCROLL_BY = View::scrollBy;              // 方法引用
Int2DAction<View> VIEW_SCROLL_TO = View::scrollTo;
Float2DAction<Canvas> CANVAS_TRANSLATE = Canvas::translate;
Float2DAction<Matrix> MATRIX_POST_TRANSLATE = Matrix::postTranslate;
```

这样 `setPrimary(view, VIEW_SCROLL_BY, 50)` 在横向 Handler 里调 `view.scrollBy(50, 0)`，在竖向 Handler 里调 `view.scrollBy(0, 50)`，业务层完全不感知方向。

### 面试深问

**Q1：为什么用方法引用而不是直接调用？**
`View.scrollBy(int, int)` 是双参数方法，Handler 需要根据方向决定哪个参数填值、哪个填 0。用方法引用把"调用本身"对象化，Handler 可以自由组装参数。

**Q2：`DEFAULT` 为什么定义成接口常量而不是单独类？**
避免每次用都 new 一个实例。常量单例无状态，全局共享安全。

**Q3：这个抽象有什么代价？**
每个方向相关操作多一层方法调用和接口分发，理论上有微小性能开销。但 PagedView 滚动频率不高（每帧几次），开销可忽略；换来的是代码无需 if/else 区分方向，可维护性大幅提升。

---

## 十四、DragLayer 自身的事件处理

除了 `BaseDragLayer` 提供的责任链，`DragLayer` 自己还重写了几个方法处理拖拽场景的特殊需求。

`dispatchTouchEvent` 做了 X 方向的位移修正：

```java
// DragLayer.java
@Override
public boolean dispatchTouchEvent(MotionEvent ev) {
    ev.offsetLocation(getTranslationX(), 0);                   // 加上 DragLayer 自身 X 平移
    try {
        return super.dispatchTouchEvent(ev);
    } finally {
        ev.offsetLocation(-getTranslationX(), 0);              // 还原，避免污染其他消费者
    }
}
```

设计意图：DragLayer 在某些动画（如关闭文件夹的滑出动画）期间会被 `setTranslationX`，导致子 View 的触摸坐标和视觉位置错位。`offsetLocation` 把坐标平移到"视觉真实位置"，让点击命中正确的子 View。`finally` 块还原是因为 `MotionEvent` 是复用对象，不还原会污染后续事件。

构造函数关闭多指分裂：

```java
// DragLayer.java
public DragLayer(Context context, AttributeSet attrs) {
    super(context, attrs, ALPHA_CHANNEL_COUNT);
    setMotionEventSplittingEnabled(false);                      // 关闭多指分裂
    setChildrenDrawingOrderEnabled(true);
    mFocusIndicatorHelper = new ViewGroupFocusHelper(this);
    mIsRtl = Utilities.isRtl(getResources());
}
```

设计意图：**`setMotionEventSplittingEnabled(false)`** 让多指事件全部走主指针。Launcher 的拖拽/翻页/状态切换都是单指语义，多指分裂会导致"两个手指同时拖两个图标"这种无意义状态。

`BaseDragLayer` 还提供 `proxyTouchEvent` 用于系统手势区域事件代理：

```java
// BaseDragLayer.java
public boolean proxyTouchEvent(MotionEvent ev, boolean allowViewDispatch) {
    int actionMasked = ev.getActionMasked();
    boolean isViewDispatching = (mTouchDispatchState & TOUCH_DISPATCHING_FROM_VIEW) != 0;

    allowViewDispatch = allowViewDispatch && !isViewDispatching
            && (actionMasked == ACTION_DOWN
                || ((mTouchDispatchState & TOUCH_DISPATCHING_TO_VIEW_IN_PROGRESS) != 0));

    if (allowViewDispatch) {
        mTouchDispatchState |= TOUCH_DISPATCHING_TO_VIEW_IN_PROGRESS;
        super.dispatchTouchEvent(ev);                           // 走正常分发
        if (actionMasked == ACTION_UP || actionMasked == ACTION_CANCEL) {
            mTouchDispatchState &= ~TOUCH_DISPATCHING_TO_VIEW_IN_PROGRESS;
            mTouchDispatchState &= ~TOUCH_DISPATCHING_FROM_PROXY;
        }
        return true;
    } else {
        boolean handled;
        if (mProxyTouchController != null) {
            handled = mProxyTouchController.onControllerTouchEvent(ev);  // 代理 Controller 消费
        } else {
            // DOWN 时决定是否进入代理模式
            if (actionMasked == ACTION_DOWN) {
                if (isViewDispatching && mActiveController != null) {
                    mTouchDispatchState &= ~TOUCH_DISPATCHING_FROM_PROXY;  // 已有 Controller，不代理
                } else {
                    mTouchDispatchState |= TOUCH_DISPATCHING_FROM_PROXY;   // 进入代理
                }
            }
            if ((mTouchDispatchState & TOUCH_DISPATCHING_FROM_PROXY) != 0) {
                // ... 找代理 Controller 消费
            }
        }
        return handled;
    }
}
```

设计意图：**两套分发通道互斥共存**。`TOUCH_DISPATCHING_FROM_VIEW` 是子 View 正常分发；`TOUCH_DISPATCHING_FROM_PROXY` 是系统手势区域代理分发。用位标志隔离，保证同一时刻只有一套通道激活，避免双分发。

### 面试深问

**Q1：`dispatchTouchEvent` 里 `offsetLocation` 为什么只用 `getTranslationX()` 不用 Y？**
DragLayer 的 Y 平移主要发生在 AllApps 上滑（整个 DragLayer 不动，是子 View 动）。X 平移发生在文件夹/浮层滑出动画，这种场景需要修正触摸坐标。Y 方向没有这种"父 View 整体平移但子 View 视觉不动"的场景。

**Q2：`setChildrenDrawingOrderEnabled(true)` 的作用？**
让 DragLayer 能控制子 View 的绘制顺序（如把拖拽中的 DragView 画在最上面）。默认按 z-order 绘制无法满足拖拽场景的层级需求。

**Q3：`proxyTouchEvent` 在什么场景被调用？**
系统手势（如底部上滑 Home）的事件经过 SysUI 的 GestureNavigationShell 传到 Launcher，需要绕过正常 dispatch 链路用 `proxyTouchEvent` 注入。这是全面屏手势和 Launcher 联动的底层通道。

---

## 附：触摸事件分发完整时序

下面是一次"用户在桌面上划进入 AllApps"的完整时序，把前面所有章节串起来：

```
1. ACTION_DOWN 到达 DragLayer.dispatchTouchEvent
   → 设 mTouchDispatchState 标志
   → super.dispatchTouchEvent 分发给 Workspace

2. Workspace 的 OnTouchListener (WorkspaceTouchListener) 收到 DOWN
   → 记录 mTouchDownPoint，mLongPressState = STATE_REQUESTED
   → 返回 true，Workspace.onTouchEvent 也处理

3. BaseDragLayer.onInterceptTouchEvent(DOWN)
   → findControllerToHandleTouch
   → 遍历 mControllers：DragController.onControllerInterceptTouchEvent 返回 false
   → AllAppsSwipeController.onControllerInterceptTouchEvent(DOWN)
     → canInterceptTouch 校验（NORMAL 态、无浮层）通过
     → getSwipeDirection 算出 DIRECTION_POSITIVE（上划可进 AllApps）
     → mDetector.setDetectableScrollConditions(POSITIVE, false)
     → mDetector.isDraggingOrSettling() 返回 false（还没超过 slop）
   → mActiveController = null，不拦截

4. ACTION_MOVE 到达
   → Workspace.onTouchEvent 处理（判定是否翻页）
   → DragLayer.onInterceptTouchEvent(MOVE)
     → AllAppsSwipeController.onControllerInterceptTouchEvent(MOVE)
       → mDetector.onTouchEvent(MOVE)
       → shouldScrollStart 判定：Y 位移 > slop 且方向匹配
       → setState(DRAGGING) → reportDragStart → AllAppsSwipeController.onDragStart
       → mDetector.isDraggingOrSettling() 返回 true
     → 返回 true，拦截！
   → mActiveController = AllAppsSwipeController
   → 后续 MOVE/UP 不再进 Workspace

5. 后续 ACTION_MOVE 都进 DragLayer.onTouchEvent
   → mActiveController.onControllerTouchEvent(MOVE)
   → AllAppsSwipeController.onControllerTouchEvent → mDetector.onTouchEvent(MOVE)
   → reportDragging → onDrag(displacement)
   → AbstractStateChangeTouchController.onDrag
     → progress = mProgressMultiplier * displacement
     → mCurrentAnimation.setPlayFraction(progress)
     → 状态动画播放，视觉跟随手指

6. ACTION_UP
   → DragLayer.onTouchEvent(UP)
   → AllAppsSwipeController.onControllerTouchEvent(UP)
   → mDetector.onTouchEvent(UP) → setState(SETTLING) → reportDragEnd
   → AbstractStateChangeTouchController.onDragEnd(velocity)
     → 判定 fling：isFling(velocity)
     → 判定落点：targetState = fling ? 速度方向决定 : 进度过线决定
     → 算 startProgress/endProgress/duration
     → anim.start() 启动 settle 动画
   → 动画结束 → onSwipeInteractionCompleted → goToTargetState(ALL_APPS)
   → LauncherStateManager 真正切到 ALL_APPS 态
```

每一步都对应前面章节的具体方法。理解这条时序，就理解了 Launcher3 触摸系统的全部主干。
