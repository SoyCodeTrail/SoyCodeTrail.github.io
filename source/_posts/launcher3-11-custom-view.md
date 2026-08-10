---
title: Launcher3 源码精读（11）：自定义视图
category: client
platform: android
tags: ["AOSP", "Launcher3", "源码", "Framework"]
readTime: 21分钟
featured: true
date: 2026-08-02
---

# Launcher3 自定义视图体系

Launcher3 的整个界面几乎全部由自定义 View 构成，从桌面图标、文件夹、AllApps 列表，到拖拽时弹出的删除栏、长按弹出的快捷方式菜单、底部的 Snackbar 提示，每一个视觉元素背后都有一个对应的自定义视图类。这些视图并不是随意散落的，而是围绕几个核心基类组织成一套清晰的层级体系：`LauncherRootView` 是整棵视图树的根，`BaseDragLayer` 负责承载所有浮层，`AbstractFloatingView` 抽象出所有「弹出层」的共同行为，`BubbleTextView` 则是几乎所有图标（桌面、AllApps、文件夹、Taskbar）的统一载体。

理解这套视图体系，关键在于抓住三个设计要点：第一，Launcher 不复用系统的通用控件，而是针对桌面场景做了大量性能与交互定制；第二，所有「会弹出、会关闭」的界面被抽象成一个统一的浮层模型，由 `DragLayer` 统一管理生命周期；第三，图标视图通过数据绑定（`applyFromItemInfo`）+ 缓存加载（`IconCache`）+ 自绘制（红点、运行指示器）三段式工作，把「数据→视图」的链路解耦得很干净。本文按从核心到外围的顺序，逐个拆解这些视图的实现与设计意图。

## 一、BubbleTextView：桌面图标的统一载体

### 1.1 为什么继承 TextView 而不是自定义 View

`BubbleTextView` 是 Launcher3 里最核心、出现频率最高的视图，桌面上每一个应用图标、AllApps 列表里的每一行、文件夹里的每一个图标、Taskbar 上的每一个应用，底层都是同一个类的实例。它的声明是这样的：

```java
// 继承 TextView 而非自定义 View，复用文字测量/绘制/省略号/无障碍能力
public class BubbleTextView extends TextView implements ItemInfoUpdateReceiver,
        FloatingIconViewCompanion, DraggableView, Reorderable, Poppable {
```

这里有一个非常关键的设计决策：为什么图标视图要继承 `TextView`，而不是自己继承 `View` 把图标和文字都画出来？类头注释给出了直接答案：

```java
/**
 * TextView that draws a bubble behind the text. We cannot use a LineBackgroundSpan
 * because we want to make the bubble taller than the text and TextView's clip is
 * too aggressive.
 */
// 翻译：在文字背后画气泡的 TextView。无法用 LineBackgroundSpan，
// 因为气泡要比文字更高，而 TextView 的裁剪太激进
```

换句话说，AOSP 工程师评估过用 `LineBackgroundSpan`（给文字加背景的官方方案）的可行性，发现 TextView 内部对文字行的裁剪太狠，气泡无法做得比文字更高，于是放弃，转而直接继承 TextView 然后自己接管绘制。

继承 TextView 带来的实际好处是巨大的，主要体现在四个方面：

第一，文字测量与布局完全免费。Launcher 的图标标签需要处理省略号（`TruncateAt.END`）、字间距压缩、两行换行、RTL、大字体无障碍等场景。`TextView` 内部有成熟的 `StaticLayout`、`BoringLayout` 体系，自己重写这套逻辑成本极高且容易出 bug。看 `onMeasure` 里对两行标签的处理就明白自己实现有多复杂：

```java
@Override
protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
    int height = MeasureSpec.getSize(heightMeasureSpec); // 取父布局给定的高度
    if (mCenterVertically) { // 需要垂直居中时，手动计算 padding 把内容推到中间
        Paint.FontMetrics fm = getPaint().getFontMetrics();
        int cellHeightPx = mIconSize + getCompoundDrawablePadding() +
                (int) Math.ceil(fm.bottom - fm.top) * getCellSpecMaxTextLineCount();
        setPadding(getPaddingLeft(), (height - cellHeightPx) / 2, getPaddingRight(),
                getPaddingBottom()); // 上 padding = (格子高度 - 内容高度) / 2
    }
    // ...两行标签的换行计算
    super.onMeasure(widthMeasureSpec, heightMeasureSpec); // 最终交给 TextView 测量
}
```

第二，图标天然作为 `compound drawable` 挂在 TextView 上。`BubbleTextView` 把应用图标当作 TextView 的「复合 drawable」来用，调用 `setCompoundDrawables` 就能把图标显示在文字上方，省掉了自己画图标的麻烦：

```java
private void updateIcon(Drawable newIcon) {
    if (mLayoutHorizontal) { // 横向布局（搜索结果）时图标在左
        setCompoundDrawablesRelative(newIcon, null, null, null);
    } else { // 默认纵向布局，图标在上
        setCompoundDrawables(null, newIcon, null, null);
    }
}
```

第三，无障碍能力（contentDescription、 Marlquee 跑马灯、触摸探索）TextView 全部内置。`onFocusChanged` 里切跑马灯就是一行代码：

```java
@Override
protected void onFocusChanged(boolean focused, int direction, Rect previouslyFocusedRect) {
    // 失焦时关掉跑马灯，避免更新文字触发重排
    setEllipsize(focused ? TruncateAt.MARQUEE : TruncateAt.END);
    super.onFocusChanged(focused, direction, previouslyFocusedRect);
}
```

第四，TextView 的状态机（pressed、focused、enabled）可以直接通过 `onCreateDrawableState` 扩展，不必自己维护。`BubbleTextView` 正是利用这一点加了 `mStayPressed`（拖拽时图标保持按下高亮）这个自定义状态。

继承 TextView 的代价是：TextView 是个重类，构造和测量开销不小。Launcher 通过 RecyclerView 复用（AllApps）和视图缓存（`ViewCache`）来抵消这个开销。结论是，当视图天然需要文字渲染能力时，继承 TextView 比从 View 起手划算得多，这也几乎是 Android 框架自己的官方建议（`CompoundButton`、`CheckBox` 都继承自 TextView 系）。

### 1.2 数据绑定：applyFromItemInfo 家族

`BubbleTextView` 不直接持有数据，它通过一组 `applyFrom*` 方法把 `ItemInfo`（数据模型）绑定到视图上。这套方法是「数据→视图」的唯一入口，对应四种数据来源：

```java
@UiThread // 必须在主线程调用，因为涉及视图更新
public void applyFromWorkspaceItem(WorkspaceItemInfo info) { // 桌面快捷方式
    applyIconAndLabel(info);
    setItemInfo(info); // setTag(info)，把数据挂在 View 的 tag 上
    applyDotState(info, false /* animate */); // 红点状态
    setDownloadStateContentDescription(info, info.getProgressLevel()); // 下载进度无障碍文案
}

@UiThread
public void applyFromApplicationInfo(AppInfo info) { // AllApps 应用
    applyIconAndLabel(info);
    setItemInfo(info);
    verifyHighRes(); // 立即校验是不是高清图标
    applyDotState(info, false /* animate */);
    setDownloadStateContentDescription(info, info.getProgressLevel());
}

@UiThread
public void applyFromItemInfoWithIcon(ItemInfoWithIcon info) { // 通用带图标数据
    applyIconAndLabel(info);
    setItemInfo(info);
    verifyHighRes();
    setDownloadStateContentDescription(info, info.getProgressLevel());
}
```

三个方法的共同入口是 `applyIconAndLabel(ItemInfoWithIcon info)`，它负责「换图标 + 换文字 + 处理下载进度」：

```java
@UiThread
public void applyIconAndLabel(ItemInfoWithIcon info) {
    FastBitmapDrawable oldIcon = mIcon; // 记下旧图标，用于判断能否复用动画
    // 如果旧图标动画已结束，或新旧图标不是同一个信息，就重新生成图标
    if (hasPendingAnimationCompleted(mIcon) || !mIcon.isSameInfo(info.bitmap)) {
        setNonPendingIcon(info);
    }
    applyLabel(info); // 设置文字
    maybeApplyProgressLevel(info, oldIcon); // 应用下载进度条
}
```

文字绑定走 `applyLabel`：

```java
@UiThread
public void applyLabel(ItemInfo info) {
    // 第四个参数控制是否给文案加「已停用」前缀
    applyLabel(info.title, info.contentDescription, Flags.useNewIconForArchivedApps()
            && info instanceof ItemInfoWithIcon infoWithIcon
            && infoWithIcon.isInactiveArchive(), info.isDisabled());
}

private void applyLabel(@Nullable CharSequence label, @Nullable CharSequence contentDescription,
        boolean isTextWithArchivingIcon, boolean isItemDisabled) {
    if (label != null) {
        mLastOriginalText = label; // 保存原始文案，两行换行要用
        mLastModifiedText = mLastOriginalText;
        // 预先算好单词断点，onMeasure 里根据可用宽度决定在哪换行
        mBreakPointsIntArray = StringMatcherUtility.getListOfBreakpoints(label, MATCHER);
        if (isTextWithArchivingIcon) {
            setTextWithArchivingIcon(label); // 归档应用：文字前加云下载图标
        } else {
            setText(label);
        }
    }
    if (contentDescription != null) { // 无障碍文案，停用应用加「已停用」前缀
        setContentDescription(isItemDisabled
                ? getContext().getString(R.string.disabled_app_label, contentDescription)
                : contentDescription);
    }
}
```

`setItemInfo` 的实现简单却关键——把数据塞进 `getTag()`：

```java
protected void setItemInfo(ItemInfoWithIcon itemInfo) {
    setTag(itemInfo); // 后续所有逻辑通过 getTag() 反查数据
}
```

这种「数据塞进 tag」的模式贯穿整个 Launcher3。任何拿到 `BubbleTextView` 的代码都能通过 `(ItemInfo) view.getTag()` 反向取回数据，避免了到处维护「视图↔数据」映射表的麻烦。

`applyFrom*` 是一次性绑定。当图标在后台加载完成后，`IconCache` 会通过 `ItemInfoUpdateReceiver` 接口回调 `reapplyItemInfo` 来刷新视图：

```java
@Override
public void reapplyItemInfo(ItemInfoWithIcon info) {
    if (getTag() == info) { // 仅当当前视图还在显示这条数据时才刷新（防止复用错乱）
        mIconLoadRequest = null;
        mDisableRelayout = true; // 临时禁用 requestLayout，避免图标尺寸没变却触发重排
        mHighResUpdateInProgress = true;
        info.bitmap.icon.prepareToDraw(); // N 以后：预上传位图到 RenderThread，减少卡顿
        if (info instanceof AppInfo) {
            applyFromApplicationInfo((AppInfo) info);
        } else if (info instanceof WorkspaceItemInfo) {
            applyFromWorkspaceItem((WorkspaceItemInfo) info);
        } else if (info != null) {
            applyFromItemInfoWithIcon(info);
        }
        mDisableRelayout = false;
        mHighResUpdateInProgress = false;
    }
}
```

这里有两个细节值得注意。一是 `getTag() == info` 的引用相等判断，保证后台任务回来时如果视图已被复用展示别的应用，就不会被错误刷新。二是 `mDisableRelayout` 配合 `requestLayout` 的覆写，在图标尺寸不变时跳过昂贵的重排：

```java
@Override
public void requestLayout() {
    if (!mDisableRelayout) { // 仅在允许时才向上抛重排请求
        super.requestLayout();
    }
}
```

Launcher 在快速滚动 AllApps 时会有大量图标加载回调，这个优化能显著减少 measure/layout 调用次数。

### 1.3 图标渲染：IconCache + FastBitmapDrawable

`BubbleTextView` 不自己解码 PNG/Vector 图标，而是从 `IconCache` 拿到一个已经渲染好的 `FastBitmapDrawable`。整个链路是：`ItemInfoWithIcon.newIcon()` → 生成 `FastBitmapDrawable` → `setIcon` → `applyCompoundDrawables` 挂到 TextView 上。

```java
private void setNonPendingIcon(ItemInfoWithIcon info) {
    // 用数据的 bitmap 生成 drawable，flags 控制主题化、是否带 badge
    FastBitmapDrawable iconDrawable =
            info.newIcon(getContext(), getIconCreationFlagsForInfo(info));
    if (mIsShowingMinimalPopup) { // 长按弹精简菜单时关掉图标动画
        iconDrawable.setAnimationEnabled(false);
    }
    setIcon(iconDrawable);
}

protected void setIcon(FastBitmapDrawable icon) {
    if (mIsIconVisible) { // 图标可见时才挂到 TextView
        applyCompoundDrawables(icon);
    }
    mIcon = icon;
    if (mIcon != null) { // 同步可见性，让动画 drawable 在不可见时停止
        mIcon.setVisible(getWindowVisibility() == VISIBLE && isShown(), false);
        mIcon.setHoverScaleEnabledForDisplay(mDisplay != DISPLAY_TASKBAR); // Taskbar 不开悬停缩放
    }
}
```

图标生成时的 `flags` 决定了 badge（工作图标角标）和主题化行为：

```java
@DrawableCreationFlags
public int getIconCreationFlagsForInfo(ItemInfoWithIcon info) {
    int flags = shouldUseTheme() ? FLAG_THEMED : 0; // 桌面/文件夹/Taskbar 走主题化图标
    if (mHideBadge || mDisplay == DISPLAY_SEARCH_RESULT_SMALL) { // 小图标去 badge
        flags |= FLAG_NO_BADGE;
    }
    if (mSkipUserBadge) {
        flags |= FLAG_SKIP_USER_BADGE; // 跳过工作账户角标
    }
    return flags;
}

protected boolean shouldUseTheme() { // 只有这几个显示场景启用主题化图标
    return mDisplay == DISPLAY_WORKSPACE || mDisplay == DISPLAY_FOLDER
            || mDisplay == DISPLAY_TASKBAR;
}
```

`mDisplay` 是 BubbleTextView 在构造时从 XML 属性读出的「显示场景」，它决定了一切视觉参数（图标尺寸、文字大小、是否主题化）：

```java
public static final int DISPLAY_WORKSPACE = 0;       // 桌面
public static final int DISPLAY_ALL_APPS = 1;        // AllApps 列表
public static final int DISPLAY_FOLDER = 2;          // 文件夹内
public static final int DISPLAY_TASKBAR = 5;         // 任务栏
public static final int DISPLAY_SEARCH_RESULT = 6;   // 搜索结果
public static final int DISPLAY_SEARCH_RESULT_SMALL = 7; // 小尺寸搜索结果
public static final int DISPLAY_PREDICTION_ROW = 8;  // 预测行
public static final int DISPLAY_SEARCH_RESULT_APP_ROW = 9; // 搜索应用行
```

构造函数里根据 `mDisplay` 选不同的 `IconProfile` 拿尺寸：

```java
mDisplay = a.getInteger(R.styleable.BubbleTextView_iconDisplay, DISPLAY_WORKSPACE);
final int defaultIconSize;
if (mDisplay == DISPLAY_WORKSPACE) { // 桌面：用桌面图标 profile
    setTextSize(TypedValue.COMPLEX_UNIT_PX,
            mDeviceProfile.getWorkspaceIconProfile().getIconTextSizePx());
    setCompoundDrawablePadding(
            mDeviceProfile.getWorkspaceIconProfile().getIconDrawablePaddingPx());
    defaultIconSize = mDeviceProfile.getWorkspaceIconProfile().getIconSizePx();
    setCenterVertically(mDeviceProfile.getWorkspaceIconProfile().getIconCenterVertically());
} else if (mDisplay == DISPLAY_ALL_APPS || mDisplay == DISPLAY_PREDICTION_ROW
        || mDisplay == DISPLAY_SEARCH_RESULT_APP_ROW) { // AllApps：用 AllApps profile
    setTextSize(TypedValue.COMPLEX_UNIT_PX,
            mDeviceProfile.getAllAppsProfile().getIconTextSizePx());
    // ...
    defaultIconSize = mDeviceProfile.getAllAppsProfile().getIconSizePx();
} // ... 其他分支
```

这套 `DeviceProfile` + 多 `IconProfile` 的设计，让同一个视图类能适配完全不同的尺寸体系，是 Launcher 在手机/平板/折叠屏/桌面模式都能复用代码的关键。

`FastBitmapDrawable` 本身是个轻量的 Drawable 封装，除了画位图，还支持缩放动画、禁用态、hover 缩放、下载进度 delegate 等。Launcher 不直接用 `BitmapDrawable` 是因为需要这些额外能力（比如长按时的缩放反馈、拖拽时的可见性控制）。

### 1.4 红点（通知圆点）的绘制

红点（notification dot）是 BubbleTextView 自定义绘制部分的代表。它不在 XML 里画，而是在 `onDraw` 末尾通过 `DotRenderer` 手动画上去：

```java
@Override
public void onDraw(Canvas canvas) {
    super.onDraw(canvas); // 先画 TextView 本体（图标 + 文字）
    drawDotIfNecessary(canvas); // 再画红点
    drawRunningAppIndicatorIfNecessary(canvas); // 再画运行指示器（Taskbar 用）
}

protected void drawDotIfNecessary(Canvas canvas) {
    if (!mForceHideDot && (hasDot() || mDotParams.scale > 0)) { // 强制隐藏或缩放为 0 就不画
        getIconBounds(mDotParams.iconBounds); // 取图标边界
        Utilities.scaleRectAboutCenter(mDotParams.iconBounds, ICON_VISIBLE_AREA_FACTOR); // 缩放到可见区
        final int scrollX = getScrollX();
        final int scrollY = getScrollY();
        canvas.translate(scrollX, scrollY); // 补偿滚动偏移
        mDotRenderer.draw(canvas, mDotParams); // 委托给 DotRenderer 画
        canvas.translate(-scrollX, -scrollY);
    }
}
```

红点的状态由 `DotInfo` 表示，通过 `applyDotState` 绑定。当通知数量变化时，会触发一个缩放动画让红点弹出来或缩回去：

```java
public void applyDotState(ItemInfo itemInfo, boolean animate) {
    if (mIcon != null) {
        boolean wasDotted = mDotInfo != null;
        mDotInfo = mActivity.getDotInfoForItem(itemInfo); // 从 Activity 查通知状态
        boolean isDotted = mDotInfo != null;
        float newDotScale = isDotted ? 1f : 0;
        if (wasDotted || isDotted) {
            // 仅在状态切换（异或）且可见时才播动画
            if (animate && (wasDotted ^ isDotted) && isShown()) {
                animateDotScale(newDotScale);
            } else {
                cancelDotScaleAnim();
                mDotParams.scale = newDotScale; // 直接设最终值
                invalidate();
            }
        }
        // ... 更新无障碍文案（带通知数量）
    }
}
```

缩放动画用的是一个自定义 `Property`，直接驱动 `mDotParams.scale` 字段：

```java
private static final Property<BubbleTextView, Float> DOT_SCALE_PROPERTY
        = new Property<BubbleTextView, Float>(Float.TYPE, "dotScale") {
    @Override
    public Float get(BubbleTextView bubbleTextView) {
        return bubbleTextView.mDotParams.scale;
    }
    @Override
    public void set(BubbleTextView bubbleTextView, Float value) {
        bubbleTextView.mDotParams.scale = value; // 改字段
        bubbleTextView.invalidate(); // 触发重绘
    }
};

public void animateDotScale(float... dotScales) {
    cancelDotScaleAnim();
    mDotScaleAnim = ObjectAnimator.ofFloat(this, DOT_SCALE_PROPERTY, dotScales);
    mDotScaleAnim.addListener(new AnimatorListenerAdapter() {
        @Override
        public void onAnimationEnd(Animator animation) {
            mDotScaleAnim = null; // 结束后清空引用
        }
    });
    mDotScaleAnim.start();
}
```

为什么红点不做成一个独立的子 View？因为红点要精确叠加在图标的右上角，且要跟图标做联动动画（拖拽时一起隐藏）。如果做成子 View，需要额外处理布局、裁剪、动画同步，反而更复杂。直接在 `onDraw` 里画几十行代码就解决了，性能也好（少一次视图对象）。

`DotRenderer` 本身是个无状态的工具类（`DrawParams` 才是状态），桌面和 AllApps 用不同的 `DotRenderer` 实例（圆点形状可能不同）：

```java
if (mDisplay == DISPLAY_ALL_APPS) {
    mDotRenderer = mActivity.getDeviceProfile().mDotRendererAllApps;
    mDotParams.shapeInfo = IconShapeInfo.DEFAULT; // AllApps 用默认形状
} else {
    mDotRenderer = mActivity.getDeviceProfile().mDotRendererWorkSpace; // 桌面用跟随图标形状的红点
    mDotParams.shapeInfo = ThemeManager.INSTANCE.get(context)
            .getIconState().getIconShapeInfo();
}
```

拖拽时会强制隐藏红点，避免拖影里带个红点：

```java
@Override
public void setForceHideDot(boolean forceHideDot) {
    if (mForceHideDot == forceHideDot) return;
    mForceHideDot = forceHideDot;
    if (forceHideDot) {
        invalidate(); // 隐藏：直接重绘
    } else if (hasDot()) {
        animateDotScale(0, 1); // 恢复：从 0 弹到 1
    }
}
```

### 1.5 长按反馈与拖拽准备

`BubbleTextView` 的长按交互是 Launcher 最有标志性的体验之一。长按一个图标，图标会缩放、弹出快捷方式菜单，拖拽时图标保持按下高亮。这套反馈分散在几个机制里。

长按检测交给 `CheckLongPressHelper`：

```java
@Override
public boolean onTouchEvent(MotionEvent event) {
    if (event.getAction() == MotionEvent.ACTION_DOWN
            && shouldIgnoreTouchDown(event.getX(), event.getY())) {
        return false; // 落在 padding 区域的按下直接忽略
    }
    if (isLongClickable()) {
        super.onTouchEvent(event);
        mLongPressHelper.onTouchEvent(event); // 长按检测交由 helper
        return true; // 持续接收后续事件
    } else {
        return super.onTouchEvent(event);
    }
}
```

`shouldIgnoreTouchDown` 屏蔽了 padding 区域的触摸，避免点图标边缘空白处也触发：

```java
protected boolean shouldIgnoreTouchDown(float x, float y) {
    if (mDisplay == DISPLAY_TASKBAR) {
        return false; // Taskbar 图标小，允许 padding 内触摸
    }
    return y < getPaddingTop()
            || x < getPaddingLeft()
            || y > getHeight() - getPaddingBottom()
            || x > getWidth() - getPaddingRight();
}
```

长按真正触发后，`startLongPressAction` 会弹出快捷方式菜单，并返回一个 `PreDragCondition` 控制拖拽前行为：

```java
public PreDragCondition startLongPressAction(PopupController<?> popupController) {
    Popup popup = popupController.show(this); // 弹出菜单
    return popup != null ? popup.createPreDragCondition() : null; // 返回预拖拽条件
}

public boolean canShowLongPressPopup() { // 是否支持快捷方式（看有没有 shortcuts）
    return getTag() instanceof ItemInfo && ShortcutUtil.supportsShortcuts((ItemInfo) getTag());
}
```

拖拽过程中，图标要保持按下高亮，这是通过自定义 drawable 状态实现的。`onCreateDrawableState` 在父类状态基础上额外叠加 `STATE_PRESSED`：

```java
private static final int[] STATE_PRESSED = new int[]{android.R.attr.state_pressed};

@Override
protected int[] onCreateDrawableState(int extraSpace) {
    final int[] drawableState = super.onCreateDrawableState(extraSpace + 1); // 多留一个状态位
    if (mStayPressed) { // 拖拽时强制保持按下
        mergeDrawableStates(drawableState, STATE_PRESSED); // 合并 pressed 状态
    }
    return drawableState;
}

void setStayPressed(boolean stayPressed) {
    mStayPressed = stayPressed;
    refreshDrawableState(); // 触发状态刷新
}
```

还有个细节：键盘释放按键时，按下状态会立刻消失造成闪烁，所以 `onKeyUp` 临时关闭状态刷新：

```java
@Override
public boolean onKeyUp(int keyCode, KeyEvent event) {
    // 键盘事件会立刻传播 pressed 状态变化，不像触摸要等 onClickHandler，会闪
    mIgnorePressedStateChange = true; // 临时忽略
    boolean result = super.onKeyUp(keyCode, event);
    mIgnorePressedStateChange = false;
    refreshDrawableState(); // 恢复后统一刷新
    return result;
}

@Override
public void refreshDrawableState() {
    if (!mIgnorePressedStateChange) { // 配合上面的忽略逻辑
        super.refreshDrawableState();
    }
}
```

重排时的弹性缩放（拖动其他图标时被挤的图标会弹一下）由 `Reorderable` 接口提供：

```java
@Override
public void setReorderBounceScale(float scale) {
    mScaleForReorderBounce = scale; // 记下当前缩放值
    super.setScaleX(scale); // 用 super 避免 MultiTranslateDelegate 干扰
    super.setScaleY(scale);
}

@Override
public float getReorderBounceScale() {
    return mScaleForReorderBounce;
}
```

拖拽起始时，`prepareDrawDragView` 准备拖拽视图的绘制（重置图标缩放、隐藏红点）：

```java
@Override
public SafeCloseable prepareDrawDragView() {
    resetIconScale(); // 重置图标缩放
    setForceHideDot(true); // 隐藏红点
    return () -> {
    };
}
```

### 1.6 pressed / focused 状态与文字压缩

图标文字经常比格子宽（应用名很长），需要省略号或字间距压缩。`checkForEllipsis` 用二分查找找最合适的字间距：

```java
private void checkForEllipsis() {
    float width = getWidth() - getCompoundPaddingLeft() - getCompoundPaddingRight();
    if (width <= 0) return;
    setLetterSpacing(0);
    String text = getText().toString();
    TextPaint paint = getPaint();
    if (paint.measureText(text) < width) return; // 文字本就放得下，不用压

    float spacing = findBestSpacingValue(paint, text, width, MIN_LETTER_SPACING);
    paint.setLetterSpacing(0); // 重置以便 TextView 做差异判断
    setLetterSpacing(spacing); // 应用压缩后的字间距
}

// 二分查找：在 [0, minSpacingEm] 之间找让文字刚好放下的最大字间距
private float findBestSpacingValue(TextPaint paint, String text, float allowedWidthPx,
        float minSpacingEm) {
    paint.setLetterSpacing(minSpacingEm);
    if (paint.measureText(text) > allowedWidthPx) {
        return minSpacingEm; // 即使最大压缩还放不下，只能返回最小间距
    }
    float lowLimit = 0;
    float highLimit = minSpacingEm;
    for (int i = 0; i < MAX_SEARCH_LOOP_COUNT; i++) { // 最多迭代 20 次
        float value = (lowLimit + highLimit) / 2;
        paint.setLetterSpacing(value);
        if (paint.measureText(text) < allowedWidthPx) {
            highLimit = value;
        } else {
            lowLimit = value;
        }
    }
    return highLimit;
}
```

这是个典型的「用渲染精度换视觉」的技巧：宁可压缩字间距也不显示省略号，因为完整的应用名比 `Chrome...` 这种可读性强得多。

`reset()` 方法用于视图回收复用前的清理，把所有可能残留的状态归零：

```java
public void reset() {
    mDotInfo = null;
    cancelDotScaleAnim();
    mDotParams.scale = 0f;
    mForceHideDot = false;
    setBackground(null);
    configureMinimalPopup(false);
    mLineIndicatorColor = Color.TRANSPARENT;
    mLineIndicatorWidth = 0;
    setTag(null); // 清掉数据引用，防止内存泄漏
    if (mIconLoadRequest != null) {
        mIconLoadRequest.cancel(); // 取消挂起的后台图标加载
        mIconLoadRequest = null;
    }
    setPivotY(0);
    setAlpha(1);
    setScaleY(1);
    setTranslationY(0);
    setMaxLines(1);
    setVisibility(VISIBLE);
}
```

最后看下文字透明度控制。桌面在切换状态（如进入 AllApps）时会让图标文字淡出，通过 `TEXT_ALPHA_PROPERTY` 实现：

```java
public static final Property<BubbleTextView, Float> TEXT_ALPHA_PROPERTY
        = new Property<BubbleTextView, Float>(Float.class, "textAlpha") {
    @Override
    public Float get(BubbleTextView bubbleTextView) {
        return bubbleTextView.mTextAlpha;
    }
    @Override
    public void set(BubbleTextView bubbleTextView, Float alpha) {
        bubbleTextView.setTextAlpha(alpha);
    }
};

private int getModifiedColor() {
    if (mTextAlpha == 0) {
        return Color.TRANSPARENT; // alpha 为 0 时特殊处理，避免高对比模式残留文字阴影
    }
    return setColorAlphaBound(mTextColor, Math.round(Color.alpha(mTextColor) * mTextAlpha));
}
```

### 面试深问

**问 1：BubbleTextView 既继承 TextView 又自己画红点，为什么不直接全部自定义绘制（图标 + 文字 + 红点）？**

答：自己画文字要重新实现 `StaticLayout`、省略号、跑马灯、RTL、字间距、多行、无障碍焦点，工作量巨大且容易出 bug。TextView 的核心价值就是这一套文字能力，复用它只需在 `onDraw` 末尾补几行画红点的代码，性价比远高于全自定义。Android 框架自身的 `Button`、`CheckBox` 都继承自 TextView 系，遵循同一思路。

**问 2：`reapplyItemInfo` 里 `getTag() == info` 的引用相等判断为什么用 `==` 而非 `equals`？**

答：RecyclerView 会复用视图。后台图标加载任务回来时，视图可能已经滚走、被复用展示别的应用。这时 `getTag()` 指向的是新应用的数据对象，与异步任务持有的 `info` 不是同一个实例，`==` 返回 false 就跳过刷新，避免把上一个应用的图标画到当前应用上。用 `equals` 反而可能因为「两个 AppInfo 业务相等」而误判，引用相等才是「这条数据还在这条视图上」的精确语义。

**问 3：`mDisableRelayout` 在图标刷新时临时禁用 requestLayout，会不会导致布局不更新？**

答：不会。这个标志只在「图标尺寸不变、只换内容」的场景下短时间开启——构造函数已知新图标和旧图标尺寸都是 `mIconSize`，layout 不会变，所以跳过 requestLayout 是安全的优化。真正需要重排的场景（如 `onMeasure`、文字变化）发生时该标志已复位为 false。这种「上下文敏感的 requestLayout 屏蔽」是 ListView/RecyclerView 性能优化的常见手法。

---

## 二、AbstractFloatingView：浮层基类

### 2.1 统一抽象的设计意图

Launcher3 里有大量「会弹出、会关闭、悬浮在主界面之上」的界面：文件夹打开后的图标网格、长按图标弹出的快捷方式菜单、AllApps 的教育性弹跳、Widget 选择器、Snackbar 提示、Taskbar 教程、拖拽时的弹出菜单、添加到桌面的确认框等。如果每个都自己实现「怎么显示、怎么关闭、怎么响应返回键、怎么跟 DragLayer 交互、怎么发无障碍事件」，代码会爆炸重复。

`AbstractFloatingView` 就是把这堆共同行为抽到一个抽象基类里。它本身继承 `LinearLayout`，同时实现 `TouchController`（参与触摸分发）和 `OnBackAnimationCallback`（响应预测式返回手势）：

```java
@TargetApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
public abstract class AbstractFloatingView extends LinearLayout implements TouchController,
        OnBackAnimationCallback {
```

核心状态只有一个布尔位 `mIsOpen`，表示这个浮层当前是否处于打开状态：

```java
protected boolean mIsOpen;
```

关闭是模板方法模式：`close` 是 final 的（固定流程），`handleClose` 由子类实现具体动画：

```java
public final void close(boolean animate) {
    animate &= areAnimatorsEnabled(); // 动画被系统禁用（如省电模式）时强制跳过
    if (mIsOpen) {
        // Add to WW logging
    }
    handleClose(animate); // 子类实现具体关闭逻辑
    mIsOpen = false; // 关闭后置为 false
}

protected abstract void handleClose(boolean animate);
```

`isOpen()` 是状态查询的唯一入口：

```java
public final boolean isOpen() {
    return mIsOpen;
}
```

`isOfType` 是另一个抽象方法，子类用位运算声明自己属于哪一类浮层：

```java
protected abstract boolean isOfType(@FloatingViewType int type);
```

### 2.2 类型系统：位运算分类所有浮层

Launcher 用一个 `@IntDef(flag = true)` 把所有浮层类型定义为位标志，方便用「按位与」快速判断「这个浮层是不是属于某一组」：

```java
@IntDef(flag = true, value = {
        TYPE_FOLDER, TYPE_ACTION_POPUP, TYPE_WIDGETS_BOTTOM_SHEET,
        TYPE_WIDGET_RESIZE_FRAME, TYPE_WIDGETS_FULL_SHEET, TYPE_ON_BOARD_POPUP,
        TYPE_DISCOVERY_BOUNCE, TYPE_SNACKBAR, TYPE_LISTENER, TYPE_ALL_APPS_EDU,
        TYPE_DRAG_DROP_POPUP, TYPE_TASK_MENU, TYPE_OPTIONS_POPUP, TYPE_ICON_SURFACE,
        // ... 共 25 种
})
public @interface FloatingViewType {}
public static final int TYPE_FOLDER = 1 << 0;          // 文件夹
public static final int TYPE_ACTION_POPUP = 1 << 1;    // 长按弹出的快捷菜单
public static final int TYPE_WIDGETS_BOTTOM_SHEET = 1 << 2; // Widget 底部抽屉
public static final int TYPE_SNACKBAR = 1 << 7;        // Snackbar
// ...
```

位标志的威力在于可以「组合」出多种语义不同的「类型集合」：

```java
// 所有浮层的全集
public static final int TYPE_ALL = TYPE_FOLDER | TYPE_ACTION_POPUP
        | TYPE_WIDGETS_BOTTOM_SHEET | /* ... */ | TYPE_TASKBAR_OVERFLOW;

// launcher rebind（数据重载）时应该保持打开的类型
public static final int TYPE_REBIND_SAFE = TYPE_WIDGETS_FULL_SHEET
        | TYPE_WIDGETS_BOTTOM_SHEET | TYPE_ON_BOARD_POPUP | TYPE_DISCOVERY_BOUNCE
        | /* ... */ | TYPE_NUDGE;

// 需要独占无障碍焦点的类型
public static final int TYPE_ACCESSIBLE = TYPE_ALL & ~TYPE_DISCOVERY_BOUNCE & ~TYPE_LISTENER
        & ~TYPE_ALL_APPS_EDU & /* ... */;

// 滑动状态栏手势在这些浮层打开时应该被禁止
public static final int TYPE_STATUS_BAR_SWIPE_DOWN_DISALLOW = TYPE_WIDGETS_BOTTOM_SHEET |
        TYPE_WIDGETS_FULL_SHEET | TYPE_WIDGET_RESIZE_FRAME | TYPE_ON_BOARD_POPUP |
        TYPE_DISCOVERY_BOUNCE | TYPE_TASK_MENU | TYPE_DRAG_DROP_POPUP;

// Taskbar overlay 窗口独占的浮层
public static final int TYPE_TASKBAR_OVERLAYS =
        TYPE_TASKBAR_ALL_APPS | TYPE_TASKBAR_EDUCATION_DIALOG | TYPE_NUDGE;

// TouchController 不应该尝试拦截触摸的浮层
public static final int TYPE_TOUCH_CONTROLLER_NO_INTERCEPT = TYPE_ALL & ~TYPE_DISCOVERY_BOUNCE
        & ~TYPE_LISTENER & ~TYPE_TASKBAR_OVERLAYS;
```

这套位运算让「按组操作浮层」变得极简洁。比如「关闭除某个浮层外的所有浮层」：

```java
public static void closeAllOpenViewsExcept(ActivityContext activity, boolean animate,
                                           @FloatingViewType int type) {
    closeOpenViews(activity, animate, TYPE_ALL & ~type); // 用按位取反排除
    activity.finishAutoCancelActionMode();
}
```

「关闭所有浮层」就是 `TYPE_ALL`：

```java
public static void closeAllOpenViews(ActivityContext activity, boolean animate) {
    closeOpenViews(activity, animate, TYPE_ALL);
    activity.finishAutoCancelActionMode(); // 顺便取消自动取消的 ActionMode
}
```

### 2.3 浮层管理：DragLayer + 静态查询方法

所有浮层都被添加到 `DragLayer`（Launcher 的拖拽层，也是浮层容器）作为子 View。`AbstractFloatingView` 提供了一组静态方法，通过遍历 DragLayer 的子 View 来查询/关闭浮层：

```java
public static <T extends AbstractFloatingView> T getOpenView(
        ActivityContext activity, @FloatingViewType int type) {
    return getView(activity, type, true /* mustBeOpen */);
}

public static boolean hasOpenView(ActivityContext activity, @FloatingViewType int type) {
    return getOpenView(activity, type) != null;
}

private static <T extends AbstractFloatingView> T getView(
        ActivityContext activity, @FloatingViewType int type, boolean mustBeOpen) {
    BaseDragLayer dragLayer = activity.getDragLayer();
    if (dragLayer == null) return null;
    // 逆序遍历：后添加的浮层在 DragLayer 末尾，越靠后优先级越高
    for (int i = dragLayer.getChildCount() - 1; i >= 0; i--) {
        View child = dragLayer.getChildAt(i);
        if (child instanceof AbstractFloatingView) {
            AbstractFloatingView view = (AbstractFloatingView) child;
            if (view.isOfType(type) && (!mustBeOpen || view.isOpen())) {
                return (T) view;
            }
        }
    }
    return null;
}
```

逆序遍历是有讲究的：浮层按添加顺序叠在 DragLayer 上，后添加的盖在上面，所以查找「最顶层打开的浮层」要从后往前找。

`closeOpenViews` 委托给 `AbstractFloatingViewHelper`（一个无状态的 Kotlin 帮助类），逻辑和 `getView` 类似：

```java
public static void closeOpenViews(ActivityContext activity, boolean animate,
        @FloatingViewType int type) {
    new AbstractFloatingViewHelper().closeOpenViews(activity, animate, type);
}
```

`AbstractFloatingViewHelper.kt` 的实现：

```kotlin
class AbstractFloatingViewHelper {
    fun closeOpenViews(activity: ActivityContext, animate: Boolean, @FloatingViewType type: Int) {
        val dragLayer = activity.getDragLayer()
        // 逆序遍历，逐个匹配类型并关闭
        for (i in dragLayer.getChildCount() - 1 downTo 0) {
            val child = dragLayer.getChildAt(i)
            if (child is AbstractFloatingView && child.isOfType(type)) {
                child.close(animate)
            }
        }
    }
}
```

之所以单独抽出一个 helper 而不是直接用静态方法，是因为它要被 Kotlin 代码（如 `PopupDataSource.kt`、`SystemShortcut.java`）调用，单独的类更便于注入和测试。

### 2.4 触摸拦截与返回键

浮层要拦截所有落在自己身上的触摸事件，防止事件穿透到下面的 Workspace。`onTouchEvent` 直接返回 true 吃掉所有事件：

```java
@SuppressLint("ClickableViewAccessibility")
@Override
public boolean onTouchEvent(MotionEvent ev) {
    return true; // 吃掉所有触摸事件，不穿透到 Workspace
}
```

返回手势通过 `OnBackAnimationCallback` 接管。`onBackInvoked` 默认行为就是关闭浮层：

```java
@Override
public void onBackInvoked() {
    close(true); // 用户按返回键时关闭（带动画）
}

public boolean canHandleBack() {
    return true; // 默认能处理返回，子类可覆盖
}
```

### 2.5 无障碍广播

浮层打开/关闭时需要通知无障碍服务焦点变化。`announceAccessibilityChanges` 是统一的广播入口：

```java
protected void announceAccessibilityChanges() {
    Pair<View, String> targetInfo = getAccessibilityTarget(); // 子类提供目标 view 和文案
    if (targetInfo == null || !isAccessibilityEnabled(getContext())) {
        return;
    }
    sendCustomAccessibilityEvent(
            targetInfo.first, TYPE_WINDOW_STATE_CHANGED, targetInfo.second); // 发 WINDOW_STATE_CHANGED

    if (mIsOpen) { // 打开时请求无障碍焦点
        getAccessibilityInitialFocusView().performAccessibilityAction(
                AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS, null);
    }
    ActivityContext.lookupContext(getContext()).getDragLayer()
            .sendAccessibilityEvent(TYPE_WINDOW_CONTENT_CHANGED); // 通知 DragLayer 内容变化
}

protected Pair<View, String> getAccessibilityTarget() {
    return null; // 子类覆盖，返回 (目标 view, 描述文案)
}

protected View getAccessibilityInitialFocusView() {
    return this; // 默认焦点是自己
}
```

这种「子类提供数据 + 基类统一广播」的模板，保证所有浮层无障碍行为一致。

### 面试深问

**问 1：为什么浮层都挂在 DragLayer 而不是直接挂到 Window（用 WindowManager.addView）？**

答：挂到 DragLayer 内有三个好处：一是和主界面共享同一个坐标系，浮层动画可以无缝引用 Workspace 的坐标（如弹出菜单要精确对齐到图标位置）；二是触摸分发统一走 DragLayer 的 TouchController 链，避免跨 window 的事件协调复杂度；三是生命周期和 Activity 绑定，Activity 销毁时浮层自动清理。跨 window 的 WindowManager 浮层虽然能盖过其他应用，但需要单独管理 token、权限、生命周期，成本高，Launcher 内部浮层不需要。

**问 2：`TYPE_ALL & ~TYPE_DISCOVERY_BOUNCE` 这种按位取反操作，如果 `type` 是多个标志的组合，结果是什么语义？**

答：这是「从全集里排除某些类型」的集合运算。`TYPE_ALL` 是所有浮层的并集，`~TYPE_DISCOVERY_BOUNCE` 在 `flag=true` 的 IntDef 语义下表示「除了 DISCOVERY_BOUNCE 之外的所有位」。两者按位与，结果就是「除 DISCOVERY_BOUNCE 外的所有浮层」。这种集合代数在「关闭除某类外所有浮层」「某类浮层不需要无障碍焦点」等场景下非常顺手，是位标志相对于枚举+集合的天然优势。

**问 3：`close(boolean)` 为什么要做成 final 而 `handleClose` 是 abstract？**

答：这是模板方法模式的典型应用。`close` 封装了「记录日志 + 调用子类关闭 + 重置 mIsOpen」这套固定流程，做成 final 防止子类跳过 `mIsOpen = false` 这种关键收尾。`handleClose` 留给子类实现各自的关闭动画（Snackbar 淡出、底部抽屉上滑、文件夹缩回），保留扩展性。把变与不变分离，是基类设计的核心原则。

---

## 三、DropTargetBar：拖拽时的操作栏

### 3.1 为什么用浮层式布局

`DropTargetBar` 是用户长按拖动图标时，屏幕顶部出现的「删除 / 卸载 / 应用信息」按钮栏。它的声明很特别——继承 `FrameLayout` 并实现 `Insettable`：

```java
public class DropTargetBar extends FrameLayout
        implements DragListener, Insettable {
```

它不是一个 `AbstractFloatingView`，但它「跟着拖拽手势出现/消失」的特性让它在视觉上类似浮层。它和 DragLayer 的关系是：DropTargetBar 是 DragLayer 的一个固定子 View（不是动态 add/remove），通过 alpha 动画控制显隐，而不是像 Snackbar 那样用完即删。

这种「常驻视图 + alpha 显隐」的设计，相比「动态添加浮层」，省去了反复 inflate/addView/removeView 的开销。DropTargetBar 在 Launcher 整个生命周期里只创建一次，每次拖拽只是淡入淡出：

```java
public DropTargetBar(Context context, AttributeSet attrs) {
    super(context, attrs);
    mLauncher = Launcher.getLauncher(context); // 持有 Launcher 引用，用于拿 DeviceProfile
}
```

`onFinishInflate` 把所有子 View（即各个 ButtonDropTarget）收集到数组里：

```java
@Override
protected void onFinishInflate() {
    super.onFinishInflate();
    mDropTargets = new ButtonDropTarget[getChildCount()]; // 子 View 即各操作按钮
    for (int i = 0; i < mDropTargets.length; i++) {
        mDropTargets[i] = (ButtonDropTarget) getChildAt(i);
        mDropTargets[i].setDropTargetBar(this); // 让按钮反向持有 bar，方便联动
    }
    mTempTargets = new ButtonDropTarget[getChildCount()]; // 测量时的临时数组
}
```

### 3.2 显示/隐藏动画

显隐的核心是 `animateToVisibility`，用 `ViewPropertyAnimator` 做 alpha 淡入淡出：

```java
protected static final int DEFAULT_DRAG_FADE_DURATION = 175; // 淡入淡出 175ms
protected static final TimeInterpolator DEFAULT_INTERPOLATOR = Interpolators.ACCELERATE; // 加速曲线

public void animateToVisibility(boolean isVisible) {
    if (mVisible != isVisible) { // 状态没变就不动
        mVisible = isVisible;
        if (mCurrentAnimation != null) { // 取消进行中的动画
            mCurrentAnimation.cancel();
            mCurrentAnimation = null;
        }
        float finalAlpha = mVisible ? 1 : 0;
        if (Float.compare(getAlpha(), finalAlpha) != 0) { // 当前 alpha 已是目标值就不用动
            setVisibility(View.VISIBLE); // 动画期间保持 VISIBLE，结束后再判断是否 INVISIBLE
            mCurrentAnimation = animate().alpha(finalAlpha)
                    .setInterpolator(DEFAULT_INTERPOLATOR)
                    .setDuration(DEFAULT_DRAG_FADE_DURATION)
                    .withEndAction(mFadeAnimationEndRunnable); // 动画结束回调
        }
    }
}

// 结束回调：alpha 为 0 时切到 INVISIBLE，避免继续响应触摸
private final Runnable mFadeAnimationEndRunnable =
        () -> updateVisibility(DropTargetBar.this);
```

`updateVisibility` 来自 `AlphaUpdateListener`，它的逻辑是：alpha 为 0 时设 INVISIBLE/GONE，否则设 VISIBLE。这是 Launcher 处理「半透明视图」的标准做法——不显式设 INVISIBLE 的话，alpha 为 0 的视图仍会接收触摸。

### 3.3 与 DragController 的联动

DropTargetBar 通过实现 `DragListener` 接口响应拖拽的开始/结束：

```java
@Override
public void onDragStart(DropTarget.DragObject dragObject, DragOptions options) {
    animateToVisibility(true); // 拖拽开始：淡入显示
}

@Override
public void onDragEnd() {
    if (!mDeferOnDragEnd) {
        animateToVisibility(false); // 拖拽结束：淡出隐藏
    } else {
        mDeferOnDragEnd = false; // 标记过的，等真正放下后再隐藏
    }
}

protected void deferOnDragEnd() {
    mDeferOnDragEnd = true; // 标记「拖拽结束时不立刻隐藏，等放下动画完成」
}
```

`deferOnDragEnd` 是个细节：当用户把图标拖到「卸载」按钮上时，松手后会先播放图标的消失动画，此时 DropTargetBar 应该保持可见，等动画结束再淡出。这个标记位让 `onDragEnd` 推迟隐藏。

`setup` 方法把 DropTargetBar 和它的所有按钮都注册为 DragController 的监听器/放置目标：

```java
public void setup(DragController dragController) {
    dragController.addDragListener(this); // 自己监听拖拽起止
    for (int i = 0; i < mDropTargets.length; i++) {
        dragController.addDragListener(mDropTargets[i]); // 每个按钮也监听拖拽（用于 hover 高亮）
        dragController.addDropTarget(mDropTargets[i]); // 每个按钮都是放置目标
    }
}
```

### 3.4 动态测量与布局

DropTargetBar 的特殊之处是按钮数量和可见性是动态的（不同应用支持的拖拽操作不同：桌面图标只有「删除」，已安装应用有「卸载」+「应用信息」）。`onMeasure` 根据 `getVisibleButtons` 返回的可见按钮数走不同分支：

```java
@Override
protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
    int width = MeasureSpec.getSize(widthMeasureSpec);
    int height = MeasureSpec.getSize(heightMeasureSpec);
    int heightSpec = MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY); // 高度固定

    int visibleCount = getVisibleButtons(mTempTargets);
    if (visibleCount == 1) { // 只有一个按钮：宽度自适应
        int widthSpec = MeasureSpec.makeMeasureSpec(width, MeasureSpec.AT_MOST);
        ButtonDropTarget firstButton = mTempTargets[0];
        firstButton.setTextSize(TypedValue.COMPLEX_UNIT_PX,
                mLauncher.getDeviceProfile().getDropTargetProfile().getTextSizePx());
        firstButton.setTextVisible(true);
        firstButton.setIconVisible(true);
        firstButton.measure(widthSpec, heightSpec);
        firstButton.resizeTextToFit(); // 文字太长时缩字号
    } else if (visibleCount == 2) { // 两个按钮：平分可用宽度
        // ... 复杂的两按钮测量逻辑，处理截断、换行、缩字号
    }
    setMeasuredDimension(width, height);
}
```

`onLayout` 把按钮居中布置，还要考虑 Workspace 缩放（拖拽时桌面会缩小腾出空间）：

```java
@Override
protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
    int visibleCount = getVisibleButtons(mTempTargets);
    if (visibleCount == 0) return;
    DeviceProfile dp = mLauncher.getDeviceProfile();
    float scale = dp.getWorkspaceSpringLoadScale(mLauncher); // 拖拽时桌面的缩放比例
    Workspace<?> ws = mLauncher.getWorkspace();
    int barCenter;
    // 计算按钮栏中心要对齐的桌面中心，考虑缩放偏移
    int workspaceCenter = (ws.getLeft() + ws.getRight()) / 2;
    // ...
    if (visibleCount == 1) { // 单按钮居中
        ButtonDropTarget button = mTempTargets[0];
        button.layout(barCenter - (button.getMeasuredWidth() / 2), 0,
                barCenter + (button.getMeasuredWidth() / 2), button.getMeasuredHeight());
    } else if (visibleCount == 2) { // 双按钮按 gap 分布
        // ...
    }
}
```

### 3.5 Insettable 与适配

`Insettable` 接口让 DropTargetBar 响应系统窗口 insets（状态栏、导航栏、刘海）。`setInsets` 是适配的核心：

```java
@Override
public void setInsets(Rect insets) {
    FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) getLayoutParams();
    DeviceProfile deviceProfile = mLauncher.getDeviceProfile();
    mIsVertical = deviceProfile.isVerticalBarLayout(); // 是否竖屏布局（横屏手机/平板）
    int widthPx = deviceProfile.getDeviceProperties().getWidthPx();

    lp.leftMargin = insets.left; // 左边距 = 左侧系统 inset
    lp.topMargin = insets.top;
    lp.bottomMargin = insets.bottom;
    lp.rightMargin = insets.right;
    // ...计算水平边距，平板按列数算，手机用 dimen
    lp.topMargin += deviceProfile.getDropTargetProfile().getBarTopMarginPx(); // 额外加顶部边距
    lp.width = deviceProfile.getDeviceProperties().getAvailableWidthPx() - 2 * horizontalMargin;
    if (mIsVertical) { // 竖屏布局时左右居中
        lp.leftMargin = (widthPx - lp.width) / 2;
        lp.rightMargin = (widthPx - lp.width) / 2;
    }
    lp.height = deviceProfile.getDropTargetProfile().getBarSizePx(); // 高度取自 profile
    lp.gravity = Gravity.CENTER_HORIZONTAL | Gravity.TOP; // 水平居中、顶部对齐
    setLayoutParams(lp);
    for (ButtonDropTarget button : mDropTargets) { // 按钮的文字大小、padding 也按 profile 设
        button.setTextSize(TypedValue.COMPLEX_UNIT_PX,
                deviceProfile.getDropTargetProfile().getTextSizePx());
        button.setToolTipLocation(tooltipLocation);
        button.setPadding(horizontalPadding, verticalPadding, horizontalPadding, verticalPadding);
    }
}
```

`ButtonDropTarget` 本身继承自 TextView，每个具体按钮（`DeleteDropTarget`、`UninstallDropTarget`、`AppInfoDropTarget`）实现 `onDrop` 处理实际的删除/卸载/打开信息操作。

### 面试深问

**问 1：DropTargetBar 为什么继承 FrameLayout 而不是 LinearLayout？两个按钮用 LinearLayout 平分不更方便？**

答：FrameLayout 给了 DropTargetBar 完全自定义的测量和布局控制权。两个按钮不是简单平分，而是要根据 Workspace 缩放后的实际可用宽度、按钮 gap、文字是否截断等动态调整——LinearLayout 的 `layout_weight` 无法表达「文字截断时去掉图标换两行」这种逻辑。FrameLayout 把所有测量/布局都交给开发者，灵活性最高，代价是要自己写 `onMeasure`/`onLayout`。

**问 2：`deferOnDragEnd` 这个标志位解决什么问题？如果不加会怎样？**

答：解决「拖拽放手后到图标消失动画结束」这段时间的视觉一致性。用户拖图标到「卸载」上松手，会先播一个图标飞向卸载按钮的动画，期间 DropTargetBar 应该保持可见让用户看清楚反馈。如果 `onDragEnd` 立刻淡出 bar，图标还在飞但操作栏已经没了，体验割裂。`deferOnDragEnd` 让 bar 推迟到真正的放下流程完成后再隐藏。

**问 3：`updateVisibility` 在 alpha 动画结束时调用，为什么不直接在 `animateToVisibility` 里设 INVISIBLE？**

答：因为动画期间视图必须保持 VISIBLE 才能看到淡入淡出的过程。如果在 `animateToVisibility` 立刻设 INVISIBLE，View 会瞬间消失看不到动画；如果在动画开始前设 INVISIBLE，alpha 动画根本不会渲染。正确做法是动画期间保持 VISIBLE，在 `withEndAction` 回调里（动画结束、最终 alpha 已确定）再判断是否切到 INVISIBLE。`AlphaUpdateListener.updateVisibility` 封装的就是这套「根据 alpha 决定 visibility」的逻辑。

---

## 四、LauncherRootView 与 BaseActivity

### 4.1 视图层级根节点

`LauncherRootView` 是 Launcher 整棵视图树的根。它继承 `InsettableFrameLayout`，负责承载整个桌面 UI、处理系统窗口 insets、绘制系统 UI 遮罩（ scrim）、管理手势排除区：

```java
public class LauncherRootView extends InsettableFrameLayout {
    private final Rect mTempRect = new Rect();
    private final StatefulContainer mStatefulContainer; // 状态管理容器引用
    // 整个 view 的边界作为系统手势排除区，用于禁止边缘返回手势
    private static final List<Rect> SYSTEM_GESTURE_EXCLUSION_RECT =
            Collections.singletonList(new Rect());
    private WindowStateListener mWindowStateListener;
    private boolean mDisallowBackGesture; // 是否禁止返回手势
    private boolean mForceHideBackArrow; // 是否强制隐藏返回箭头
    private final SysUiScrim mSysUiScrim; // 系统 UI 遮罩（状态栏渐变等）
```

构造函数里把 `SysUiScrim` 挂上，它是负责画「壁纸在状态栏区域的渐变遮罩」的：

```java
public LauncherRootView(Context context, AttributeSet attrs) {
    super(context, attrs);
    mStatefulContainer = ActivityContext.lookupContext(context); // 通过 ActivityContext 查到状态管理器
    mSysUiScrim = new SysUiScrim(this);
}
```

### 4.2 Insets 处理与状态重应用

`LauncherRootView` 的核心职责之一是处理系统窗口 insets（状态栏高度、导航栏高度、刘海）。Insets 变化时要做两件事：更新 DeviceProfile、必要时重应用当前状态（因为布局变了）：

```java
private void handleSystemWindowInsets(Rect insets) {
    mStatefulContainer.getDeviceProfile().updateInsets(insets); // 更新 DeviceProfile 的 inset 记录
    boolean resetState = !insets.equals(mInsets); // inset 变了就要重排
    setInsets(insets);
    if (resetState) {
        mStatefulContainer.getStateManager().reapplyState(true /* cancelCurrentAnimation */); // 重新应用状态
    }
}

@Override
public WindowInsets onApplyWindowInsets(WindowInsets insets) {
    mStatefulContainer.handleConfigurationChanged(
            mStatefulContainer.asContext().getResources().getConfiguration()); // 配置变化先处理
    return updateInsets(insets);
}

@Override
public void setInsets(Rect insets) {
    // inset 没变就是 no-op，避免无谓的子 view 重排
    if (!insets.equals(mInsets)) {
        super.setInsets(insets);
        mSysUiScrim.onInsetsChanged(insets);
    }
}
```

`setInsets` 里的「inset 相等就跳过」是性能优化：旋转屏幕、弹出键盘等会频繁触发 insets 回调，但很多时候值没变，跳过 `super.setInsets` 能避免整棵视图树重排。

### 4.3 系统手势排除与绘制

`setDisallowBackGesture` 控制 Android 10+ 的边缘返回手势是否生效。比如全屏 Widget 选择时需要禁止边缘返回干扰，就设置排除区：

```java
public void setDisallowBackGesture(boolean disallowBackGesture) {
    if (SEPARATE_RECENTS_ACTIVITY.get()) return; // 独立 Recents Activity 时不管
    mDisallowBackGesture = disallowBackGesture;
    // 强制隐藏返回箭头或禁止手势时，把整个 view 设为手势排除区
    setSystemGestureExclusionRects((mForceHideBackArrow || mDisallowBackGesture)
            ? SYSTEM_GESTURE_EXCLUSION_RECT
            : Collections.emptyList());
}
```

绘制方面，`dispatchDraw` 在画子 view 之前先画 `SysUiScrim`（保证遮罩在内容之下）：

```java
@Override
protected void dispatchDraw(Canvas canvas) {
    mSysUiScrim.draw(canvas); // 先画遮罩
    super.dispatchDraw(canvas); // 再画子 view
}

@Override
protected void onLayout(boolean changed, int l, int t, int r, int b) {
    super.onLayout(changed, l, t, r, b);
    SYSTEM_GESTURE_EXCLUSION_RECT.get(0).set(l, t, r, b); // 排除区跟随布局更新
    setDisallowBackGesture(mDisallowBackGesture);
    mSysUiScrim.setSize(r - l, b - t); // 遮罩尺寸跟随
}
```

`WindowStateListener` 把窗口焦点/可见性变化转发出去，让 Launcher 响应：

```java
public interface WindowStateListener {
    void onWindowFocusChanged(boolean hasFocus);
    void onWindowVisibilityChanged(int visibility);
}
```

### 4.4 BaseActivity：Activity 层的通用能力

`BaseActivity` 是所有 Launcher Activity（`Launcher`、`WidgetPicker` 等）的抽象基类，实现了 `ActivityContext` 接口，提供设备配置、状态标志、生命周期、事件回调等通用能力。它不是 View，但和视图体系紧密相关——它持有 `DeviceProfile`，管理 Activity 状态标志位。

```java
public abstract class BaseActivity extends Activity implements ActivityContext,
        DisplayInfoChangeListener {
```

最核心的是一套 Activity 状态标志位（用位运算管理）：

```java
public static final int ACTIVITY_STATE_STARTED = 1 << 0;          // 已启动
public static final int ACTIVITY_STATE_RESUMED = 1 << 1;          // 已恢复（前台）
public static final int ACTIVITY_STATE_DEFERRED_RESUMED = 1 << 2; // 恢复后已绘制一帧
public static final int ACTIVITY_STATE_WINDOW_FOCUSED = 1 << 3;   // 窗口有焦点
public static final int ACTIVITY_STATE_USER_ACTIVE = 1 << 4;      // 用户活跃
public static final int ACTIVITY_STATE_TRANSITION_ACTIVE = 1 << 6; // 状态切换中
@ActivityFlags
private int mActivityFlags;
```

状态变更通过 `addActivityFlags` / `removeActivityFlags`，每次都通知子类：

```java
protected void addActivityFlags(int toAdd) {
    final int oldFlags = mActivityFlags;
    mActivityFlags |= toAdd;
    if (DEBUG) {
        Log.d(TAG, "Launcher flags updated: " + formatFlagChange(mActivityFlags, oldFlags,
                BaseActivity::getActivityStateString));
    }
    onActivityFlagsChanged(toAdd); // 通知子类
}
```

生命周期方法把 Activity 标准回调映射到这套标志位：

```java
@Override
protected void onStart() {
    addActivityFlags(ACTIVITY_STATE_STARTED);
    super.onStart();
    mEventCallbacks[EVENT_STARTED].executeAllAndClear(); // 触发注册的「启动」回调
}

@Override
protected void onResume() {
    setResumed();
    super.onResume();
    mEventCallbacks[EVENT_RESUMED].executeAllAndClear();
}

@Override
protected void onStop() {
    removeActivityFlags(ACTIVITY_STATE_STARTED | ACTIVITY_STATE_USER_ACTIVE);
    mForceInvisible = 0;
    super.onStop();
    mEventCallbacks[EVENT_STOPPED].executeAllAndClear();
    getSystemUiController().updateUiState(UI_STATE_FULLSCREEN_TASK, 0); // 重置 sysui 标志
}
```

`addEventCallback` 提供了「等某个生命周期事件发生后执行一次」的能力，用于异步任务依赖：

```java
public void addEventCallback(@ActivityEvent int event, Runnable callback) {
    mEventCallbacks[event].add(callback);
}
```

`mForceInvisible` 是一套独立的「强制不可见」标志，专门用于最近任务动画期间控制 Launcher 的可见性：

```java
public static final int INVISIBLE_BY_STATE_HANDLER = 1 << 0;
public static final int INVISIBLE_BY_APP_TRANSITIONS = 1 << 1;
public static final int INVISIBLE_BY_PENDING_FLAGS = 1 << 2;
public static final int PENDING_INVISIBLE_BY_WALLPAPER_ANIMATION = 1 << 3;

public void addForceInvisibleFlag(@InvisibilityFlags int flag) {
    mForceInvisible |= flag;
}

public boolean isForceInvisible() {
    return hasSomeInvisibleFlag(INVISIBLE_FLAGS);
}
```

`BaseActivity` 还接入了 Jetpack 的 `Lifecycle`、`SavedStateRegistry`（用于 ViewModel/Compose 集成）：

```java
private final SavedStateRegistryController mSavedStateRegistryController =
        SavedStateRegistryController.create(this);
private final LifecycleRegistry mLifecycleRegistry = new LifecycleRegistry(this);

@NonNull
@Override
public Lifecycle getLifecycle() {
    return mLifecycleRegistry;
}
```

`onDisplayInfoChanged` 处理屏幕旋转，竖屏布局下重新应用 UI：

```java
@Override
public void onDisplayInfoChanged(Context context, Info info, int flags) {
    if ((flags & CHANGE_ROTATION) != 0 && mDeviceProfile.isVerticalBarLayout()) {
        reapplyUi(); // 竖屏布局旋转时重新应用 UI
    }
}
```

### 面试深问

**问 1：LauncherRootView 在 `setInsets` 里判断 `!insets.equals(mInsets)` 才调用 `super.setInsets`，如果删掉这个判断会有什么后果？**

答：会触发频繁的全树重排。系统在很多场景都会派发 insets（旋转、键盘弹出/收起、分屏调整、immersive 模式切换），其中很多次实际值并未变化。`InsettableFrameLayout.setInsets` 会遍历所有子 view 重新设置 LayoutParams margin，引发整棵树 measure/layout。加判断后只有真正变化的 insets 才走重排，能避免大量无谓计算，对滑动/动画流畅度很关键。

**问 2：BaseActivity 用位运算管理 Activity 状态而不是用枚举或单独的布尔字段，优势在哪？**

答：位运算支持「批量查询和设置」。`isStarted() && hasBeenResumed() && isUserActive()` 这种多条件判断，用位运算就是 `(mActivityFlags & (STARTED|RESUMED|USER_ACTIVE)) == (STARTED|RESUMED|USER_ACTIVE)`，一次按位与搞定。`removeActivityFlags(STARTED | USER_ACTIVE)` 一次清多个标志。用独立布尔字段要写多行 if，用枚举要建 Set 集合。位运算还省内存（一个 int 装所有状态）、序列化方便，是状态机的经典实现方式。

**问 3：`LauncherRootView` 既实现 `dispatchDraw` 画 scrim，又继承 `InsettableFrameLayout`，为什么不把 scrim 画到一个独立的子 view 上？**

答：画在 `dispatchDraw` 开头保证 scrim 永远在最底层（在所有子 view 之下），不用关心子 view 的 z-order。如果做成子 view，要确保它是第一个 child 且不被其他 view 盖住，布局代码会更脆弱。scrim 还需要响应 inset 变化和尺寸变化，直接挂在 root view 上能复用 root 的 onLayout/onSizeChanged 回调，比独立 view 监听更直接。这是「装饰绘制」嵌入容器的常见手法。

---

## 五、PillColorProvider：颜色主题适配

### 5.1 单例与 Matcha 开关

`PillColorProvider` 是个 Kotlin 单例，负责给应用名标签的「胶囊背景」（pill background，桌面图标文字下方的圆角矩形背景）提供颜色。它跟随一个叫 `matcha_enable` 的系统设置开关：

```kotlin
class PillColorProvider private constructor(c: Context) {
    private val context = c.applicationContext // 持有 application context，避免 Activity 泄漏
    private val matchaUri by lazy { Settings.Secure.getUriFor(MATCHA_SETTING) } // 监听的设置 URI
    var appTitlePillPaint = Paint() // 胶囊背景的画笔
        private set
    var appTitleTextPaint = Paint() // 胶囊内文字的画笔
        private set
    private var isMatchaEnabledInternal = 0
    var isMatchaEnabled = isMatchaEnabledInternal != 0 // 对外暴露的开关状态
```

注意它持有 `applicationContext`，这是单例的标准防泄漏做法——单例生命周期比任何 Activity 都长，持 Activity context 会导致 Activity 无法回收。

`MATCHA_SETTING` 是个 Settings.Secure 开关，用户可以在系统设置里开关「Matcha」主题：

```kotlin
companion object {
    private var INSTANCE: PillColorProvider? = null
    private const val MATCHA_SETTING = "matcha_enable"
    @JvmStatic
    fun getInstance(context: Context): PillColorProvider {
        if (INSTANCE == null) {
            INSTANCE = PillColorProvider(context)
        }
        return INSTANCE!!
    }
}
```

### 5.2 ContentObserver 监听主题变化

为了让视图在用户切换 Matcha 开关时立即响应，`PillColorProvider` 注册了一个 `ContentObserver` 监听设置变化：

```kotlin
private val pillColorObserver =
        object : ContentObserver(ORDERED_BG_EXECUTOR.handler) { // 在后台有序线程回调
            override fun onChange(selfChange: Boolean, uri: Uri?) {
                if (uri == matchaUri) { // 只关心 matcha 设置
                    isMatchaEnabledInternal =
                            Settings.Secure.getInt(context.contentResolver, MATCHA_SETTING, 0)
                    isMatchaEnabled = isMatchaEnabledInternal != 0
                }
            }
        }

fun registerObserver() {
    context.contentResolver.registerContentObserver(matchaUri, false, pillColorObserver)
    setup() // 注册时立即读一次当前值
}

fun unregisterObserver() {
    context.contentResolver.unregisterContentObserver(pillColorObserver)
}
```

`ContentObserver` 用 `ORDERED_BG_EXECUTOR.handler`，保证回调在后台线程有序执行，不阻塞 UI。读 Settings 是个 binder 调用，放后台是对的。

### 5.3 setup 与颜色读取

`setup` 读取 Material 颜色资源并初始化画笔：

```kotlin
fun setup() {
    appTitlePillPaint.color = context.getColor(R.color.materialColorSurfaceContainer) // 胶囊背景色
    appTitleTextPaint.color = context.getColor(R.color.materialColorOnSurface)        // 胶囊内文字色
    isMatchaEnabledInternal = Settings.Secure.getInt(context.contentResolver, MATCHA_SETTING, 0)
    isMatchaEnabled = isMatchaEnabledInternal != 0
}
```

`materialColorSurfaceContainer` 和 `materialColorOnSurface` 是 Material Design 3 的颜色 token，会跟随系统深色/浅色主题自动切换。这意味着 Matcha 模式下，胶囊背景在深色模式是深色、浅色模式是浅色，文字色相反，保证对比度。

### 5.4 与 BubbleTextView 的协作

`BubbleTextView` 在 `shouldDrawAppContrastTile` 判断是否要画胶囊背景：

```java
public boolean shouldDrawAppContrastTile() {
    return mDisplay == DISPLAY_WORKSPACE && shouldTextBeVisible() // 仅桌面且文字可见
            && PillColorProvider.getInstance(getContext()).isMatchaEnabled() // Matcha 开启
            && enableContrastTiles(); // feature flag 开启
}
```

`drawAppContrastTile` 实际画胶囊，直接从 `PillColorProvider` 取画笔：

```java
public void drawAppContrastTile(Canvas canvas) {
    RectF appTitleBounds;
    Paint.FontMetrics fm = getPaint().getFontMetrics();
    Rect tmpRect = new Rect();
    getDrawingRect(tmpRect);
    CharSequence text = getText();
    int mAppTitleHorizontalPadding = getResources().getDimensionPixelSize(
            R.dimen.app_title_pill_horizontal_padding);
    int mRoundRectPadding = getResources().getDimensionPixelSize(
            R.dimen.app_title_pill_round_rect_padding);
    // 计算文字宽度 + padding，得到胶囊宽度
    float titleLength = (getPaint().measureText(text, 0, text.length())
            + (mAppTitleHorizontalPadding + mRoundRectPadding) * 2);
    titleLength = Math.min(titleLength, tmpRect.width()); // 不超过格子宽度
    // ... 计算 RectF 边界
    canvas.drawRoundRect(appTitleBounds, appTitleBounds.height() / 2,
            appTitleBounds.height() / 2,
            PillColorProvider.getInstance(getContext()).getAppTitlePillPaint()); // 用 PillColorProvider 的画笔画
}
```

`setTextColor(ColorStateList)` 在 Matcha 模式下也走 `PillColorProvider` 取文字色：

```java
@Override
public void setTextColor(ColorStateList colors) {
    if (shouldDrawAppContrastTile()) {
        mTextColor = PillColorProvider.getInstance(
                getContext()).getAppTitleTextPaint().getColor(); // Matcha 模式用专用文字色
    } else {
        mTextColor = colors.getDefaultColor();
        mTextColorStateList = colors;
    }
    // ...
}
```

`DoubleShadowBubbleTextView` 进一步在 `onDraw` 开头判断是否画胶囊（覆盖父类逻辑）：

```java
@Override
public void onDraw(Canvas canvas) {
    if (shouldDrawAppContrastTile() && !TextUtils.isEmpty(getText())) {
        drawAppContrastTile(canvas); // 先画胶囊背景
    }
    // ... 双阴影文字绘制
}
```

这套设计的巧妙之处：颜色策略（深色/浅色/Matcha）集中在 `PillColorProvider`，视图只管「要不要画」和「怎么画」，两者解耦。新增主题只需改 `PillColorProvider`，不动视图代码。

### 面试深问

**问 1：`PillColorProvider` 用 `applicationContext` 而不是传入的 Activity context，为什么？**

答：单例的生命周期和进程一样长，如果持有 Activity context，Activity 销毁后无法被 GC（单例还引用着它），造成内存泄漏。`applicationContext` 生命周期和单例匹配，安全。这是 Android 单例持有 context 的铁律——只能用 application context。

**问 2：ContentObserver 回调里改了 `isMatchaEnabled`，已经在屏幕上的 `BubbleTextView` 怎么知道要重绘？**

答：观察者模式只更新了 provider 自己的状态，已经在屏的视图不会自动重绘。实际触发重绘靠的是：用户改 Matcha 开关通常会伴随配置变化（深浅色切换），Launcher 的 `handleConfigurationChanged` 会重建或重绑数据，期间 `applyFrom*` 重新跑，`shouldDrawAppContrastTile` 读到新状态决定是否画胶囊。也就是说 provider 提供「当前状态」，重绘时机交给配置变化流程，provider 不主动通知每个视图。

**问 3：为什么用 `Settings.Secure` 而不是 `Settings.System` 或 feature flag？**

答：`Settings.System` 已废弃用于全局设置，`Settings.Secure` 是现代全局开关的标准位置（用户可在开发者选项或系统设置改）。feature flag 是编译期决定的，用户无法动态切换。Matcha 是个用户可开关的运行时主题，必须是 `Settings.Secure` + ContentObserver 这套动态监听机制。

---

## 六、其他视图：Snackbar、ArrowTipView、AbstractSlideInView

### 6.1 Snackbar

`Snackbar` 是 Launcher 自己实现的轻量级提示条（不是 AndroidX 的 Snackbar），继承 `AbstractFloatingView`，定位是「屏幕底部带文字和可选动作按钮的临时提示」：

```java
public class Snackbar extends AbstractFloatingView {
    private static final long SHOW_DURATION_MS = 180;     // 显示动画时长
    private static final long HIDE_DURATION_MS = 180;     // 隐藏动画时长
    private static final int TIMEOUT_DURATION_MS = 4000;  // 自动消失时间
```

`show` 是个静态工厂方法，负责创建、布局、动画、自动消失的全流程：

```java
public static void show(ActivityContext activity, CharSequence labelString,
        int actionStringResId, Runnable onDismissed, @Nullable Runnable onActionClicked) {
    closeOpenViews(activity, true, TYPE_SNACKBAR); // 先关掉已有的 snackbar
    Snackbar snackbar = new Snackbar((Context) activity, null);
    // ...设置朝向、padding、背景、尺寸
    snackbar.mIsOpen = true;
    BaseDragLayer dragLayer = activity.getDragLayer();
    dragLayer.addView(snackbar); // 添加到 DragLayer 作为浮层
    // ...计算 LayoutParams（底部居中、考虑 taskbar/inset）
    // 显示动画：alpha 0→1 + scale 0.8→1
    snackbar.setAlpha(0);
    snackbar.setScaleX(0.8f);
    snackbar.setScaleY(0.8f);
    snackbar.animate()
            .alpha(1f).withLayer()
            .scaleX(1).scaleY(1)
            .setDuration(SHOW_DURATION_MS)
            .setInterpolator(Interpolators.ACCELERATE_DECELERATE)
            .start();
    // 无障碍推荐的超时（考虑用户的无障碍设置）
    int timeout = AccessibilityManagerCompat.getRecommendedTimeoutMillis(snackbar.getContext(),
            TIMEOUT_DURATION_MS, FLAG_CONTENT_TEXT | FLAG_CONTENT_CONTROLS);
    snackbar.postDelayed(() -> snackbar.close(true), timeout); // 自动消失
}
```

`handleClose` 实现淡出 + 移除：

```java
@Override
protected void handleClose(boolean animate) {
    if (mIsOpen) {
        if (animate) {
            animate().alpha(0f).withLayer()
                    .setStartDelay(0)
                    .setDuration(HIDE_DURATION_MS)
                    .setInterpolator(Interpolators.ACCELERATE)
                    .withEndAction(this::onClosed)
                    .start();
        } else {
            animate().cancel();
            onClosed();
        }
        mIsOpen = false;
    }
}

private void onClosed() {
    mActivity.getDragLayer().removeView(this); // 从 DragLayer 移除自己
    if (mOnDismissed != null) {
        mOnDismissed.run(); // 通知外部「我消失了」
    }
}
```

`isOfType` 声明自己是 `TYPE_SNACKBAR`：

```java
@Override
protected boolean isOfType(int type) {
    return (type & TYPE_SNACKBAR) != 0;
}
```

`onControllerInterceptTouchEvent` 实现「点 snackbar 外面就关闭」：

```java
@Override
public boolean onControllerInterceptTouchEvent(MotionEvent ev) {
    if (ev.getAction() == MotionEvent.ACTION_DOWN) {
        BaseDragLayer dl = mActivity.getDragLayer();
        if (!dl.isEventOverView(this, ev)) { // 按下点不在 snackbar 上
            close(true); // 关闭
        }
    }
    return false;
}
```

### 6.2 ArrowTipView

`ArrowTipView` 是带箭头的教学提示气泡（onboarding tip），用于「首次进入 Widget 选择器」「Taskbar 教程」等场景。它也继承 `AbstractFloatingView`，类型是 `TYPE_ON_BOARD_POPUP`：

```java
public class ArrowTipView extends AbstractFloatingView {
    private static final long AUTO_CLOSE_TIMEOUT_MILLIS = 10 * 1000; // 10 秒自动关闭
    private static final long SHOW_DELAY_MS = 200;
    private static final long SHOW_DURATION_MS = 300;
    private static final long HIDE_DURATION_MS = 100;
```

它的特点是箭头位置可调，且能根据屏幕边界自动翻转（向上/向下）：

```java
protected ArrowTipView showAtLocation(
        @Px int arrowXCoord, @Px int yCoordDownPointingTip, @Px int yCoordUpPointingTip,
        @Px int minViewMargin, @Px int parentViewWidth, @Px int parentViewHeight,
        boolean shouldAutoClose) {
    post(() -> {
        // 水平调整：箭头坐标超出边界就把气泡推到边界内
        float halfWidth = getWidth() / 2f;
        float xCoord;
        if (arrowXCoord - halfWidth < minViewMargin) {
            xCoord = minViewMargin; // 左边界
        } else if (arrowXCoord + halfWidth > parentViewWidth - minViewMargin) {
            xCoord = parentViewWidth - minViewMargin - getWidth(); // 右边界
        } else {
            xCoord = arrowXCoord - halfWidth; // 居中于箭头
        }
        setX(xCoord);
        // 垂直调整：放不下就翻转箭头方向
        boolean isPointingUp = mIsPointingUp;
        if (mIsPointingUp
                ? (yCoordUpPointingTip + viewHeight > parentViewHeight)
                : (yCoordDownPointingTip - viewHeight < 0)) {
            isPointingUp = !isPointingUp; // 翻转
        }
        updateArrowTipInView(isPointingUp); // 重画箭头
        setY(isPointingUp ? yCoordUpPointingTip : yCoordDownPointingTip - viewHeight);
        // 箭头相对气泡的位置，保证箭头尖端始终对准 arrowXCoord
        mArrowView.setX(arrowXCoord - xCoord - mArrowView.getWidth() / 2f);
        requestLayout();
    });
    // ...
}
```

箭头本身用 `ShapeDrawable` + `TriangleShape` + `CornerPathEffect` 画，可带圆角：

```java
private void updateArrowTipInView(boolean isPointingUp) {
    ViewGroup.LayoutParams arrowLp = mArrowView.getLayoutParams();
    ShapeDrawable arrowDrawable = new ShapeDrawable(TriangleShape.create(
            arrowLp.width, arrowLp.height, isPointingUp)); // 三角形，朝向可变
    Paint arrowPaint = arrowDrawable.getPaint();
    @Px int arrowTipRadius = getContext().getResources()
            .getDimensionPixelSize(R.dimen.arrow_toast_corner_radius);
    arrowPaint.setColor(mArrowViewPaintColor);
    arrowPaint.setPathEffect(new CornerPathEffect(arrowTipRadius)); // 圆角
    mArrowView.setBackground(arrowDrawable);
    // ...根据朝向调整 margin（负 margin 隐藏底部圆角）
}
```

`handleClose` 用预构建的 `AnimatorSet`：

```java
@Override
protected void handleClose(boolean animate) {
    if (mOpenAnimator.isStarted()) mOpenAnimator.cancel();
    if (mIsOpen) {
        if (animate) {
            mCloseAnimator.addListener(AnimatorListeners.forSuccessCallback(
                    () -> mActivityContext.getDragLayer().removeView(this)));
            mCloseAnimator.start();
        } else {
            mCloseAnimator.cancel();
            mActivityContext.getDragLayer().removeView(this);
        }
        if (mOnClosed != null) mOnClosed.run();
        mIsOpen = false;
    }
}
```

### 6.3 AbstractSlideInView

`AbstractSlideInView` 是从底部滑入的浮层基类（Widget 底部抽屉、AllApps 在某些设备上的滑入等都基于它）。它继承 `AbstractFloatingView` 并实现 `SingleAxisSwipeDetector.Listener`（支持下拉关闭）：

```java
public abstract class AbstractSlideInView<T extends Context & ActivityContext>
        extends AbstractFloatingView implements SingleAxisSwipeDetector.Listener {

    protected static final float TRANSLATION_SHIFT_CLOSED = 1f; // 完全关闭：下移整个高度
    protected static final float TRANSLATION_SHIFT_OPENED = 0f; // 完全打开：不下移
    private static final int DEFAULT_DURATION = 300;
    // 范围 [0,1]，0 完全打开，1 完全关闭
    protected float mTranslationShift = TRANSLATION_SHIFT_CLOSED;
```

核心是用 `translationShift` 这个 0~1 的归一化值控制内容竖直位移：

```java
protected void setTranslationShift(float translationShift) {
    mTranslationShift = translationShift;
    mContent.setTranslationY(mTranslationShift * getShiftRange()); // 位移 = shift * 内容高度
    invalidate();
}

protected float getShiftRange() {
    return mContent.getHeight(); // 滑动范围就是内容高度
}
```

打开/关闭动画通过 `AnimatorPlaybackController`（一个可拖动的动画控制器）实现，这样用户拖拽时可以实时控制动画进度：

```java
private AnimatorPlaybackController setUpOpenCloseAnimation(
        float fromTranslationShift, float toTranslationShift, long duration) {
    mFromTranslationShift = fromTranslationShift;
    mToTranslationShift = toTranslationShift;
    PendingAnimation animation = new PendingAnimation(duration);
    animation.addEndListener(b -> {
        mSwipeDetector.finishedScrolling();
        announceAccessibilityChanges();
    });
    animation.addFloat(
            this, TRANSLATION_SHIFT, fromTranslationShift, toTranslationShift, LINEAR);
    if (mColorScrim != null) {
        animation.setViewAlpha(mColorScrim, 1 - toTranslationShift, getScrimInterpolator());
    }
    onOpenCloseAnimationPending(animation);
    mOpenCloseAnimation = animation.createPlaybackController();
    return mOpenCloseAnimation;
}
```

下拉拖拽时，`onDrag` 把手指位移映射到动画进度：

```java
@Override
public boolean onDrag(float displacement) {
    float progress = mDragStartProgress
            + Math.signum(mToTranslationShift - mFromTranslationShift)
            * (displacement / getShiftRange());
    mOpenCloseAnimation.setPlayFraction(Utilities.boundToRange(progress, 0, 1)); // 实时控制
    return true;
}

@Override
public void onDragEnd(float velocity) {
    float successfulShiftThreshold = mActivityContext.getDeviceProfile().getDeviceProperties().isTablet()
            ? TABLET_BOTTOM_SHEET_SUCCESS_TRANSITION_PROGRESS : SUCCESS_TRANSITION_PROGRESS;
    if ((mSwipeDetector.isFling(velocity) && velocity > 0) // 下拉 fling
            || mTranslationShift > successfulShiftThreshold) { // 或拖过阈值
        // 关闭
        mScrollInterpolator = scrollInterpolatorForVelocity(velocity);
        mScrollDuration = BaseSwipeDetector.calculateDuration(
                velocity, TRANSLATION_SHIFT_CLOSED - mTranslationShift);
        mScrollEndProgress = mToTranslationShift == TRANSLATION_SHIFT_OPENED ? 0 : 1;
        close(true);
    } else {
        // 没拖过阈值，弹回打开状态
        ValueAnimator animator = mOpenCloseAnimation.getAnimationPlayer();
        animator.setInterpolator(Interpolators.DECELERATE);
        animator.setFloatValues(
                mOpenCloseAnimation.getProgressFraction(),
                mToTranslationShift == TRANSLATION_SHIFT_OPENED ? 1 : 0);
        animator.setDuration(BaseSwipeDetector.calculateDuration(velocity, mTranslationShift))
                .start();
    }
}
```

它还实现了 Android 14 的预测式返回手势（`OnBackAnimationCallback`），返回滑动时缩小内容：

```java
@Override
@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
public void onBackProgressed(BackEvent backEvent) {
    final float progress = backEvent.getProgress();
    mSwipeToDismissProgress.updateValue(progress); // 更新归一化进度
}

protected void onUserSwipeToDismissProgressChanged() {
    float progress = mSwipeToDismissProgress.value;
    mIsDismissInProgress = progress > 0f;
    // 缩放：progress 0→1 时 scale 从 1→PREDICTIVE_BACK_MIN_SCALE
    float scale = PREDICTIVE_BACK_MIN_SCALE + (1 - PREDICTIVE_BACK_MIN_SCALE) * (1f - progress);
    SCALE_PROPERTY.set(mViewToAnimateInSwipeToDismiss, scale);
    setClipChildren(!mIsDismissInProgress); // 缩放时关掉裁剪，让内容能露出
    setClipToPadding(!mIsDismissInProgress);
    mContent.setClipChildren(!mIsDismissInProgress);
    mContent.setClipToPadding(!mIsDismissInProgress);
    invalidate();
}
```

`attachToContainer` 把自己（和可选的 scrim）添加到 DragLayer：

```java
protected void attachToContainer() {
    if (mColorScrim != null) {
        getPopupContainer().addView(mColorScrim); // 先加 scrim（在底层）
    }
    getPopupContainer().addView(this); // 再加自己
}

protected BaseDragLayer getPopupContainer() {
    return mActivityContext.getDragLayer();
}
```

### 6.4 视图体系全景

把所有视图放在一起看，Launcher3 的视图层级大致是：

```
LauncherRootView (InsettableFrameLayout, 视图树根)
├── SysUiScrim (dispatchDraw 里画，非子 view)
├── 背景 / 壁纸
├── Workspace (桌面分页)
│   └── CellLayout → BubbleTextView / FolderIcon
├── Hotseat (固定栏)
│   └── BubbleTextView
├── DragLayer (浮层容器 + 拖拽层)
│   ├── DropTargetBar (常驻，alpha 显隐)
│   │   └── ButtonDropTarget × N
│   ├── AbstractFloatingView 子类 (动态 add/remove)
│   │   ├── Folder (TYPE_FOLDER)
│   │   ├── PopupContainer (TYPE_ACTION_POPUP)
│   │   ├── WidgetsBottomSheet extends AbstractSlideInView
│   │   ├── Snackbar (TYPE_SNACKBAR)
│   │   ├── ArrowTipView (TYPE_ON_BOARD_POPUP)
│   │   └── ...
│   └── DragView (拖拽时的图标副本)
└── ScrimView / Taskbar (部分场景)
```

这套体系的设计哲学是：**根视图管 inset 和全局绘制，DragLayer 管浮层和拖拽，Workspace 管桌面布局，BubbleTextView 管单个图标**。每一层职责单一，通过 `ActivityContext` 接口互相查找（`ActivityContext.lookupContext`），通过 `getTag()` 反查数据，通过位标志类型系统按组操作浮层。理解了这个分工，阅读 Launcher3 任何视图代码都能快速定位到它属于哪一层、跟谁交互。

### 面试深问

**问 1：Launcher 为什么自己实现 Snackbar 而不用 AndroidX 的 `com.google.android.material.snackbar.Snackbar`？**

答：AndroidX Snackbar 的显示位置、动画、生命周期都和 CoordinatorLayout 绑定，且不属于 Launcher 的浮层体系，无法被 `closeAllOpenViews(TYPE_ALL)` 统一关闭、无法响应 Launcher 的触摸分发链、无法和 DragLayer 协同。自己实现的 Snackbar 继承 `AbstractFloatingView`，天然纳入浮层管理体系，能用 `TYPE_SNACKBAR` 精确控制，触摸、返回键、无障碍行为和其他浮层一致。这是「为了体系一致性而重造轮子」的合理决策。

**问 2：`AbstractSlideInView` 用 `AnimatorPlaybackController` 而不是直接 `ObjectAnimator`，原因是什么？**

答：`AnimatorPlaybackController` 是 Launcher 自己的可「拖动」动画控制器，核心能力是把一个完整动画（0→1）映射到任意进度（`setPlayFraction`）。下拉关闭手势需要「手指拖到哪动画跟到哪」，松手后再 fling 或弹回——这种「先跟手、后自动」的交互，必须能把动画进度实时设为任意值，普通 `ObjectAnimator` 做不到（它只能从头播到尾）。用 PlaybackController，拖拽时 `setPlayFraction(displacement/range)`，松手时 `getAnimationPlayer().start()` 接着播，无缝衔接。

**问 3：ArrowTipView 在屏幕边界自动翻转箭头方向，这个「翻转」是怎么实现的？**

答：箭头是个 `ShapeDrawable`，由 `TriangleShape.create(width, height, isPointingUp)` 生成，`isPointingUp` 决定三角形朝向。检测到「朝上但顶部放不下」或「朝下但底部放不下」时，调用 `updateArrowTipInView(!isPointingUp)` 重新生成相反朝向的三角形 drawable，并调整它在 LinearLayout 中的位置（朝上时 addView 到 index 0，朝下时 addView 到 index 1）和负 margin（隐藏底/顶圆角）。整个翻转是重建 drawable + 调位置，不涉及动画过渡。
