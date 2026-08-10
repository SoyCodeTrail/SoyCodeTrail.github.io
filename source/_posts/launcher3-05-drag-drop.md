---
title: Launcher3 源码精读（05）：拖拽机制
category: client
platform: android
tags: ["AOSP", "Launcher3", "源码", "Framework", "DragAndDrop"]
readTime: 25分钟
featured: true
date: 2026-08-02
---

# Launcher3 拖拽机制源码精读

Launcher3 的拖拽是一套自管触摸级框架：用一个浮在 `DragLayer` 顶层的 `DragView` 跟随手指，再通过矩形命中测试找到当前悬停的 `DropTarget`，由目标决定"放下"后做什么。整条链路由 `DragController` 编排，事件来源被 `DragDriver` 抽象成统一回调，来源（`DragSource`）与目标（`DropTarget`）解耦，可自由组合（AllApps→Workspace、Workspace→删除区、跨进程 System DnD→Workspace）。本文按真实源码逐层拆解：时序、状态机、驱动、视图、目标、重排。

> 源码路径：`packages/apps/Launcher3/src/com/android/launcher3/dragndrop/`（核心目录）+ 顶层 `DragSource.java` / `DropTarget.java`。版本基线：aosp-r4。

---

## 一、角色总览与协作拓扑

### 1.1 核心类职责矩阵

| 角色 | 类 | 文件 | 职责 |
|------|-----|------|------|
| 拖拽总控（抽象） | `DragController<T extends ActivityContext>` | `dragndrop/DragController.java` | 状态机、触摸分发、命中测试、生命周期编排；实现 `DragDriver.EventListener` 与 `TouchController` |
| 总控实现 | `LauncherDragController extends DragController<Launcher>` | `dragndrop/LauncherDragController.java` | Launcher 场景特化：创建 `LauncherDragView`、Fling 删除、Widget 缩放、Spring Loaded 退出 |
| 父容器 | `DragLayer extends BaseDragLayer<Launcher>` | `dragndrop/DragLayer.java` | 接管触摸、承载 `DragView`、播放下落动画、绘制拖拽 Scrim |
| 父容器基类 | `BaseDragLayer<T>` | `views/BaseDragLayer.java` | `TouchController` 调度、坐标系换算、System Gesture Region 处理、系统拖拽事件代理 |
| 事件驱动器 | `DragDriver`（抽象）/ `InternalDragDriver` / `SystemDragDriver` | `dragndrop/DragDriver.java` | 把原始 `MotionEvent` / `DragEvent` 翻译成统一的 `EventListener` 回调 |
| 拖拽视图 | `DragView<T>`（抽象）/ `LauncherDragView` | `dragndrop/DragView.java` | 跟随手指的"幻影"，注册点校准、放大动画、Spring 视差、content 复用 |
| 放下目标接口 | `DropTarget` | `DropTarget.java` | `onDrop/onDragEnter/onDragOver/onDragExit/acceptDrop` + 内部类 `DragObject` |
| 拖拽来源接口 | `DragSource` | `DragSource.java` | `onDropCompleted(View target, DragObject d, boolean success)` |
| 拖拽选项 | `DragOptions` | `dragndrop/DragOptions.java` | 携带 accessible/keyboard/simulatedDndStartPoint/`PreDragCondition`/`preDragEndScale` |
| 弹性模式控时 | `SpringLoadedDragController` | `dragndrop/SpringLoadedDragController.kt` | 500ms 切屏 / 950ms 取消拖拽的 `Alarm` |
| Fling 删除 | `FlingToDeleteHelper` | `dragndrop/FlingToDeleteHelper.java` | 速度追踪 + 向上/向左角度判定（≤35°） |
| 系统拖拽控 | `SystemDragController`（sealed）/ `SystemDragControllerImpl` | `dragndrop/SystemDragController.kt` | 处理跨进程 System DnD，注册为 `DragController.SystemDragHandler` |

### 1.2 协作拓扑

```
手指 MotionEvent
     │
     ▼
BaseDragLayer.dispatchTouchEvent / onInterceptTouchEvent
     │  findControllerToHandleTouch(): 遍历 mControllers
     ▼
DragController (是 TouchController 之一)
     │  onControllerInterceptTouchEvent / onControllerTouchEvent
     ▼
DragDriver (Internal 或 System)
     │  onTouchEvent / onDragEvent → 翻译为 EventListener 回调
     ▼
DragController.onDriverDragMove / onDriverDragEnd / onDriverDragCancel
     │  handleMoveEvent → checkTouchMove → findDropTarget
     ▼
DropTarget (Workspace/CellLayout/Hotseat/FolderIcon/ButtonDropTarget...)
     │  onDragEnter / onDragOver / onDragExit / onDrop
     ▼
DragSource.onDropCompleted(target, dragObject, success)
```

### 1.3 三条关键设计意图

**为何 `DragController` 同时是 `TouchController` 又是 `DragDriver.EventListener`？**
拖拽期间它要直接接管触摸（`TouchController`），但事件来源不止触摸一种——键盘无障碍拖拽、跨进程 System DnD 都要驱动同一条状态机。用 `DragDriver` 抽象事件来源、用 `EventListener` 把翻译后的事件回灌自身，状态机就与输入介质彻底解耦。

**为何 `DragView` 要算注册点（registrationX/Y）？**
`DragView` 的尺寸是放大后的位图尺寸，但手指触摸点在原图标的某个像素上。若直接把 `DragView` 左上角对齐触摸点，图标会整体跳到手指右下方。注册点 = "触摸点在 DragView 内部的相对坐标"，`move()` 据此平移，保证视觉上图标始终"挂"在手指原位置。

**为何重排要三方案择优（`MODE_SHOW_REORDER_HINT` / `MODE_DRAG_OVER` / `MODE_ON_DROP`）？**
拖拽过程中性能敏感（每帧 `onDragOver`），不能每次都跑完整让位算法；最终 `onDrop` 又必须算出确定解。三方案对应"实时廉价预览 / 延迟精算 / 落定终解"三档，复用同一份 `ItemConfiguration` 缓存（`mPreviousSolution`），在精度与帧率间取平衡。

---

## 二、拖拽完整时序：从 ACTION_DOWN 到 ACTION_UP

### 2.1 长按触发：ItemLongClickListener → startDrag

长按由各 View 自身的 `CheckLongPressHelper`（或系统 `setOnLongClickListener`）检测，触发 `ItemLongClickListener` 中的静态回调。Workspace 图标用 `INSTANCE_WORKSPACE`，AllApps 用 `INSTANCE_ALL_APPS`：

```java
// ItemLongClickListener.java
public static final OnLongClickListener INSTANCE_WORKSPACE =
        ItemLongClickListener::onWorkspaceItemLongClick; // 工作区图标长按

private static boolean onWorkspaceItemLongClick(View v) {
    Launcher launcher = Launcher.getLauncher(v.getContext());
    if (!canStartDrag(launcher)) return false; // 锁屏/已在拖拽/分屏选择中则放弃
    if (!launcher.isInState(NORMAL)            // 仅 NORMAL/OVERVIEW/EDIT_MODE 可拖
            && !launcher.isInState(OVERVIEW)
            && !launcher.isInState(EDIT_MODE)) {
        return false;
    }
    if (!(v.getTag() instanceof ItemInfo)) return false;
    launcher.setWaitingForResult(null);
    beginDrag(v, launcher, (ItemInfo) v.getTag(), new DragOptions());
    return true;
}

public static boolean canStartDrag(Launcher launcher) {
    if (launcher == null) return false;
    if (launcher.isWorkspaceLocked()) return false;          // 工作区加载中禁止拖
    if (launcher.getDragController().isDragging()) return false; // 已在拖则拒绝二次拖
    if (launcher.isSplitSelectionActive()) return false;     // 分屏选择中禁止
    return true;
}
```

`beginDrag` 区分来源：图标若在 Folder 内则走 `Folder.startDrag`，否则交给 `Workspace.startDrag`：

```java
public static void beginDrag(View v, Launcher launcher, ItemInfo info, DragOptions dragOptions) {
    if (info.container >= 0) {                       // container>=0 表示在 Folder 内
        Folder folder = Folder.getOpen(launcher);
        if (folder != null) {
            if (!folder.getIconsInReadingOrder().contains(v)) {
                folder.close(true);                  // 点的是文件夹外则先关
            } else {
                folder.startDrag(v, dragOptions);    // 文件夹内图标由 Folder 管
                return;
            }
        }
    }
    CellInfo longClickCellInfo = new CellInfo(v, info,
            launcher.getCellPosMapper().mapModelToPresenter(info));
    launcher.getWorkspace().startDrag(longClickCellInfo, dragOptions);
}
```

`Workspace.startDrag` 仅做状态记录（`mDragInfo`、隐藏原 View、可选无障碍监听），真正的拖拽启动在 `beginDragShared`：

```java
// Workspace.java
public void startDrag(CellInfo cellInfo, DragOptions options) {
    mDragInfo = cellInfo;                  // 记录被拖元素原始信息
    cellInfo.cell.setVisibility(INVISIBLE); // 原图标立即隐藏，由 DragView 接管显示
    if (options.isAccessibleDrag) {
        mAccessibilityDragListener = new AccessibleDragListenerAdapter(...) { ... };
    }
    beginDragShared(cellInfo.cell, this, options);
}
```

### 2.2 beginDragShared：构造 DragView 并交给 DragController

`beginDragShared` 是所有内部拖拽的汇聚点，负责：生成预览（`DragPreviewProvider`）、算出 DragLayer 坐标、设置 `PreDragCondition`、调用 `DragController.startDrag`：

```java
public DragView beginDragShared(View child, DraggableView draggableView, DragSource source,
        ItemInfo dragObject, DragPreviewProvider previewProvider, DragOptions dragOptions) {
    child.clearFocus();
    child.setPressed(false);                           // 清掉按下态避免视觉残留

    final View contentView = previewProvider.getContentView();
    final float scale;
    final Drawable drawable;
    if (contentView == null) {
        drawable = previewProvider.createDrawable();   // 普通图标：生成位图 Drawable
        scale = previewProvider.getScaleAndPosition(drawable, mTempXY);
    } else {
        drawable = null;                               // Widget：直接复用真实 View
        scale = previewProvider.getScaleAndPosition(contentView, mTempXY);
    }
    int dragLayerX = mTempXY[0];                       // Drawable 左上在 DragLayer 的 x
    int dragLayerY = mTempXY[1];

    Rect dragRect = new Rect();
    if (draggableView != null) {
        draggableView.getSourceVisualDragBounds(dragRect); // 可视区域边界（去 padding）
        dragLayerY += dragRect.top;
    }
    if (child.getParent() instanceof ShortcutAndWidgetContainer) {
        mDragSourceInternal = (ShortcutAndWidgetContainer) child.getParent(); // 记源容器
    }

    // 预拖条件：长按图标先弹快捷方式，拖动一段距离后才真正进入拖拽
    if (child instanceof BubbleTextView) {
        if (!dragOptions.isAccessibleDrag) {
            dragOptions.preDragCondition =
                    btv.startLongPressAction(mLauncher.getPopupControllerForAppIcons());
        }
    }

    // 把 contentView/drawable 与坐标一起交给 DragController
    final DragView dv;
    if (contentView != null) {
        dv = mDragController.startDrag(contentView, draggableView, dragLayerX, dragLayerY,
                source, dragObject, dragRect, scale * iconScale, scale, dragOptions);
    } else {
        dv = mDragController.startDrag(drawable, draggableView, dragLayerX, dragLayerY,
                source, dragObject, dragRect, scale * iconScale, scale, dragOptions);
    }
    return dv;
}
```

### 2.3 DragController.startDrag：状态机启动核心

抽象基类提供两个便捷重载（Drawable 版 / View 版），最终汇聚到抽象方法；`LauncherDragController` 实现它。这是整条链路最关键的方法，逐段精读：

```java
// LauncherDragController.java
@Override
protected DragView startDrag(@Nullable Drawable drawable, @Nullable View view,
        DraggableView originalView, int dragLayerX, int dragLayerY,
        DragSource source, ItemInfo dragInfo, Rect dragRegion,
        float initialDragViewScale, float dragViewScaleOnDrop, DragOptions options) {

    // ① 鼠标右键拖拽特化：注入一个永不真正启动的 PreDragCondition，
    //    仅用于让原 View 在预拖阶段保持可见（避免 FolderIcon 文字闪烁）
    if (removeAppsRefreshOnRightClick() && mIsInMouseRightClick
            && options.preDragCondition == null && originalView instanceof View v) {
        options.preDragCondition = new PreDragCondition() {
            public boolean shouldStartDrag(double distanceDragged) { return false; }
            public void onPreDragStart(DragObject dragObject) { v.setVisibility(VISIBLE); }
            public void onPreDragEnd(DragObject dragObject, boolean dragStarted) { }
        };
    }

    mActivity.hideKeyboard();
    AbstractFloatingView.closeOpenViews(mActivity, false, TYPE_DISCOVERY_BOUNCE); // 关弹跳提示
    mOptions = options;

    // ② 系统 DnD 起点用 simulatedDndStartPoint 覆盖触摸坐标
    if (mOptions.simulatedDndStartPoint != null) {
        mLastTouch.x = mMotionDown.x = mOptions.simulatedDndStartPoint.x;
        mLastTouch.y = mMotionDown.y = mOptions.simulatedDndStartPoint.y;
    }

    // ③ 注册点校准：触摸点相对于 DragView 左上角的偏移
    final int registrationX = mMotionDown.x - dragLayerX; // 触摸点在 DragView 内的 x
    final int registrationY = mMotionDown.y - dragLayerY;

    mLastDropTarget = null;

    // ④ 构造数据载体与 DragView
    mDragObject = new DropTarget.DragObject(mActivity.getApplicationContext());
    mDragObject.originalView = originalView;
    mIsInPreDrag = mOptions.preDragCondition != null
            && !mOptions.preDragCondition.shouldStartDrag(0); // 是否进入预拖

    final float scalePx;
    if (originalView.getViewType() == DraggableView.DRAGGABLE_WIDGET) {
        scalePx = mIsInPreDrag ? 0f : getWidgetDragScalePx(drawable, view, dragInfo); // Widget 放大像素
    } else {
        scalePx = mIsInPreDrag ? res.getDimensionPixelSize(R.dimen.pre_drag_view_scale) : 0f;
    }
    final DragView dragView = mDragObject.dragView = drawable != null
            ? new LauncherDragView(mActivity, drawable, registrationX, registrationY,
                    initialDragViewScale, dragViewScaleOnDrop, scalePx)
            : new LauncherDragView(mActivity, view, view.getMeasuredWidth(), view.getMeasuredHeight(),
                    registrationX, registrationY, initialDragViewScale, dragViewScaleOnDrop, scalePx);

    dragView.setItemInfo(dragInfo);
    mDragObject.dragComplete = false;
    mDragObject.xOffset = mMotionDown.x - (dragLayerX + dragRegionLeft); // 触摸点相对 cell 左上偏移
    mDragObject.yOffset = mMotionDown.y - (dragLayerY + dragRegionTop);

    // ⑤ 创建驱动；Fling 删除要录速度，故把 recordMotionEvent 作为副事件消费者
    mDragDriver = DragDriver.create(this, mOptions, mFlingToDeleteHelper::recordMotionEvent);
    updateDescendantsAccessibility(dragView, false); // 拖拽中屏蔽子节点无障碍
    if (!mOptions.isAccessibleDrag) {
        mDragObject.stateAnnouncer = DragViewStateAnnouncer.createFor(dragView);
    }
    mDragObject.dragSource = source;
    mDragObject.dragInfo = dragInfo;
    mDragObject.originalDragInfo = mDragObject.dragInfo.makeShallowCopy(); // 留底原始信息

    // ⑥ 触觉反馈 + 显示 + 立即触发一次 move 完成首次命中
    mActivity.getDragLayer().performHapticFeedback(HapticFeedbackConstants.LONG_PRESS);
    dragView.show(mLastTouch.x, mLastTouch.y);
    mDistanceSinceScroll = 0;

    if (!mIsInPreDrag) {
        callOnDragStart();              // 非预拖：立即通知 onDragStart
    } else if (mOptions.preDragCondition != null) {
        mOptions.preDragCondition.onPreDragStart(mDragObject); // 预拖：只通知预拖开始
    }
    handleMoveEvent(mLastTouch.x, mLastTouch.y); // 首帧立即做一次命中

    // ⑦ 不可固定项或触摸已结束：立刻取消（防止事件丢失导致僵尸拖拽）
    if (!isItemPinnable() || (!mIsInPreDrag && !mActivity.isTouchInProgress()
            && options.simulatedDndStartPoint == null)) {
        MAIN_EXECUTOR.post(this::cancelDrag);
    }
    return dragView;
}
```

`callOnDragStart` 是预拖→真拖的切换点，顺带处理 `preDragEndScale`（如 AllApps 图标拖到桌面要放大到桌面尺寸）：

```java
// DragController.java
private static final int DRAG_VIEW_SCALE_DURATION_MS = 500; // 预拖结束缩放时长

protected void callOnDragStart() {
    if (mOptions.preDragCondition != null) {
        mOptions.preDragCondition.onPreDragEnd(mDragObject, true /* dragStarted*/); // 通知预拖结束
    }
    mIsInPreDrag = false;
    if (mOptions.preDragEndScale != 0) { // 预拖结束后的目标缩放（如 AllApps→桌面放大）
        mDragObject.dragView.animate()
                .scaleX(mOptions.preDragEndScale).scaleY(mOptions.preDragEndScale)
                .setInterpolator(Interpolators.EMPHASIZED)
                .setDuration(DRAG_VIEW_SCALE_DURATION_MS) // 500ms
                .start();
    }
    mDragObject.dragView.onDragStart(); // 触发 Spring 视差素材装载
    for (DragListener listener : new ArrayList<>(mListeners)) {
        listener.onDragStart(mDragObject, mOptions); // 通知 Workspace/ButtonDropTarget 等
    }
}
```

### 2.4 触摸分发：onControllerInterceptTouchEvent / onControllerTouchEvent

`BaseDragLayer` 在 `onInterceptTouchEvent` 中调用 `findControllerToHandleTouch`，遍历 `mControllers` 找到第一个 `onControllerInterceptTouchEvent` 返回 true 的控制器。`DragController` 正是其一：

```java
// DragController.java
@Override
public boolean onControllerInterceptTouchEvent(MotionEvent ev) {
    if (mOptions != null && mOptions.isAccessibleDrag) {
        return false; // 无障碍拖拽不接触摸，走 completeAccessibleDrag
    }
    Point dragLayerPos = getClampedDragLayerPos(getX(ev), getY(ev)); // 钳制到 DragLayer 可见区
    mLastTouch.set(dragLayerPos.x, dragLayerPos.y);
    if (ev.getAction() == MotionEvent.ACTION_DOWN) {
        mMotionDown.set(dragLayerPos.x, dragLayerPos.y); // 记录按下点（注册点基准）
    }
    mLastTouchClassification = ev.getClassification(); // 深按压分类（影响预拖距离阈值）
    return mDragDriver != null && mDragDriver.onInterceptTouchEvent(ev);
}

@Override
public boolean onControllerTouchEvent(MotionEvent ev) {
    return mDragDriver != null && mDragDriver.onTouchEvent(ev); // 全部交给驱动翻译
}
```

`LauncherDragController` 覆写拦截仅为了记录鼠标右键标记：

```java
// LauncherDragController.java
@Override
public boolean onControllerInterceptTouchEvent(MotionEvent ev) {
    mIsInMouseRightClick = TouchUtil.isMouseRightClickDownOrMove(ev);
    return super.onControllerInterceptTouchEvent(ev);
}
```

### 2.5 handleMoveEvent：移动处理（预拖判定 + 命中）

驱动把 `ACTION_MOVE` 翻译成 `onDriverDragMove`，进入 `handleMoveEvent`：

```java
// DragController.java
@Override
public void onDriverDragMove(float x, float y) {
    Point dragLayerPos = getClampedDragLayerPos(x, y); // 钳制防越界
    handleMoveEvent(dragLayerPos.x, dragLayerPos.y);
}

private static final int DEEP_PRESS_DISTANCE_FACTOR = 3; // 深按压预拖距离倍数

protected void handleMoveEvent(int x, int y) {
    mDragObject.dragView.move(x, y); // ① 移动 DragView（含 Spring 视差）

    mDistanceSinceScroll += Math.hypot(mLastTouch.x - x, mLastTouch.y - y); // 累计滑动距离
    mLastTouch.set(x, y);

    int distanceDragged = mDistanceSinceScroll;
    if (mLastTouchClassification == MotionEvent.CLASSIFICATION_DEEP_PRESS) {
        distanceDragged /= DEEP_PRESS_DISTANCE_FACTOR; // 深按压需拖 3 倍距离才出预拖
    }
    // ② 预拖→真拖判定
    if (mIsInPreDrag && mOptions.preDragCondition != null
            && mOptions.preDragCondition.shouldStartDrag(distanceDragged)) {
        callOnDragStart();
    }

    checkTouchMove(x, y); // ③ 命中检测
}
```

### 2.6 checkTouchMove：命中检测与 DropTarget 状态机

`checkTouchMove` 维护 `mLastDropTarget`，产生标准的 `onDragEnter/onDragOver/onDragExit` 事件序列。预拖期间完全屏蔽命中（避免预拖时误触目标）：

```java
private DropTarget checkTouchMove(final int x, final int y) {
    if (mIsInPreDrag) {
        return mLastDropTarget; // 预拖阶段不触发任何目标事件
    }
    DropTarget dropTarget = findDropTarget(x, y);
    if (dropTarget != null) {
        if (mLastDropTarget != dropTarget) {        // 切换目标：先 exit 旧的，再 enter 新的
            if (mLastDropTarget != null) {
                mLastDropTarget.onDragExit(mDragObject);
            }
            dropTarget.onDragEnter(mDragObject);
        }
        dropTarget.onDragOver(mDragObject);         // 始终触发 onDragOver
    } else if (mLastDropTarget != null) {           // 离开所有目标：exit 旧的
        mLastDropTarget.onDragExit(mDragObject);
    }
    mLastDropTarget = dropTarget;
    return mLastDropTarget;
}
```

`findDropTarget` 是矩形命中：倒序遍历 `mDropTargets`（后注册的优先级高），第一个 `getHitRectRelativeToDragLayer` 包含点的即命中；都未命中则返回 `getDefaultDropTarget`（Launcher 中即 Workspace）：

```java
private DropTarget findDropTarget(final int x, final int y) {
    mCoordinatesTemp[0] = x;
    mCoordinatesTemp[1] = y;
    final Rect r = mRectTemp;
    final ArrayList<DropTarget> dropTargets = mDropTargets;
    for (int i = dropTargets.size() - 1; i >= 0; i--) { // 倒序：后注册优先
        DropTarget target = dropTargets.get(i);
        if (!target.isDropEnabled()) continue;
        target.getHitRectRelativeToDragLayer(r);
        if (r.contains(x, y)) {
            View dropTargetView = target.getDropView();
            if (dropTargetView != null) {
                mActivity.getDragLayer().mapCoordInSelfToDescendant(dropTargetView, mCoordinatesTemp);
            }
            mDragObject.x = mCoordinatesTemp[0]; // 坐标换算到目标 View 坐标系
            mDragObject.y = mCoordinatesTemp[1];
            return target;
        }
    }
    DropTarget dropTarget = getDefaultDropTarget(mCoordinatesTemp);
    mDragObject.x = mCoordinatesTemp[0];
    mDragObject.y = mCoordinatesTemp[1];
    return dropTarget;
}
```

### 2.7 drop / cancelDrag / endDrag 三者区别

驱动收到 `ACTION_UP` 翻译成 `onDriverDragEnd`，`ACTION_CANCEL` 翻译成 `onDriverDragCancel`：

```java
// DragController.java
@Override
public void onDriverDragEnd(float x, float y) {
    if (!endWithFlingAnimation()) {            // 先判 Fling 删除
        drop(findDropTarget((int) x, (int) y), null);
    }
    endDrag();
}

@Override
public void onDriverDragCancel() {
    cancelDrag();
}
```

**`drop`**：执行"放下"。先把命中目标对齐到 `mLastDropTarget`（补 enter/exit），再调 `acceptDrop` 校验，通过则调 `onDrop`，最后 `dispatchDropComplete` 通知 `DragSource`。注意预拖中直接 return（除非右键刷新特性）：

```java
protected void drop(DropTarget dropTarget, Runnable flingAnimation) {
    if (dropTarget != mLastDropTarget) { // 终态对齐：补齐 enter/exit
        if (mLastDropTarget != null) mLastDropTarget.onDragExit(mDragObject);
        mLastDropTarget = dropTarget;
        if (dropTarget != null) dropTarget.onDragEnter(mDragObject);
    }
    mDragObject.dragComplete = true;

    if (mIsInPreDrag) { // 预拖中放下：不真正 drop（右键刷新特性除外）
        if (removeAppsRefreshOnRightClick()) {
            mDragObject.cancelled = true;
        } else {
            if (dropTarget != null) dropTarget.onDragExit(mDragObject);
            return;
        }
    }

    boolean accepted = false;
    if (dropTarget != null) {
        dropTarget.onDragExit(mDragObject);
        if (!mIsInPreDrag && dropTarget.acceptDrop(mDragObject)) { // 二次校验
            if (flingAnimation != null) {
                flingAnimation.run(); // Fling 删除走自定义动画
            } else {
                dropTarget.onDrop(mDragObject, mOptions); // 正常 drop
            }
            accepted = true;
        }
        dispatchDropComplete(dropTarget.getDropView(), accepted); // 通知 DragSource
    }
}
```

**`cancelDrag`**：取消（外部中断，如 App 被删、Activity 失焦）。先 exit 当前目标，置 `cancelled/dragComplete`，再 `endDrag`：

```java
public void cancelDrag() {
    if (isDragging()) {
        if (mLastDropTarget != null) mLastDropTarget.onDragExit(mDragObject);
        mDragObject.deferDragViewCleanupPostAnimation = false;
        mDragObject.cancelled = true;
        mDragObject.dragComplete = true;
        if (!mIsInPreDrag) {
            dispatchDropComplete(null, false); // 通知源：失败
        }
    }
    endDrag();
}
```

**`endDrag`**：清理视图与监听。`deferDragViewCleanupPostAnimation` 决定是否延迟移除 DragView（成功 drop 时目标要播下落动画，DragView 不能立刻消失）：

```java
protected void endDrag() {
    if (isDragging()) {
        mDragDriver = null;
        boolean isDeferred = false;
        if (mDragObject.dragView != null) {
            isDeferred = mDragObject.deferDragViewCleanupPostAnimation;
            if (!isDeferred) {
                mDragObject.dragView.remove(); // 立即移除
            } else if (mIsInPreDrag) {
                animateDragViewToOriginalPosition(null, null, -1); // 预拖取消：飞回原位
            }
            mDragObject.dragView.clearAnimation();
            mDragObject.dragView = null;
        }
        if (!isDeferred) {
            callOnDragEnd(); // 通知所有 DragListener
        }
        // 延迟分支：等动画结束后由 DragLayer.clearAnimatedView → onDeferredEndDrag 调 callOnDragEnd
    }
}
```

三者的边界：`drop` 是"用户主动放手、可能成功"；`cancelDrag` 是"外部强制中止、必定失败"；`endDrag` 是两者共用的"视图清理尾声"。成功 drop 时 `onDragEnd` 被推迟到下落动画结束（`deferDragViewCleanupPostAnimation=true`），由 `DragLayer.clearAnimatedView → onDeferredEndDrag → callOnDragEnd` 补发。

### 面试深问

**Q1：为什么 `findDropTarget` 倒序遍历 `mDropTargets`？**
后注册的目标视觉上更靠前（如 `DropTargetBar` 的删除/卸载按钮在拖拽开始时才注册），倒序保证上层目标优先命中，避免被底层 Workspace 抢走。

**Q2：`drop` 里为什么先 `onDragExit` 再 `acceptDrop` 再 `onDrop`？**
`onDragExit` 清掉目标在 `onDragOver` 期间产生的临时视觉（如高亮）；`acceptDrop` 是目标的二次确定性校验（`onDragOver` 时 `isDropEnabled` 可能变过）；通过后才 `onDrop` 真正落定。顺序错了会导致目标带临时状态执行 drop。

**Q3：预拖中调用 `drop` 会发生什么？**
正常情况下 `mIsInPreDrag` 为 true 时 `drop` 直接 return（仅 `onDragExit` 当前目标），不触发 `onDrop`，随后 `endDrag` 把 DragView 飞回原位。这保证"长按弹快捷方式后松手"不会误移动图标。

---

## 三、DragController 状态机

### 3.1 状态字段全景

`DragController` 没有显式枚举状态，状态由一组字段隐式表达：

```java
// DragController.java
protected DragDriver mDragDriver = null;          // 非 null 表示有活跃拖拽（含预拖）
public DragOptions mOptions;                       // null 表示完全空闲
protected final Point mMotionDown = new Point();   // 按下点（注册点基准）
protected final Point mLastTouch = new Point();    // 最近触摸点
public DropTarget.DragObject mDragObject;          // 数据载体
private final ArrayList<DropTarget> mDropTargets;  // 已注册目标
private final ArrayList<DragListener> mListeners;  // 拖拽起止监听
protected DropTarget mLastDropTarget;              // 当前悬停目标
private final ArrayList<SystemDragHandler> mSystemDragHandlers; // 系统 DnD 处理者
@Nullable private SystemDragHandler mLastSystemDragHandler;     // 当前锁定的系统拖拽 handler
protected boolean mIsInPreDrag;                    // 是否在预拖
protected int mDistanceSinceScroll = 0;            // 累计滑动距离（用于切屏与预拖）
private int mLastTouchClassification;              // 触摸分类（深按压）
```

`isDragging()` 的判定也反映这套隐式状态：

```java
public boolean isDragging() {
    return mDragDriver != null || (mOptions != null && mOptions.isAccessibleDrag);
}
```

### 3.2 四阶段状态机

| 阶段 | 触发 | mDragDriver | mOptions | mIsInPreDrag | 说明 |
|------|------|-------------|----------|--------------|------|
| IDLE | 初始 / `endDrag` 完成 | null | null | false | 完全空闲 |
| PRE_DRAG | `startDrag` 且有 `preDragCondition` | 非 null | 非 null | true | 已起 DragView 但未触发 `onDragStart`，命中被屏蔽 |
| DRAG_ACTIVE | `callOnDragStart` 后 | 非 null | 非 null | false | 真正拖拽，命中正常工作 |
| DRAG_ENDING | `drop`/`cancelDrag` 调用后 | null（`endDrag` 内置空）| 待清理 | false | 视图清理中，可能延迟到动画结束 |

`PRE_DRAG → DRAG_ACTIVE` 的迁移由 `handleMoveEvent` 中 `shouldStartDrag(distanceDragged)` 判定；`DRAG_ACTIVE → DRAG_ENDING` 由 `onDriverDragEnd`/`onDriverDragCancel` 触发。

### 3.3 callOnDragEnd 与延迟结束

```java
protected void callOnDragEnd() {
    if (mIsInPreDrag && mOptions.preDragCondition != null) {
        mOptions.preDragCondition.onPreDragEnd(mDragObject, false /* dragStarted */); // 预拖未升级即结束
    }
    mIsInPreDrag = false;
    mOptions = null; // 清空，回到 IDLE 的关键标志
    for (DragListener listener : new ArrayList<>(mListeners)) {
        listener.onDragEnd();
    }
}
```

延迟结束链路：成功 drop 时 `DragObject.deferDragViewCleanupPostAnimation=true`（默认值），`endDrag` 跳过 `callOnDragEnd`；下落动画结束后 `DragLayer.clearAnimatedView` 调 `mDragController.onDeferredEndDrag`，再补发 `callOnDragEnd`：

```java
void onDeferredEndDrag(DragView dragView) {
    dragView.remove();
    if (mDragObject.deferDragViewCleanupPostAnimation) {
        callOnDragEnd(); // 补发之前跳过的 onDragEnd
    }
}
```

### 3.4 LauncherDragController 的特化

`LauncherDragController` 覆写四处：

**`exitDrag`**：drop 失败时退出 Spring Loaded 状态（带 500ms 延迟 `SPRING_LOADED_EXIT_DELAY`）：

```java
@Override
protected void exitDrag() {
    if (!mIsInPreDrag && !mActivity.isInState(EDIT_MODE)) {
        mActivity.getStateManager().goToState(NORMAL, SPRING_LOADED_EXIT_DELAY); // 500ms 后回 NORMAL
    }
}
```

**`endWithFlingAnimation`**：抬手时检测 Fling 删除。命中则用 `FlingAnimation` 替代 `onDrop`：

```java
@Override
protected boolean endWithFlingAnimation() {
    if (mDragObject != null && mDragObject.dragView != null) {
        updateDescendantsAccessibility(mDragObject.dragView, true);
    }
    Runnable flingAnimation = mFlingToDeleteHelper.getFlingAnimation(mDragObject, mOptions);
    if (flingAnimation != null) {
        drop(mFlingToDeleteHelper.getDropTarget(), flingAnimation); // 直接 drop 到删除目标
        return true;
    }
    return super.endWithFlingAnimation();
}
```

**`getDefaultDropTarget`**：都未命中时默认 drop 到 Workspace（保证拖出屏幕外也能回到桌面）：

```java
@Override
protected DropTarget getDefaultDropTarget(int[] dropCoordinates) {
    mActivity.getDragLayer().mapCoordInSelfToDescendant(mActivity.getWorkspace(), dropCoordinates);
    return mActivity.getWorkspace();
}
```

**`onControllerInterceptTouchEvent`**：记录鼠标右键标记，供 `startDrag` 注入右键特化的 `PreDragCondition`。

### 3.5 Fling 删除的角度判定

`FlingToDeleteHelper` 用 `VelocityTracker` 算速度，再判方向角：

```java
// FlingToDeleteHelper.java
private static final float MAX_FLING_DEGREES = 35f; // 与竖直/水平方向夹角阈值

private PointF isFlingingToDelete() {
    if (mVelocityTracker == null) return null;
    if (mDropTarget == null) {
        mDropTarget = (ButtonDropTarget) mLauncher.findViewById(R.id.delete_target_text);
    }
    if (mDropTarget == null || !mDropTarget.isDropEnabled()) return null;
    ViewConfiguration config = ViewConfiguration.get(mLauncher);
    mVelocityTracker.computeCurrentVelocity(1000, config.getScaledMaximumFlingVelocity());
    PointF vel = new PointF(mVelocityTracker.getXVelocity(), mVelocityTracker.getYVelocity());
    float theta = MAX_FLING_DEGREES + 1; // 初始超出阈值
    DeviceProfile deviceProfile = mLauncher.getDeviceProfile();
    if (mVelocityTracker.getYVelocity() < deviceProfile.flingToDeleteThresholdVelocity) {
        // 竖屏：判与向上向量 (0,-1) 的夹角
        theta = getAngleBetweenVectors(vel, new PointF(0f, -1f));
    } else if (mLauncher.getDeviceProfile().isVerticalBarLayout()
            && mVelocityTracker.getXVelocity() < deviceProfile.flingToDeleteThresholdVelocity) {
        // 横屏：删除区在左侧，判与向左向量 (-1,0) 的夹角
        theta = getAngleBetweenVectors(vel, new PointF(-1f, 0f));
    }
    if (theta <= Math.toRadians(MAX_FLING_DEGREES)) return vel; // 方向够正才算 fling
    return null;
}
```

速度数据来自 `LauncherDragController.startDrag` 注册的副事件消费者 `mFlingToDeleteHelper::recordMotionEvent`——`InternalDragDriver.onTouchEvent`/`onInterceptTouchEvent` 每帧都把 `MotionEvent` 喂给它。

### 面试深问

**Q1：为什么用一组字段而非显式 enum 表达状态？**
状态迁移点分散在 `startDrag`/`callOnDragStart`/`drop`/`cancelDrag`/`endDrag`，且预拖与正常拖的差别只是 `mIsInPreDrag` 一个布尔。用 enum 反而要在每个迁移点维护一致性，字段组合更贴合实际控制流。

**Q2：`deferDragViewCleanupPostAnimation` 默认 true，谁会把它设成 false？**
`cancelDrag` 与 `dispatchDropComplete`（drop 未被接受时）显式置 false，要求 DragView 立即移除而非等动画。成功 drop 时保持 true，让目标播完下落动画再清理。

**Q3：Fling 删除为什么用角度而非纯速度阈值？**
纯速度无法区分"快速向上甩"和"快速横向划走"。35° 角约束保证只有朝向删除区（竖屏向上、横屏向左）的快速甩动才触发，避免误删。

---

## 四、DragDriver：Internal 与 System 两套驱动

### 4.1 为什么两套

`DragDriver.create` 按起点决定用哪套：

```java
// DragDriver.java
public static DragDriver create(DragController dragController, DragOptions options,
        Consumer<MotionEvent> sec) {
    if (options.simulatedDndStartPoint != null) {        // 系统 DnD 起点非空
        if (options.isAccessibleDrag) {
            return null;                                  // 无障碍系统拖不建驱动
        }
        return new SystemDragDriver(dragController, sec);
    } else {
        return new InternalDragDriver(dragController, sec); // 默认自管
    }
}
```

`simulatedDndStartPoint` 非 null 表示这次拖拽由跨进程 System DnD 触发（如从别的 App 拖文件进来），事件来源是框架的 `DragEvent` 而非触摸。两套驱动的存在是为了：**让同一条 `DragController` 状态机既能处理 Launcher 内部触摸拖拽（低延迟、自管 DragView），又能承接 Android 系统 DnD（跨进程、`DragEvent` 驱动）**。两者事件语义不同（触摸有 DOWN/MOVE/UP，系统 DnD 有 DRAG_STARTED/LOCATION/EXITED/DROP/ENDED），但都能翻译成统一的 `EventListener` 四回调。

### 4.2 EventListener 统一回调

```java
public interface EventListener {
    void onDriverDragMove(float x, float y);
    void onDriverDragExitWindow();
    void onDriverDragEnd(float x, float y);
    void onDriverDragCancel();
}
```

`DragController` 实现这四个方法，驱动只管翻译、不管状态。

### 4.3 InternalDragDriver：触摸翻译

```java
static class InternalDragDriver extends DragDriver {
    private final DragController mDragController;

    @Override
    public boolean onTouchEvent(MotionEvent ev) {
        mSecondaryEventConsumer.accept(ev); // 喂给 Fling 速度追踪
        final int action = ev.getAction();
        switch (action) {
            case MotionEvent.ACTION_MOVE:
                mEventListener.onDriverDragMove(mDragController.getX(ev), mDragController.getY(ev));
                break;
            case MotionEvent.ACTION_UP:
                mEventListener.onDriverDragMove(mDragController.getX(ev), mDragController.getY(ev));
                mEventListener.onDriverDragEnd(mDragController.getX(ev), mDragController.getY(ev));
                break;
            case MotionEvent.ACTION_CANCEL:
                mEventListener.onDriverDragCancel();
                break;
        }
        return true;
    }

    public boolean onInterceptTouchEvent(MotionEvent ev) {
        mSecondaryEventConsumer.accept(ev);
        final int action = ev.getAction();
        switch (action) {
            case MotionEvent.ACTION_UP:
                mEventListener.onDriverDragEnd(mDragController.getX(ev), mDragController.getY(ev));
                break;
            case MotionEvent.ACTION_CANCEL:
                mEventListener.onDriverDragCancel();
                break;
        }
        return true;
    }
}
```

注意 `onInterceptTouchEvent` 也处理 UP/CANCEL——拦截阶段手指可能直接抬起，此时不会再到 `onTouchEvent`。

### 4.4 SystemDragDriver：DragEvent 翻译

```java
static class SystemDragDriver extends DragDriver {
    private final long mDragStartTime;
    float mLastX = 0;
    float mLastY = 0;

    SystemDragDriver(DragController dragController, Consumer<MotionEvent> sec) {
        super(dragController, sec);
        mDragStartTime = SystemClock.uptimeMillis(); // 用于伪造 MotionEvent 的时间戳
    }

    @Override
    public boolean onInterceptTouchEvent(MotionEvent ev) {
        return false; // 系统 DnD 不接触摸
    }

    // 系统 DnD 没有 MotionEvent，但 Fling 追踪需要；伪造一个喂给副消费者
    private void simulateSecondaryMotionEvent(DragEvent event) {
        final int motionAction;
        switch (event.getAction()) {
            case DragEvent.ACTION_DRAG_STARTED:   motionAction = MotionEvent.ACTION_DOWN; break;
            case DragEvent.ACTION_DRAG_LOCATION:  motionAction = MotionEvent.ACTION_MOVE; break;
            case DragEvent.ACTION_DRAG_ENDED:     motionAction = MotionEvent.ACTION_UP; break;
            default: return;
        }
        MotionEvent emulatedEvent = MotionEvent.obtain(mDragStartTime,
                SystemClock.uptimeMillis(), motionAction, event.getX(), event.getY(), 0);
        mSecondaryEventConsumer.accept(emulatedEvent);
        emulatedEvent.recycle();
    }

    @Override
    public boolean onDragEvent(DragEvent event) {
        simulateSecondaryMotionEvent(event);
        final int action = event.getAction();
        switch (action) {
            case DragEvent.ACTION_DRAG_STARTED:
                mLastX = event.getX(); mLastY = event.getY();
                return true;
            case DragEvent.ACTION_DRAG_ENTERED: // 进入接收者窗口，不需翻译
                return true;
            case DragEvent.ACTION_DRAG_LOCATION:
                mLastX = event.getX(); mLastY = event.getY();
                mEventListener.onDriverDragMove(event.getX(), event.getY());
                return true;
            case DragEvent.ACTION_DROP:
                mLastX = event.getX(); mLastY = event.getY();
                mEventListener.onDriverDragMove(event.getX(), event.getY());
                mEventListener.onDriverDragEnd(mLastX, mLastY); // DROP 翻成 end
                return true;
            case DragEvent.ACTION_DRAG_EXITED:
                mEventListener.onDriverDragExitWindow(); // 离开窗口
                return true;
            case DragEvent.ACTION_DRAG_ENDED:
                mEventListener.onDriverDragCancel(); // ENDED 翻成 cancel
                return true;
            default:
                return false;
        }
    }
}
```

`ACTION_DROP` 与 `ACTION_DRAG_ENDED` 的区别：DROP 是"用户在窗口内松手、可能成功"，ENDED 是"整个系统 DnD 结束"（可能 DROP 已发生过或被外部取消）。前者翻成 `onDriverDragEnd`（走 drop 流程），后者翻成 `onDriverDragCancel`。

### 4.5 系统 DnD 的注册与分发

`SystemDragControllerImpl` 注册为 `DragController.SystemDragHandler`：

```java
// SystemDragController.kt
class SystemDragControllerImpl(private val systemDragListenerFactory: SystemDragListenerFactory) :
    SystemDragController(), DragController.SystemDragHandler {

    private var launcher: Launcher? = null
    private var systemDragListener: SystemDragListener? = null

    override fun onDrag(event: DragEvent): Boolean =
        continueDrag(event) ?: startDrag(event) ?: false // 先续拖，再尝试起拖

    override fun setLauncher(launcher: Launcher) {
        if (this.launcher != launcher) {
            this.launcher?.dragController?.removeSystemDragHandler(this)
            this.launcher = launcher.also { it.dragController?.addSystemDragHandler(this) }
        }
    }

    private fun continueDrag(event: DragEvent): Boolean? = systemDragListener?.onDrag(event)

    private fun startDrag(event: DragEvent): Boolean? =
        launcher?.run {
            dragController?.isDragging == false &&
                event.action == DragEvent.ACTION_DRAG_STARTED &&
                systemDragListenerFactory(this)
                    .also { listener ->
                        systemDragListener = listener
                        listener.setCleanupCallback { if (systemDragListener == listener) systemDragListener = null }
                    }
                    .onDrag(event)
        }
}
```

`DragController.onDragEvent` 在 `enableSystemDrag` 开启时分发：`ACTION_DRAG_STARTED` 时倒序找第一个接受的 handler 锁定，后续事件只发给它；若 handler 中途拒绝则取消当前内部拖拽。

### 面试深问

**Q1：为什么 SystemDragDriver 要伪造 MotionEvent 喂给副消费者？**
`FlingToDeleteHelper` 依赖 `VelocityTracker`，而 `VelocityTracker` 只吃 `MotionEvent`。系统 DnD 只有 `DragEvent`，所以伪造一个等价的 `MotionEvent`（用 `mDragStartTime` 保证 down/move/up 时间连续），让 Fling 追踪在系统拖拽下也能工作。

**Q2：`ACTION_DROP` 之后还会来 `ACTION_DRAG_ENDED` 吗？**
会。系统 DnD 协议规定 DROP 后必然跟 ENDED。但因为 DROP 已经触发 `onDriverDragEnd → drop → endDrag`，此时 `mDragDriver` 已置 null，后续 ENDED 到达时 `endDrag` 内 `isDragging()` 为 false，不会重复处理。

**Q3：两套驱动能否在一次拖拽中切换？**
不能。`DragDriver.create` 在 `startDrag` 时一次性决定，整个拖拽周期驱动类型不变。跨场景切换（如内部拖出窗口变成系统拖）需要先 `cancelDrag` 再以新 `simulatedDndStartPoint` 重启。

---

## 五、DragLayer 与 BaseDragLayer：触摸接管与下落动画

### 5.1 TouchController 机制

`BaseDragLayer` 持有一组 `TouchController`，每次 `ACTION_DOWN` 时遍历找出当前活跃的控制器：

```java
// BaseDragLayer.java
protected TouchController[] mControllers;
protected TouchController mActiveController;
protected TouchController mProxyTouchController;

@Override
public boolean onInterceptTouchEvent(MotionEvent ev) {
    int action = ev.getAction();
    if (action == ACTION_UP || action == ACTION_CANCEL) {
        if (mTouchCompleteListener != null) mTouchCompleteListener.onTouchComplete();
        mTouchCompleteListener = null;
    } else if (action == MotionEvent.ACTION_DOWN) {
        mContainer.finishAutoCancelActionMode();
    }
    return findActiveController(ev);
}

private TouchController findControllerToHandleTouch(MotionEvent ev) {
    AbstractFloatingView topView = AbstractFloatingView.getTopOpenView(mContainer);
    if (topView != null
            && (isEventWithinSystemGestureRegion(ev) || topView.canInterceptEventsInSystemGestureRegion())
            && topView.onControllerInterceptTouchEvent(ev)) {
        return topView; // 浮层优先（如 Folder）
    }
    for (TouchController controller : mControllers) {
        if (controller.onControllerInterceptTouchEvent(ev)) {
            return controller; // 第一个拦截的控制器接管整条手势
        }
    }
    return null;
}
```

`DragController` 实现了 `TouchController`，但它只在 `mDragDriver != null`（拖拽进行中）时才真正拦截。拖拽未开始时，长按由各 View 自身的 `CheckLongPressHelper` 检测，触发 `startDrag` 后 `mDragDriver` 才非空，此后触摸才被 `DragController` 接管。这套机制让"长按检测"与"拖拽移动"分属不同控制器，互不干扰。

`DragLayer.recreateControllers` 在状态切换时重建控制器列表：

```java
// DragLayer.java
@Override
public void recreateControllers() {
    super.recreateControllers();
    mControllers = mContainer.createTouchControllers(); // 不同状态有不同的控制器集合
}
```

### 5.2 触摸分发：dispatchTouchEvent 与 proxyTouchEvent

`BaseDragLayer.dispatchTouchEvent` 维护一套 `mTouchDispatchState` 位图，区分事件来自 View 系统、系统手势区、还是 InputMonitor 代理：

```java
// 位图含义
private static final int TOUCH_DISPATCHING_FROM_VIEW = 1 << 0;                // 普通 View 派发
private static final int TOUCH_DISPATCHING_FROM_VIEW_GESTURE_REGION = 1 << 1; // 起于系统手势区
private static final int TOUCH_DISPATCHING_FROM_PROXY = 1 << 2;               // 来自 InputMonitor 代理
private static final int TOUCH_DISPATCHING_TO_VIEW_IN_PROGRESS = 1 << 3;      // DOWN 已派发，等 UP/CANCEL
```

这套机制是为了处理"系统手势（如返回手势）与 Launcher 手势冲突"——起于手势区的事件限制内部手势处理，避免抢走系统返回。

`proxyTouchEvent` 用于从 InputMonitor（如 Taskbar、Recents）代理触摸进来，允许 View 派发与代理派发共存且 View 派发可随时接管：

```java
public boolean proxyTouchEvent(MotionEvent ev, boolean allowViewDispatch) {
    int actionMasked = ev.getActionMasked();
    boolean isViewDispatching = (mTouchDispatchState & TOUCH_DISPATCHING_FROM_VIEW) != 0;
    // View 派发始终优先：若已在 View 派发，或本就是 DOWN/进行中，才允许 View 派发
    allowViewDispatch = allowViewDispatch && !isViewDispatching
            && (actionMasked == ACTION_DOWN
                || ((mTouchDispatchState & TOUCH_DISPATCHING_TO_VIEW_IN_PROGRESS) != 0));
    if (allowViewDispatch) {
        // ... 走正常 super.dispatchTouchEvent
    } else {
        // 否则只走 TouchController（mProxyTouchController）
    }
}
```

### 5.3 DragLayer 的下落动画

成功 drop 时目标（如 Workspace、ButtonDropTarget）调用 `DragLayer.animateViewIntoPosition` 把 DragView 飞到落点。核心是 `animateView`：

```java
// DragLayer.java
public static final int ANIMATION_END_DISAPPEAR = 0;    // 动画结束 DragView 消失
public static final int ANIMATION_END_REMAIN_VISIBLE = 2; // 动画结束保持可见

public void animateView(final DragView view, final Rect to,
        final float finalAlpha, final float finalScaleX, final float finalScaleY, int duration,
        final Interpolator motionInterpolator, final Runnable onCompleteRunnable,
        final int animationEndStyle, View anchorView) {
    view.cancelAnimation();
    view.requestLayout();

    final int[] from = getViewLocationRelativeToSelf(view);
    final float dist = (float) Math.hypot(to.left - from[0], to.top - from[1]); // 距离决定时长
    final Resources res = getResources();
    final float maxDist = (float) res.getInteger(R.integer.config_dropAnimMaxDist);

    if (duration < 0) { // 负值=按距离算时长
        duration = res.getInteger(R.integer.config_dropAnimMaxDuration);
        if (dist < maxDist) {
            duration *= DECELERATE_1_5.getInterpolation(dist / maxDist);
        }
        duration = Math.max(duration, res.getInteger(R.integer.config_dropAnimMinDuration));
    }

    TimeInterpolator interpolator = motionInterpolator == null ? DECELERATE_1_5 : motionInterpolator;

    PendingAnimation anim = new PendingAnimation(duration);
    anim.add(ofFloat(view, View.SCALE_X, finalScaleX), interpolator, SpringProperty.DEFAULT);
    anim.add(ofFloat(view, View.SCALE_Y, finalScaleY), interpolator, SpringProperty.DEFAULT);
    anim.setViewAlpha(view, finalAlpha, interpolator);
    anim.setFloat(view, VIEW_TRANSLATE_Y, to.top, interpolator);

    ObjectAnimator xMotion = ofFloat(view, VIEW_TRANSLATE_X, to.left);
    if (anchorView != null) { // 锚点（如 AllApps 滚动时补偿）
        final int startScroll = anchorView.getScrollX();
        TypeEvaluator<Float> evaluator = (f, s, e) -> mapRange(f, s, e)
                + (anchorView.getScaleX() * (startScroll - anchorView.getScrollX()));
        xMotion.setEvaluator(evaluator);
    }
    anim.add(xMotion, interpolator, SpringProperty.DEFAULT);
    if (onCompleteRunnable != null) {
        anim.addListener(forEndCallback(onCompleteRunnable));
    }
    playDropAnimation(view, anim.buildAnim(), animationEndStyle);
}
```

`playDropAnimation` 维护 `mDropAnim/mDropView`，结束时若 `ANIMATION_END_DISAPPEAR` 则 `clearAnimatedView` 触发 `onDeferredEndDrag`（补发 `callOnDragEnd`）：

```java
public void playDropAnimation(final DragView view, Animator animator, int animationEndStyle) {
    if (mDropAnim != null) mDropAnim.cancel(); // 取消上一个
    mDropView = view;
    mDropAnim = animator;
    mDropAnim.addListener(forEndCallback(() -> mDropAnim = null));
    if (animationEndStyle == ANIMATION_END_DISAPPEAR) {
        mDropAnim.addListener(forEndCallback(this::clearAnimatedView)); // 结束清理并补发 onDragEnd
    }
    mDropAnim.start();
}

public DragView clearAnimatedView() {
    if (mDropAnim != null) mDropAnim.cancel();
    mDropAnim = null;
    if (mDropView != null) {
        mDragController.onDeferredEndDrag(mDropView); // 补发 callOnDragEnd
    }
    DragView ret = mDropView;
    mDropView = null;
    invalidate();
    return ret;
}
```

### 5.4 绘制顺序：DragView 总在最上

`DragLayer` 用 `getChildDrawingOrder` 保证 `DragView` 绘制在所有子 View 之上：

```java
@Override
protected int getChildDrawingOrder(int childCount, int i) {
    if (mChildCountOnLastUpdate != childCount) updateChildIndices(); // 兼容旧平台回调时机
    if (mTopViewIndex == -1) return i;     // 没有 DragView：默认顺序
    else if (i == childCount - 1) return mTopViewIndex; // 最后一帧画 DragView
    else if (i < mTopViewIndex) return i;
    else return i + 1;                     // 其余跳过 DragView 的位置
}
```

### 面试深问

**Q1：为什么 `DragController` 在拖拽未开始时不拦截触摸？**
长按检测依赖各 View 的 `CheckLongPressHelper`（基于 `Handler.postDelayed`），需要 View 自己收到 `ACTION_DOWN` 才能启动计时。若 `DragController` 提前拦截，长按无法触发，拖拽就永远起不来。只在 `startDrag` 后（`mDragDriver != null`）才接管，形成"长按检测→startDrag→接管触摸"的单向流转。

**Q2：下落动画时长为什么按距离算？**
固定时长会让短距离飞得过慢、长距离过快，违逆物理直觉。`DECELERATE_1_5` 插值 + 最小时长保底，让近距离仍可见、远距离不拖沓。

**Q3：`proxyTouchEvent` 解决什么问题？**
Taskbar、Recents 等组件通过 `InputMonitor` 拿到的事件不在普通 View 派发链里，但它们又想让 Launcher 的 TouchController 处理。`proxyTouchEvent` 把代理事件喂进控制器系统，同时用位图保证普通 View 派发优先级更高（一旦 View 系统开始派发，代理让位）。

---

## 六、DragView：跟随手指的视图

### 6.1 注册点校准原理

`DragView` 是 `FrameLayout` 子类，内部包一个 `mContent`（图标 ImageView 或 Widget View）。注册点 `mRegistrationX/Y` 表示"触摸点在 DragView 内部的相对坐标"，是视觉对齐的关键：

```java
// DragView.java
protected final int mRegistrationX; // 触摸点在 DragView 内的 x 偏移
protected final int mRegistrationY;

private void applyTranslation() {
    setTranslationX(mLastTouchX - mRegistrationX + mAnimatedShiftX); // 触摸点 - 注册点 = 左上角
    setTranslationY(mLastTouchY - mRegistrationY + mAnimatedShiftY);
}

public void move(int touchX, int touchY) {
    if (touchX > 0 && touchY > 0 && mLastTouchX > 0 && mLastTouchY > 0
            && mScaledMaskPath != null) {
        // Spring 视差：前后景按手指移动方向反向偏移
        mTranslateX.animateToPos(mLastTouchX - touchX);
        mTranslateY.animateToPos(mLastTouchY - touchY);
    }
    mLastTouchX = touchX;
    mLastTouchY = touchY;
    applyTranslation();
}
```

注册点在 `LauncherDragController.startDrag` 算出：`registrationX = mMotionDown.x - dragLayerX`。`dragLayerX/Y` 是 Drawable 左上角在 DragLayer 的坐标，`mMotionDown` 是触摸点，相减得到触摸点相对 Drawable 左上的偏移。这样 `DragView` 平移时，触摸点始终对应 Drawable 上的同一像素，视觉无跳动。

### 6.2 show 的放大动画

`show` 把 DragView 加进 DragLayer 并播放入场缩放：

```java
public static final int VIEW_ZOOM_DURATION = 150; // 入场缩放时长

public DragView(T activity, View content, int width, int height, int registrationX,
        int registrationY, final float initialScale, final float scaleOnDrop,
        final float finalScaleDps) {
    super(activity);
    mActivity = activity;
    mDragLayer = activity.getDragLayer();
    mContent = content;
    mWidth = width;
    mHeight = height;
    // ... 复用 content 逻辑（见 6.3）
    mEndScale = (width + finalScaleDps) / width; // 终态缩放（含放大像素）
    setScaleX(initialScale); // 设初始缩放避免跳变
    setScaleY(initialScale);

    mScaleAnim = ValueAnimator.ofFloat(0f, 1f);
    mScaleAnim.setDuration(VIEW_ZOOM_DURATION);
    mScaleAnim.addUpdateListener(animation -> {
        final float value = (Float) animation.getAnimatedValue();
        setScaleX(Utilities.mapRange(value, initialScale, mEndScale)); // 从 initial 到 end 插值
        setScaleY(Utilities.mapRange(value, initialScale, mEndScale));
        if (!isAttachedToWindow()) animation.cancel();
    });
    // ...
}

public void show(int touchX, int touchY) {
    mDragLayer.addView(this);
    BaseDragLayer.LayoutParams lp = new BaseDragLayer.LayoutParams(mWidth, mHeight);
    lp.customPosition = true; // 自定义定位，不走 FrameLayout 默认布局
    setLayoutParams(lp);
    if (mContent != null) {
        if (getHasDragOffset()) {
            mContent.setVisibility(INVISIBLE); // 有 dragOffset 时隐藏原 content（避免重影）
        } else {
            mContent.setVisibility(VISIBLE);
        }
    }
    move(touchX, touchY);
    post(mScaleAnim::start); // post 到下一帧，避开首帧其他重活
}
```

### 6.3 content 复用机制

构造时若 `mContent` 已有父 View，先把它从原父 View 摘下、记录原位置，再加进自己：

```java
mContentViewLayoutParams = mContent.getLayoutParams();
if (mContent.getParent() instanceof ViewGroup) {
    mContentViewParent = (ViewGroup) mContent.getParent();
    mContentViewInParentViewIndex = mContentViewParent.indexOfChild(mContent);
    mContentViewParent.removeView(mContent); // 从原父摘下
}
addView(content, new LayoutParams(width, height)); // 挂到 DragView
```

这是 Widget 拖拽的关键：Widget 是真实的 `AppWidgetHostView`，直接复用而非截图，拖拽中 Widget 仍能交互/更新。拖拽结束后 `detachContentView` 决定是否还回原父：

```java
public void detachContentView(boolean reattachToPreviousParent) {
    if (mContent != null && mContentViewParent != null && mContentViewInParentViewIndex >= 0) {
        // 把当前 content 绘到 Picture，作为 DragView 的新背景（保留视觉）
        Picture picture = new Picture();
        mContent.draw(picture.beginRecording(mWidth, mHeight));
        picture.endRecording();
        View view = new View(mActivity);
        view.setBackground(new PictureDrawable(picture));
        view.measure(makeMeasureSpec(mWidth, EXACTLY), makeMeasureSpec(mHeight, EXACTLY));
        view.layout(mContent.getLeft(), mContent.getTop(), mContent.getRight(), mContent.getBottom());
        setClipToOutline(mContent.getClipToOutline());
        setOutlineProvider(mContent.getOutlineProvider());
        addViewInLayout(view, indexOfChild(mContent), mContent.getLayoutParams(), true);
        removeViewInLayout(mContent); // 摘下真实 content
        mContent.setVisibility(INVISIBLE);
        mContent.setLayoutParams(mContentViewLayoutParams);
        if (reattachToPreviousParent) {
            mContentViewParent.addView(mContent, mContentViewInParentViewIndex); // 还回原父
        }
        mContentViewParent = null;
        mContentViewInParentViewIndex = -1;
    }
}
```

`reattachToPreviousParent=true` 用于 drop 取消（图标飞回原位），`false` 用于 drop 成功到新位置（content 由目标接管）。用 `Picture` 快照替换是为了让 DragView 在动画期间仍有视觉内容（真实 content 已被移走）。

### 6.4 SpringFloatValue 弹性视差

AdaptiveIcon 的图标在拖拽时前景相对背景做弹性视差，由 `SpringFloatValue` 驱动：

```java
private static class SpringFloatValue {
    private static final int STIFFNESS = 4000;            // 弹簧刚度
    private static final float DAMPENING_RATIO = 1f;      // 临界阻尼（不震荡）
    private static final int PARALLAX_MAX_IN_DP = 8;      // 最大视差 8dp

    private final View mView;
    private final SpringAnimation mSpring;
    private final float mDelta;
    private float mValue;

    public SpringFloatValue(View view, float range) {
        mView = view;
        mSpring = new SpringAnimation(this, VALUE, 0)
                .setMinValue(-range).setMaxValue(range)
                .setSpring(new SpringForce(0)
                        .setDampingRatio(DAMPENING_RATIO)
                        .setStiffness(STIFFNESS));
        mDelta = Math.min(range, view.getResources().getDisplayMetrics().density * PARALLAX_MAX_IN_DP);
    }

    public void animateToPos(float value) {
        mSpring.animateToFinalPosition(Utilities.boundToRange(value, -mDelta, mDelta)); // 钳到 ±8dp
    }
}
```

`setItemInfo` 在后台线程解析 AdaptiveIcon，拿到前景/背景 Drawable 与 mask Path，`onDragStart` 时切换渲染路径：

```java
public void onDragStart() {
    mOnDragStartCallback.executeAllAndDestroy(); // 触发后台已准备好的 mask/Drawable 装载
}

@Override
public void draw(Canvas canvas) {
    super.draw(canvas);
    mHasDrawn = true;
    if (mScaledMaskPath != null) {
        int cnt = canvas.save();
        canvas.clipPath(mScaledMaskPath);      // 按 icon 形状裁剪
        mBgSpringDrawable.draw(canvas);        // 背景固定
        canvas.translate(mTranslateX.mValue, mTranslateY.mValue);
        mFgSpringDrawable.draw(canvas);        // 前景按视差偏移
        canvas.restoreToCount(cnt);
        mBadge.draw(canvas);                   // 角标固定
    }
}
```

设计意图：让"图标有立体感、像被拎起"，且手指快速划动时前景拖在后面（弹簧延迟），松手回弹到中心，强化物理真实感。8dp 上限避免视差过大导致前景飞出背景。

### 6.5 LauncherDragView 的状态联动

`LauncherDragView` 监听 Launcher 状态切换，在非拖拽相关状态（如 ALL_APPS）下隐藏自己：

```java
// LauncherDragView.java
@Override
public void onStateTransitionComplete(LauncherState finalState) {
    setVisibility((finalState == LauncherState.NORMAL
            || finalState == LauncherState.SPRING_LOADED
            || finalState == LauncherState.EDIT_MODE) ? VISIBLE : INVISIBLE);
}

@Override
public void animateTo(int toTouchX, int toTouchY, Runnable onCompleteRunnable, int duration) {
    mTempLoc[0] = toTouchX - mRegistrationX; // 终点也按注册点换算
    mTempLoc[1] = toTouchY - mRegistrationY;
    mActivity.getDragLayer().animateViewIntoPosition(this, mTempLoc, 1f, mScaleOnDrop,
            mScaleOnDrop, DragLayer.ANIMATION_END_DISAPPEAR, onCompleteRunnable, duration);
}
```

### 面试深问

**Q1：注册点为什么不能直接用触摸坐标当 DragView 左上角？**
图标 Drawable 通常比触摸点大（手指按在图标中心偏上），若左上角对齐触摸点，图标整体右下移，视觉上"图标从手指位置跳走"。注册点记录触摸点在 Drawable 内的偏移，`move` 时 `translation = touch - registration`，保证 Drawable 上原触摸像素始终贴着手指。

**Q2：Widget 拖拽为什么不截图而复用真实 View？**
Widget 是 `AppWidgetHostView`，可能含交互（时钟跳动、按钮），截图会变成死画面。复用真实 View 保证拖拽中 Widget 仍更新。代价是 View 树结构复杂（content 摘挂），所以用 `detachContentView` 配合 `Picture` 快照处理动画期的视觉过渡。

**Q3：Spring 视差为什么用临界阻尼（`DAMPENING_RATIO=1`）？**
欠阻尼会反复震荡，手指停住后前景还在晃，显得不稳重；过阻尼回弹太慢，没有弹性感。临界阻尼是最快无超调的回复，配合 4000 刚度让响应迅速，视觉"跟手又不飘"。

---

## 七、DropTarget 与 DragSource 接口

### 7.1 DropTarget 接口

```java
// DropTarget.java
public interface DropTarget {
    boolean isDropEnabled();                              // 当前是否可接收 drop
    void onDrop(DragObject dragObject, DragOptions options); // 真正放下处理
    void onDragEnter(DragObject dragObject);              // 进入目标
    void onDragOver(DragObject dragObject);               // 在目标上移动（高频）
    void onDragExit(DragObject dragObject);               // 离开目标
    boolean acceptDrop(DragObject dragObject);            // drop 前二次校验
    void prepareAccessibilityDrop();                      // 无障碍 drop 前准备
    void getHitRectRelativeToDragLayer(Rect outRect);     // 命中矩形（相对 DragLayer）
    default View getDropView() { return (View) this; }    // 坐标换算目标 View
}
```

`getDropView` 默认返回 `this`，`findDropTarget` 命中后用它把 DragLayer 坐标换算到目标 View 坐标系，写入 `DragObject.x/y`。

### 7.2 DragObject 数据载体

```java
class DragObject {
    public int x = -1;        // 当前触摸点（已换算到目标坐标系）
    public int y = -1;
    public int xOffset = -1;  // 触摸点相对 cell 左上的 x 偏移
    public int yOffset = -1;  // 触摸点相对 cell 左上的 y 偏移
    public boolean dragComplete = false; // 是否进入终态（drop/cancel）
    public DragView dragView = null;     // 跟随手指的视图
    public ItemInfo dragInfo = null;     // 被拖元素信息（可能被目标改写）
    public ItemInfo originalDragInfo = null; // 原始信息（不被改写）
    public DragSource dragSource = null; // 拖拽来源
    public boolean cancelled = false;    // 是否被取消
    public boolean deferDragViewCleanupPostAnimation = true; // 延迟清理 DragView
    public DragViewStateAnnouncer stateAnnouncer; // 无障碍播报
    public FolderNameSuggestionLoader folderNameSuggestionLoader; // 文件夹名建议
    public DraggableView originalView = null; // 源 View
    public final InstanceId logInstanceId = ...; // 日志追踪

    public final float[] getVisualCenter(float[] recycle) {
        final float res[] = (recycle == null) ? new float[2] : recycle;
        Rect dragRegion = dragView.getDragRegion();
        int left = x - xOffset - dragRegion.left;
        int top = y - yOffset - dragRegion.top;
        res[0] = left + dragRegion.width() / 2;  // 可视中心 x
        res[1] = top + dragRegion.height() / 2;  // 可视中心 y
        return res;
    }
}
```

`getVisualCenter` 的意义：用户对"图标在哪"的感知是图标的视觉中心，而非手指位置（手指可能按在图标边缘）。所有重排、文件夹创建、命中判定都用视觉中心，保证落点符合直觉。算法是"触摸点 - 偏移 - dragRegion 左上 + 半宽高"，其中 `xOffset/yOffset` 把触摸点折回 cell 左上，再 `dragRegion` 裁掉透明边距，最后取中心。

### 7.3 DragSource 接口

```java
// DragSource.java
public interface DragSource {
    void onDropCompleted(View target, DragObject d, boolean success);
}
```

极简：drop 完成后回调来源。`success=true` 时来源负责从原位置移除元素，`false` 时负责还原（如把图标设回可见）。`Workspace.onDropCompleted` 是典型实现：

```java
// Workspace.java
@Override
public void onDropCompleted(final View target, final DragObject d, final boolean success) {
    if (success) {
        if (target != this && mDragInfo != null) {
            removeWorkspaceItem(mDragInfo.cell); // 成功且目标非自己：从原位移除
        }
    } else if (mDragInfo != null) {
        // 取消：Widget 还回原父；普通图标 cell 重新挂回
        if (mDragInfo.cell instanceof LauncherAppWidgetHostView && d.dragView != null) {
            d.dragView.detachContentView(true /* reattachToPreviousParent */);
        }
        final CellLayout cellLayout = mLauncher.getCellLayout(mDragInfo.container, mDragInfo.screenId);
        if (cellLayout != null) {
            cellLayout.onDropChild(mDragInfo.cell); // 重新挂回
        }
    }
    View cell = getViewByItemId(d.originalDragInfo.id);
    if (d.cancelled && cell != null) {
        cell.setVisibility(VISIBLE); // 取消时恢复原图标可见
    }
    mDragInfo = null;
}
```

### 7.4 DropTarget 的实现类与各自 onDrop

| 实现类 | 文件 | onDrop 干什么 |
|--------|------|---------------|
| `Workspace` | `Workspace.java` | 内部移动：`performReorder` 重排后 `addInScreen`；外部来源：`onDropExternal`（创建 `WorkspaceItemInfo` 并落位）；文件夹：`createUserFolderIfNecessary`/`addToExistingFolderIfNecessary` |
| `CellLayout` | `CellLayout.java` | 被 Workspace 委托，自身不直接接 DropTarget 事件；提供 `performReorder`/`visualizeDropLocation` |
| `Hotseat` | 通过 Workspace 的 `shouldUseHotseatAsDropLayout` 判定 | 实际 drop 仍走 Workspace（`dropTargetLayout` 指向 Hotseat 的 CellLayout） |
| `FolderIcon` | `folder/FolderIcon.java` | `onDrop` 把元素加入文件夹：`onDrop(item, d, ...)` 更新预览、`mFolder.add(item)` |
| `ButtonDropTarget`（抽象） | `ButtonDropTarget.java` | 通用：算 `getIconRect`，`detachContentView`，`animateView` 飞向按钮图标，动画结束调 `completeDrop` |
| `DeleteDropTarget` | `DeleteDropTarget.java` | `completeDrop` 调 `mDropTargetHandler.onDeleteComplete` 从工作区与数据库删除；不可删项（`id==NO_ID`）走取消 |
| `SecondaryDropTarget` | `SecondaryDropTarget.java` | 卸载/重新配置：包装 `DeferredOnComplete` 延迟到卸载结果返回；`performDropAction` 拉起卸载 Intent |

**ButtonDropTarget.onDrop** 通用流程：

```java
// ButtonDropTarget.java
private static final int DRAG_VIEW_DROP_DURATION = 285; // 飞向按钮时长
private static final float DRAG_VIEW_HOVER_OVER_OPACITY = 0.65f; // 悬停时 DragView 透明度

@Override
public void onDrop(final DragObject d, final DragOptions options) {
    if (options.isFlingToDelete) return; // Fling 动画自己处理

    final DragLayer dragLayer = mDropTargetHandler.getDragLayer();
    final DragView dragView = d.dragView;
    final Rect to = getIconRect(d); // 飞向按钮图标的矩形
    final float scale = (float) to.width() / dragView.getMeasuredWidth();
    dragView.detachContentView(true /* reattachToPreviousParent */); // content 还回原父

    mDropTargetBar.deferOnDragEnd();
    Runnable onAnimationEndRunnable = () -> {
        completeDrop(d);                       // 子类实现具体动作
        mDropTargetBar.onDragEnd();
        mDropTargetHandler.onDropAnimationComplete();
    };
    dragLayer.animateView(d.dragView, to, scale, 0.1f, 0.1f,
            DRAG_VIEW_DROP_DURATION, Interpolators.DECELERATE_2, onAnimationEndRunnable,
            DragLayer.ANIMATION_END_DISAPPEAR, null);
}
```

**DeleteDropTarget.completeDrop**：

```java
// DeleteDropTarget.java
@Override
public void completeDrop(DragObject d) {
    ItemInfo item = d.dragInfo;
    if (canRemove(item)) { // canRemove = item.id != NO_ID
        mDropTargetHandler.onDeleteComplete(item, null); // 从工作区与 DB 删
    }
}
```

`canRemove` 判定很关键：从 AllApps 拖来的项 `id == NO_ID`（尚未添加到数据库），此时 drop 显示"取消"文案，不删除，相当于放弃添加。

**SecondaryDropTarget.onDrop** 用 `DeferredOnComplete` 包装 `DragSource`，把 `onDropCompleted` 延迟到卸载 Activity 返回结果：

```java
// SecondaryDropTarget.java
@Override
public void onDrop(DragObject d, DragOptions options) {
    d.dragSource = new DeferredOnComplete(d.dragSource, getContext()); // 包装源，延迟回调
    super.onDrop(d, options);
    doLog(d.logInstanceId, d.originalDragInfo, mCurrentAccessibilityAction);
}
```

### 7.5 ButtonDropTarget 的激活阈值

按钮目标不是一拖就激活，要拖够距离才出现：

```java
// ButtonDropTarget.java
@Override
public boolean isDropEnabled() {
    return mActive && (mAccessibleDrag ||
            mActivityContext.getDragController().getDistanceDragged()
                    >= mDragDistanceThreshold); // 拖够阈值才启用
}
```

`mDragDistanceThreshold` 来自 `R.dimen.drag_distanceThreshold`，避免轻微挪动就弹出删除按钮。

### 面试深问

**Q1：`getVisualCenter` 为什么要减 `xOffset` 再减 `dragRegion.left`？**
`x` 是触摸点（目标坐标系）。`xOffset` 是触摸点相对 cell 左上的偏移，减它得到 cell 左上。`dragRegion` 裁掉图标透明边距（让拖拽更精准），再减 `dragRegion.left` 得到可视区域左上，加半宽高得中心。三步把"手指位置"换算成"用户感知的图标中心"。

**Q2：为什么 `acceptDrop` 和 `isDropEnabled` 是两道独立校验？**
`isDropEnabled` 控制 `findDropTarget` 是否命中（高频，每帧），`acceptDrop` 是 drop 瞬间的最终确认（低频）。分离让目标能在 hover 期间动态调整可命中性（如拖够距离才开），又在 drop 前做确定性检查（如目标状态刚好变化），避免命中后状态突变导致 drop 到无效目标。

**Q3：`SecondaryDropTarget` 为什么要延迟 `onDropCompleted`？**
卸载是异步的（拉起系统卸载 Activity），`onDrop` 返回时结果未知。若立即回调 `onDropCompleted(success=true)`，源会把图标从工作区删掉，但用户可能取消卸载，导致图标丢失。`DeferredOnComplete` 把回调挂起，等卸载结果返回再决定 success，保证数据一致。

---

## 八、DragOptions 与 PreDragCondition

### 8.1 DragOptions 字段

```java
// DragOptions.java
public boolean isAccessibleDrag = false;     // 无障碍拖拽（键盘/ TalkBack）
public boolean isKeyboardDrag = false;       // 键盘驱动
public Point simulatedDndStartPoint = null;  // 系统 DnD 起点（非 null 用 SystemDragDriver）
public PreDragCondition preDragCondition = null; // 预拖条件
public float preDragEndScale;                // 预拖结束后的目标缩放
public float intrinsicIconScaleFactor = 1f;  // 图标固有缩放因子
public boolean isFlingToDelete;              // 是否 Fling 删除（运行时填）
```

### 8.2 PreDragCondition 预拖机制

预拖解决"长按图标既要弹快捷方式、又要能拖动"的冲突。长按后先进入预拖（DragView 已显示、但 `onDragStart` 未触发、命中被屏蔽），用户拖动一段距离后才升级为真拖：

```java
// DragOptions.java
public interface PreDragCondition {
    boolean shouldStartDrag(double distanceDragged); // 拖够距离返回 true 才升级
    void onPreDragStart(DropTarget.DragObject dragObject); // 预拖开始
    void onPreDragEnd(DropTarget.DragObject dragObject, boolean dragStarted); // 预拖结束（升级或取消）
    default Point getDragOffset() { return new Point(0,0); } // 拖拽偏移（影响 content 显示位置）
}
```

典型生产者：`BubbleTextView.startLongPressAction` 返回的 `PreDragCondition`——长按图标弹出 DeepShortcuts，拖动超过阈值后才真正移动图标。这样用户可以"长按→选快捷方式"或"长按→拖动"两种交互共存。

`LauncherDragController.startDrag` 里的鼠标右键特化是另一例：注入一个 `shouldStartDrag` 永远返回 false 的条件，让右键拖拽永远停在预拖阶段（仅用于刷新 Remove Apps，不真正移动图标）。

`preDragEndScale` 用于跨尺寸场景：AllApps 图标比桌面图标小，拖到桌面要放大，预拖结束时按 `preDragEndScale` 缩放（`beginDragShared` 中 `btv.isDisplaySearchResult()` 时设置）。

### 面试深问

**Q1：预拖期间 `checkTouchMove` 被屏蔽，会不会漏掉目标切换？**
不会。预拖升级为真拖时 `callOnDragStart` 后，`handleMoveEvent` 立即被下一次 `ACTION_MOVE` 触发，`checkTouchMove` 重新工作。预拖期间本来就不该触发目标（用户意图未定），屏蔽是预期行为。

**Q2：`shouldStartDrag` 的距离为什么深按压要除以 3？**
深按压（`CLASSIFICATION_DEEP_PRESS`）通常伴随较大初始形变，普通阈值会过早升级。`DEEP_PRESS_DISTANCE_FACTOR=3` 让深按压需拖 3 倍距离，避免重压误触发拖动。

**Q3：`preDragEndScale` 与 `DragView` 的 `mEndScale` 有何区别？**
`mEndScale` 是 `show()` 入场动画的终态缩放（由 `finalScaleDps` 决定，一次性）；`preDragEndScale` 是预拖升级时的额外缩放（如 AllApps→桌面的尺寸适配，独立动画）。两者叠加决定 DragView 的最终视觉大小。

---

## 九、重排算法（拖拽触发部分）

> 完整的重排算法（推挤/整块移动/最近空位）在 02 文档详述。本节只讲拖拽如何触发重排、何时触发、跨屏如何处理。

### 9.1 Workspace 触发 CellLayout 重排的链路

拖拽开始时 Workspace 作为 `DragListener` 收到 `onDragStart`，进入 Spring Loaded 状态并加临时空屏：

```java
// Workspace.java
@Override
public void onDragStart(DragObject dragObject, DragOptions options) {
    if (mDragInfo != null && mDragInfo.cell != null) {
        CellLayout layout = (CellLayout) (mDragInfo.cell instanceof LauncherAppWidgetHostView
                ? dragObject.dragView.getContentViewParent().getParent()
                : mDragInfo.cell.getParent().getParent());
        layout.markCellsAsUnoccupiedForView(mDragInfo.cell); // 拖起后原 cell 标记为空
    }

    boolean addNewPage = !(options.isAccessibleDrag && dragObject.dragSource != this);
    if (addNewPage) {
        mDeferRemoveExtraEmptyScreen = false;
        addExtraEmptyScreenOnDrag(dragObject); // 加临时空屏
        // Widget 从外部拖入：跳到有空间的页
        if (dragObject.dragInfo.itemType == ITEM_TYPE_APPWIDGET && dragObject.dragSource != this) {
            int currentPage = getDestinationPage();
            for (int pageIndex = currentPage; pageIndex < getPageCount(); pageIndex++) {
                CellLayout page = (CellLayout) getPageAt(pageIndex);
                if (page.hasReorderSolution(dragObject.dragInfo)) {
                    setCurrentPage(pageIndex);
                    break;
                }
            }
        }
    }
    if (!mLauncher.isInState(EDIT_MODE)) {
        mLauncher.getStateManager().goToState(SPRING_LOADED); // 进入弹性模式
    }
}
```

`onDragOver` 是重排的核心驱动，每次移动都重新判定落点布局、距离、是否触发重排：

```java
// Workspace.java
public void onDragOver(DragObject d) {
    if (!transitionStateShouldAllowDrop()) return; // 状态切换中不处理
    ItemInfo item = d.dragInfo;
    mDragViewVisualCenter = d.getVisualCenter(mDragViewVisualCenter); // 视觉中心

    // ① 判定落点布局（当前页/邻页/Hotseat），变化则切换 mDragTargetLayout
    if (setDropLayoutForDragObject(d, mDragViewVisualCenter[0], mDragViewVisualCenter[1])) {
        if (mDragTargetLayout == null || mLauncher.isHotseatLayout(mDragTargetLayout)) {
            mSpringLoadedDragController.cancel(); // Hotseat/无目标：取消切屏 alarm
        } else {
            mSpringLoadedDragController.setAlarm(mDragTargetLayout); // 设置切屏 alarm
        }
    }

    if (mDragTargetLayout != null) {
        mapPointFromDropLayout(mDragTargetLayout, mDragViewVisualCenter); // 换算到目标布局坐标
        mTargetCell = findNearestArea((int) mDragViewVisualCenter[0],
                (int) mDragViewVisualCenter[1], item.spanX, item.spanY,
                mDragTargetLayout, mTargetCell); // 最近格位
        setCurrentDropOverCell(mTargetCell[0], mTargetCell[1]);

        float targetCellDistance = mDragTargetLayout.getDistanceFromWorkspaceCellVisualCenter(
                mDragViewVisualCenter[0], mDragViewVisualCenter[1], mTargetCell); // 到目标格中心的距离
        manageFolderFeedback(targetCellDistance, d); // 文件夹创建/加入反馈

        boolean nearestDropOccupied = mDragTargetLayout.isNearestDropLocationOccupied(
                (int) mDragViewVisualCenter[0], (int) mDragViewVisualCenter[1],
                item.spanX, item.spanY, child, mTargetCell);
        manageReorderOnDragOver(d, targetCellDistance, nearestDropOccupied, minSpanX, minSpanY,
                reorderX, reorderY); // ② 重排判定
    }
}
```

### 9.2 650ms reorderAlarm 延迟机制

`manageReorderOnDragOver` 决定"立即显示重排提示"还是"延迟 650ms 执行真正重排"：

```java
public static final int REORDER_TIMEOUT = 650; // 重排延迟
protected final Alarm mReorderAlarm = new Alarm();

protected void manageReorderOnDragOver(DragObject d, float targetCellDistance,
        boolean nearestDropOccupied, int minSpanX, int minSpanY, int reorderX, int reorderY) {
    ItemInfo item = d.dragInfo;
    final View child = (mDragInfo == null) ? null : mDragInfo.cell;

    if (!nearestDropOccupied) {
        // 情况 A：目标格空——立即显示重排提示（不真正移动其他图标）
        mDragTargetLayout.performReorder(..., CellLayout.MODE_SHOW_REORDER_HINT);
        mDragTargetLayout.visualizeDropLocation(...); // 画落点高亮
    } else if ((mDragMode == DRAG_MODE_NONE || mDragMode == DRAG_MODE_REORDER)
            && (mLastReorderX != reorderX || mLastReorderY != reorderY) // 格位变了才重设
            && targetCellDistance < mDragTargetLayout.getReorderRadius(mTargetCell, item.spanX, item.spanY)) {
        // 情况 B：目标格被占、在重排半径内、格位变化——先 cancel 旧 alarm，设新 alarm
        mReorderAlarm.cancelAlarm();
        mLastReorderX = reorderX;
        mLastReorderY = reorderY;
        mDragTargetLayout.performReorder(..., CellLayout.MODE_SHOW_REORDER_HINT); // 先显示提示
        ReorderAlarmListener listener = new ReorderAlarmListener(mDragViewVisualCenter,
                minSpanX, minSpanY, item.spanX, item.spanY, d, child);
        mReorderAlarm.setOnAlarmListener(listener);
        mReorderAlarm.setAlarm(REORDER_TIMEOUT); // 650ms 后真正重排
    }
}
```

**为什么用 Alarm 延迟而非立即重排？**`onDragOver` 每帧触发（~16ms 一次），若每次格位变化都立即执行 `performReorder`（涉及让位算法 + 动画），CPU 与动画系统都扛不住，且图标会疯狂跳动。650ms 缓冲让用户"停在某格"才执行重排，手指快速划过时不会触发，平衡了响应性与稳定性。`mLastReorderX/Y` 记录上次格位，只有格位变化才重设 alarm（手指在同一格停留不重复触发）。

`Alarm` 本身基于 `Handler.postDelayed`，但有"短超时覆盖长超时"的优化：

```java
// Alarm.java
public void setAlarm(long millisecondsInFuture) {
    long currentTime = SystemClock.uptimeMillis();
    mAlarmPending = true;
    long oldTriggerTime = mAlarmTriggerTime;
    mAlarmTriggerTime = currentTime + millisecondsInFuture;
    // 若旧 alarm 比新的长，取消重排（避免等更久）
    if (mWaitingForCallback && oldTriggerTime > mAlarmTriggerTime) {
        mHandler.removeCallbacks(this);
        mWaitingForCallback = false;
    }
    if (!mWaitingForCallback) {
        mHandler.postDelayed(this, mAlarmTriggerTime - currentTime);
        mWaitingForCallback = true;
    }
}

public void cancelAlarm() {
    mAlarmPending = false; // 只清标志，回调里检查 mAlarmPending 决定是否真正触发
}
```

`cancelAlarm` 只清 `mAlarmPending` 标志而非 `removeCallbacks`，是因为格位频繁变化时反复 register/remove 回调开销大；回调真正执行时再检查标志，被 cancel 的就跳过。

`ReorderAlarmListener.onAlarm` 在 650ms 后执行真正的 `MODE_DRAG_OVER` 重排：

```java
class ReorderAlarmListener implements OnAlarmListener {
    final float[] dragViewCenter;
    final int minSpanX, minSpanY, spanX, spanY;
    final DragObject dragObject;
    final View child;

    public void onAlarm(Alarm alarm) {
        mTargetCell = findNearestArea(...);
        mTargetCell = mDragTargetLayout.performReorder(..., CellLayout.MODE_DRAG_OVER); // 真正让位
        if (mTargetCell[0] < 0 || mTargetCell[1] < 0) {
            mDragTargetLayout.revertTempState(); // 无解：回滚
        } else {
            setDragMode(DRAG_MODE_REORDER);
        }
        mDragTargetLayout.visualizeDropLocation(...); // 更新落点高亮
    }
}
```

### 9.3 setDropLayoutForDragObject 三段判定

`setDropLayoutForDragObject` 决定当前落点属于哪个 CellLayout，按优先级三段判定：

```java
private boolean setDropLayoutForDragObject(DragObject d, float centerX, float centerY) {
    CellLayout layout = null;
    if (shouldUseHotseatAsDropLayout(d)) {
        layout = mLauncher.getHotseat(); // ① Hotseat 优先（图标且在 Hotseat 区域）
    } else if (!isDragObjectOverSmartSpace(d)) {
        // 不在 SmartSpace/QSB 上才判定（否则不高亮任何页）
        layout = checkDragObjectIsOverNeighbourPages(d, centerX); // ② 邻页（Spring Loaded 切屏）
        if (layout == null) {
            IntSet visiblePageIndices = getVisiblePageIndices();
            for (int visiblePageIndex : visiblePageIndices) {
                layout = verifyInsidePage(visiblePageIndex, d.x, d.y); // ③ 当前可见页
                if (layout != null) break;
            }
        }
    }
    if (layout != mDragTargetLayout) { // 布局变化：切换并重置重排状态
        setCurrentDropLayout(layout);
        setCurrentDragOverlappingLayout(layout);
        return true;
    }
    return false;
}
```

`checkDragObjectIsOverNeighbourPages` 判定手指是否悬停在相邻页边缘（用于跨屏拖拽切屏）：

```java
private CellLayout checkDragObjectIsOverNeighbourPages(DragObject d, float centerX) {
    if (isPageInTransition()) return null; // 切屏动画中不判
    float touchX;
    float touchY = d.y;
    int nextPage = getNextPage();
    IntSet pageIndexesToVerify = IntSet.wrap(nextPage - 1,
            nextPage + (isTwoPanelEnabled() ? 2 : 1)); // 检查前一页与后一页（双屏后两页）

    for (int pageIndex : pageIndexesToVerify) {
        // 取手指位置与视觉中心的极端 X（左拖取 min，右拖取 max）
        touchX = (((pageIndex < nextPage) && !mIsRtl) || (pageIndex > nextPage && mIsRtl))
                ? Math.min(d.x, centerX) : Math.max(d.x, centerX);
        CellLayout layout = verifyInsidePage(pageIndex, touchX, touchY);
        if (layout != null) return layout;
    }
    return null;
}
```

取极端 X 是因为图标有宽度，手指可能已在邻页但视觉中心还在本页（或反之），取最远点保证"图标任何部分进入邻页"都触发切屏判定。

### 9.4 跨屏拖拽：SpringLoadedDragController 的 500ms/950ms

悬停在邻页边缘不立即切屏，而是设 alarm，停够时间才切：

```java
// SpringLoadedDragController.kt
class SpringLoadedDragController(private val launcher: Launcher) : OnAlarmListener {
    internal val alarm = Alarm().also { it.setOnAlarmListener(this) }
    private var screen: CellLayout? = null // 当前悬停的页

    fun setAlarm(cl: CellLayout?) {
        cancel()
        alarm.setAlarm(
            when {
                cl == null -> ENTER_SPRING_LOAD_CANCEL_HOVER_TIME // 950ms：无目标则取消拖
                Utilities.isRunningInTestHarness() -> ENTER_SPRING_LOAD_HOVER_TIME_IN_TEST // 测试 3000ms
                else -> ENTER_SPRING_LOAD_HOVER_TIME // 500ms：切到悬停页
            }
        )
        screen = cl
    }

    override fun onAlarm(alarm: Alarm) {
        if (screen != null) {
            with(launcher.workspace) {
                if (!isVisible(screen) && launcher.dragController.mDistanceSinceScroll != 0) {
                    snapToPage(indexOfChild(screen)); // 切到悬停页
                }
            }
        } else {
            launcher.dragController.cancelDrag(); // 无目标悬停 950ms：取消拖拽
        }
    }

    companion object {
        private const val ENTER_SPRING_LOAD_HOVER_TIME: Long = 500 // 切屏阈值
        private const val ENTER_SPRING_LOAD_HOVER_TIME_IN_TEST: Long = 3000 // 测试用（Cuttlefish 抗 flaky）
        private const val ENTER_SPRING_LOAD_CANCEL_HOVER_TIME: Long = 950 // 取消阈值
    }
}
```

**为什么 500ms 切屏、950ms 取消？** 500ms 是"用户有意切屏"的体感阈值（短于这个时间算划过），950ms 是"用户彻底放弃"的阈值。两者都用 `Alarm`（基于 `Handler.postDelayed`），避免每帧判定。`mDistanceSinceScroll != 0` 保证只有"边拖边停"才切屏，纯静止悬停（如读快捷方式）不切。

### 9.5 addExtraEmptyScreenOnDrag 临时空屏

拖拽开始时插入一页临时空屏，让用户总能拖到"新页"：

```java
private void addExtraEmptyScreenOnDrag(DragObject dragObject) {
    boolean lastChildOnScreen = false;
    boolean childOnFinalScreen = false;

    if (mDragSourceInternal != null) {
        int dragSourceChildCount = mDragSourceInternal.getChildCount();
        // 双屏 home：加上配对页的子元素数
        if (isTwoPanelEnabled() && !(mDragSourceInternal.getParent() instanceof Hotseat)) {
            int pagePairScreenId = getScreenPair(...).screenId);
            CellLayout pagePair = mWorkspaceScreens.get(pagePairScreenId);
            dragSourceChildCount += pagePair.getShortcutsAndWidgets().getChildCount();
        }
        // Widget 拖拽时 content 已被摘离原父，计数补 1
        if (dragObject.dragView.getContentView() instanceof LauncherAppWidgetHostView) {
            dragSourceChildCount++;
        }
        if (dragSourceChildCount == 1) lastChildOnScreen = true; // 源页只剩这一个元素
        CellLayout cl = (CellLayout) mDragSourceInternal.getParent();
        if (!FOLDABLE_SINGLE_PAGE.get()
                && getLeftmostVisiblePageForIndex(indexOfChild(cl))
                == getLeftmostVisiblePageForIndex(getPageCount() - 1)) {
            childOnFinalScreen = true; // 源页就是最后一屏
        }
    }

    // 若被拖元素是最后一屏的唯一元素，拖起后那屏会变空，无需再加临时屏
    if (lastChildOnScreen && childOnFinalScreen) return;

    forEachExtraEmptyPageId(extraEmptyPageId -> {
        if (!mWorkspaceScreens.containsKey(extraEmptyPageId)) {
            insertNewWorkspaceScreen(extraEmptyPageId); // 插入临时空屏
        }
    });
}
```

设计意图：保证拖拽过程中"总有一页空屏可放"，用户能流畅地把图标拖到新页。双屏 home 时插入两页（`EXTRA_EMPTY_SCREEN_ID` + `EXTRA_EMPTY_SCREEN_SECOND_ID`）。拖拽结束（`onDragEnd` 后回到 NORMAL 状态）时 `removeExtraEmptyScreen` 清理未使用的临时屏。

### 9.6 重排三方案择优

`CellLayout` 定义四个 mode，对应不同时机与精度：

```java
// CellLayout.java
public static final int MODE_SHOW_REORDER_HINT = 0; // 实时廉价预览（每帧）
public static final int MODE_DRAG_OVER = 1;         // 延迟精算（650ms 后）
public static final int MODE_ON_DROP = 2;           // 落定终解（drop 时）
public static final int MODE_ON_DROP_EXTERNAL = 3;  // 外部来源落定
```

`performReorder` 内部按 mode 复用 `mPreviousSolution` 缓存：`MODE_SHOW_REORDER_HINT` 每次重算但只输出预览；`MODE_DRAG_OVER` 与 `MODE_ON_DROP` 在已有解时跳过重算（`if (mode == MODE_SHOW_REORDER_HINT || mPreviousSolution == null)` 才重算）。这样高频的 `onDragOver` 复用低频算出的解，drop 时只在必要时重算终解，兼顾帧率与正确性。

`getReorderRadius` 决定何时触发重排（与 `getFolderCreationRadius` 配合，后者取重排半径与图标半径的中点，避免文件夹与重排阈值打架）：

```java
// CellLayout.java
public float getReorderRadius(int[] targetCell, int spanX, int spanY) {
    int[] centerPoint = mTmpPoint;
    getWorkspaceCellVisualCenter(targetCell[0], targetCell[1], centerPoint);
    Rect cellBoundsWithSpacing = mTempRect;
    cellToRect(targetCell[0], targetCell[1], spanX, spanY, cellBoundsWithSpacing);
    cellBoundsWithSpacing.inset(-mBorderSpace.x / 2, -mBorderSpace.y / 2); // 含间距
    if (canCreateFolder(getChildAt(targetCell[0], targetCell[1])) && spanX == 1 && spanY == 1) {
        // 可建文件夹的格位：取较小维度的半径，避免过早触发重排
        int minRadius = centerPoint[0] - cellBoundsWithSpacing.left;
        minRadius = Math.min(minRadius, centerPoint[1] - cellBoundsWithSpacing.top);
        // ...
    }
    // ...
}
```

### 9.7 onDrop 的落定重排

`onDrop` 时用 `MODE_ON_DROP` 执行最终重排，并处理"落回原位防抖动"：

```java
// Workspace.java
public void onDrop(final DragObject d, DragOptions options) {
    mDragViewVisualCenter = d.getVisualCenter(mDragViewVisualCenter);
    CellLayout dropTargetLayout = mDropToLayout; // onDragExit 时记录的最终页
    if (dropTargetLayout != null) {
        mapPointFromDropLayout(dropTargetLayout, mDragViewVisualCenter);
    }

    if (d.dragSource != this || mDragInfo == null) {
        final int[] touchXY = new int[]{(int) mDragViewVisualCenter[0], (int) mDragViewVisualCenter[1]};
        onDropExternal(touchXY, dropTargetLayout, d); // 外部来源
    } else {
        final View cell = mDragInfo.cell;
        if (dropTargetLayout != null && !d.cancelled) {
            // 内部移动
            mTargetCell = findNearestArea(...);
            // 先判文件夹创建/加入
            if (createUserFolderIfNecessary(...) || addToExistingFolderIfNecessary(...)) {
                if (!mLauncher.isInState(EDIT_MODE)) {
                    mLauncher.getStateManager().goToState(NORMAL, SPRING_LOADED_EXIT_DELAY);
                }
                return;
            }

            // 防抖：状态切换中且落点被占且非原位——退回原位，避免误重排
            boolean returnToOriginalCellToPreventShuffling = !isFinishedSwitchingState()
                    && !droppedOnOriginalCellDuringTransition
                    && !dropTargetLayout.isRegionVacant(mTargetCell[0], mTargetCell[1], spanX, spanY);
            if (returnToOriginalCellToPreventShuffling) {
                mTargetCell[0] = mTargetCell[1] = -1; // 退回原位
            } else {
                mTargetCell = dropTargetLayout.performReorder(..., CellLayout.MODE_ON_DROP); // 终解
            }
            // ... addInScreen 落位、更新 LP、Widget resize、动画
        }
    }
}
```

`returnToOriginalCellToPreventShuffling` 是用户体验细节：状态切换动画进行中用户快速放手，若落点被占会触发大规模重排，不符合预期（用户可能只是想取消）。此时强制退回原位，等状态稳定。

### 面试深问

**Q1：为什么重排用 650ms 而非更短（如 300ms）？**
300ms 接近一次正常滑动的停留时间，手指略慢就会误触发重排，图标频繁跳动。650ms 足够区分"快速划过"与"有意停留"，又不至于让用户觉得卡顿。这个值经交互设计调校，在响应性与稳定性间取平衡。

**Q2：`setDropLayoutForDragObject` 三段判定的优先级能否调整？**
不能。Hotseat 必须最先判（图标在 Hotseat 区域应优先落 Hotseat，否则会被当前页抢）；邻页必须在当前页之前（否则手指滑到邻页边缘时仍命中当前页，无法触发切屏）；SmartSpace 单独排除（拖到搜索栏不高亮任何页）。顺序错了会导致落点错乱。

**Q3：临时空屏什么时候清理？**
`onDragEnd` 后回到 NORMAL 状态时，`removeExtraEmptyScreen(true)` 清理。但若 drop 目标是卸载（`DeferredOnComplete`），会先 `deferRemoveExtraEmptyScreen()` 延迟清理，等卸载结果返回（用户可能取消卸载，图标要回到原屏）。这保证临时屏不会在卸载结果未定时被误删。

---

## 十、系统拖拽（System DnD）集成

### 10.1 enableSystemDrag Flag

`enableSystemDrag` 开启后，`BaseDragLayer` 把系统 `DragEvent` 委托给 `DragController.onDragEvent`：

```java
// BaseDragLayer.java
public BaseDragLayer(Context context, AttributeSet attrs, int alphaChannelCount) {
    super(context, attrs);
    // ...
    if (enableSystemDrag()) {
        super.setOnDragListener((view, event) -> {
            final DragController<T> dragController = mContainer.getDragController();
            return dragController != null && dragController.onDragEvent(event); // 委托
        });
    }
}
```

### 10.2 DragController.onDragEvent 分发

```java
// DragController.java
public boolean onDragEvent(DragEvent event) {
    if (!enableSystemDrag()) {
        return mDragDriver != null && mDragDriver.onDragEvent(event); // 关闭时只转给驱动
    }

    if (event.getAction() == DragEvent.ACTION_DRAG_STARTED) {
        for (int i = mSystemDragHandlers.size() - 1; i >= 0; i--) { // 倒序找 handler
            final SystemDragHandler handler = mSystemDragHandlers.get(i);
            if (handler.onDrag(event)) {
                mLastSystemDragHandler = handler; // 锁定 handler
                if (mDragDriver != null) mDragDriver.onDragEvent(event);
                return true;
            }
        }
        mLastSystemDragHandler = null;
        return false;
    }

    if (mLastSystemDragHandler != null && mLastSystemDragHandler.onDrag(event)) { // 后续事件给锁定者
        if (mDragDriver != null) mDragDriver.onDragEvent(event);
        return true;
    }

    if (mLastSystemDragHandler != null) { // handler 拒绝：取消内部拖
        mLastSystemDragHandler = null;
        if (isDragging()) cancelDrag();
    }
    return false;
}
```

设计：每次系统 DnD 只锁一个 handler（倒序=后注册优先），后续事件只发给它。handler 中途拒绝则取消当前拖拽，防止状态不一致。

### 面试深问

**Q1：为什么 `mSystemDragHandlers` 倒序遍历？**
后注册的 handler 通常对应更上层的 UI（如当前打开的浮层），应优先处理系统 DnD。倒序保证最新的 handler 先拿到事件，类似 `mDropTargets` 的优先级逻辑。

**Q2：系统 DnD 与内部拖拽能同时进行吗？**
理论上可以（`mDragDriver` 与 `mLastSystemDragHandler` 可并存），但实际上系统 DnD 由 `simulatedDndStartPoint` 触发 `SystemDragDriver`，内部拖拽由触摸触发 `InternalDragDriver`，二者启动路径互斥。`onDragEvent` 里 `mDragDriver.onDragEvent(event)` 的调用是为系统拖拽场景下让 `SystemDragDriver` 也收到事件。

**Q3：`SystemDragControllerImpl` 为什么要 `setLauncher` 而非构造时传入？**
它是 Dagger 单例（`INSTANCE = DaggerSingletonObject(...)`），生命周期长于任何 Launcher 实例。Launcher 重建时调 `setLauncher` 切换绑定的 `DragController`（先 `removeSystemDragHandler` 旧的，再 `addSystemDragHandler` 新的），避免向已销毁的 Launcher 派发事件。

---

## 十一、关键常量速查表

| 常量 | 值 | 位置 | 含义 |
|------|-----|------|------|
| `REORDER_TIMEOUT` | 650 | `Workspace.java` | 重排 alarm 延迟（ms） |
| `ENTER_SPRING_LOAD_HOVER_TIME` | 500 | `SpringLoadedDragController.kt` | 邻页悬停切屏阈值（ms） |
| `ENTER_SPRING_LOAD_HOVER_TIME_IN_TEST` | 3000 | 同上 | 测试环境切屏阈值（ms） |
| `ENTER_SPRING_LOAD_CANCEL_HOVER_TIME` | 950 | 同上 | 无目标悬停取消拖拽阈值（ms） |
| `SPRING_LOADED_EXIT_DELAY` | 500 | `LauncherAnimUtils.java` | drop 失败后退出 Spring Loaded 延迟（ms） |
| `VIEW_ZOOM_DURATION` | 150 | `DragView.java` | DragView 入场缩放时长（ms） |
| `DRAG_VIEW_SCALE_DURATION_MS` | 500 | `DragController.java` | 预拖结束缩放动画时长（ms） |
| `DRAG_VIEW_DROP_DURATION` | 285 | `ButtonDropTarget.java` | DragView 飞向按钮目标时长（ms） |
| `DRAG_VIEW_HOVER_OVER_OPACITY` | 0.65 | `ButtonDropTarget.java` | 悬停按钮时 DragView 透明度 |
| `DEEP_PRESS_DISTANCE_FACTOR` | 3 | `DragController.java` | 深按压预拖距离倍数 |
| `MAX_FLING_DEGREES` | 35 | `FlingToDeleteHelper.java` | Fling 删除方向角阈值（度） |
| `STIFFNESS` | 4000 | `DragView.SpringFloatValue` | Spring 视差弹簧刚度 |
| `DAMPENING_RATIO` | 1 | 同上 | 临界阻尼 |
| `PARALLAX_MAX_IN_DP` | 8 | 同上 | Spring 视差最大值（dp） |
| `MODE_SHOW_REORDER_HINT` | 0 | `CellLayout.java` | 重排提示模式 |
| `MODE_DRAG_OVER` | 1 | 同上 | 拖拽中重排模式 |
| `MODE_ON_DROP` | 2 | 同上 | 落定重排模式 |
| `MODE_ON_DROP_EXTERNAL` | 3 | 同上 | 外部来源落定模式 |
| `ANIMATION_END_DISAPPEAR` | 0 | `DragLayer.java` | 下落动画结束 DragView 消失 |
| `ANIMATION_END_REMAIN_VISIBLE` | 2 | `DragLayer.java` | 下落动画结束保持可见 |

---

## 十二、调试与排错锚点

- **拖拽起不来**：查 `ItemLongClickListener.canStartDrag`（是否 `isWorkspaceLocked`/`isDragging`/`isSplitSelectionActive`）→ 查 View 是否绑了 `INSTANCE_WORKSPACE`/`INSTANCE_ALL_APPS` → 查 `Launcher` 状态是否在 NORMAL/OVERVIEW/EDIT_MODE/ALL_APPS。
- **DragView 不跟手**：查 `registrationX/Y` 计算（`mMotionDown` 是否正确）→ 查 `getClampedDragLayerPos` 是否把坐标钳到 DragLayer 外 → 查 `applyTranslation` 是否被 `mAnimatedShiftX/Y` 干扰。
- **命中错误目标**：查 `mDropTargets` 注册顺序（倒序命中）→ 查 `getHitRectRelativeToDragLayer` 返回的矩形是否正确（`ButtonDropTarget` 会加 `dragPaddingPx` 扩大命中区）→ 查 `isDropEnabled` 是否被 `mDragDistanceThreshold` 卡住。
- **重排不触发**：查 `manageReorderOnDragOver` 的三个条件（`mDragMode`/格位变化/`targetCellDistance < getReorderRadius`）→ 查 `mReorderAlarm` 是否被 `cleanupReorder` 误 cancel → 查 `performReorder` 是否返回 -1（无解）。
- **切屏不工作**：查 `SpringLoadedDragController.setAlarm` 是否被调用（`setDropLayoutForDragObject` 返回 true 才设）→ 查 `mDistanceSinceScroll` 是否为 0（静止不切）→ 查 `isPageInTransition`（切屏中不判）。
- **Fling 删除失效**：查 `mVelocityTracker` 是否有数据（`recordMotionEvent` 是否被喂）→ 查 `mDropTarget`（`delete_target_text`）是否 enable → 查速度方向角是否 ≤35°。
- **临时空屏残留**：查 `onDragEnd` 是否被调用 → 查 `mDeferRemoveExtraEmptyScreen`（卸载场景延迟清理）→ 查是否回到 NORMAL 状态（监听器在 NORMAL 时才 remove）。
- **DragView 残留不消失**：查 `deferDragViewCleanupPostAnimation` 是否被置 false（cancelDrag/dispatchDropComplete）→ 查下落动画是否正常结束触发 `clearAnimatedView` → 查 `DragView.removeAllViews` 是否在 resume 时清理了残留（Widget 例外）。
