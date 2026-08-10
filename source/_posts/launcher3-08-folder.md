---
title: Launcher3 源码精读（08）：文件夹机制
category: client
platform: android
tags: ["AOSP", "Launcher3", "源码", "Framework"]
readTime: 23分钟
featured: true
date: 2026-08-02
---

Launcher3 的文件夹机制是一套"图标聚合"系统：把桌面上零散的 app 图标收进一个可展开的容器里。这套系统的复杂度集中在三件事上——桌面上那个圆角预览图标怎么画、点击后图标如何"放大"成全屏容器、以及图标在容器内外如何增删改。文档按"类体系 → 创建 → 开关动画 → 内容管理 → 数据存储 → 拖拽交互"的顺序拆，每个机制都对应 `folder/` 目录下的真实源码。核心是两个 View：`FolderIcon`（桌面上的图标）和 `Folder`（展开后的浮层），二者通过 `FolderInfo` 这个数据模型绑定，再用 `FolderPagedView` 当内部网格容器，`PreviewBackground` 负责圆角背景的绘制与缩放动画。

## 文件夹类体系总览

`folder/` 目录共 25 个文件、约 6300 行。真正撑起业务的只有 4 个核心类，其余是动画、命名建议、布局规则等辅助。

| 类 | 行数 | 职责 | 父类/接口 |
|---|---|---|---|
| `Folder` | 2066 | 文件夹展开后的全屏浮层，管开关动画/拖拽落点/重命名 | `AbstractFloatingView` |
| `FolderIcon` | 819 | 桌面上的文件夹图标，画预览图 + 当 DropTarget | `FrameLayout` |
| `FolderPagedView` | 714 | 文件夹内部的分页网格容器（多页文件夹用） | `PagedView` |
| `PreviewBackground` | 474 | 文件夹图标的圆角背景，含"接受合并"放大动画 | `DelegatedCellDrawing` |
| `PreviewItemManager` | 491 | 计算并绘制预览图里那 4 个缩略图的位置/缩放 | — |
| `ClippedFolderIconLayoutRule` | 223 | 预览图里 1~4 个图标的圆周排布算法 | — |
| `FolderGridOrganizer` | 221 | 根据图标数量算文件夹内网格几行几列 | — |
| `FolderAnimationManager` | 518 | 打开/关闭动画的 AnimatorSet 组装 | `FolderAnimationCreator` |
| `FolderNameProvider` | 185 | 推测文件夹名（同包名→包名、工作区→Work） | — |
| `LauncherDelegate` | 176 | 把 Launcher 专属操作抽出来，支持非 Launcher 场景（Taskbar） | — |

### 四个核心类的关系链

```
桌面 CellLayout
   └─ FolderIcon (FrameLayout)
        ├─ mFolderName: BubbleTextView   // 图标下方文字
        ├─ mBackground: PreviewBackground // 圆角预览背景
        ├─ mPreviewItemManager           // 画预览图
        ├─ mInfo: FolderInfo             // 数据模型
        └─ mFolder: Folder               // 展开后的浮层（懒加载）
              ├─ mContent: FolderPagedView // 内部分页网格
              ├─ mFolderName: FolderNameEditText // 重命名输入框
              └─ mFooter: LinearLayout     // 底部标题栏
```

`FolderIcon` 和 `Folder` 是一对关系：图标常驻桌面，`Folder` 浮层只在打开时被加进 `DragLayer`。两者共享同一个 `FolderInfo mInfo`，数据模型只有一份。

### 为什么文件夹用独立布局 FolderPagedView 而不直接复用 Workspace

`Workspace` 是整个桌面的分页容器，每页是一个 `CellLayout`，设计上要承载 widget、图标、文件夹混排，还要做页面间滑动切换、缩略图编辑态等重逻辑。文件夹内部只需要一个"小号网格"，不需要 widget、不需要编辑模式。直接复用 `Workspace` 会带入大量无用状态机。

`FolderPagedView` 继承自 `PagedView`（只保留翻页能力），每个 page 是一个轻量 `CellLayout`，通过 `ViewCache` 复用 `folder_page` 和 `folder_application` 布局。这样文件夹的开关只是把 `Folder` 这个 `AbstractFloatingView` 加进/移出 `DragLayer`，完全不碰 `Workspace` 的状态。

```java
public class FolderPagedView extends PagedView<PageIndicatorDots> implements ClipPathView {
    // 继承 PagedView 拿到翻页能力，但砍掉 Workspace 的编辑态/widget 逻辑
    private final FolderGridOrganizer mOrganizer; // 按数量算网格尺寸
    private final ViewCache mViewCache;            // 复用 folder_page/cell 视图
    private int mGridCountX;                        // 当前行数（动态）
    private int mGridCountY;                        // 当前列数（动态）
}
```

### Folder 的三态机

`Folder` 用一个 int 字段 `mState` 表达生命周期，三态用常量定义，并用 `@IntDef` 做编译期检查。

```java
public static final int STATE_CLOSED = 0;    // 关闭（默认）
public static final int STATE_ANIMATING = 1; // 正在播开关动画
public static final int STATE_OPEN = 2;      // 已打开可交互

@Retention(RetentionPolicy.SOURCE)
@IntDef({STATE_CLOSED, STATE_ANIMATING, STATE_OPEN})
public @interface FolderState {}
```

`isDropEnabled()` 直接拿状态做闸门——动画过程中不允许落点，避免动画还没播完图标就被塞进来导致位置错乱：

```java
public boolean isDropEnabled() {
    return mState != STATE_ANIMATING; // 动画中禁止 drop
}
```

### 面试深问

**Q1：FolderIcon 和 Folder 为什么不合成一个 View？**
桌面图标要常驻、数量可能很多（几十个文件夹），如果每个都持有展开浮层的全部视图树，内存爆炸。拆开后 `Folder` 浮层按需 inflate、用完从 `DragLayer` 移除，图标本身只留 `PreviewBackground` 和几个 `PreviewItemDrawingParams`，轻量。

**Q2：为什么 mState 不用 enum 而用 int + IntDef？**
Android 的 enum 在 dex 里是对象，有内存开销；`@IntDef` 是编译期注解，编译后退化成原始 int，零运行时开销，同时保留类型检查。Launcher3 是系统应用，对启动内存敏感。

**Q3：LauncherDelegate 这个类解决了什么问题？**
`Folder` 原本硬编码依赖 `Launcher`（如 `mLauncher.getWorkspace()`）。但 Taskbar、多窗口拖拽等非 Launcher 场景也需要文件夹。`LauncherDelegate` 把 Launcher 专属操作抽成接口，非 Launcher 场景用 `FallbackDelegate`（所有方法空实现或返回 false），让 `Folder` 能脱离 Launcher 复用。

## 文件夹的创建

文件夹不是用户主动"新建"的，而是拖拽时两个图标重叠触发的。整个创建分两条路径：**新建文件夹**（两个散图标合并）和**加入已有文件夹**（拖到 FolderIcon 上）。判定由 `Workspace` 在 `onDragOver` 里完成。

### 触发阈值：距离判定

`Workspace.manageFolderFeedback()` 在每次 dragOver 时算拖拽点到目标格子的距离，跟 `CellLayout.getFolderCreationRadius()` 给的半径比。超过半径直接 return，不触发任何反馈。

```java
private void manageFolderFeedback(float distance, DragObject dragObject) {
    if (distance > mDragTargetLayout.getFolderCreationRadius(mTargetCell)) {
        // 超出文件夹创建半径，撤销任何待创建/待加入状态
        if ((mDragMode == DRAG_MODE_ADD_TO_FOLDER
                || mDragMode == DRAG_MODE_CREATE_FOLDER)) {
            setDragMode(DRAG_MODE_NONE);
        }
        return;
    }
    // ... 进入创建/加入判定
}
```

`willCreateUserFolder()` 做最终拍板：目标格子上是个可接受的图标（非 widget、非热区预测位）、且拖拽物本身也是可入夹的类型。

```java
boolean willCreateUserFolder(ItemInfo info, View dropOverView, boolean considerTimeout) {
    // 目标图标正在被临时移动（tmpCoords），不算
    if (dropOverView != null) {
        CellLayoutLayoutParams lp = (CellLayoutLayoutParams) dropOverView.getLayoutParams();
        if (lp.useTmpCoords && (lp.getTmpCellX() != lp.getCellX()
                || lp.getTmpCellY() != lp.getCellY())) {
            return false;
        }
    }
    boolean hasntMoved = mDragInfo != null && dropOverView == mDragInfo.cell;
    if (dropOverView == null || hasntMoved
            || (considerTimeout && !mCreateUserFolderOnDrop)) {
        return false;
    }
    boolean aboveShortcut = Folder.willAccept(dropOverView.getTag()) // 目标是 app/快捷方式
            && ((ItemInfo) dropOverView.getTag()).container != CONTAINER_HOTSEAT_PREDICTION;
    boolean willBecomeShortcut = FolderInfo.willAcceptItemType(info.itemType);
    return (aboveShortcut && willBecomeShortcut);
}
```

`FolderInfo.willAcceptItemType()` 限定只有三类能进文件夹：

```java
public static boolean willAcceptItemType(int itemType) {
    return itemType == ITEM_TYPE_APPLICATION       // 普通 app
            || itemType == ITEM_TYPE_DEEP_SHORTCUT // 快捷方式
            || itemType == ITEM_TYPE_APP_PAIR;     // 分屏对
}
```

### 拖拽反馈：预览背景提前浮现

进入"待创建文件夹"态时，`Workspace` 会新建一个临时 `PreviewBackground`，用 `animateToAccept()` 让它在目标图标下方放大，给用户"马上要合并"的视觉预告。这个背景画完会移交给真正创建出来的 `FolderIcon`，保证动画连续。

```java
// Workspace.manageFolderFeedback() 内
mFolderCreateBg = new PreviewBackground(getContext());
mFolderCreateBg.setup(mLauncher, mLauncher, null,
        mDragOverView.getMeasuredWidth(), mDragOverView.getPaddingTop());
mFolderCreateBg.isClipping = false; // 背景画在图标下面，不裁剪
mFolderCreateBg.animateToAccept(mDragTargetLayout, mTargetCell[0], mTargetCell[1]);
setDragMode(DRAG_MODE_CREATE_FOLDER);
```

`animateToAccept()` 把背景缩放到 `ACCEPT_SCALE_FACTOR = 1.20f`（放大 20%），并把绘制委托给目标 `CellLayout`，让背景能画在图标下层：

```java
public void animateToAccept(CellLayout cl, int cellX, int cellY) {
    delegateDrawing(cl, cellX, cellY);   // 委托 CellLayout 绘制
    animateScale(/* isAccepting= */ true, mIsHovered);
}
```

### 真正创建：createUserFolderIfNecessary

drop 发生且判定为创建文件夹时，`Workspace.createUserFolderIfNecessary()` 执行三步：把目标图标从 CellLayout 摘出、调 `mLauncher.addFolder()` 往数据库插一行文件夹记录并 inflate 出 `FolderIcon`、再用 `performCreateAnimation()` 播合并动画。

```java
// Workspace.createUserFolderIfNecessary() 核心段
target.removeView(v); // 摘掉被合并的目标图标
FolderIcon fi = mLauncher.addFolder(target, container, screenId, targetCell[0], targetCell[1]);
destInfo.cellX = -1; destInfo.cellY = -1; // 入夹后 cellX/cellY 失效，改用 rank
sourceInfo.cellX = -1; sourceInfo.cellY = -1;

boolean animate = d != null;
if (animate) {
    // 把刚才那个临时背景交给新图标，保证视觉连续
    fi.setFolderBackground(mFolderCreateBg);
    mFolderCreateBg = new PreviewBackground(getContext()); // Workspace 换个新的备用
    fi.performCreateAnimation(destInfo, v, sourceInfo, d, folderLocation, scale);
} else {
    fi.prepareCreateAnimation(v);
    fi.getFolder().addFolderContent(destInfo);
    fi.getFolder().addFolderContent(sourceInfo);
}
```

### 合并动画 performCreateAnimation

`FolderIcon.performCreateAnimation()` 把两个图标分别塞进 `FolderInfo.contents`，然后播两段动画：目标图标"飞进"预览位、拖拽物"飞进"预览位。

```java
public void performCreateAnimation(final ItemInfo destInfo, final View destView,
        final ItemInfo srcInfo, final DragObject d, Rect dstRect,
        float scaleRelativeToDragLayer) {
    prepareCreateAnimation(destView);
    getFolder().addFolderContent(destInfo); // 第一个图标入库
    // 第一个图标从原位置飞到预览第 0 位
    mPreviewItemManager.createFirstItemAnimation(false /* reverse */, null).start();
    // 拖拽物飞进预览（成为第 1 个）
    onDrop(srcInfo, d, dstRect, scaleRelativeToDragLayer, 1,
            false /* itemReturnedOnFailedDrop */);
}
```

注意一个时序约束：`INITIAL_ITEM_ANIMATION_DURATION(350)` 必须小于 `DROP_IN_ANIMATION_DURATION(400)`，否则两个图标的入场动画会错位。这个约束在 `inflateIcon()` 里硬检查：

```java
public static FolderIcon inflateIcon(int resId, ActivityContext activity,
        @Nullable ViewGroup group, FolderInfo folderInfo) {
    final boolean error = INITIAL_ITEM_ANIMATION_DURATION >= DROP_IN_ANIMATION_DURATION;
    if (error) {
        throw new IllegalStateException("DROP_IN_ANIMATION_DURATION must be greater than "
                + "INITIAL_ITEM_ANIMATION_DURATION, as sequencing of adding first two items "
                + "is dependent on this");
    }
    // ...
}
```

### 临时文件夹 → 正式 commit

文件夹创建是即时的——`addFolder()` 一调，数据库立刻多一行 `ITEM_TYPE_FOLDER` 记录，子图标的 `container` 字段立刻改成 `folder.id`。没有"草稿态"。

但"解散"有延迟判定。当文件夹只剩 1 个图标时，不是立刻解散，而是设标记 `mDeleteFolderOnDropCompleted`，等 drop 流程跑完再在 `onDropCompleted()` 里调 `replaceFolderWithFinalItem()`。这样能避免拖拽中途动画被打断。

### 面试深问

**Q1：为什么文件夹创建用距离阈值而不是简单的"重叠即合并"？**
纯重叠判定会导致用户只是想拖到隔壁格子就误触发合并。距离阈值（`getFolderCreationRadius`）给了一个容差区间，只有真的"压上去"才合并，且配合 `mCreateUserFolderOnDrop` 超时标记，避免快速划过时误判。

**Q2：performCreateAnimation 里为什么要先 addFolderContent 再播动画？**
动画的终点是"预览图里的位置"，而预览图的位置由 `FolderInfo.contents` 的数量决定（`scaleForItem` 按数量算缩放）。必须先把数据塞进去，预览参数才算得对，否则动画终点错位。

**Q3：创建文件夹时那个临时 PreviewBackground 为什么用完要换新的？**
`mFolderCreateBg` 被移交给了新创建的 `FolderIcon`，它的绘制状态（缩放、委托）已经绑定到那个图标。如果 Workspace 继续用同一个实例，下次创建文件夹会跟上一个图标的动画状态串味。换个新实例彻底隔离。

## 文件夹的打开与关闭

点击 `FolderIcon` → 触发 `Folder.animateOpen()` → 把 `Folder` 浮层加进 `DragLayer` → 播放大动画 → 状态置 `STATE_OPEN`。关闭是逆过程。整套动画的核心难点是"图标怎么平滑地放大成全屏容器"，靠 `FolderAnimationManager` 协调十几个 Animator。

### 打开流程 animateOpen

`animateOpen()` 是入口，做五件事：bind 数据、定位浮层、加进 DragLayer、cancel 旧动画、启动新 AnimatorSet。

```java
private void animateOpen(List<ItemInfo> items, int pageNo) {
    if (!shouldAnimateOpen(items)) return;       // 只有 ≤1 个图标不播
    Folder openFolder = getOpen(mActivityContext);
    closeOpenFolder(openFolder);                  // 关掉可能已开的其他文件夹

    mContent.bindItems(items);                    // 把图标绑到分页视图
    mContent.setCanAnnouncePageDescriptionForFolder(true);
    centerAboutIcon();                            // 浮层居中于原图标位置
    mItemsInvalidated = true;
    updateTextViewFocus();

    mIsOpen = true;
    BaseDragLayer dragLayer = mActivityContext.getDragLayer();
    if (getParent() == null) {
        dragLayer.addView(this);                  // 加进拖拽层
        mActivityContext.getDragController().addDropTarget(this); // 注册为落点
    }
    // ...
    mContent.completePendingPageChanges();
    mContent.setCurrentPage(pageNo);
    mDeleteFolderOnDropCompleted = false;
    cancelRunningAnimations();

    AnimatorSet animatorSet = getFolderAnimationManager()
            .createAnimatorSet(/* isOpening */ true);
    animatorSet.addListener(new AnimatorListenerAdapter() {
        @Override
        public void onAnimationStart(Animator animation) {
            mFolderIcon.setIconVisible(false); // 隐藏桌面图标（已被浮层替代）
            mFolderIcon.drawLeaveBehindIfExists(); // 画"留位"虚影
        }
        @Override
        public void onAnimationEnd(Animator animation) {
            setState(STATE_OPEN);
            announceAccessibilityChanges();
            mContent.setFocusOnFirstChild();
        }
    });
    // 跳过第一帧（t=0 时浮层已和图标重合）
    animatorSet.setCurrentPlayTime(Math.min(
            getSingleFrameMs(getContext()), animatorSet.getTotalDuration()));
    animatorSet.start();
}
```

`shouldAnimateOpen()` 拦掉空文件夹和单图标文件夹——这俩根本不该被打开（应该在更早阶段被解散）：

```java
boolean shouldAnimateOpen(List<ItemInfo> items) {
    if (items == null || items.size() <= 1) {
        Log.d(TAG, "Couldn't animate folder open because items is: " + items);
        return false;
    }
    return true;
}
```

### 浮层定位 centerAboutIcon

文件夹打开后要"从图标位置长出来"。`centerAboutIcon()` 算出浮层的左上角坐标，让浮层视觉中心对齐图标中心，同时设好 `pivotX/pivotY`（缩放支点），后续放大动画才以图标为中心展开。

```java
private void centerAboutIcon() {
    BaseDragLayer.LayoutParams lp = (BaseDragLayer.LayoutParams) getLayoutParams();
    BaseDragLayer parent = mActivityContext.getDragLayer();
    int width = getFolderWidth();
    int height = getFolderHeight();

    parent.getDescendantRectRelativeToSelf(mFolderIcon, sTempRect); // 图标在拖拽层的实际矩形
    int centerX = sTempRect.centerX();
    int centerY = sTempRect.centerY();
    int centeredLeft = centerX - width / 2;
    int centeredTop = centerY - height / 2;

    sTempRect.set(mActivityContext.getFolderBoundingBox()); // 允许的摆放区域
    // 防止浮层超出屏幕边界，做钳制
    int left = Utilities.boundToRange(centeredLeft, sTempRect.left, sTempRect.right - width);
    int top = Utilities.boundToRange(centeredTop, sTempRect.top, sTempRect.bottom - height);
    int[] inOutPosition = new int[]{left, top};
    mActivityContext.updateOpenFolderPosition(inOutPosition, sTempRect, width, height);
    left = inOutPosition[0];
    top = inOutPosition[1];

    // 缩放支点：因为浮层被钳制移动了，pivot 要补偿差值，让视觉上仍像从图标中心展开
    int folderPivotX = width / 2 + (centeredLeft - left);
    int folderPivotY = height / 2 + (centeredTop - top);
    setPivotX(folderPivotX);
    setPivotY(folderPivotY);

    lp.width = width; lp.height = height;
    lp.x = left; lp.y = top;
    mBackground.setBounds(0, 0, width, height);
}
```

设计意图：浮层理想位置是图标正中心，但屏幕边缘附近会被钳制到边界内。这时如果不调 pivot，放大动画的支点会跑到浮层几何中心，视觉上"歪着长出来"。通过把 pivot 偏移 `centeredLeft - left`，支点在视觉上仍锚定图标中心。

### 动画引擎 FolderAnimationManager

`FolderAnimationManager.createAnimatorSet()` 是整个开关动画的总装车间，返回一个 `AnimatorSet`。它要协调：浮层平移、内容缩放、背景颜色渐变、reveal 裁剪、页脚淡入、图标缩放、图标文字淡入等十几个动画。

核心思路是"反向求解"：先算出图标预览态下各项参数（缩放、位置、颜色），作为动画起点；全屏态作为终点。打开动画从起点播到终点，关闭反之。

```java
public AnimatorSet createAnimatorSet(boolean isOpening) {
    mIsOpening = isOpening;
    final BaseDragLayer.LayoutParams lp =
            (BaseDragLayer.LayoutParams) mFolder.getLayoutParams();
    mFolderIcon.getPreviewItemManager().recomputePreviewDrawingParams();
    ClippedFolderIconLayoutRule rule = mFolderIcon.getLayoutRule();
    final List<View> itemsInPreview = getPreviewIconsOnPage(0);

    // 1. 算图标预览态的尺寸（用于反推浮层起点缩放）
    final Rect folderIconPos = new Rect();
    float scaleRelativeToDragLayer = mFolder.mActivityContext.getDragLayer()
            .getDescendantRectRelativeToSelf(mFolderIcon, folderIconPos);
    int scaledRadius = mPreviewBackground.getScaledRadius();
    float initialSize = (scaledRadius * 2) * scaleRelativeToDragLayer;

    // 2. 浮层内容的初始缩放 = 预览图标尺寸 / 标准图标尺寸
    float previewScale = rule.scaleForItem(itemsInPreview.size(), 0);
    float previewSize = rule.getIconSize() * previewScale;
    float baseIconSize = getBubbleTextView(itemsInPreview.get(0)).getIconSize();
    float initialScale = previewSize / baseIconSize * scaleRelativeToDragLayer;
    final float finalScale = 1f;
    float scale = mIsOpening ? initialScale : finalScale;
    mFolder.setPivotX(0); mFolder.setPivotY(0);

    // 3. 把内容和页脚缩到预览尺寸（动画起点）
    mFolder.mContent.setScaleX(scale); mFolder.mContent.setScaleY(scale);
    mFolder.mContent.setPivotX(0); mFolder.mContent.setPivotY(0);
    mFolder.mFooter.setScaleX(scale); mFolder.mFooter.setScaleY(scale);
    mFolder.mFooter.setPivotX(0); mFolder.mFooter.setPivotY(0);
    // ...
}
```

### 圆角过渡 reveal 动画

打开时背景从"图标的小圆角"过渡到"浮层的大圆角"，用 `ShapeDelegate.createRevealAnimator()` 实现。它根据起止 Rect 和圆角半径生成裁剪动画。

```java
// 背景的 reveal：从图标尺寸的小矩形 → 浮层全尺寸矩形
Rect startRect = new Rect(totalOffsetX, paddingOffsetY,
        Math.round((totalOffsetX + initialSize)),
        Math.round((paddingOffsetY + initialSize)));
Rect endRect = new Rect(0, 0, lp.width, lp.height);
float finalRadius = mFolderBackground.getCornerRadius();

ShapeDelegate shapeDelegate = ThemeManager.INSTANCE.get(mContext).getFolderShape();
play(a, shapeDelegate.createRevealAnimator(
        mFolder, startRect, endRect, finalRadius, !mIsOpening));

// 内容区也有自己的 reveal，且额外加一点半径让图标不被裁
int extraRadius = (int) ((mDeviceProfile.folderIconSizePx / initialScale)
        * EXTRA_FOLDER_REVEAL_RADIUS_PERCENTAGE); // 0.125
Rect contentStart = new Rect(
        (int) (left + (startRect.left / initialScale)) - extraRadius,
        (int) (startRect.top / initialScale) - extraRadius,
        (int) (left + (startRect.right / initialScale)) + extraRadius,
        (int) (startRect.bottom / initialScale) + extraRadius);
Rect contentEnd = new Rect(left, 0, left + lp.width, lp.height);
play(a, shapeDelegate.createRevealAnimator(
        mFolder.getContent(), contentStart, contentEnd, finalRadius, !mIsOpening));
```

`EXTRA_FOLDER_REVEAL_RADIUS_PERCENTAGE = 0.125F` 给内容区 reveal 多放 12.5% 半径，因为内容图标比背景边缘略大，不加余量图标会被裁掉一角。

### 背景颜色渐变

图标态背景色（`folderPreviewColor`，偏深）和浮层态背景色（`folderBackgroundColor`，偏亮）不同，打开时做 ARGB 渐变：

```java
final int initialColor = Themes.getAttrColor(mContext, R.attr.folderPreviewColor);
final int finalColor = Themes.getAttrColor(mContext, R.attr.folderBackgroundColor);
mFolderBackground.mutate();
mFolderBackground.setColor(mIsOpening ? initialColor : finalColor);
mBgColorAnimator = getAnimator(mFolderBackground, "color", initialColor, finalColor);
play(a, mBgColorAnimator);
```

`getAnimator()` 根据 `mIsOpening` 反转起止值，这样打开和关闭共用同一套代码：

```java
private Animator getAnimator(View view, Property property, float v1, float v2) {
    return mIsOpening
            ? ObjectAnimator.ofFloat(view, property, v1, v2)   // 打开：v1→v2
            : ObjectAnimator.ofFloat(view, property, v2, v1);  // 关闭：v2→v1
}
```

### 大文件夹的特殊处理

图标超过 4 个（`MAX_NUM_ITEMS_IN_PREVIEW`）算"大文件夹"。大文件夹的预览图图标和展开后的图标用不同插值器，为了让预览图标"追上"展开节奏，打开时预览图标动画要 `delay`，关闭时要缩短时长。

```java
private Interpolator getPreviewItemInterpolator() {
    if (isLargeFolder()) {
        // 大文件夹预览图标要更快到位（打开）或更慢消失（关闭）
        return mIsOpening
                ? mLargeFolderPreviewItemOpenInterpolator
                : mLargeFolderPreviewItemCloseInterpolator;
    }
    return mIsOpening ? mFolderOpenInterpolator : mFolderCloseInterpolator;
}

// 在 addPreviewItemAnimators 里
if (mFolder.getItemCount() > MAX_NUM_ITEMS_IN_PREVIEW) {
    int delay = mIsOpening ? mDelay : mDelay * 2;
    if (mIsOpening) {
        translationX.setStartDelay(delay);
        translationY.setStartDelay(delay);
        scaleAnimator.setStartDelay(delay);
    }
    translationX.setDuration(translationX.getDuration() - delay);
    // ...
}
```

### 动画期间的 clip 关闭

放大动画期间，如果 `Folder`/`FolderPagedView`/`CellLayout` 还在 clip children，图标会从边缘被裁掉。`createAnimatorSet()` 在 `onAnimationStart` 关闭所有 clip，`onAnimationEnd` 恢复。

```java
a.addListener(new AnimatorListenerAdapter() {
    private boolean mFolderClipChildren;
    // ... 缓存各层 clip 状态
    @Override
    public void onAnimationStart(Animator animator) {
        mCellLayout = mContent.getCurrentCellLayout();
        mFolderClipChildren = mFolder.getClipChildren();
        // ... 缓存
        mFolder.setClipChildren(false);
        mFolder.setClipToPadding(false);
        mContent.setClipChildren(false);
        mContent.setClipToPadding(false);
        mCellLayout.setClipChildren(false);
        mCellLayout.setClipToPadding(false);
    }
    @Override
    public void onAnimationEnd(Animator animation) {
        mFolder.setTranslationX(0.0f); mFolder.setTranslationY(0.0f);
        mFolder.mContent.setScaleX(1f); mFolder.mContent.setScaleY(1f);
        // ... 恢复 clip
        mFolder.setClipChildren(mFolderClipChildren);
        // ...
    }
});
```

### 关闭流程 animateClosed

`handleClose(true)` → `animateClosed()`。关闭逻辑是打开的镜像，但多两步：调 `mContent.snapToPageImmediately(getDestinationPage())` 把页码归位（关闭时应该看到第一页），并在动画结束后判断要不要解散文件夹。

```java
private void animateClosed() {
    if (mIsAnimatingClosed) return; // 防重入
    int size = getIconsInReadingOrder().size();
    if (size <= 1) { // 又变成单图标，直接关不播动画
        closeComplete(false);
        post(this::announceAccessibilityChanges);
        return;
    }
    mContent.completePendingPageChanges();
    mContent.snapToPageImmediately(mContent.getDestinationPage()); // 归位到目标页
    cancelRunningAnimations();
    AnimatorSet animatorSet = getFolderAnimationManager()
            .createAnimatorSet(/* isOpening */ false);
    animatorSet.addListener(new AnimatorListenerAdapter() {
        @Override
        public void onAnimationStart(Animator animation) {
            setWindowInsetsAnimationCallback(null); // 关键盘动画回调
            mIsAnimatingClosed = true;
        }
        @Override
        public void onAnimationEnd(Animator animation) {
            if (mKeyboardInsetAnimationCallback != null) {
                setWindowInsetsAnimationCallback(mKeyboardInsetAnimationCallback);
            }
            closeComplete(true);
            announceAccessibilityChanges();
            mIsAnimatingClosed = false;
        }
    });
    addAnimationStartListeners(animatorSet);
    animatorSet.start();
}
```

`closeComplete()` 是真正的收尾：从 DragLayer 移除浮层、注销 DropTarget、恢复桌面图标可见、判断是否解散。

```java
private void closeComplete(boolean wasAnimated) {
    BaseDragLayer parent = (BaseDragLayer) getParent();
    if (parent != null) parent.removeView(this); // 从拖拽层摘除
    mActivityContext.getDragController().removeDropTarget(this);
    clearFocus();
    if (mFolderIcon != null) {
        mFolderIcon.setVisibility(View.VISIBLE); // 桌面图标重新可见
        mFolderIcon.setIconVisible(true);
        mFolderIcon.mFolderName.setTextVisibility(true);
        if (wasAnimated) {
            mFolderIcon.animateBgShadowAndStroke();
            mFolderIcon.onFolderClose(mContent.getCurrentPage());
            if (mFolderIcon.hasDot()) {
                mFolderIcon.animateDotScale(0f, 1f); // 通知红点重新出现
            }
            mFolderIcon.requestFocus();
        }
    }
    if (mRearrangeOnClose) { rearrangeChildren(); mRearrangeOnClose = false; }
    if (getItemCount() <= 1) {
        if (!mIsDragInProgress && !mSuppressFolderDeletion) {
            replaceFolderWithFinalItem(); // ≤1 个图标 → 解散
        } else if (mIsDragInProgress) {
            mDeleteFolderOnDropCompleted = true; // 拖拽中，延迟解散
        }
    } else if (!mIsDragInProgress) {
        mContent.unbindItems(); // 释放视图，数据还在 FolderInfo
    }
    mSuppressFolderDeletion = false;
    clearDragInfo();
    setState(STATE_CLOSED);
    mContent.setCurrentPage(0);
}
```

### 点击外部关闭

`Folder.onControllerInterceptTouchEvent()` 监听触摸事件：编辑名称时点输入框外提交名称；非编辑时点浮层外直接关闭。

```java
@Override
public boolean onControllerInterceptTouchEvent(MotionEvent ev) {
    if (ev.getAction() == MotionEvent.ACTION_DOWN) {
        BaseDragLayer dl = (BaseDragLayer) getParent();
        if (mIsEditingName) {
            if (!dl.isEventOverView(mFolderName, ev)) {
                mFolderName.dispatchBackKey(); // 提交名称
                return true;
            }
            return false;
        } else if (!dl.isEventOverView(this, ev)
                && mLauncherDelegate.interceptOutsideTouch(ev, dl, this)) {
            return true; // 点外面 → 关闭
        }
    }
    return false;
}
```

### 面试深问

**Q1：打开动画为什么要 setCurrentPlayTime 跳过第一帧？**
t=0 时浮层的缩放/位置和桌面图标完全重合，播这一帧没意义还浪费一次绘制。跳到 `getSingleFrameMs()`（一帧时长）让动画提前一帧进入"开始分离"状态，视觉上更跟手。代码注释原话："because t=0 has the folder match the folder icon, we can skip the first frame"。

**Q2：大文件夹为什么预览图标要用不同插值器？**
小文件夹预览图（≤4 个）和展开后图标布局一致，同步缩放即可。大文件夹预览图只有 4 个挤在圆角里，展开后变成网格，两者的运动轨迹差异大。用 `large_folder_preview_item_open_interpolator`（更快减速）让预览图标先到位，避免和网格图标"打架"。

**Q3：动画期间为什么要把 clip 全关掉？**
放大过程中图标要从预览的紧凑排列"飞"到网格的分散位置，飞行轨迹会超出 FolderPagedView 和 CellLayout 的边界。如果 clip 开着，飞行中的图标会被裁切，出现"半截图标"。关掉 clip 让图标能暂时越界绘制，动画结束再恢复。

## PreviewBackground 圆角预览背景

`PreviewBackground` 是文件夹图标上那个圆角白底的绘制者，同时负责"接受合并"时的放大动画和 hover 反馈。它不继承 View，是个纯绘制对象，通过 `DelegatedCellDrawing` 把绘制委托给 `FolderIcon` 或 `CellLayout`。

### 关键字段

| 字段 | 类型 | 含义 |
|---|---|---|
| `previewSize` | int | 背景直径（px），来自 `grid.folderIconSizePx` |
| `basePreviewOffsetX/Y` | int | 背景在图标内的偏移（居中用） |
| `mScale` | float | 当前缩放，1f 为静止，1.2f 为接受态 |
| `mBgColor` | int | 背景填充色（theme `folderPreviewColor`） |
| `mStrokeColor` | int | 边框色 |
| `isClipping` | boolean | 是否裁剪到圆角内（创建文件夹时不裁，让背景画在图标下） |
| `mIsAccepting` | boolean | 是否处于"接受合并"态 |

### 尺寸初始化 setup

`setup()` 在 `PreviewItemManager.computePreviewDrawingParams()` 里被调，算出背景的尺寸和偏移。偏移让背景水平居中、垂直靠上（留出下方文字空间）。

```java
public void setup(Context context, ActivityContext activity, View invalidateDelegate,
                  int availableSpaceX, int topPadding) {
    mInvalidateDelegate = invalidateDelegate;
    TypedArray ta = context.getTheme().obtainStyledAttributes(R.styleable.FolderIconPreview);
    mStrokeColor = ta.getColor(R.styleable.FolderIconPreview_folderIconBorderColor, 0);
    mBgColor = ta.getColor(R.styleable.FolderIconPreview_folderPreviewColor, 0);
    ta.recycle();

    DeviceProfile grid = activity.getDeviceProfile();
    previewSize = grid.folderIconSizePx; // 背景直径
    basePreviewOffsetX = (availableSpaceX - previewSize) / 2; // 水平居中
    basePreviewOffsetY = topPadding + grid.folderIconOffsetYPx; // 垂直偏移
    mStrokeWidth = context.getResources().getDisplayMetrics().density; // 1dp 边框
    // ...
}
```

### 绘制 drawBackground

背景是个圆角形状（由 `ShapeDelegate` 决定，默认圆），用 Paint.FILL 画填充，可选画边框和阴影（默认都关）。

```java
public void drawBackground(Canvas canvas) {
    mPaint.setStyle(Paint.Style.FILL);
    mPaint.setColor(getBgColor());
    getShape().drawShape(canvas, getOffsetX(), getOffsetY(), getScaledRadius(), mPaint);
    drawShadow(canvas);
}

private ShapeDelegate getShape() {
    return ThemeManager.INSTANCE.get(mContext).getFolderShape(); // 支持主题切换形状
}
```

`getScaledRadius()` = `mScale * previewSize / 2`，缩放直接体现在半径上。`getOffsetX/Y()` 补偿缩放带来的中心偏移，保证缩放是"以中心为锚"的。

### 接受合并动画 animateScale

拖拽物进入文件夹图标判定区时，背景放大到 1.2 倍表示"可以放了"。`animateScale()` 是统一的缩放动画入口，处理三种目标态：接受（1.2）、hover（1.1）、静止（1.0）。

```java
protected void animateScale(boolean isAccepting, boolean isHovered) {
    if (mScaleAnimator != null) mScaleAnimator.cancel();
    final float startScale = mScale;
    final float endScale = isAccepting ? ACCEPT_SCALE_FACTOR   // 1.20f
            : (isHovered ? HOVER_SCALE : 1f);                   // 1.10f 或 1.0f
    Interpolator interpolator = isAccepting != mIsAccepting
            ? ACCELERATE_DECELERATE : EMPHASIS_DECELERATE;
    int duration = isAccepting != mIsAccepting
            ? CONSUMPTION_ANIMATION_DURATION  // 100ms（快速反馈）
            : HOVER_ANIMATION_DURATION;       // 300ms（hover 慢一点）
    mIsAccepting = isAccepting;
    mIsHovered = isHovered;
    if (startScale == endScale) {
        if (!mIsAccepting) clearDrawingDelegate();
        mIsHoveredOrAnimating = mIsHovered;
        return;
    }
    mScaleAnimator = ValueAnimator.ofFloat(0f, 1.0f);
    mScaleAnimator.addUpdateListener(animation -> {
        float prog = animation.getAnimatedFraction();
        mScale = prog * endScale + (1 - prog) * startScale; // 线性插值
        invalidate();
    });
    // ...
}
```

接受态切换（`isAccepting != mIsAccepting`）用 100ms 快速动画，给用户"立即响应"感；hover 切换用 300ms，更柔和。

### 委托绘制 delegateDrawing

创建文件夹时，背景要画在"被合并的图标"下层，但那个图标属于 `CellLayout`。`delegateDrawing()` 把背景注册到 CellLayout 的 delegated drawing 列表里，让 CellLayout 重绘时顺带画这个背景。

```java
private void delegateDrawing(CellLayout delegate, int cellX, int cellY) {
    if (mDrawingDelegate != delegate) {
        delegate.addDelegatedCellDrawing(this);
    }
    mDrawingDelegate = delegate;
    mDelegateCellX = cellX;
    mDelegateCellY = cellY;
    invalidate();
}
```

`FolderIcon.dispatchDraw()` 根据 `drawingDelegated()` 决定是否自己画背景——委托给 CellLayout 时就不自己画，避免重复。

```java
// FolderIcon.dispatchDraw()
if (!mBackground.drawingDelegated()) {
    mBackground.drawBackground(canvas);
}
// ... 画预览图标
if (!mBackground.drawingDelegated()) {
    mBackground.drawBackgroundStroke(canvas);
}
```

### 留位虚影 drawLeaveBehind

文件夹打开后，桌面上原位置会留一个浅色圆点表示"这里有个文件夹"，叫 leave-behind。`drawLeaveBehind()` 用 0.5 倍缩放画背景。

```java
public void drawLeaveBehind(Canvas canvas, int color) {
    float originalScale = mScale;
    mScale = 0.5f; // 缩小一半当虚影
    mPaint.setStyle(Paint.Style.FILL);
    mPaint.setColor(color);
    getShape().drawShape(canvas, getOffsetX(), getOffsetY(), getScaledRadius(), mPaint);
    mScale = originalScale;
}
```

`FolderIconParent` 接口让宿主（CellLayout）决定何时画/清留位：

```java
public interface FolderIconParent {
    void drawFolderLeaveBehindForIcon(FolderIcon child);
    void clearFolderLeaveBehind(FolderIcon child);
}
```

### 面试深问

**Q1：PreviewBackground 为什么用 Property + ObjectAnimator 而不是直接 setValue？**
`STROKE_ALPHA`、`SHADOW_ALPHA` 用 `Property` 定义，setter 里自动调 `invalidate()` 触发重绘。直接 setValue 会忘记 invalidate 导致画面不更新。Property 模式把"改值+刷新"封装成原子操作。

**Q2：isClipping 这个字段什么时候为 false？**
正常 FolderIcon 里背景裁剪到圆角内（预览图标不会溢出）。但创建文件夹的瞬间，临时背景要画在目标图标下层做"吞并"预告，这时 `isClipping = false`，背景画完整圆且不裁剪图标。创建完成后背景移交给新 FolderIcon，恢复 `isClipping = true`。

**Q3：drawLeaveBehind 为什么直接改 mScale 而不另开一个字段？**
留位是临时一次性绘制，不需要动画。直接改 mScale 画完即恢复，最简单。如果加新字段反而要维护两套绘制路径。代价是线程不安全（mScale 被临时改写），但调用方都在主线程且立即恢复，无并发问题。

## 预览图绘制 PreviewItemManager + ClippedFolderIconLayoutRule

文件夹图标上的那几个缩略图是动态画的，不是一张静态图。`PreviewItemManager` 管绘制，`ClippedFolderIconLayoutRule` 算每个缩略图的位置和缩放。预览最多 4 个图标（`MAX_NUM_ITEMS_IN_PREVIEW = 4`），按圆周排布。

### 圆周排布算法

`ClippedFolderIconLayoutRule` 把 1~4 个图标建模成圆上的点，从左上象限开始排，保证水平垂直对称。

```java
private void getPosition(int index, int curNumItems, float[] result) {
    curNumItems = Math.max(curNumItems, 2); // 1 个的情况按 2 个算（同构）
    double theta0 = mIsRtl ? 0 : Math.PI;   // 起始角：LTR 从 π（左侧）开始
    int direction = mIsRtl ? 1 : -1;        // RTL 顺时针，LTR 逆时针
    double thetaShift = 0;
    if (curNumItems == 3) thetaShift = Math.PI / 2;
    else if (curNumItems == 4) thetaShift = Math.PI / 4;
    theta0 += direction * thetaShift;

    // 4 个图标时交换第 2、3 个，保证阅读顺序（0 1 / 2 3）
    if (curNumItems == 4 && index == 3) index = 2;
    else if (curNumItems == 4 && index == 2) index = 3;

    float radius = getRadius(curNumItems);
    double theta = theta0 + index * (2 * Math.PI / curNumItems) * direction;
    float halfIconSize = (mIconSize * scaleForItem(curNumItems, 0)) / 2;
    // 映射到画布坐标，y 轴取反匹配屏幕坐标系
    result[0] = mAvailableSpace / 2 + (float) (radius * Math.cos(theta) / 2) - halfIconSize;
    result[1] = mAvailableSpace / 2 + (float) (-radius * Math.sin(theta) / 2) - halfIconSize;
}
```

设计意图：用圆周模型而非网格，是因为 1~4 个图标的排布用同一套公式能自然过渡（数量变化时图标沿圆滑动），网格模型做不到。4 个时交换 index 是为了让视觉顺序匹配阅读顺序（左上→右上→左下→右下）。

### 缩放系数 scaleForItem

图标数量影响缩放：≤3 个用大缩放（`MAX_SCALE = 0.51`），4 个或非首页用小缩放（`MIN_SCALE = 0.44`）。数量越多图标越小。

```java
public float scaleForItem(int numItems, int page) {
    float scale;
    if (page > 0) scale = MIN_SCALE;        // 非首页预览统一小图
    else if (numItems <= 3) scale = MAX_SCALE; // 1~3 个用大图
    else scale = MIN_SCALE;                    // 4 个用小图
    return scale * mBaselineIconScale; // 乘以"可用空间/原图尺寸"基准
}
```

### 半径膨胀 getRadius

图标越多，圆半径越大（图标往外撑），避免重叠。`MAX_RADIUS_DILATION = 0.25` 是最大膨胀量，按数量线性插值。

```java
private float getRadius(int numItems) {
    if (Flags.enableLauncherIconShapes()) {
        return mRadius * (1 + radiusDilationForItems(numItems)); // 新版按数量定权重
    } else {
        // 旧版：从 0 膨胀到 MAX_RADIUS_DILATION，随数量线性增长
        return mRadius * (1 + MAX_RADIUS_DILATION * (numItems - MIN_NUM_ITEMS_IN_PREVIEW)
                / (MAX_NUM_ITEMS_IN_PREVIEW - MIN_NUM_ITEMS_IN_PREVIEW));
    }
}

private float radiusDilationForItems(int numItems) {
    if (numItems == 3) return 0.15f;
    else if (numItems == MAX_NUM_ITEMS_IN_PREVIEW) return 0.12f;
    else return 0;
}
```

`mRadius` 本身在 `init()` 里按 `ITEM_RADIUS_SCALE_FACTOR(1.15)` 算出，再乘膨胀系数：

```java
public void init(int availableSpace, float intrinsicIconSize, boolean rtl, int numFolderColumns) {
    mAvailableSpace = availableSpace;
    mRadius = (Flags.enableLauncherIconShapes()
            ? ITEM_RADIUS_SCALE_FACTOR_SHAPES  // 1.2
            : ITEM_RADIUS_SCALE_FACTOR)        // 1.15
            * availableSpace / 2f;
    // ...
}
```

### PreviewItemDrawingParams 绘制参数

每个预览图标对应一个 `PreviewItemDrawingParams`，存平移、缩放、drawable 等。

```java
class PreviewItemDrawingParams {
    float index;       // 在预览中的索引（用于动画）
    float transX;      // x 平移
    float transY;      // y 平移
    float scale;       // 缩放
    public FolderPreviewItemAnim anim; // 当前动画
    public boolean hidden;             // 是否隐藏（动画过渡用）
    public Drawable drawable;          // 实际图标
    public ItemInfo item;
}
```

`update()` 有个细节：如果新值和正在跑的动画终点重合，跳过更新让动画跑完，避免抖动。

```java
public void update(float transX, float transY, float scale) {
    if (anim != null) {
        if (anim.finalState[1] == transX || anim.finalState[2] == transY
                || anim.finalState[0] == scale) {
            return; // 跟动画终点一致，别打断
        }
        anim.cancel();
    }
    this.transX = transX;
    this.transY = transY;
    this.scale = scale;
}
```

### 绘制流程 draw

`PreviewItemManager.draw()` 按"第一个图标最后画（最上层）"的顺序绘制，并用 `clipPath` 裁剪到圆角背景内。

```java
public void draw(Canvas canvas) {
    int saveCount = canvas.getSaveCount();
    PreviewBackground bg = mIcon.getFolderBackground();
    Path clipPath = bg.getClipPath();
    float firstPageItemsTransX = 0;
    // 翻页时当前页预览滑入效果
    if (mShouldSlideInFirstPage) {
        PointF firstPageOffset = new PointF(bg.basePreviewOffsetX + mCurrentPageItemsTransX,
                bg.basePreviewOffsetY);
        boolean shouldClip = mCurrentPageItemsTransX > mClipThreshold; // 1dp 阈值
        drawParams(canvas, mCurrentPageParams, firstPageOffset, shouldClip, clipPath);
        firstPageItemsTransX = -ITEM_SLIDE_IN_OUT_DISTANCE_PX + mCurrentPageItemsTransX;
    }
    PointF firstPageOffset = new PointF(bg.basePreviewOffsetX + firstPageItemsTransX,
            bg.basePreviewOffsetY);
    boolean shouldClipFirstPage = firstPageItemsTransX < -mClipThreshold;
    drawParams(canvas, mFirstPageParams, firstPageOffset, shouldClipFirstPage, clipPath);
    canvas.restoreToCount(saveCount);
}

public void drawParams(Canvas canvas, ArrayList<PreviewItemDrawingParams> params,
        PointF offset, boolean shouldClipPath, Path clipPath) {
    // 逆序画，第一个（index 0）最后画，叠在最上层
    for (int i = params.size() - 1; i >= 0; i--) {
        PreviewItemDrawingParams p = params.get(i);
        if (!p.hidden) {
            boolean isExiting = p.index == EXIT_INDEX; // 退出动画的总是裁剪
            drawPreviewItem(canvas, p, offset, isExiting | shouldClipPath, clipPath);
        }
    }
}
```

`drawPreviewItem()` 做实际的 translate/scale + drawable.draw：

```java
private void drawPreviewItem(Canvas canvas, PreviewItemDrawingParams params, PointF offset,
        boolean shouldClipPath, Path clipPath) {
    canvas.save();
    if (shouldClipPath) canvas.clipPath(clipPath); // 裁剪到圆角
    canvas.translate(offset.x + params.transX, offset.y + params.transY);
    canvas.scale(params.scale, params.scale);
    Drawable d = params.drawable;
    if (d != null) {
        Rect bounds = d.getBounds();
        canvas.save();
        canvas.translate(-bounds.left, -bounds.top);
        canvas.scale(mIntrinsicIconSize / bounds.width(), mIntrinsicIconSize / bounds.height());
        d.draw(canvas);
        canvas.restore();
    }
    canvas.restore();
}
```

### 翻页时的预览滑动 onFolderClose

关闭文件夹时如果停在非首页，预览图要先展示当前页图标，再滑出、首页图标滑入。`onFolderClose()` 触发这个过渡。

```java
void onFolderClose(int currentPage) {
    mShouldSlideInFirstPage = currentPage != 0; // 非首页才需要滑动
    if (mShouldSlideInFirstPage) {
        mCurrentPageItemsTransX = 0;
        buildParamsForPage(currentPage, mCurrentPageParams, false);
        onParamsChanged();
        ValueAnimator slideAnimator = ObjectAnimator
                .ofFloat(this, CURRENT_PAGE_ITEMS_TRANS_X, 0, ITEM_SLIDE_IN_OUT_DISTANCE_PX); // 200px
        slideAnimator.addListener(new AnimatorListenerAdapter() {
            @Override
            public void onAnimationEnd(Animator animation) {
                mCurrentPageParams.clear();
            }
        });
        slideAnimator.setStartDelay(SLIDE_IN_FIRST_PAGE_ANIMATION_DURATION_DELAY); // 100ms
        slideAnimator.setDuration(SLIDE_IN_FIRST_PAGE_ANIMATION_DURATION);          // 300ms
        slideAnimator.start();
    }
}
```

### 面试深问

**Q1：预览图为什么最多 4 个？**
4 个是 2x2 的极限，再多就挤、看不清。超过 4 个用 `mDisplayingUpperLeftQuadrant` 标记，仍只画左上 2x2 象限的图标，视觉上"代表"整个文件夹。`MAX_NUM_ITEMS_IN_PREVIEW = 4` 是这个魔数的源头。

**Q2：4 个图标时为什么要交换 index 2 和 3？**
圆周模型天然顺序是"左上→左下→右下→右上"，但阅读顺序是"左上→右上→左下→右下"。交换 2、3 让圆周排列匹配阅读顺序，用户看到的图标顺序和打开后一致。

**Q3：翻页时预览滑动为什么用 200px 固定距离？**
`ITEM_SLIDE_IN_OUT_DISTANCE_PX = 200` 是经验值，足够让图标"划出去"出视野。配合 `clipPath` 裁剪，图标滑出圆角背景就不可见，200px 保证完全消失。用固定值而非按比例算，是因为预览区尺寸固定，没必要动态算。

## 文件夹内容管理

文件夹内部图标怎么排、怎么分页、怎么增删，由 `FolderPagedView` + `FolderGridOrganizer` 协作完成。

### 网格尺寸动态计算

文件夹的网格不是固定几行几列，而是按图标数量动态收缩。`FolderGridOrganizer.calculateGridSize()` 让网格刚好容纳当前数量，且 `countY <= countX`（宽大于高）。

```java
private void calculateGridSize(int count) {
    boolean done;
    int gridCountX = mCountX;
    int gridCountY = mCountY;
    if (count >= mMaxItemsPerPage) { // 满页用最大网格
        gridCountX = mMaxCountX;
        gridCountY = mMaxCountY;
        done = true;
    } else {
        done = false;
    }
    while (!done) {
        int oldCountX = gridCountX;
        int oldCountY = gridCountY;
        if (gridCountX * gridCountY < count) {
            // 网格不够大，优先扩列，列满再扩行
            if ((gridCountX <= gridCountY || gridCountY == mMaxCountY) && gridCountX < mMaxCountX) {
                gridCountX++;
            } else if (gridCountY < mMaxCountY) {
                gridCountY++;
            }
            if (gridCountY == 0) gridCountY++;
        } else if ((gridCountY - 1) * gridCountX >= count && gridCountY >= gridCountX) {
            gridCountY = Math.max(0, gridCountY - 1); // 能减行就减
        } else if ((gridCountX - 1) * gridCountY >= count) {
            gridCountX = Math.max(0, gridCountX - 1); // 能减列就减
        }
        done = gridCountX == oldCountX && gridCountY == oldCountY;
    }
    mCountX = gridCountX;
    mCountY = gridCountY;
}
```

设计意图：3 个图标用 3x1 比 2x2（带空位）更紧凑好看。这个算法让网格"恰好包住"图标数量，没有多余空格。

### rank 到坐标的映射

图标在文件夹里用 `rank`（一维序号）排序，渲染时转成二维 `(cellX, cellY)`。`getPosForRank()` 做这个映射：

```java
public Point getPosForRank(int rank) {
    int pagePos = rank % mMaxItemsPerPage; // 页内位置
    if (mCountX == 0) { mPoint.x = 0; mPoint.y = 0; }
    else {
        mPoint.x = pagePos % mCountX; // 列
        mPoint.y = pagePos / mCountX; // 行
    }
    return mPoint;
}
```

`updateRankAndPos()` 只更新 rank（cellX/cellY 由 PagedView 在 arrangeChildren 时算）：

```java
public boolean updateRankAndPos(ItemInfo item, int rank) {
    if (rank != item.rank) {
        item.rank = rank;
        return true; // 有变化才返回 true，触发数据库更新
    }
    return false;
}
```

### 排序：按 rank，不是按字母

文件夹内图标默认按 `rank` 排（即拖动顺序），不自动按字母排序。`Folder.ITEM_POS_COMPARATOR` 是这个顺序的比较器：

```java
public static final Comparator<ItemInfo> ITEM_POS_COMPARATOR = new Comparator<ItemInfo>() {
    @Override
    public int compare(ItemInfo lhs, ItemInfo rhs) {
        if (lhs.rank != rhs.rank) {
            return lhs.rank - rhs.rank; // 先比 rank
        } else if (lhs.cellY != rhs.cellY) {
            return lhs.cellY - rhs.cellY; // 再比行
        } else {
            return lhs.cellX - rhs.cellX; // 最后比列
        }
    }
};
```

### 排列子视图 arrangeChildren

任何增删后都要重新排列。`FolderPagedView.arrangeChildren()` 是核心：先清空所有页、按新顺序重填、多余的页删除、不足的页新建。

```java
public void arrangeChildren(List<View> list) {
    int itemCount = list.size();
    ArrayList<CellLayout> pages = new ArrayList<>();
    for (int i = 0; i < getChildCount(); i++) {
        CellLayout page = (CellLayout) getChildAt(i);
        page.removeAllViews(); // 先清空所有页的子视图
        pages.add(page);
    }
    mOrganizer.setFolderInfo(mFolder.getInfo());
    setupContentDimensions(itemCount); // 按新数量算网格尺寸

    Iterator<CellLayout> pageItr = pages.iterator();
    CellLayout currentPage = null;
    int position = 0;
    int rank = 0;
    for (int i = 0; i < itemCount; i++) {
        View v = list.size() > i ? list.get(i) : null;
        if (currentPage == null || position >= mOrganizer.getMaxItemsPerPage()) {
            // 换页：有旧页复用，没有就新建
            if (pageItr.hasNext()) currentPage = pageItr.next();
            else currentPage = createAndAddNewPage();
            position = 0;
        }
        if (v != null) {
            CellLayoutLayoutParams lp = (CellLayoutLayoutParams) v.getLayoutParams();
            ItemInfo info = (ItemInfo) v.getTag();
            lp.setCellXY(mOrganizer.getPosForRank(rank));
            currentPage.addViewToCellLayout(v, -1, info.getViewId(), lp, true);
            if (mOrganizer.isItemInPreview(rank) && v instanceof BubbleTextView) {
                ((BubbleTextView) v).verifyHighRes(); // 预览图标用高清图
            }
        }
        rank++;
        position++;
    }
    // 删多余页
    boolean removed = false;
    while (pageItr.hasNext()) {
        removeView(pageItr.next());
        removed = true;
    }
    if (removed) setCurrentPage(0);
    setEnableOverscroll(getPageCount() > 1);
    mPageIndicator.setVisibility(getPageCount() > 1 ? View.VISIBLE : View.GONE); // 单页隐藏指示器
    // ...
}
```

### 分页机制

`mMaxItemsPerPage = mMaxCountX * mMaxCountY`（由 DeviceProfile 的文件夹网格决定）。图标数超过单页就自动翻页。`addViewForRank()` 根据 rank 算页码：

```java
public void addViewForRank(View view, ItemInfo item, int rank) {
    int pageNo = rank / mOrganizer.getMaxItemsPerPage(); // 整除得页码
    CellLayoutLayoutParams lp = (CellLayoutLayoutParams) view.getLayoutParams();
    lp.setCellXY(mOrganizer.getPosForRank(rank));
    getPageAt(pageNo).addViewToCellLayout(view, -1, item.getViewId(), lp, true);
}
```

### 实时重排 realTimeReorder

拖拽过程中图标要让位，这叫 realtime reorder。`FolderPagedView.realTimeReorder()` 把空位（被拖走的图标位置）移到目标位置，沿途图标顺次平移。

```java
public void realTimeReorder(int empty, int target) {
    if (!mViewsBound) return;
    completePendingPageChanges();
    int delay = 0;
    float delayAmount = START_VIEW_REORDER_DELAY; // 30ms 起步
    int pageToAnimate = getNextPage();
    int maxItemsPerPage = mOrganizer.getMaxItemsPerPage();
    // ... 算方向、起止位置
    if (target == empty) return; // 没动
    else if (target > empty) {
        direction = 1; // 空位往后挪
        // ... 跨页时先瞬移
    } else {
        direction = -1; // 空位往前挪
        // ...
    }
    // 当前页内图标用 animateChildToPosition 平移
    CellLayout page = getPageAt(pageToAnimate);
    for (int i = startPos; i != endPos; i += direction) {
        int nextPos = i + direction;
        View v = page.getChildAt(nextPos % mGridCountX, nextPos / mGridCountX);
        if (page.animateChildToPosition(v, i % mGridCountX, i / mGridCountX,
                REORDER_ANIMATION_DURATION, delay, true, true)) { // 230ms
            delay += delayAmount;
            delayAmount *= VIEW_REORDER_DELAY_FACTOR; // 0.9，逐个递减延迟
        }
    }
}
```

`VIEW_REORDER_DELAY_FACTOR = 0.9f` 让每个图标的延迟比上一个少 10%，形成"波浪式"连锁动画，比齐刷刷移动更自然。

### 增删图标

`Folder.addFolderContent()` 是统一入口：入库 + 更新视图 + 刷新预览。

```java
public void addFolderContent(ItemInfo item, int rank, boolean animate) {
    if (!willAcceptItemType(item.itemType)) {
        throw new RuntimeException("tried to add an illegal type into a folder");
    }
    rank = Utilities.boundToRange(rank, 0, mInfo.getContents().size());
    mInfo.getContents().add(rank, item); // 加入数据模型
    if (!mSuppressContentUpdate) {
        FolderGridOrganizer verifier = createFolderGridOrganizer(
                mActivityContext.getDeviceProfile()).setFolderInfo(mInfo);
        verifier.updateRankAndPos(item, rank);
        mActivityContext.getModelWriter().addOrMoveItemInDatabase(item, mInfo.id, 0,
                item.cellX, item.cellY); // 写库
        updateItemLocationsInDatabaseBatch(false); // 批量更新其他图标 rank
        if (mContent.areViewsBound()) {
            mContent.createAndAddViewForRank(item, rank); // 加视图
        }
        mItemsInvalidated = true;
        updateTextViewFocus();
    }
    mActivityContext.getModelWriter().notifyItemModified(mInfo);
    mFolderIcon.onItemsChanged(animate); // 刷新桌面图标预览
}
```

`removeFolderContent()` 反向操作，注意它在图标数 ≤1 时触发解散：

```java
public void removeFolderContent(boolean animate, ItemInfo... items) {
    List<ItemInfo> itemArray = Arrays.asList(items);
    if (mInfo.getContents().removeAll(itemArray)) {
        mActivityContext.getModelWriter().notifyItemModified(mInfo);
    }
    if (!mSuppressContentUpdate) {
        mItemsInvalidated = true;
        itemArray.forEach(item -> mContent.removeItem(getViewForInfo(item)));
        if (mState == STATE_ANIMATING) mRearrangeOnClose = true;
        else rearrangeChildren();
        if (getItemCount() <= 1) { // 只剩 0 或 1 个
            if (mIsOpen) close(true);
            else replaceFolderWithFinalItem(); // 直接解散
        }
        updateTextViewFocus();
    }
    mFolderIcon.onItemsChanged(animate);
}
```

### 重命名

`FolderNameEditText` 是个定制 EditText。编辑完成（按回车/失焦/BackKey）时调 `mInfo.setTitle()` 写库。

```java
@Override
public boolean onBackKey() {
    String newTitle = mFolderName.getText().toString();
    mInfo.setTitle(newTitle, mActivityContext.getModelWriter()); // 写库
    mFolderIcon.onTitleChanged(newTitle); // 刷新桌面图标文字
    if (TextUtils.isEmpty(mInfo.title)) {
        mFolderName.setHint(R.string.folder_hint_text);
        mFolderName.setText("");
    } else {
        mFolderName.setHint(null);
    }
    // 无障碍播报重命名
    sendCustomAccessibilityEvent(this, AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED,
            getContext().getString(R.string.folder_renamed, newTitle));
    mFolderName.clearFocus();
    Selection.setSelection(mFolderName.getText(), 0, 0);
    mIsEditingName = false;
    return true;
}
```

`setTitle()` 内部根据 title 内容算 `LabelState`（UNLABELED/EMPTY/SUGGESTED/MANUAL），用于命名建议的机器学习打点：

```java
// FolderInfo 内
LabelState newLabelState =
        title == null ? LabelState.UNLABELED
                : title.length() == 0 ? LabelState.EMPTY :
                        getAcceptedSuggestionIndex().isPresent() ? LabelState.SUGGESTED
                                : LabelState.MANUAL;
if (newLabelState.equals(LabelState.MANUAL)) {
    setOption(FLAG_MANUAL_FOLDER_NAME, true, writer); // 标记为手动命名
}
```

### 面试深问

**Q1：为什么文件夹内图标不自动按字母排序？**
用户拖动顺序代表主观意图（常用的放前面）。自动字母排序会破坏用户排列，体验差。`ITEM_POS_COMPARATOR` 只按 rank 排，rank 由拖动落点决定。

**Q2：realTimeReorder 的延迟为什么用 0.9 的衰减因子？**
如果所有图标同时移动，视觉僵硬。`VIEW_REORDER_DELAY_FACTOR = 0.9` 让每个图标比前一个晚 10% 启动，形成"连锁波纹"效果，像多米诺骨牌。这是 Material Design 推荐的 staggered animation 手法。

**Q3：mSuppressContentUpdate 这个标记解决什么问题？**
某些操作（如 failed drop 把图标放回文件夹）需要先改数据模型再批量更新视图，中间过程不想触发逐个 add/remove。`executeWithContentUpdateSuppressed()` 把这些操作包起来，只在最后统一刷新一次，避免中间态闪烁。

## 文件夹的数据存储

文件夹在数据库（`favorites` 表）里是一行父记录 + 多行子记录的结构。父记录 `itemType = ITEM_TYPE_FOLDER`，子记录的 `container` 字段填父记录的 `id`。

### 表结构关系

```
favorites 表
┌──────┬─────────────┬───────────┬─────────┬───────┬────────┐
│ id   │ itemType    │ container │ screenId│ rank  │ title  │
├──────┼─────────────┼───────────┼─────────┼───────┼────────┤
│ 10   │ FOLDER      │ DESKTOP   │ 0       │ 0     │ Tools  │ ← 文件夹本身
│ 11   │ APPLICATION │ 10        │ 0       │ 0     │ -      │ ← 子图标1，container=10
│ 12   │ APPLICATION │ 10        │ 0       │ 1     │ -      │ ← 子图标2
│ 13   │ APP_PAIR    │ 10        │ 0       │ 2     │ -      │ ← 分屏对
└──────┴─────────────┴───────────┴─────────┴───────┴────────┘
```

文件夹本身的 `container/screenId/cellX/cellY` 表示它在桌面上的位置；子图标的这几个字段失效（cellX/cellY 被设为 -1），改用 `rank` 表示文件夹内顺序。

### FolderInfo 的 options 位标记

文件夹用一个 int `options` 字段存若干布尔标记，节省存储。

```java
public static final int FLAG_MULTI_PAGE_ANIMATION = 0x00000004; // 多页动画已播过
public static final int FLAG_MANUAL_FOLDER_NAME = 0x00000008;   // 用户手动命名过

public boolean hasOption(int optionFlag) {
    return (options & optionFlag) != 0;
}

public void setOption(int option, boolean isEnabled, ModelWriter writer) {
    // 位运算设置/清除标记，可选写库
}
```

`FLAG_MULTI_PAGE_ANIMATION` 标记"多页动画只播一次"——文件夹从单页变多页时播一次扩展动画，之后不再播，避免每次打开都啰嗦。`FLAG_MANUAL_FOLDER_NAME` 标记用户主动改过名，之后不再被自动建议覆盖。

### 批量更新 updateItemLocationsInDatabaseBatch

任何重排都要更新所有受影响图标的 rank。`Folder.updateItemLocationsInDatabaseBatch()` 一次性收集所有变化，批量写库，避免逐条 IO。

```java
private void updateItemLocationsInDatabaseBatch(boolean isBind) {
    FolderGridOrganizer verifier = createFolderGridOrganizer(
            mActivityContext.getDeviceProfile()).setFolderInfo(mInfo);
    ArrayList<ItemInfo> items = new ArrayList<>();
    int total = mInfo.getContents().size();
    for (int i = 0; i < total; i++) {
        ItemInfo itemInfo = mInfo.getContents().get(i);
        if (verifier.updateRankAndPos(itemInfo, i)) { // rank 变了才收集
            items.add(itemInfo);
        }
    }
    if (!items.isEmpty()) {
        mActivityContext.getModelWriter().moveItemsInDatabase(items, mInfo.id, 0); // 批量
    }
    if (!isBind && total > 1) {
        // 重新算命名建议（异步）
        LauncherComponentProvider.get(getContext()).getFolderNameSuggestionLoader()
                .getSuggestedFolderName(mInfo.getAppContents(),
                        folderNameInfos -> mInfo.suggestedFolderNames = folderNameInfos);
    }
}
```

`updateRankAndPos()` 只在 rank 真的变化时返回 true，减少无谓的数据库写入。

### 解散文件夹 replaceFolderWithFinalItem

文件夹只剩 1 个图标时自动解散，把那个图标放回桌面原位置。`LauncherDelegate.replaceFolderWithFinalItem()` 做这件事。

```java
boolean replaceFolderWithFinalItem(Folder folder) {
    Runnable onCompleteRunnable = new Runnable() {
        @Override
        public void run() {
            int itemCount = folder.getItemCount();
            FolderInfo info = folder.mInfo;
            if (itemCount <= 1) {
                View newIcon = null;
                ItemInfo finalItem = null;
                if (itemCount == 1) {
                    // 把最后一个图标移到桌面原位置
                    CellLayout cellLayout = mLauncher.getCellLayout(info.container,
                            mLauncher.getCellPosMapper().mapModelToPresenter(info).screenId);
                    finalItem = info.getContents().remove(0);
                    newIcon = mLauncher.getItemInflater().inflateItem(finalItem, cellLayout);
                    mLauncher.getModelWriter().addOrMoveItemInDatabase(finalItem,
                            info.container, info.screenId, info.cellX, info.cellY);
                }
                // 删除文件夹记录
                mLauncher.removeItem(folder.mFolderIcon, info, true /* deleteFromDb */,
                        "folder removed because there's only 1 item in it");
                if (newIcon != null) {
                    mLauncher.getWorkspace().addInScreenFromBind(newIcon, info);
                    newIcon.requestFocus();
                }
                // 打点：文件夹转图标
                if (finalItem != null) {
                    StatsLogger logger = mLauncher.getStatsLogManager().logger().withItemInfo(finalItem);
                    mLauncher.getDragController().getLogInstanceId()
                            .map(logger::withInstanceId).orElse(logger)
                            .log(LAUNCHER_FOLDER_CONVERTED_TO_ICON);
                }
            }
        }
    };
    View finalChild = folder.mContent.getLastItem();
    if (finalChild != null) {
        folder.mFolderIcon.performDestroyAnimation(onCompleteRunnable); // 播解散动画再删
    } else {
        onCompleteRunnable.run(); // 没图标直接删
    }
    return true;
}
```

解散动画 `performDestroyAnimation()` 把最后一个预览图标放大成正常图标尺寸，视觉上"文件夹变回图标"：

```java
public void performDestroyAnimation(Runnable onCompleteRunnable) {
    mPreviewItemManager.createFirstItemAnimation(true /* reverse */, onCompleteRunnable).start();
}
```

### 命名建议

新建文件夹后系统会推测名字。`FolderNameProvider.getSuggestedFolderName()` 有两条规则：全工作区图标→"Work"；同包名图标→包名。

```java
public void getSuggestedFolderName(Context context,
        ArrayList<WorkspaceItemInfo> workspaceItemInfos, FolderNameInfos nameInfos) {
    // 规则1：全是工作区 profile 的图标 → 建议工作区名
    Set<UserHandle> users = workspaceItemInfos.stream().map(w -> w.user)
            .collect(Collectors.toSet());
    if (users.size() == 1 && !users.contains(Process.myUserHandle())) {
        setAsLastSuggestion(nameInfos, getWorkFolderName(context));
    }
    // 规则2：全同包名 → 建议包名（如全是 com.google.xxx → Google）
    Set<String> packageNames = workspaceItemInfos.stream()
            .map(WorkspaceItemInfo::getTargetComponent)
            .filter(Objects::nonNull)
            .map(ComponentName::getPackageName)
            .collect(Collectors.toSet());
    if (packageNames.size() == 1) {
        Optional<AppInfo> info = getAppInfoByPackageName(packageNames.iterator().next());
        info.ifPresent(i -> setAsFirstSuggestion(
                nameInfos, i.title == null ? "" : i.title.toString()));
    }
}
```

建议结果存 `FolderNameInfos`，最多 4 个（`SUGGEST_MAX = 4`，对应 IME 3 个候选 + 输入框 1 个）。`FolderNameInfos` 用位标记表达状态：

```java
public static final int SUCCESS = 1;
public static final int HAS_PRIMARY = 1 << 1;       // 有主建议
public static final int HAS_SUGGESTIONS = 1 << 2;    // 有候选
public static final int ERROR_NO_PROVIDER = 1 << 3;  // 无 provider
// ... 其他错误码
```

### 自动命名 setLabelSuggestion

新建文件夹后，如果处于 `UNLABELED` 态，自动套用第一个建议。`FolderIcon.setLabelSuggestion()` 做这件事，并打点供 ML 训练。

```java
public void setLabelSuggestion(FolderNameInfos nameInfos, InstanceId instanceId) {
    if (!mInfo.getLabelState().equals(LabelState.UNLABELED)) return; // 只给未命名夹套
    if (nameInfos == null || !nameInfos.hasSuggestions()) {
        // 打点：跳过命名（无建议）
        StatsLogManager.newInstance(getContext()).logger().withInstanceId(instanceId)
                .withItemInfo(mInfo).log(LAUNCHER_FOLDER_AUTO_LABELING_SKIPPED_EMPTY_SUGGESTIONS);
        return;
    }
    if (!nameInfos.hasPrimary()) {
        // 打点：跳过命名（无主建议）
        StatsLogManager.newInstance(getContext()).logger().withInstanceId(instanceId)
                .withItemInfo(mInfo).log(LAUNCHER_FOLDER_AUTO_LABELING_SKIPPED_EMPTY_PRIMARY);
        return;
    }
    CharSequence newTitle = nameInfos.getLabels()[0];
    FromState fromState = mInfo.getFromLabelState();
    mInfo.setTitle(newTitle, mActivity.getModelWriter());
    onTitleChanged(mInfo.title);
    mFolder.getFolderName().setText(mInfo.title);
    // 打点：自动命名成功
    StatsLogManager.newInstance(getContext()).logger().withInstanceId(instanceId)
            .withItemInfo(mInfo).withFromState(fromState).withToState(ToState.TO_SUGGESTION0)
            .withEditText(newTitle.toString()).log(LAUNCHER_FOLDER_AUTO_LABELED);
}
```

### 面试深问

**Q1：文件夹子图标为什么 cellX/cellY 设成 -1？**
文件夹内位置由 rank 决定，cellX/cellY 无意义。设 -1 是个哨兵值，表示"不属于任何二维网格"。绑定渲染时由 `FolderGridOrganizer.getPosForRank()` 临时算出 cellX/cellY，不读数据库里的值。

**Q2：FLAG_MULTI_PAGE_ANIMATION 为什么只播一次？**
单页扩成多页时，第一次播扩展动画告诉用户"现在能翻页了"。之后每次打开都播会啰嗦。标记位记录"已播过"，下次直接跳过。用户把文件夹删到单页再加回多页，标记会被清掉重新播。

**Q3：命名建议为什么放后台线程算？**
`FolderNameProvider` 构造函数强制 `assertWorkerThread()`。算建议要查所有 app 信息和已有文件夹，IO 密集。放后台避免阻塞拖拽动画。结果通过 `FolderNameSuggestionLoader` 异步回调，主线程只负责套用。

## 文件夹与拖拽系统的交互

文件夹既是 DropTarget（接收拖入），也是 DragSource（内部图标可拖出）。拖拽交互分散在 `Folder`、`FolderIcon`、`Workspace` 三处。

### FolderIcon 作为 DropTarget

拖到桌面文件夹图标上时，`FolderIcon.onDragEnter()` 播接受动画，并设个 800ms 定时器——停够久就自动展开文件夹（spring loading）。

```java
public void onDragEnter(ItemInfo dragInfo) {
    if (mFolder.isDestroyed() || !willAcceptItem(dragInfo)) return;
    CellLayoutLayoutParams lp = (CellLayoutLayoutParams) getLayoutParams();
    CellLayout cl = (CellLayout) getParent().getParent();
    mBackground.animateToAccept(cl, lp.getCellX(), lp.getCellY()); // 背景放大
    mOpenAlarm.setOnAlarmListener(mOnOpenListener);
    if (SPRING_LOADING_ENABLED &&
            ((dragInfo instanceof WorkspaceItemFactory)
                    || (dragInfo instanceof PendingAddShortcutInfo)
                    || Folder.willAccept(dragInfo))) {
        mOpenAlarm.setAlarm(ON_OPEN_DELAY); // 800ms 后自动展开
    }
}

OnAlarmListener mOnOpenListener = new OnAlarmListener() {
    public void onAlarm(Alarm alarm) {
        mFolder.beginExternalDrag(); // 触发展开
    }
};
```

`ON_OPEN_DELAY = 800` 是经验值：太短会误触发，太长用户觉得迟钝。`beginExternalDrag()` 以"外部拖拽"模式打开文件夹，末尾留个空位等 drop。

### 拖入文件夹 onDrop

`FolderIcon.onDrop()` 是合并入口。它处理三种来源：AllApps（要复制）、跨窗口（要复制）、本桌面（直接用）。

```java
public void onDrop(DragObject d, boolean itemReturnedOnFailedDrop) {
    ItemInfo item;
    if (d.dragInfo instanceof WorkspaceItemFactory) {
        item = ((WorkspaceItemFactory) d.dragInfo).makeWorkspaceItem(getContext()); // AllApps 来的复制一份
    } else if (d.dragSource instanceof BaseItemDragListener) {
        if (d.dragInfo instanceof AppPairInfo) {
            item = new AppPairInfo((AppPairInfo) d.dragInfo); // 跨窗口复制
        } else {
            item = new WorkspaceItemInfo((WorkspaceItemInfo) d.dragInfo);
        }
    } else {
        item = d.dragInfo; // 本桌面直接用
    }
    mFolder.notifyDrop();
    onDrop(item, d, null, 1.0f,
            itemReturnedOnFailedDrop ? item.rank : mInfo.getContents().size(),
            itemReturnedOnFailedDrop);
}
```

内部 `onDrop()` 算落点动画终点（预览图里的位置），播飞入动画，再调 `addFolderContent` 入库。

```java
private void onDrop(final ItemInfo item, DragObject d, Rect finalRect,
        float scaleRelativeToDragLayer, int index, boolean itemReturnedOnFailedDrop) {
    item.cellX = -1; item.cellY = -1; // 入夹后网格坐标失效
    DragView animateView = d.dragView;
    if (animateView != null && mActivity instanceof Launcher) {
        final Launcher launcher = (Launcher) mActivity;
        DragLayer dragLayer = launcher.getDragLayer();
        Rect to = finalRect;
        if (to == null) {
            to = new Rect();
            // 算 FolderIcon 在 DragLayer 的最终矩形
            // ...
        }
        int numItemsInPreview = Math.min(MAX_NUM_ITEMS_IN_PREVIEW, index + 1);
        // ... 处理预览图变更（新图标挤进预览位时旧图标让位）
        int[] center = new int[2];
        float scale = getLocalCenterForIndex(index, numItemsInPreview, center); // 算预览位中心
        center[0] = Math.round(scaleRelativeToDragLayer * center[0]);
        center[1] = Math.round(scaleRelativeToDragLayer * center[1]);
        to.offset(center[0] - animateView.getMeasuredWidth() / 2,
                center[1] - animateView.getMeasuredHeight() / 2);
        float finalAlpha = index < MAX_NUM_ITEMS_IN_PREVIEW ? 1f : 0f; // 预览外透明
        float finalScale = scale * scaleRelativeToDragLayer;
        // 飞入动画
        dragLayer.animateView(animateView, to, finalAlpha, finalScale, finalScale,
                DROP_IN_ANIMATION_DURATION, Interpolators.DECELERATE_2,
                () -> {
                    mPreviewItemManager.hidePreviewItem(finalIndex, false);
                    mFolder.showItem(item);
                }, DragLayer.ANIMATION_END_DISAPPEAR, null);
        mFolder.hideItem(item); // 飞行途中先隐藏目标位
        // ...
    } else {
        getFolder().addFolderContent(item); // 无动画直接加
    }
}
```

### 预览图变更动画 onDrop

新图标加入可能挤进预览位，把旧预览图标挤出。`PreviewItemManager.onDrop()` 算三类变化：移入、移位、移出，各自动画。

```java
public void onDrop(List<ItemInfo> oldItems, List<ItemInfo> newItems, ItemInfo dropped) {
    int numItems = newItems.size();
    final ArrayList<PreviewItemDrawingParams> params = mFirstPageParams;
    buildParamsForPage(0, params, false);

    // 移入：新进预览的图标（除被拖的）
    List<ItemInfo> moveIn = new ArrayList<>();
    for (ItemInfo newItem : newItems) {
        if (!oldItems.contains(newItem) && !newItem.equals(dropped)) {
            moveIn.add(newItem);
        }
    }
    for (int i = 0; i < moveIn.size(); ++i) {
        int prevIndex = newItems.indexOf(moveIn.get(i));
        PreviewItemDrawingParams p = params.get(prevIndex);
        computePreviewItemDrawingParams(prevIndex, numItems, p);
        updateTransitionParam(p, moveIn.get(i), ENTER_INDEX, newItems.indexOf(moveIn.get(i)), numItems);
    }
    // 移位：预览内换了位置
    for (int newIndex = 0; newIndex < newItems.size(); ++newIndex) {
        int oldIndex = oldItems.indexOf(newItems.get(newIndex));
        if (oldIndex >= 0 && newIndex != oldIndex) {
            PreviewItemDrawingParams p = params.get(newIndex);
            updateTransitionParam(p, newItems.get(newIndex), oldIndex, newIndex, numItems);
        }
    }
    // 移出：被挤出预览的图标
    List<ItemInfo> moveOut = new ArrayList<>(oldItems);
    moveOut.removeAll(newItems);
    for (int i = 0; i < moveOut.size(); ++i) {
        ItemInfo item = moveOut.get(i);
        int oldIndex = oldItems.indexOf(item);
        PreviewItemDrawingParams p = computePreviewItemDrawingParams(oldIndex, numItems, null);
        updateTransitionParam(p, item, oldIndex, EXIT_INDEX, numItems);
        params.add(0, p); // 移出的画最前（最上层）
    }
    for (int i = 0; i < params.size(); ++i) {
        if (params.get(i).anim != null) params.get(i).anim.start();
    }
}
```

`ENTER_INDEX = -3` 和 `EXIT_INDEX = -2` 是预览图进出的特殊索引，在 `computePreviewItemDrawingParams()` 里有专门的位置（进：右下；出：右上）。

```java
// ClippedFolderIconLayoutRule.computePreviewItemDrawingParams()
if (index == EXIT_INDEX) {
    getGridPosition(0, 2, mTmpPoint);  // 0 1 *  ← 退出位（行0列2）
} else if (index == ENTER_INDEX) {
    getGridPosition(1, 2, mTmpPoint);  // 0 1
                                         // 2 3 * ← 进入位（行1列2）
}
```

### 从文件夹拖出

长按文件夹内图标触发拖拽。`Folder.startDrag()` 记录被拖视图和空位 rank，调 `beginDragShared()` 走标准拖拽流程。

```java
public boolean startDrag(View v, DragOptions options) {
    Object tag = v.getTag();
    if (tag instanceof ItemInfo item) {
        mEmptyCellRank = item.rank; // 记空位（被拖走的位置）
        mCurrentDragView = v;
        addDragListener(options);
        callBeginDragShared(v, options);
    }
    return true;
}
```

拖拽开始时 `onDragStart()` 把被拖视图从文件夹移除，但暂不改数据库（失败要放回）。

```java
@Override
public void onDragStart(DropTarget.DragObject dragObject, DragOptions options) {
    if (dragObject.dragSource != this) return;
    mContent.removeItem(mCurrentDragView); // 视图移除
    mItemsInvalidated = true;
    // 改数据模型但不写库（executeWithContentUpdateSuppressed 抑制写库）
    executeWithContentUpdateSuppressed(() -> removeFolderContent(true, dragObject.dragInfo));
    mIsDragInProgress = true;
    mItemAddedBackToSelfViaIcon = false;
}
```

### 拖出后落点完成 onDropCompleted

拖出文件夹后，根据落点是否成功决定放回还是真正移除。

```java
@Override
public void onDropCompleted(final View target, final DragObject d, final boolean success) {
    if (success) {
        if (getItemCount() <= 1) {
            mDeleteFolderOnDropCompleted = true; // 只剩1个，标记解散
        }
        if (mDeleteFolderOnDropCompleted && !mItemAddedBackToSelfViaIcon && target != this) {
            replaceFolderWithFinalItem(); // 解散文件夹
        }
    } else {
        // 拖失败，把图标放回文件夹原位
        ItemInfo info = d.dragInfo;
        View icon = (mCurrentDragView != null && mCurrentDragView.getTag() == info)
                ? mCurrentDragView : mContent.createNewView(info);
        ArrayList<View> views = getIconsInReadingOrder();
        if (!views.contains(icon)) {
            info.rank = Utilities.boundToRange(info.rank, 0, views.size());
            views.add(info.rank, icon);
            mContent.arrangeChildren(views);
            mItemsInvalidated = true;
            executeWithContentUpdateSuppressed(
                    () -> mFolderIcon.onDrop(d, true /* itemReturnedOnFailedDrop */));
        }
    }
    // ...
    mDeleteFolderOnDropCompleted = false;
    mIsDragInProgress = false;
    mCurrentDragView = null;
    updateItemLocationsInDatabaseBatch(false); // 最后批量写库
    if (getItemCount() <= mContent.itemsPerPage()) {
        mInfo.setOption(FolderInfo.FLAG_MULTI_PAGE_ANIMATION, false,
                mActivityContext.getModelWriter()); // 重新可能播多页动画
    }
}
```

**拖出最后一个自动解散**：`getItemCount() <= 1` 触发 `mDeleteFolderOnDropCompleted = true`，配合 `target != this`（拖到了文件夹外），最终调 `replaceFolderWithFinalItem()`。

### 文件夹内的拖拽落点 onDragOver

在打开的文件夹内拖动时，`Folder.onDragOver()` 算目标 rank，触发实时重排。

```java
@Override
public void onDragOver(DropObject d) {
    if (mScrollPauseAlarm.alarmPending()) return; // 翻页滚动中不处理
    final float[] r = new float[2];
    mTargetRank = getTargetRank(d, r); // 找最近格子
    if (mTargetRank != mPrevTargetRank) {
        mReorderAlarm.cancelAlarm();
        mReorderAlarm.setOnAlarmListener(mReorderAlarmListener);
        mReorderAlarm.setAlarm(REORDER_DELAY); // 250ms 后重排（防抖）
        mPrevTargetRank = mTargetRank;
        if (d.stateAnnouncer != null) {
            d.stateAnnouncer.announce(getContext().getString(R.string.move_to_position,
                    mTargetRank + 1)); // 无障碍播报位置
        }
    }
    // 左右边缘触发翻页
    float x = r[0];
    int currentPage = mContent.getNextPage();
    float cellOverlap = mContent.getCurrentCellLayout().getCellWidth() * ICON_OVERSCROLL_WIDTH_FACTOR; // 0.45
    boolean isOutsideLeftEdge = x < cellOverlap;
    boolean isOutsideRightEdge = x > (getWidth() - cellOverlap);
    if (currentPage > 0 && (mContent.mIsRtl ? isOutsideRightEdge : isOutsideLeftEdge)) {
        showScrollHint(SCROLL_LEFT, d);
    } else if (currentPage < (mContent.getPageCount() - 1)
            && (mContent.mIsRtl ? isOutsideLeftEdge : isOutsideRightEdge)) {
        showScrollHint(SCROLL_RIGHT, d);
    } else {
        mOnScrollHintAlarm.cancelAlarm();
        if (mScrollHintDir != SCROLL_NONE) {
            mContent.clearScrollHint();
            mScrollHintDir = SCROLL_NONE;
        }
    }
}
```

`REORDER_DELAY = 250` 是防抖——手指抖动导致 rank 频繁变化时不立即重排，停 250ms 才动。`ICON_OVERSCROLL_WIDTH_FACTOR = 0.45` 定义翻页触发区（边缘 45% 格宽内）。

### 跨页拖动

拖到边缘时 `showScrollHint()` 先显示翻页预告（页面微微偏移），持续 `SCROLL_HINT_DURATION(500ms)` 后真翻页。

```java
private void showScrollHint(int direction, DragObject d) {
    if (mScrollHintDir != direction) {
        mContent.showScrollHint(direction); // 页面偏移一点预告
        mScrollHintDir = direction;
    }
    if (!mOnScrollHintAlarm.alarmPending() || mCurrentScrollDir != direction) {
        mCurrentScrollDir = direction;
        mOnScrollHintAlarm.cancelAlarm();
        mOnScrollHintAlarm.setOnAlarmListener(new OnScrollHintListener(d));
        mOnScrollHintAlarm.setAlarm(SCROLL_HINT_DURATION); // 500ms 后真翻
        mReorderAlarm.cancelAlarm();
        mTargetRank = mEmptyCellRank;
    }
}
```

`OnScrollHintListener` 在定时器触发时翻页，并暂停拖拽事件直到翻页动画结束：

```java
private class OnScrollHintListener implements OnAlarmListener {
    private final DragObject mDragObject;
    @Override
    public void onAlarm(Alarm alarm) {
        if (mCurrentScrollDir == SCROLL_LEFT) mContent.scrollLeft();
        else if (mCurrentScrollDir == SCROLL_RIGHT) mContent.scrollRight();
        else return;
        mCurrentScrollDir = SCROLL_NONE;
        // 翻页动画期间暂停拖拽事件
        mScrollPauseAlarm.setOnAlarmListener(new OnScrollFinishedListener(mDragObject));
        int rescrollDelay = getResources().getInteger(
                R.integer.config_pageSnapAnimationDuration) + RESCROLL_EXTRA_DELAY; // +150ms
        mScrollPauseAlarm.setAlarm(rescrollDelay);
    }
}
```

`showScrollHint()` 在 `FolderPagedView` 里实现，让页面偏移 7% 宽度做预告：

```java
public void showScrollHint(int direction) {
    float fraction = (direction == Folder.SCROLL_LEFT) ^ mIsRtl
            ? -SCROLL_HINT_FRACTION : SCROLL_HINT_FRACTION; // 0.07
    int hint = (int) (fraction * getWidth());
    int scroll = getScrollForPage(getNextPage()) + hint;
    int delta = scroll - getScrollX();
    if (delta != 0) {
        mScroller.startScroll(getScrollX(), 0, delta, 0, Folder.SCROLL_HINT_DURATION);
        invalidate();
    }
}
```

### 落点 onDrop

拖拽松手时 `Folder.onDrop()` 算最终落点，必要时先重排（如果翻页期间 rank 变了）。

```java
@Override
public void onDrop(DragObject d, DragOptions options) {
    // 翻页期间落点要重算
    if (!mContent.rankOnCurrentPage(mEmptyCellRank)) {
        mTargetRank = getTargetRank(d, null);
        mReorderAlarmListener.onAlarm(mReorderAlarm); // 立即重排
        mOnScrollHintAlarm.cancelAlarm();
        mScrollPauseAlarm.cancelAlarm();
    }
    mContent.completePendingPageChanges();
    // ... 处理 PendingAddShortcutInfo / WorkspaceItemFactory 等来源
    final ItemInfo si = d.dragInfo;
    View currentDragView;
    if (mIsExternalDrag) {
        currentDragView = mContent.createAndAddViewForRank(si, mEmptyCellRank);
        mActivityContext.getModelWriter().addOrMoveItemInDatabase(
                si, mInfo.id, 0, si.cellX, si.cellY); // 外部拖拽写库
        mIsExternalDrag = false;
    } else {
        currentDragView = mCurrentDragView;
        mContent.addViewForRank(currentDragView, si, mEmptyCellRank);
    }
    // 飞入动画
    if (d.dragView.hasDrawn()) {
        float scaleX = getScaleX(); float scaleY = getScaleY();
        setScaleX(1.0f); setScaleY(1.0f);
        launcher.getDragLayer().animateViewIntoPosition(d.dragView, currentDragView, null);
        setScaleX(scaleX); setScaleY(scaleY);
    } else {
        d.deferDragViewCleanupPostAnimation = false;
        currentDragView.setVisibility(VISIBLE);
    }
    mItemsInvalidated = true;
    rearrangeChildren();
    executeWithContentUpdateSuppressed(() -> addFolderContent(si, mEmptyCellRank, false));
    if (d.dragSource != this) {
        updateItemLocationsInDatabaseBatch(false); // 跨源才批量写库
    }
    // ...
}
```

### 通知红点同步

文件夹内图标的通知红点要汇总到文件夹图标上。`FolderIcon.updateDotInfo()` 遍历所有子图标，求红点和。

```java
public void updateDotInfo() {
    boolean hadDot = mDotInfo.hasDot();
    mDotInfo.reset();
    for (ItemInfo si : mInfo.getContents()) {
        mDotInfo.addDotInfo(mActivity.getDotInfoForItem(si)); // 求和
    }
    boolean isDotted = mDotInfo.hasDot();
    float newDotScale = isDotted ? 1f : 0f;
    if ((hadDot ^ isDotted) && isShown()) {
        animateDotScale(newDotScale); // 红点出现/消失动画
    } else {
        cancelDotScaleAnim();
        mDotScale = newDotScale;
        invalidate();
    }
}
```

红点绘制 `drawDot()` 考虑了"接受合并"态——背景放大时红点要缩小消失，避免和放大背景重叠。

```java
public void drawDot(Canvas canvas) {
    if (!mForceHideDot && ((mDotInfo != null && mDotInfo.hasDot()) || mDotScale > 0)) {
        // ... 算红点位置（基于图标 bounds）
        // 接受态时红点随背景放大而消失
        mDotParams.scale = Math.max(0, mDotScale - mBackground.getAcceptScaleProgress());
        mDotRenderer.draw(canvas, mDotParams);
    }
}
```

### 面试深问

**Q1：拖出最后一个图标为什么不在 onDragStart 就解散？**
拖拽可能失败（拖到无效区域），那时要把图标放回。如果 start 时就解散，失败时文件夹已没了没法放回。正确流程：start 时只改内存数据（suppressContentUpdate），dropCompleted 成功才真正解散，失败放回。

**Q2：spring loading 的 800ms 延迟为什么不用 Handler postDelayed？**
`Alarm` 类支持 cancel 和重新设定，比 Handler 灵活。拖拽过程中手指可能多次进出文件夹区域，每次 enter 要重置定时器，exit 要取消。Alarm 的 `setAlarm/cancelAlarm` 语义清晰。Handler 也能做但要自己管回调清理。

**Q3：翻页时的滚动预告为什么是 7% 宽度？**
`SCROLL_HINT_FRACTION = 0.07f`。太小用户看不到反馈，太大像真的翻页了。7% 是"刚好能察觉到方向"的临界值，配合 500ms 延迟，给用户"可以收手让它翻"的反应时间。

## 附录：关键常量速查

| 常量 | 值 | 出处 | 含义 |
|---|---|---|---|
| `MAX_NUM_ITEMS_IN_PREVIEW` | 4 | ClippedFolderIconLayoutRule | 预览图最多图标数 |
| `MIN_SCALE` | 0.44f | ClippedFolderIconLayoutRule | 预览图标最小缩放 |
| `MAX_SCALE` | 0.51f | ClippedFolderIconLayoutRule | 预览图标最大缩放 |
| `ICON_OVERLAP_FACTOR` | 1.125 | ClippedFolderIconLayoutRule | 预览图标溢出背景的系数 |
| `ACCEPT_SCALE_FACTOR` | 1.20f | PreviewBackground | 接受合并时背景放大倍数 |
| `HOVER_SCALE` | 1.1f | PreviewBackground | hover 时背景放大倍数 |
| `ON_OPEN_DELAY` | 800 | FolderIcon | 拖入自动展开延迟 |
| `DROP_IN_ANIMATION_DURATION` | 400 | FolderIcon | 拖入飞行动画时长 |
| `INITIAL_ITEM_ANIMATION_DURATION` | 350 | PreviewItemManager | 首图标入场动画 |
| `REORDER_DELAY` | 250 | Folder | 实时重排防抖延迟 |
| `SCROLL_HINT_DURATION` | 500 | Folder | 翻页预告持续时长 |
| `ICON_OVERSCROLL_WIDTH_FACTOR` | 0.45f | Folder | 翻页触发区宽度系数 |
| `ON_EXIT_CLOSE_DELAY` | 400 | Folder | 拖出后关闭延迟 |
| `SCROLL_HINT_FRACTION` | 0.07f | FolderPagedView | 翻页预告偏移比例 |
| `REORDER_ANIMATION_DURATION` | 230 | FolderPagedView | 重排动画时长 |
| `VIEW_REORDER_DELAY_FACTOR` | 0.9f | FolderPagedView | 连锁重排延迟衰减 |
| `FLAG_MULTI_PAGE_ANIMATION` | 0x04 | FolderInfo | 多页动画已播标记 |
| `FLAG_MANUAL_FOLDER_NAME` | 0x08 | FolderInfo | 手动命名标记 |
| `SUGGEST_MAX` | 4 | FolderNameProvider | 命名建议上限 |
| `EXTRA_FOLDER_REVEAL_RADIUS_PERCENTAGE` | 0.125 | FolderAnimationManager | 内容 reveal 余量 |

## 附录：核心方法调用链

### 创建文件夹
```
Workspace.onDragOver
  → manageFolderFeedback (距离判定)
    → willCreateUserFolder
    → mFolderCreateBg.animateToAccept (背景放大预告)
Workspace.onDrop
  → createUserFolderIfNecessary
    → mLauncher.addFolder (插库 + inflate FolderIcon)
    → FolderIcon.setFolderBackground (继承预告背景)
    → FolderIcon.performCreateAnimation
      → Folder.addFolderContent (目标图标入库)
      → PreviewItemManager.createFirstItemAnimation (目标飞入预览)
      → FolderIcon.onDrop (拖拽物飞入预览)
```

### 打开文件夹
```
FolderIcon.onClick
  → Folder.animateOpen
    → shouldAnimateOpen (≤1 个图标不播)
    → closeOpenFolder (关掉其他已开文件夹)
    → FolderPagedView.bindItems
    → centerAboutIcon (定位浮层)
    → DragLayer.addView (加进拖拽层)
    → FolderAnimationManager.createAnimatorSet(true)
      → 算 initialScale (预览态缩放)
      → reveal 动画 (圆角过渡)
      → 背景颜色渐变
      → 图标缩放平移
    → animatorSet.start
    → setState(STATE_OPEN)
```

### 拖入已有文件夹
```
FolderIcon.onDragEnter
  → animateToAccept (背景放大)
  → mOpenAlarm.setAlarm(800ms) (spring loading)
FolderIcon.onDrop
  → 判定来源 (AllApps/跨窗口/本桌面)
  → 算预览位中心
  → DragLayer.animateView (飞入动画)
  → PreviewItemManager.onDrop (预览图重排动画)
  → Folder.addFolderContent (入库)
  → setLabelSuggestion (自动命名)
```

### 拖出图标
```
Folder.startDrag (长按内部图标)
  → 记录 mEmptyCellRank
  → callBeginDragShared
Folder.onDragStart
  → removeItem (视图移除)
  → removeFolderContent (suppressContentUpdate, 不写库)
落到文件夹外 → Folder.onDropCompleted(success=true)
  → getItemCount ≤ 1 → replaceFolderWithFinalItem (解散)
落到无效区 → onDropCompleted(success=false)
  → 图标放回原 rank
  → FolderIcon.onDrop(itemReturnedOnFailedDrop=true)
```
