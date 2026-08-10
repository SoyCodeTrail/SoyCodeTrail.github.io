---
title: Launcher3 源码精读（02）：桌面布局
category: client
platform: android
tags: ["AOSP", "Launcher3", "源码", "Framework"]
readTime: 26分钟
featured: true
date: 2026-08-02
---

# Launcher3 桌面布局源码精读

> 源码基线：`aosp-r4`（`packages/apps/Launcher3`）
> 本篇讲透一件事：**一条数据库记录如何变成屏幕上一个确定像素位置的格子**，并覆盖多屏滑动、拖拽让位、设备适配的全部机制。
> 涉及 11 个真实类：`PagedView` / `Workspace` / `WorkspaceLayoutManager` / `CellLayout` / `ShortcutAndWidgetContainer` / `CellLayoutLayoutParams` / `Hotseat` / `GridOccupancy` / `ReorderAlgorithm` / `ViewCluster` / `ItemConfiguration` / `DeviceProfile` / `InvariantDeviceProfile`。下面每一个字段名、方法签名、常量值都来自源码逐行核对。

| 类 | 行数 | 一句话职责 |
|----|------|-----------|
| `PagedView.java` | 2026 | 分页容器基类，处理滑动、snap、overscroll、双屏 |
| `Workspace.java` | 3675 | 桌面多屏容器，screenId↔页索引映射、拖拽落地、空屏管理 |
| `WorkspaceLayoutManager.java` | 177 | `addInScreen` 总入口、Hotseat rank 转换 |
| `CellLayout.java` | 1993 | 单屏网格，格子坐标系、占位表、重排调度 |
| `ShortcutAndWidgetContainer.java` | 346 | `CellLayout` 唯一子节点，真正持有图标、负责 `layout()` |
| `CellLayoutLayoutParams.java` | 216 | 网格坐标↔像素坐标的换算公式 `setup()` |
| `Hotseat.java` | 413 | 底部固定栏，继承 `CellLayout` |
| `GridOccupancy.java` | 113 | `boolean[countX][countY]` 占位二维表 |
| `ReorderAlgorithm.java` | 651 | 三方案择优的拖拽重排算法 |
| `ViewCluster.kt` | 185 | 把一组图标当成"簇"整体推挤 |
| `ItemConfiguration.kt` | 61 | 重排解容器：`Map<View, CellAndSpan>` + save/restore |
| `DeviceProfile.java` | 1987 | 按屏幕算 cellWidth/Height、图标尺寸 |
| `InvariantDeviceProfile.java` | 1778 | 全局网格规格表，读 `device_profiles.xml` |

---

## 一、视图层级：从 Launcher 到 BubbleTextView

桌面是多层 `ViewGroup` 嵌套。嵌套关系决定了一切布局逻辑：

```
Launcher (Activity, setContentView(launcher.xml))
└── DragLayer (BaseDragLayer, FrameLayout)            ← 拖拽时在此层绘制 DragView
    ├── Workspace<T> (extends PagedView<T>)           ← 横向分页容器
    │   ├── CellLayout  screenId=0   (FIRST_SCREEN_ID)  一个 CellLayout = 一屏
    │   │   └── ShortcutAndWidgetContainer (ViewGroup)  ← 真正放图标的地方
    │   │       ├── BubbleTextView        (cellX=0,cellY=0, span 1×1)
    │   │       ├── FolderIcon            (cellX=2,cellY=1, span 1×1)
    │   │       └── LauncherAppWidgetHostView (cellX=0,cellY=2, span 2×2)
    │   ├── CellLayout  screenId=1
    │   │   └── ShortcutAndWidgetContainer → ...
    │   └── CellLayout  screenId=EXTRA_EMPTY_SCREEN_ID(-201)  ← 拖拽时动态出现的空屏
    │
    └── Hotseat (extends CellLayout, containerType=HOTSEAT)  ← 与 Workspace 平级，不嵌套
        ├── ShortcutAndWidgetContainer → 5 个 BubbleTextView (cellY 恒为 0)
        └── mQsb (搜索框，构造时直接 addView，不走格子)
```

三层关系，每层职责单一：

| 层 | 职责 | 不负责 |
|----|------|--------|
| `Workspace` (PagedView) | 横向排列多个 `CellLayout`、翻页、snap | 不碰单个图标 |
| `CellLayout` | 单屏网格坐标系、绘制落点高亮框、调度重排 | 不直接持有图标，只持一个 `ShortcutAndWidgetContainer` |
| `ShortcutAndWidgetContainer` | 真正 `addView` 图标、`measureChild`/`layoutChild` 把图标摆到像素位 | 不管多屏 |

为什么 `CellLayout` 要多包一层 `ShortcutAndWidgetContainer`，而不是直接持有图标？因为 `CellLayout` 还要自己绘制（`setWillNotDraw(false)`）落点绿色高亮框、网格背景、文件夹留痕（`FolderLeaveBehind`），这些是装饰层；图标是内容层。两层分离后，`enableHardwareLayer(true)` 只对内容层生效，装饰层照常重绘，性能与正确性兼得。

继承与接口关系：

```
ViewGroup
   │ extends (abstract, 通用分页能力)
PagedView<T extends View & PageIndicator>
   │ extends + implements [DropTarget, DragSource, CellLayoutContainer,
   │                      WorkspaceLayoutManager, Insettable, ...]
Workspace<T>                          ← 桌面专用分页容器

ViewGroup
   │ extends
CellLayout ──composes──▶ ShortcutAndWidgetContainer (唯一子节点)
   │ extends
Hotseat                               ← containerType=HOTSEAT
```

`Workspace` 实现 `CellLayoutContainer` 接口（`getCellLayoutId` / `getCellLayoutIndex` / `getPanelCount` / `getPageDescription`），这是 `CellLayout` **反向回调** `Workspace` 的桥梁——`commitTempPlacement` 需要知道自己属于哪个 screenId 时就调 `mCellLayoutContainer.getCellLayoutId(this)`。

### 面试深问

**1. 为什么 Hotseat 不做成 Workspace 的特殊一屏？**
Hotseat 必须在所有屏切换时固定可见，若放进 Workspace 内部会被一起横向滚动。让它与 Workspace 平级挂在 `DragLayer` 上，再通过 `onInterceptTouchEvent` 把翻页手势委托回 Workspace，就同时满足了"固定显示"+"可横向滑动切屏"两个需求。

**2. CellLayout 自己画落点框，为什么不交给图标画？**
落点框是"拖拽预览"，此时还没有图标落地该格；同时框的尺寸要跟随 cell + borderSpace，独立于任何单个图标的 span。把绘制责任放在网格容器层，逻辑与图标解耦。

**3. ShortcutAndWidgetContainer 为什么不直接 extend CellLayout？**
CellLayout 已经在管 `mOccupied`/`mTmpOccupied` 占位表、重排动画、落点绘制，这些都是"屏级"状态。图标容器是纯"子 View 排列器"，职责更窄。分开后 CellLayout 持有容器引用即可，类型边界清晰。

---

## 二、CellLayoutLayoutParams：网格坐标与像素坐标的桥梁

`CellLayoutLayoutParams` 是所有定位的第一性原理。每个图标进入 `CellLayout` 都被包成一份这个 LayoutParams。

```java
// celllayout/CellLayoutLayoutParams.java
public class CellLayoutLayoutParams extends ViewGroup.MarginLayoutParams {
    private int mCellX;          // 永久格子 X（落库值，Favorites.cellX）
    private int mCellY;          // 永久格子 Y
    private int mTmpCellX;       // 重排期"临时"格子 X（预览用，不落库）
    private int mTmpCellY;

    public boolean useTmpCoords; // 布局时用 mCellX 还是 mTmpCellX —— 拖拽预览的核心开关
    public int cellHSpan;        // 水平跨度（普通图标 1，widget 可达 4）
    public int cellVSpan;        // 垂直跨度
    public boolean isLockedToGrid = true; // false 时 x/y/w/h 可自由设（QSB 用）
    public boolean canReorder = true;     // AllApps 按钮/QSB 置 false，重排不可推动
    public int x;                // 像素 X（setup() 推导）
    public int y;
    public boolean dropped;      // 标记刚被 drop，触发壁纸 COMMAND_DROP
}
```

| 字段 | 类型 | 含义 | 谁写它 |
|------|------|------|--------|
| `mCellX/mCellY` | int | 永久网格坐标 | `addInScreen`、`commitTempPlacement` |
| `mTmpCellX/mTmpCellY` | int | 重排预览坐标 | `copySolutionToTempState`、`animateChildToPosition` |
| `useTmpCoords` | boolean | setup() 选哪套坐标 | `setUseTempCoords`（DRAG_OVER 时 true） |
| `cellHSpan/cellVSpan` | int | 跨度 | `addInScreen`，-1 表示铺满（QSB） |
| `isLockedToGrid` | boolean | 锁定网格 vs 自由坐标 | QSB=false，其余 true |
| `x/y` | int | 像素左上角 | `setup()` |
| `dropped` | boolean | 触发壁纸特效 | `onDropChild` |

### 2.1 setup()：网格坐标 → 像素坐标的唯一公式

这是整个布局系统最该背下来的方法。`measureChild` 调它，把网格坐标翻译成 `lp.x/lp.y/lp.width/lp.height`：

```java
// celllayout/CellLayoutLayoutParams.java
public void setup(int cellWidth, int cellHeight, boolean invertHorizontally, int colCount,
        int rowCount, float cellScaleX, float cellScaleY, Point borderSpace,
        @Nullable Rect inset) {
    if (isLockedToGrid) {
        final int myCellHSpan = cellHSpan;
        final int myCellVSpan = cellVSpan;
        int myCellX = useTmpCoords ? getTmpCellX() : getCellX(); // ★ 选临时或永久坐标
        int myCellY = useTmpCoords ? getTmpCellY() : getCellY();

        if (invertHorizontally) {                 // RTL 镜像：X 关于列数翻转
            myCellX = colCount - myCellX - cellHSpan;
        }

        int hBorderSpacing = (myCellHSpan - 1) * borderSpace.x; // 多 span 内部有 (span-1) 个间距
        int vBorderSpacing = (myCellVSpan - 1) * borderSpace.y;

        // widget 用 cellScale 缩放并居中，普通图标 scale=1
        float myCellWidth  = ((myCellHSpan * cellWidth)  + hBorderSpacing) / cellScaleX;
        float myCellHeight = ((myCellVSpan * cellHeight) + vBorderSpacing) / cellScaleY;

        width  = Math.round(myCellWidth)  - leftMargin - rightMargin;
        height = Math.round(myCellHeight) - topMargin  - bottomMargin;
        x = leftMargin + (myCellX * cellWidth)  + (myCellX * borderSpace.x);   // ★像素 X
        y = topMargin  + (myCellY * cellHeight) + (myCellY * borderSpace.y);   // ★像素 Y

        if (inset != null) {                       // widget 在格子内缩进
            x += inset.left; y += inset.top;
            width -= inset.left + inset.right;
            height -= inset.top + inset.bottom;
        }
    }
}
```

像素坐标公式（死记）：

```
x      = cellX × cellWidth  + cellX × borderSpace.x        (+ margin + inset.left)
y      = cellY × cellHeight + cellY × borderSpace.y        (+ margin + inset.top)
width  = cellHSpan × cellWidth  + (cellHSpan - 1) × borderSpace.x
height = cellVSpan × cellHeight + (cellVSpan - 1) × borderSpace.y
```

设计要点：`useTmpCoords` 让同一份 LayoutParams 在拖拽期间显示临时位置、落库后切回永久位置——这就是图标能"预览式让位"而不污染数据库的机制。

### 2.2 反向换算：像素 → 格子

拖拽时手指给的是像素坐标，要反查落在哪个格。`pointToCellExact`：

```java
// CellLayout.java
public void pointToCellExact(int x, int y, int[] result) {
    final int hStartPadding = getPaddingLeft();
    final int vStartPadding = getPaddingTop();
    result[0] = (x - hStartPadding) / (mCellWidth + mBorderSpace.x);  // 整除取格子
    result[1] = (y - vStartPadding)  / (mCellHeight + mBorderSpace.y);
    if (result[0] < 0) result[0] = 0;                                  // 越界钳制
    if (result[0] >= mCountX) result[0] = mCountX - 1;
    if (result[1] < 0) result[1] = 0;
    if (result[1] >= mCountY) result[1] = mCountY - 1;
}
```

正向 `cellToRect`（在 `onDraw` 高亮、`animateChildToPosition`、`estimateItemPosition` 用）会加上未用空间的居中偏移：

```java
// CellLayout.java
public void cellToRect(int cellX, int cellY, int cellHSpan, int cellVSpan, Rect resultRect) {
    final int hStartPadding = getPaddingLeft()
            + (int) Math.ceil(getUnusedHorizontalSpace() / 2f); // 余数居中吸收
    final int vStartPadding = getPaddingTop();
    int x = hStartPadding + (cellX * mBorderSpace.x) + (cellX * cellWidth)
            + getTranslationXForCell(cellX, cellY);              // Hotseat 给气泡栏腾位
    int y = vStartPadding + (cellY * mBorderSpace.y) + (cellY * cellHeight);
    int width  = cellHSpan * cellWidth + ((cellHSpan - 1) * mBorderSpace.x);
    int height = cellVSpan * cellHeight + ((cellVSpan - 1) * mBorderSpace.y);
    resultRect.set(x, y, x + width, y + height);
}
```

注意 `cellToRect` 比 `setup()` 多了 `getUnusedHorizontalSpace()/2` 居中量、`getTranslationXForCell`（Hotseat 重写为气泡栏腾位），因为 `onLayout` 已把 `ShortcutAndWidgetContainer` 居中摆放过一次，绘制时要在 `CellLayout` 自己的坐标系里还原绝对位置。

### 2.3 坐标系直观图（4×5 网格）

```
        cellX →   0       1       2       3
   cellY        ┌───────┬───────┬───────┬───────┐
      ↓    0    │  A    │  B    │  C    │  D    │   cellWidth × cellHeight = 单格像素
                ├───────┼───────┼───────┼───────┤
           1    │  E    │  F    │  G    │  H    │   borderSpace.x = 横向间距
                ├───────┼───────┼───────┼───────┤   borderSpace.y = 纵向间距
           2    │  I    │ [   Widget 2×2     ]  │   ← cellHSpan=2,cellVSpan=2
                ├───────┤                       │     lp=(cellX=2,cellY=2,span 2×2)
           3    │  J    │ (widget 覆盖区域)     │
                ├───────┼───────┼───────┼───────┤   Widget 在 GridOccupancy 标记
           4    │  K    │  L    │  M    │  N    │   cells[2..3][2..3]=true
                └───────┴───────┴───────┴───────┘
```

### 面试深问

**1. 为什么 setup() 里 `cellScaleX/Y` 只对 widget 生效，图标永远是 1？**
图标是固定尺寸位图，在格子里靠 padding 居中即可；widget 可视内容小于格子（minCellSize < cellSize），需要按 `appWidgetScale` 比例缩放并居中，所以传非 1 的 scale，让 `width/scaleX` 反算出更大基准尺寸再缩放回可视区。

**2. useTmpCoords 什么时候 true？什么时候切回 false？**
`MODE_DRAG_OVER` 调 `setUseTempCoords(true)` 让图标按临时坐标显示；`MODE_ON_DROP` 末尾 `setUseTempCoords(false)`，配合 `commitTempPlacement` 把 `tmpCellX` 拷给 `mCellX`，从此用永久坐标——数据库也同步改。

**3. invertHorizontally 解决什么问题？**
RTL 语言（阿拉伯/希伯来语）下整个界面水平镜像，但数据库里存的是 LTR 坐标。`invertHorizontally=true` 时 `myCellX = colCount - cellX - cellHSpan`，在 setup 阶段做镜像，避免在数据层重写坐标。

---

## 三、GridOccupancy：占位二维表

`GridOccupancy` 是占位真相来源，一个 `boolean[countX][countY]`：

```java
// util/GridOccupancy.java
public class GridOccupancy {
    private final int mCountX;
    private final int mCountY;
    public final boolean[][] cells;                  // [x][y]

    public GridOccupancy(int countX, int countY) {
        cells = new boolean[countX][countY];         // 默认全 false（空）
    }

    public boolean findVacantCell(int[] vacantOut, int spanX, int spanY) {
        for (int y = 0; (y + spanY) <= mCountY; y++) {          // 逐行扫描
            for (int x = 0; (x + spanX) <= mCountX; x++) {
                boolean available = !cells[x][y];
                out:                                              // 命中即跳出双层循环
                for (int i = x; i < x + spanX; i++) {
                    for (int j = y; j < y + spanY; j++) {
                        available = available && !cells[i][j];
                        if (!available) break out;
                    }
                }
                if (available) { vacantOut[0] = x; vacantOut[1] = y; return true; }
            }
        }
        return false;
    }

    public boolean isRegionVacant(int x, int y, int spanX, int spanY) {
        int x2 = x + spanX - 1, y2 = y + spanY - 1;
        if (x < 0 || y < 0 || x2 >= mCountX || y2 >= mCountY) return false;
        for (int i = x; i <= x2; i++)
            for (int j = y; j <= y2; j++)
                if (cells[i][j]) return false;
        return true;
    }

    public void markCells(int cellX, int cellY, int spanX, int spanY, boolean value) {
        if (cellX < 0 || cellY < 0) return;
        for (int x = cellX; x < cellX + spanX && x < mCountX; x++)
            for (int y = cellY; y < cellY + spanY && y < mCountY; y++)
                cells[x][y] = value;
    }

    public void copyTo(GridOccupancy dest) { /* 逐格拷贝 */ }
}
```

`CellLayout` 持有两张表，刻意分离"真实"与"预览"：

| 表 | 字段 | 何时写 | 含义 |
|----|------|--------|------|
| `mOccupied` | 真实占位 | `addView`/`removeView`/`commitTempPlacement` | 落库的真实状态 |
| `mTmpOccupied` | 临时占位 | `copySolutionToTempState`/`animateItemsToSolution` | 拖拽预览状态，不污染真实表 |

只有 `commitTempPlacement` 时 `mTmpOccupied.copyTo(mOccupied)`，预览才升格为真实。这是"撤销拖拽"能瞬时还原的根因——真实表从未被动过。

增删图标时同步标记：

```java
// CellLayout.java
public void markCellsAsOccupiedForView(View view) {
    if (view == null || view.getParent() != mShortcutsAndWidgets) return;
    CellLayoutLayoutParams lp = (CellLayoutLayoutParams) view.getLayoutParams();
    mOccupied.markCells(lp.getCellX(), lp.getCellY(), lp.cellHSpan, lp.cellVSpan, true);
}
public void markCellsAsUnoccupiedForView(View view) { /* 同上但 value=false */ }
```

### 面试深问

**1. findVacantCell 为什么要按 y 外层、x 内层遍历？**
返回"最靠上、靠左"的第一个空位。优先填满顶部再向下，符合用户视觉直觉——空位出现在网格顶部时先被利用。

**2. mOccupied 和 mTmpOccupied 的大小一样吗？**
完全一样，都是 `new GridOccupancy(mCountX, mCountY)`，构造 `CellLayout` 时一次性建好。`DESTRUCTIVE_REORDER=false`（默认）时重排只动 tmp 表；如果设 true 会直接破坏真实表，丧失撤销能力。

**3. 为什么 widget 的 markCells 要走 mapModelToPresenter？**
widget 的 `ItemInfo.cellX` 是模型坐标（可能因 RTL/双屏有 offset），而 `GridOccupancy` 是视图坐标。`markCellsAsOccupiedForView` 对 `LauncherAppWidgetHostView` 单独分支，先 `mapModelToPresenter` 得到展示坐标再标记，保证占位与视图一致。

---

## 四、CellLayout：单屏网格核心

> `CellLayout.java` 1993 行。注释原文：*"A ViewGroup that arranges its children in a grid."*

### 4.1 关键字段

```java
// CellLayout.java
@Thunk int mCellWidth;        // 单格宽（像素，onMeasure 算出）
@Thunk int mCellHeight;       // 单格高
protected Point mBorderSpace; // 格子间距 (x, y)
protected int mCountX;        // 列数 = deviceProfile.inv.numColumns
protected int mCountY;        // 行数 = deviceProfile.inv.numRows

protected GridOccupancy mOccupied;     // 真实占位
public GridOccupancy mTmpOccupied;     // 临时占位

@ContainerType private final int mContainerType;  // WORKSPACE=0 / HOTSEAT=1 / FOLDER=2
protected final ShortcutAndWidgetContainer mShortcutsAndWidgets;  // 唯一子节点

public final int[] mDirectionVector = new int[2];          // 重排推开方向 {-1,0,1}²
ItemConfiguration mPreviousSolution = null;                // 缓存上次重排解
final ArrayMap<CellLayoutLayoutParams, Animator> mReorderAnimators;       // 真挪位动画
final ArrayMap<Reorderable, ReorderPreviewAnimation> mShakeAnimators;     // 抖动预览
```

构造时一次性建好两套表、唯一子容器：

```java
// CellLayout.java 构造
mCountX = deviceProfile.inv.numColumns;
mCountY = deviceProfile.inv.numRows;
mOccupied =  new GridOccupancy(mCountX, mCountY);
mTmpOccupied = new GridOccupancy(mCountX, mCountY);
// ...
mShortcutsAndWidgets = new ShortcutAndWidgetContainer(context, mContainerType);
mShortcutsAndWidgets.setCellDimensions(mCellWidth, mCellHeight, mCountX, mCountY, mBorderSpace);
addView(mShortcutsAndWidgets);   // CellLayout 的唯一子节点
```

### 4.2 addViewToCellLayout：图标入屏的唯一入口

```java
// CellLayout.java
public boolean addViewToCellLayout(View child, int index, int childId,
        CellLayoutLayoutParams params, boolean markCells) {
    final CellLayoutLayoutParams lp = params;

    // Hotseat 图标隐藏文字
    if (child instanceof BubbleTextView) {
        ((BubbleTextView) child).setTextVisibility(mContainerType != HOTSEAT);
    }
    child.setScaleX(DEFAULT_SCALE);
    child.setScaleY(DEFAULT_SCALE);

    // 坐标必须在网格范围内
    if (lp.getCellX() >= 0 && lp.getCellX() <= mCountX - 1
            && lp.getCellY() >= 0 && lp.getCellY() <= mCountY - 1) {
        if (lp.cellHSpan < 0) lp.cellHSpan = mCountX;  // -1 = 铺满整行（QSB）
        if (lp.cellVSpan < 0) lp.cellVSpan = mCountY;  // -1 = 铺满整列

        child.setId(childId);
        mShortcutsAndWidgets.addView(child, index, lp);    // ★ 加入容器（不立即定位）
        if (markCells) markCellsAsOccupiedForView(child);  // ★ 标占位
        return true;
    }
    return false;   // 越界，拒绝
}
```

设计要点：`addViewToCellLayout` 只负责"加进树 + 标占位"，**真正的像素定位发生在下一次 `onMeasure/onLayout`**。`markCells=false` 的特例是 `Folder`——文件夹自己管内部占位，外层只占 1×1。

### 4.3 onMeasure：单格尺寸的诞生

```java
// CellLayout.java
@Override
protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
    int widthSize = MeasureSpec.getSize(widthMeasureSpec);
    int heightSize = MeasureSpec.getSize(heightMeasureSpec);
    int childWidthSize = widthSize - (getPaddingLeft() + getPaddingRight());   // 扣 padding
    int childHeightSize = heightSize - (getPaddingTop() + getPaddingBottom());

    if (mFixedCellWidth < 0 || mFixedCellHeight < 0) {   // 非固定尺寸才重算
        int cw = DeviceProfile.calculateCellWidth(childWidthSize, mBorderSpace.x, mCountX);
        int ch = DeviceProfile.calculateCellHeight(childHeightSize, mBorderSpace.y, mCountY);
        if (cw != mCellWidth || ch != mCellHeight) {
            mCellWidth = cw; mCellHeight = ch;
            mShortcutsAndWidgets.setCellDimensions(mCellWidth, mCellHeight, mCountX, mCountY,
                    mBorderSpace);   // ★尺寸变化同步给子容器
        }
    }
    mShortcutsAndWidgets.measure(
            MeasureSpec.makeMeasureSpec(childWidthSize, MeasureSpec.EXACTLY),
            MeasureSpec.makeMeasureSpec(childHeightSize, MeasureSpec.EXACTLY));
    setMeasuredDimension(widthSize, heightSize);
}
```

`calculateCellWidth/Height` 是网格尺寸基石：

```java
// DeviceProfile.java
public static int calculateCellWidth(int width, int borderSpacing, int countX) {
    return (width - ((countX - 1) * borderSpacing)) / countX;   // (可用 − N×间距) / N
}
public static int calculateCellHeight(int height, int borderSpacing, int countY) {
    return (height - ((countY - 1) * borderSpacing)) / countY;
}
```

单格 = (可用尺寸 − (列数−1)×间距) / 列数，整除下取整。余数由 `getUnusedHorizontalSpace()` 在 `onLayout` 里居中吸收：

```java
// CellLayout.java
public int getUnusedHorizontalSpace() {
    return getMeasuredWidth() - getPaddingLeft() - getPaddingRight() - (mCountX * mCellWidth)
            - ((mCountX - 1) * mBorderSpace.x);
}
@Override
protected void onLayout(boolean changed, int l, int t, int r, int b) {
    int left = getPaddingLeft() + (int) Math.ceil(getUnusedHorizontalSpace() / 2f); // 余数居中
    int right = r - l - getPaddingRight() - (int) Math.ceil(getUnusedHorizontalSpace() / 2f);
    int top = getPaddingTop();
    int bottom = b - t - getPaddingBottom();
    mShortcutsAndWidgets.layout(left, top, right, bottom);   // 子容器整体居中摆放
}
```

### 4.4 三个 MODE 常量：重排的指挥棒

```java
// CellLayout.java
public static final int MODE_SHOW_REORDER_HINT = 0;     // 轻预览：图标抖动 hint
public static final int MODE_DRAG_OVER = 1;             // 真正推开：图标挪位动画
public static final int MODE_ON_DROP = 2;               // 落地：commitTempPlacement + 写库
public static final int MODE_ON_DROP_EXTERNAL = 3;      // 外部拖来（AllApps→桌面）落地
public static final int MODE_ACCEPT_DROP = 4;           // 仅测试能否放下，不动画
private static final boolean DESTRUCTIVE_REORDER = false; // 重排是否破坏真实表
public static final int REORDER_ANIMATION_DURATION = 150; // 挪位动画时长 ms
public static final float REORDER_PREVIEW_MAGNITUDE = 0.12f; // 抖动幅度系数
```

### 面试深问

**1. addViewToCellLayout 为什么返回 boolean，调用方失败会怎样？**
坐标越界（cellX≥countX）会返回 false。`addInScreen` 收到 false 只打 Log，不抛异常——这是防御设计：数据库脏数据（错坐标）不应让 Launcher 崩溃，宁可视图缺失也不要 crash。

**2. mFixedCellWidth 什么时候 ≥ 0？**
Hotseat 调 `setCellDimensions(width, height)` 会同时设 `mFixedCellWidth/Height`，之后 onMeasure 不再重算——Hotseat 的格子尺寸由 DeviceProfile 直接给定，不让 CellLayout 自己均分。

**3. DESTRUCTIVE_REORDER 为什么默认 false？**
true 会让重排直接改 `mOccupied` 真实表，拖拽中途取消无法回滚。false 时只改 tmp 表，`onDragExit` 调 `revertTempState` 立即还原，用户体验安全。

---

## 五、ShortcutAndWidgetContainer：图标真正落脚处

> `ShortcutAndWidgetContainer.java` 346 行。注释原文：*"Core logic to layout a child for this ViewGroup."*

### 5.1 measureChild：调 setup() + 加居中 padding

```java
// ShortcutAndWidgetContainer.java
public void measureChild(View child) {
    CellLayoutLayoutParams lp = (CellLayoutLayoutParams) child.getLayoutParams();
    final DeviceProfile dp = mActivity.getDeviceProfile();

    if (child instanceof NavigableAppWidgetHostView) {
        // widget：按 appWidgetScale 缩放
        final PointF appWidgetScale = dp.getAppWidgetScale((ItemInfo) child.getTag());
        lp.setup(mCellWidth, mCellHeight, invertLayoutHorizontally(), mCountX, mCountY,
                appWidgetScale.x, appWidgetScale.y, mBorderSpace, dp.widgetPadding);
    } else if (isChildQsb(child)) {
        // QSB：不加 padding（Smartspace/QsbContainerView 自管尺寸）
        lp.setup(mCellWidth, mCellHeight, invertLayoutHorizontally(), mCountX, mCountY, mBorderSpace);
    } else {
        // 普通图标/文件夹：算居中 padding
        lp.setup(mCellWidth, mCellHeight, invertLayoutHorizontally(), mCountX, mCountY, mBorderSpace);
        int cHeight = getCellContentHeight();   // 图标内容高度
        int cellPaddingY = dp.getWorkspaceIconProfile().getCellYPaddingPx() >= 0
                && mContainerType == WORKSPACE
                    ? dp.getWorkspaceIconProfile().getCellYPaddingPx()
                    : (int) Math.max(0, ((lp.height - cHeight) / 2f));   // 纵向居中
        boolean noPaddingX = /* borderSpace 存在时不加横向 padding */;
        int cellPaddingX = noPaddingX ? 0 : /* edgeMargin/2 */;
        child.setPadding(cellPaddingX, cellPaddingY, cellPaddingX, 0);
    }
    // 用 setup() 算出的尺寸 EXACTLY 测量
    child.measure(
        MeasureSpec.makeMeasureSpec(lp.width, MeasureSpec.EXACTLY),
        MeasureSpec.makeMeasureSpec(lp.height, MeasureSpec.EXACTLY));
}
```

### 5.2 layoutChild：把图标摆到像素位置

```java
// ShortcutAndWidgetContainer.java
public void layoutChild(View child) {
    CellLayoutLayoutParams lp = (CellLayoutLayoutParams) child.getLayoutParams();
    if (child instanceof NavigableAppWidgetHostView) {
        // widget：scaleToFit + 居中平移
        DeviceProfile profile = mActivity.getDeviceProfile();
        final PointF appWidgetScale = profile.getAppWidgetScale((ItemInfo) child.getTag());
        nahv.setScaleToFit(Math.min(appWidgetScale.x, appWidgetScale.y));
        nahv.getTranslateDelegate().setTranslation(INDEX_WIDGET_CENTERING,
                -(lp.width - (lp.width * scaleX)) / 2.0f,
                -(lp.height - (lp.height * scaleY)) / 2.0f);
    }

    int childLeft = lp.x;   // setup() 算出的像素 X
    int childTop = lp.y;
    child.layout(childLeft, childTop, childLeft + lp.width, childTop + lp.height);  // ★上屏

    // 气泡栏腾位：Hotseat 给每个图标额外 translationX
    if (mTranslationProvider != null) {
        final float tx = mTranslationProvider.getTranslationX(lp.getCellX());
        if (child instanceof Reorderable) {
            ((Reorderable) child).getTranslateDelegate()
                    .getTranslationX(INDEX_BUBBLE_ADJUSTMENT_ANIM).setValue(tx);
        } else {
            child.setTranslationX(tx);
        }
    }

    if (lp.dropped) {                       // 刚 drop，通知壁纸"有东西落下"
        lp.dropped = false;
        mWallpaperManager.sendWallpaperCommand(getWindowToken(),
                WallpaperManager.COMMAND_DROP,
                cellXY[0] + childLeft + lp.width / 2,
                cellXY[1] + childTop + lp.height / 2, 0, null);
    }
}
```

`dropped=true` 时发 `WallpaperManager.COMMAND_DROP`，让动态壁纸感知落点做特效——这是图标与壁纸的唯一交互点。

### 5.3 按 cellX/cellY 反查 child（带 span 命中）

```java
// ShortcutAndWidgetContainer.java
public View getChildAt(int cellX, int cellY) {
    final int count = getChildCount();
    for (int i = 0; i < count; i++) {
        View child = getChildAt(i);
        CellLayoutLayoutParams lp = (CellLayoutLayoutParams) child.getLayoutParams();
        // 命中条件：格子落在 [cellX, cellX+span) × [cellY, cellY+span) 内
        if ((lp.getCellX() <= cellX) && (cellX < lp.getCellX() + lp.cellHSpan)
                && (lp.getCellY() <= cellY) && (cellY < lp.getCellY() + lp.cellVSpan)) {
            return child;
        }
    }
    return null;
}
```

考虑了 span 的命中判断，2×2 widget 覆盖的 4 个格子都能反查到它。

### 面试深问

**1. measureChild 为什么对 widget/图标/QSB 分三路？**
widget 要 scaleToFit 缩放（minCellSize < cellSize）；图标要在比它大的格子里居中（用 padding 补差）；QSB 自管尺寸不加 padding。三套尺寸策略差异大，分流处理比统一公式清晰。

**2. 为什么 layoutChild 里用 `child.layout()` 而不是改 translationX？**
`layout()` 改的是 View 的固有位置（mLeft/mTop），translationX 是绘制偏移。重排动画用 translationX 平滑过渡（不动 layout 位置），动画结束才 `requestLayout()` 真正改 layout 位置——这样动画期间其他 View 不会被错误触发重新布局。

**3. INDEX_BUBBLE_ADJUSTMENT_ANIM 这个 index 干嘛的？**
气泡栏出现时挤压 Hotseat 图标，每个图标按 `getTranslationX(cellX)` 加额外平移。用 MultiTranslateDelegate 的独立 index 通道，让气泡栏平移与重排预览平移（INDEX_REORDER_PREVIEW_OFFSET）互不干扰，可叠加。

---

## 六、Workspace：多屏管理

> `Workspace.java` 3675 行，继承 `Workspace<T> extends PagedView<T>`。

### 6.1 screenId ↔ 页索引的双向映射

Workspace 内部维护**两套屏幕标识**：

```java
// Workspace.java
public final IntSparseArrayMap<CellLayout> mWorkspaceScreens = new IntSparseArrayMap<>(); // screenId → CellLayout
final IntArray mScreenOrder = new IntArray();   // screenId 的有序列表（按页顺序）
```

为什么不能直接用页索引（index）当 screenId？因为 **screenId 持久化在数据库 Favorites.screen，且可稀疏**。删屏后剩下的屏 screenId 不变，但页索引会重排。两套标识解耦后：删第 2 屏只需 `mScreenOrder.removeValue(2)`，不用改其他屏的 screenId，数据库零迁移。

特殊 screenId（`WorkspaceLayoutManager` 接口）：

```java
// WorkspaceLayoutManager.java
int EXTRA_EMPTY_SCREEN_ID        = -201;  // 末尾动态空屏，拖拽时出现
int EXTRA_EMPTY_SCREEN_SECOND_ID = -200;  // 折叠屏双屏时的第二个空屏
IntSet EXTRA_EMPTY_SCREEN_IDS = IntSet.wrap(EXTRA_EMPTY_SCREEN_ID, EXTRA_EMPTY_SCREEN_SECOND_ID);
int FIRST_SCREEN_ID              = 0;     // 第一屏，永不可删
```

核心转换方法：

```java
// Workspace.java
public CellLayout getScreenWithId(int screenId) { return mWorkspaceScreens.get(screenId); }

public int getPageIndexForScreenId(int screenId) {
    return indexOfChild(mWorkspaceScreens.get(screenId));   // screenId → 页索引
}
public int getCellLayoutId(CellLayout layout) {
    int index = mWorkspaceScreens.indexOfValue(layout);
    return index != -1 ? mWorkspaceScreens.keyAt(index) : -1;  // CellLayout → screenId
}
public int getCellLayoutIndex(CellLayout cellLayout) {
    return indexOfChild(mWorkspaceScreens.get(getCellLayoutId(cellLayout)));
}
```

注意 `getPageIndexForScreenId` 用 `indexOfChild(layout)` 而非 `mScreenOrder.indexOf(screenId)`——前者查 View 树真实位置，更可靠。

### 6.2 屏的创建：insertNewWorkspaceScreen

```java
// Workspace.java
public CellLayout insertNewWorkspaceScreen(int screenId, int insertIndex) {
    if (mWorkspaceScreens.containsKey(screenId)) {
        throw new RuntimeException("Screen id " + screenId + " already exists!");
    }
    DeviceProfile dp = mLauncher.getDeviceProfile();
    CellLayout newScreen;
    if (FOLDABLE_SINGLE_PAGE.get() && dp.getDeviceProperties().isTwoPanels()) {
        newScreen = (CellLayout) LayoutInflater.from(getContext()).inflate(
                R.layout.workspace_screen_foldable, this, false);
    } else {
        newScreen = (CellLayout) LayoutInflater.from(getContext()).inflate(
                R.layout.workspace_screen, this, false);   // inflate 但不 attach
    }
    newScreen.setCellLayoutContainer(this);   // ★建立反向回调通道

    mWorkspaceScreens.put(screenId, newScreen);
    mScreenOrder.add(insertIndex, screenId);
    addView(newScreen, insertIndex);          // ★加入 PagedView children
    mStateTransitionAnimation.applyChildState(
            mLauncher.getStateManager().getState(), newScreen, insertIndex);

    updatePageScrollValues();   // 重算每页 scrollX
    updateCellLayoutMeasures();
    return newScreen;
}
```

### 6.3 拖拽时动态加空屏：addExtraEmptyScreenOnDrag

```java
// Workspace.java
private void addExtraEmptyScreenOnDrag(DragObject dragObject) {
    boolean lastChildOnScreen = false, childOnFinalScreen = false;
    if (mDragSourceInternal != null) {
        int dragSourceChildCount = mDragSourceInternal.getChildCount();
        // 折叠屏要把配对页的图标也算进去
        if (isTwoPanelEnabled() && !(mDragSourceInternal.getParent() instanceof Hotseat)) {
            int pagePairScreenId = getScreenPair(/* ... */);
            CellLayout pagePair = mWorkspaceScreens.get(pagePairScreenId);
            dragSourceChildCount += pagePair.getShortcutsAndWidgets().getChildCount();
        }
        // widget 拖动时已脱离原 parent，补 +1
        if (dragObject.dragView.getContentView() instanceof LauncherAppWidgetHostView) {
            dragSourceChildCount++;
        }
        if (dragSourceChildCount == 1) lastChildOnScreen = true;
        // ...
        if (/* 在最后一屏 */) childOnFinalScreen = true;
    }
    // 若被拖项是最后一屏的唯一图标，不再加空屏（避免出现连续两空屏）
    if (lastChildOnScreen && childOnFinalScreen) return;

    forEachExtraEmptyPageId(extraEmptyPageId -> {
        if (!mWorkspaceScreens.containsKey(extraEmptyPageId)) {
            insertNewWorkspaceScreen(extraEmptyPageId);   // 插入 EXTRA_EMPTY_SCREEN_ID
        }
    });
}
```

### 6.4 空屏清理：stripEmptyScreens / convertFinalScreenToEmptyScreenIfNecessary

判定能否删：

```java
// Workspace.java
private boolean canRemoveEmptyScreen(int screenId, CellLayout screen) {
    return screenId > FIRST_SCREEN_ID                    // 第一屏永不可删
            && screen.getShortcutsAndWidgets().getChildCount() == 0   // 无图标
            && !screen.isDropPending();                  // 无 pending drop
}
```

`removeExtraEmptyScreenDelayed` 先删 EXTRA_EMPTY_SCREEN_IDS（动态空屏），再按 `stripEmptyScreens=true` 决定是否扫所有空屏。`convertFinalScreenToEmptyScreenIfNecessary` 把"最后一屏恰好空"复用为 EXTRA_EMPTY_SCREEN：移出 `mWorkspaceScreens`/`mScreenOrder`，改 screenId 为 -201 再加回，避免下次拖拽重新 inflate。

提交空屏为新页时分配真实 screenId：

```java
// Workspace.java commitExtraEmptyScreen
private int commitExtraEmptyScreen(int emptyScreenId) {
    CellLayout cl = mWorkspaceScreens.get(emptyScreenId);
    mWorkspaceScreens.remove(emptyScreenId);
    mScreenOrder.removeValue(emptyScreenId);
    // 从 DB 拿新 screenId，跳过已存在的
    int newScreenId = LauncherAppState.getInstance(getContext())
            .getModel().getModelDbController().getNewScreenId();
    while (mWorkspaceScreens.containsKey(newScreenId)) newScreenId++;
    mWorkspaceScreens.put(newScreenId, cl);
    mScreenOrder.add(newScreenId);
    return newScreenId;
}
```

### 面试深问

**1. 为什么 EXTRA_EMPTY_SCREEN_ID 是负数 -201？**
正常 screenId 从 0 开始递增，永远非负。负数确保空屏 id 与真实屏 id 不冲突，`EXTRA_EMPTY_SCREEN_IDS.contains(screenId)` 可一眼识别。`addInScreen` 还显式抛异常防止误往空屏加图标。

**2. dragSourceChildCount 为什么要 +1 widget？**
widget 拖动时其 View 被 `detachContentView` 转交给 DragView，原 `ShortcutAndWidgetContainer` 的 childCount 已 -1。判定"是否最后一屏唯一图标"必须补回这 1，否则误判会加多余空屏。

**3. commitExtraEmptyScreen 为什么不直接复用 -201 当真实 id？**
-201 是内存占位符，数据库不知道它。落库时必须分配真实正数 id（`getNewScreenId`），否则 DB 重启后这条记录的 screen=-201 无法对应任何屏。

---

## 七、addInScreen：图标落屏总入口

`WorkspaceLayoutManager` 接口（`Workspace` 实现）的 `addInScreen` 是**所有图标进入屏幕的唯一通道**——首次 bind、拖拽移动、外部拖入都走它。

```java
// WorkspaceLayoutManager.java
default void addInScreen(View child, int container, int screenId, int x, int y,
        int spanX, int spanY) {
    if (container == LauncherSettings.Favorites.CONTAINER_DESKTOP) {
        if (getScreenWithId(screenId) == null) {
            Log.e(TAG, "Skipping child, screenId " + screenId + " not found");
            new Throwable().printStackTrace();   // 调试用堆栈
            return;   // 防御：屏不存在直接跳过
        }
    }
    if (EXTRA_EMPTY_SCREEN_IDS.contains(screenId)) {
        throw new RuntimeException("Screen id should not be extra empty screen: " + screenId);
    }

    final CellLayout layout;
    if (container == CONTAINER_HOTSEAT || container == CONTAINER_HOTSEAT_PREDICTION) {
        layout = getHotseat();                       // ★ Hotseat 走自己
        if (child instanceof FolderIcon) ((FolderIcon) child).setTextVisible(false);
    } else {
        if (child instanceof FolderIcon) ((FolderIcon) child).setTextVisible(true);
        layout = getScreenWithId(screenId);          // ★ 桌面屏按 screenId 找
    }

    // 构造或复用 LayoutParams
    ViewGroup.LayoutParams genericLp = child.getLayoutParams();
    CellLayoutLayoutParams lp;
    if (genericLp == null || !(genericLp instanceof CellLayoutLayoutParams)) {
        lp = new CellLayoutLayoutParams(x, y, spanX, spanY);   // 新建
    } else {
        lp = (CellLayoutLayoutParams) genericLp;               // 复用（拖拽移动时）
        lp.setCellX(x); lp.setCellY(y);
        lp.cellHSpan = spanX; lp.cellVSpan = spanY;
    }
    if (spanX < 0 && spanY < 0) lp.isLockedToGrid = false;     // QSB 自由坐标

    int childId = ((ItemInfo) child.getTag()).getViewId();     // 用 ItemInfo 当唯一 id
    boolean markCellsAsOccupied = !(child instanceof Folder);  // 文件夹自管占位
    layout.addViewToCellLayout(child, -1, childId, lp, markCellsAsOccupied);  // ★第四章入口

    child.setHapticFeedbackEnabled(false);
    child.setOnLongClickListener(getWorkspaceChildOnLongClickListener()); // 长按进拖拽
    if (child instanceof DropTarget) onAddDropTarget((DropTarget) child);
}
```

bind 时的封装 `addInScreenFromBind` 多做一步坐标映射：

```java
// WorkspaceLayoutManager.java
default void addInScreenFromBind(View child, ItemInfo info) {
    CellPos presenterPos = getCellPosMapper().mapModelToPresenter(info); // 模型→视图坐标
    int x = presenterPos.cellX, y = presenterPos.cellY;
    if (info.container == CONTAINER_HOTSEAT || info.container == CONTAINER_HOTSEAT_PREDICTION) {
        // Hotseat 用 rank(screenId) 转 cellX/cellY
        x = getHotseat().getCellXFromOrder(presenterPos.screenId);
        y = getHotseat().getCellYFromOrder(presenterPos.screenId);
    }
    addInScreen(child, info.container, presenterPos.screenId, x, y, info.spanX, info.spanY);
}
```

`CellPosMapper` 处理模型坐标↔视图坐标的转换（RTL、双屏 offset）：

```java
// celllayout/CellPosMapper.java
public CellPos mapModelToPresenter(ItemInfo info) {
    return new CellPos(info.cellX, info.cellY, info.screenId);  // 默认 1:1
}
// 双屏特化：奇数 screenId 的 cellX += columnCount，把右屏坐标平移到双倍宽
public static class TwoPanelCellPosMapper extends CellPosMapper {
    public CellPos mapModelToPresenter(ItemInfo info) {
        if (info.container != CONTAINER_DESKTOP || (info.screenId % 2) == 0)
            return super.mapModelToPresenter(info);
        return new CellPos(info.cellX + mColumnCount, info.cellY, info.screenId - 1);
    }
}
```

### 面试深问

**1. addInScreen 为什么用 `ItemInfo.getViewId()` 当 childId？**
`ItemInfo` 是图标的"身份证"，`getViewId()` 把 id、container、cellX 编码成一个唯一整数（假设网格 ≤256×256）。childId 用于 `setId(childId)`，Accessibility、动画查找都靠它定位，比每次遍历 child 快。

**2. 为什么 Folder 的 markCells=false？**
Folder 在外层只占 1×1 格子，但内部有 N 个图标。若外层标占位、内部也标会冲突，所以 Folder 自己管内部 GridOccupancy，外层 `addViewToCellLayout` 跳过标占位，由 FolderIcon 自己负责。

**3. TwoPanelCellPosMapper 为什么把 screenId-1？**
双屏物理上是 2 个 screenId 并排显示，但视图层合并成 1 个超宽 CellLayout。模型层 screenId=1（右屏）的图标，视图层要放到合并屏的右半区（cellX += columns），并把 screenId 改成 0（左屏 id）以匹配合并后的 CellLayout。

---

## 八、Hotseat：底部固定栏

> `Hotseat.java` 413 行。`public class Hotseat extends CellLayout implements Insettable`

### 8.1 为什么 Hotseat 复用 CellLayout

Hotseat **本质上是一个被压扁成一行的 CellLayout**。复用而非独立实现，省掉一整套网格/占位/重排逻辑：

```java
// Hotseat.java
public void resetLayout(boolean hasVerticalHotseat) {
    // ...
    removeAllViewsInLayout();
    mHasVerticalHotseat = hasVerticalHotseat;
    DeviceProfile dp = mActivity.getDeviceProfile();

    if (bubbleBarEnabled && dp.shouldAdjustHotseatForBubbleBar(getContext(), hasBubbles)) {
        getShortcutsAndWidgets().setTranslationProvider(           // 气泡栏腾位
                cellX -> dp.getHotseatAdjustedTranslation(getContext(), cellX));
    } else {
        getShortcutsAndWidgets().setTranslationProvider(null);
    }

    resetCellSize(dp);
    if (hasVerticalHotseat) {
        setGridSize(1, dp.numShownHotseatIcons);      // 横屏：竖排 N×1
    } else {
        setGridSize(dp.numShownHotseatIcons, 1);       // 竖屏：横排 1×N
    }
}
```

`setGridSize(countX, countY)` 直接复用 `CellLayout` 的 `mCountX/mCountY + mOccupied` 重置。所以 Hotseat 每个图标就是普通 `CellLayoutLayoutParams`，只是 `cellY` 恒为 0（竖屏）或 `cellX` 恒为 0（横屏）。

### 8.2 rank ↔ cell 坐标转换

Hotseat 图标在数据库里只有 `rank`（0,1,2...），存进 `Favorites.screen` 字段。转换：

```java
// Hotseat.java
public int getCellXFromOrder(int rank) {
    return mHasVerticalHotseat ? 0 : rank;          // 横屏 cellX=0；竖屏 cellX=rank
}
public int getCellYFromOrder(int rank) {
    return mHasVerticalHotseat ? (getCountY() - (rank + 1)) : 0;  // 横屏倒序排
}
```

反向（视图→模型）在 `CellPosMapper.mapPresenterToModel`：

```java
// celllayout/CellPosMapper.java
public CellPos mapPresenterToModel(int presenterX, int presenterY, int presenterScreen,
        int container) {
    if (container == Favorites.CONTAINER_HOTSEAT) {
        presenterScreen = mHasVerticalHotseat ? mNumOfHotseat - presenterY - 1 : presenterX;
    }
    return new CellPos(presenterX, presenterY, presenterScreen);
}
```

### 8.3 触摸事件透传给 Workspace

这是 Hotseat 最巧妙的设计——允许用户在 Hotseat 区域**横向滑动切换 Workspace 页面**：

```java
// Hotseat.java
@Override
public boolean onInterceptTouchEvent(MotionEvent ev) {
    // 允许从 Hotseat 内横向滑屏：委托 Workspace 判断是否接管
    int yThreshold = getMeasuredHeight() - getPaddingBottom();
    if (mWorkspace != null && ev.getY() <= yThreshold) {
        mSendTouchToWorkspace = mWorkspace.onInterceptTouchEvent(ev);
        return mSendTouchToWorkspace;
    }
    return false;
}
@Override
public boolean onTouchEvent(MotionEvent event) {
    if (mSendTouchToWorkspace) {
        if ((event.getAction() & MotionEvent.ACTION_MASK) == MotionEvent.ACTION_UP
                || (event.getAction() & MotionEvent.ACTION_MASK) == MotionEvent.ACTION_CANCEL) {
            mSendTouchToWorkspace = false;   // 手势结束，恢复自处理
        }
        return mWorkspace.onTouchEvent(event);   // 整条手势流交给 Workspace 翻页
    }
    return false;
}
```

机制：`onInterceptTouchEvent` 时问 Workspace 要不要接管；要的话 `mSendTouchToWorkspace=true`，后续 `onTouchEvent` 全部转发给 Workspace，直到 UP/CANCEL 复位。这样 Hotseat 既是图标容器又是 Workspace 的"触摸延伸区"。

### 8.4 QSB（搜索框）与气泡栏腾位

```java
// Hotseat.java 构造
mQsb = LayoutInflater.from(context).inflate(
        Flags.enableQsbOnHotseat() ? R.layout.qsb_container_hotseat : R.layout.search_container_hotseat,
        this, false);
addView(mQsb);   // ★QSB 直接 addView，不走 ShortcutAndWidgetContainer 格子
```

QSB 在 `onLayout` 里独立摆放（内联或居中）：

```java
// Hotseat.java onLayout
if (dp.isQsbInline) {
    left = Utilities.isRtl(getResources()) ? r - getPaddingRight() + qsbSpace
            : l + getPaddingLeft() - qsbMeasuredWidth - qsbSpace;   // 内联在图标左侧
} else {
    left = (r - l - qsbMeasuredWidth) / 2;   // 居中
}
```

气泡栏（BubbleBar）出现时挤压 Hotseat，靠 `TranslationProvider` 给每个图标加额外 translationX，动态让位——这就是 `getTranslationXForCell` 在 Hotseat 的重写。

### 面试深问

**1. Hotseat 横屏为什么 cellY 倒序（`countY - rank - 1`）？**
横屏 Hotseat 在屏幕右侧竖排，视觉上从上到下是 rank 0→N。但坐标系 Y 轴向下递增，所以 rank 0 要放在最下方（cellY = countY-1），rank 越大 cellY 越小（越靠上），与竖屏"左到右 rank 递增"的视觉方向一致。

**2. mSendTouchToWorkspace 为什么在 UP 时复位，不在 MOVE 时？**
一旦 Workspace 接管手势，整条 MOVE 流必须连续转发给它，中途断开会导致 PagedView 的 `mIsBeingDragged` 状态错乱、snap 判定异常。只有手势彻底结束（UP/CANCEL）才复位，保证手势完整性。

**3. Hotseat 的图标为什么 setTextVisibility(false)？**
底部栏空间紧凑，文字会与 QSB、导航条争抢垂直空间。`addViewToCellLayout` 里 `mContainerType != HOTSEAT` 时隐藏文字，让 Hotseat 只显示图标位图，视觉更干净。

---

## 九、PagedView：滑动与翻页基类

> `PagedView.java` 2026 行。`public abstract class PagedView<T extends View & PageIndicator> extends ViewGroup`
> 注释：*"An abstraction of the original Workspace which supports browsing through a sequential list of 'pages'."*

Workspace 的全部翻页能力来自这里。这是 Launcher 自实现的分页容器（非 ViewPager），为精细控制 snap、overscroll、缩放。

### 9.1 核心状态字段

```java
// PagedView.java
private static final float RETURN_TO_ORIGINAL_PAGE_THRESHOLD = 0.33f;  // 位移>33% 且反向飞→回原页
private static final float SIGNIFICANT_MOVE_THRESHOLD = 0.4f;           // 位移>40% 视为大移动
private static final float MAX_SCROLL_PROGRESS = 1.0f;

protected int mCurrentPage;              // snap 完成后的当前页
protected int mNextPage = INVALID_PAGE;  // 正在飞向的目标页（动画中）
protected int mMaxScroll, mMinScroll;    // 滚动边界（像素）
protected OverScroller mScroller;        // 驱动 snap 动画的滚动器
private VelocityTracker mVelocityTracker;// 测手指速度，决定 fling
protected int mTouchSlop;                // 判定"开始拖"的位移阈值
protected int mPageSlop;                 // 判定"翻页"的阈值（比 touchSlop 大）
private int mFlingThresholdVelocity;     // 速度>此值才算 fling（来自 dimen）
private int mMinSnapVelocity;            // snap 动画最低速度（来自 dimen）
@Nullable protected int[] mPageScrolls = null;  // ★每页应停的 scrollX（onLayout 算出）
protected boolean mIsRtl;
```

### 9.2 mPageScrolls：每页该停在哪儿

`onLayout` 调 `getPageScrolls` 为每页算"把它放到屏幕左边需要的 scrollX"：

```java
// PagedView.java
protected boolean getPageScrolls(int[] outPageScrolls, boolean layoutChildren,
        ComputePageScrollsLogic scrollLogic) {
    final int childCount = getChildCount();
    final int startIndex = mIsRtl ? childCount - 1 : 0;
    final int endIndex = mIsRtl ? -1 : childCount;
    final int delta = mIsRtl ? -1 : 1;

    final int pageCenter = mOrientationHandler.getCenterForPage(this, mInsets);
    final int scrollOffsetStart = mOrientationHandler.getScrollOffsetStart(this, mInsets);
    final int scrollOffsetEnd = mOrientationHandler.getScrollOffsetEnd(this, mInsets);
    int panelCount = getPanelCount();

    for (int i = startIndex, childStart = scrollOffsetStart; i != endIndex; i += delta) {
        final View child = getPageAt(i);
        if (scrollLogic.shouldIncludeView(child)) {
            ChildBounds bounds = mOrientationHandler.getChildBounds(child, childStart,
                pageCenter, layoutChildren);
            // 非 RTL：pageScroll = 页左缘 − 内容区左缘
            final int pageScroll = mIsRtl
                    ? bounds.childPrimaryEnd - scrollOffsetEnd
                    : childStart - scrollOffsetStart;
            // 双屏只在最左可见页更新，其余页复用同值
            if (outPageScrolls[i] != pageScroll
                    && (panelCount <= 1 || i == getLeftmostVisiblePageForIndex(i))) {
                outPageScrolls[i] = pageScroll;
            }
            childStart += bounds.primaryDimension + getChildGap(i, i + delta);
            // 双屏只在右页后加 mPageSpacing
            int lastPanel = mIsRtl ? 0 : panelCount - 1;
            if (i % panelCount == lastPanel) childStart += mPageSpacing;
        }
    }
    if (panelCount > 1) {
        // 多屏：所有同屏页用最左页的 scroll
        for (int i = 0; i < childCount; i++) {
            int adjustedScroll = outPageScrolls[getLeftmostVisiblePageForIndex(i)];
            outPageScrolls[i] = adjustedScroll;
        }
    }
    return pageScrollChanged;
}
```

之后 `getScrollForPage(index)` 直接返回 `mPageScrolls[index]`，snap/滚动计算全靠它。`updateMinAndMaxScrollX` 设 `mMinScroll=0`、`mMaxScroll=mPageScrolls[最后一页]`，`scrollTo` 被钳在此范围。

### 9.3 onTouchEvent 完整流程：DOWN→MOVE→UP

**① onInterceptTouchEvent + determineScrollingStart**：判定是否接管手势开始横向滚动。

```java
// PagedView.java
protected void determineScrollingStart(MotionEvent ev, float touchSlopScale) {
    final int pointerIndex = ev.findPointerIndex(mActivePointerId);
    if (pointerIndex == -1) return;
    final float primaryDirection = mOrientationHandler.getPrimaryDirection(ev, pointerIndex);
    final int diff = (int) Math.abs(primaryDirection - mLastMotion);
    final int touchSlop = Math.round(touchSlopScale * mTouchSlop);
    boolean moved = diff > touchSlop || ev.getAction() == ACTION_MOVE_ALLOW_EASY_FLING;

    if (moved) {
        mIsBeingDragged = true;                          // ★超过 slop 进入拖拽
        mTotalMotion += Math.abs(mLastMotion - primaryDirection);
        mLastMotion = (int) primaryDirection;
        pageBeginTransition();
        requestDisallowInterceptTouchEvent(true);        // 独占后续事件
    }
}
```

**② onTouchEvent ACTION_MOVE**：跟随手指实时滚动 + overscroll 回弹。

```java
// PagedView.java ACTION_MOVE（精简）
if (mIsBeingDragged) {
    int delta = mLastMotion - direction;                // 增量
    // ...
    delta /= mOrientationHandler.getPrimaryScale(this);
    mLastMotion = direction;
    if (delta != 0) {
        mOrientationHandler.setPrimary(this, VIEW_SCROLL_BY, delta);  // ★实时滚动
        if (mAllowOverScroll) {
            if (pulledToX < mMinScroll) mEdgeGlowLeft.onPullDistance(...);   // 越界回弹
            else if (pulledToX > mMaxScroll) mEdgeGlowRight.onPullDistance(...);
        }
    }
} else {
    determineScrollingStart(ev);                          // 还没进拖拽，继续判定
}
```

**③ onTouchEvent ACTION_UP**：松手，决定落在哪一页。这是 snap 策略精华：

```java
// PagedView.java ACTION_UP
int velocity = (int) mOrientationHandler.getPrimaryVelocity(velocityTracker, mActivePointerId);
float delta = primaryDirection - mDownMotionPrimary;     // 总位移
int pageOrientedSize = (int) (mOrientationHandler.getMeasuredSize(current)
        * mOrientationHandler.getPrimaryScale(this));
boolean isSignificantMove = isSignificantMove(Math.abs(delta), pageOrientedSize);
boolean passedSlop = mAllowEasyFling || mTotalMotion > mPageSlop;
boolean isFling = passedSlop && shouldFlingForVelocity(velocity);
boolean isDeltaLeft = mIsRtl ? delta > 0 : delta < 0;
boolean isVelocityLeft = mIsRtl ? velocity > 0 : velocity < 0;

if (!mFreeScroll) {
    // 大位移后又反向飞 → 回原页（避免误翻）
    boolean returnToOriginalPage = false;
    if (Math.abs(delta) > pageOrientedSize * RETURN_TO_ORIGINAL_PAGE_THRESHOLD &&
            Math.signum(velocity) != Math.signum(delta) && isFling) {
        returnToOriginalPage = true;
    }
    int finalPage;
    // 翻页判定：fling 优先于大位移
    if (((isSignificantMove && !isDeltaLeft && !isFling) || (isFling && !isVelocityLeft))
            && mCurrentPage > 0) {
        finalPage = returnToOriginalPage ? mCurrentPage : mCurrentPage - getPanelCount();
        runOnPageScrollsInitialized(() -> snapToPageWithVelocity(finalPage, velocity));
    } else if (((isSignificantMove && isDeltaLeft && !isFling) || (isFling && isVelocityLeft))
            && mCurrentPage < getChildCount() - 1) {
        finalPage = returnToOriginalPage ? mCurrentPage : mCurrentPage + getPanelCount();
        runOnPageScrollsInitialized(() -> snapToPageWithVelocity(finalPage, velocity));
    } else {
        runOnPageScrollsInitialized(this::snapToDestination);   // 回最近页
    }
}
```

`snapToPageWithVelocity` 根据手指速度算动画时长：

```java
// PagedView.java
protected boolean snapToPageWithVelocity(int whichPage, int velocity) {
    whichPage = validateNewPage(whichPage);
    int halfScreenSize = mOrientationHandler.getMeasuredSize(this) / 2;
    final int newLoc = getScrollForPage(whichPage);
    int delta = newLoc - mOrientationHandler.getPrimaryScroll(this);

    if (Math.abs(velocity) < mMinFlingVelocity) {
        return snapToPage(whichPage, getSnapAnimationDuration());  // 低速：固定时长
    }
    float distanceRatio = Math.min(1f, 1.0f * Math.abs(delta) / (2 * halfScreenSize));
    float distance = halfScreenSize + halfScreenSize * distanceInfluenceForSnapDuration(distanceRatio);
    velocity = Math.max(mMinSnapVelocity, Math.abs(velocity));
    int duration = 4 * Math.round(1000 * Math.abs(distance / velocity));  // ★速度越快时长越短
    return snapToPage(whichPage, delta, duration);
}
```

`distanceInfluenceForSnapDuration` 用正弦曲线让时长随距离非线性变化，避免短距离也拖很久。

**④ snapToPage**：启动 `OverScroller` 动画。

```java
// PagedView.java
protected boolean snapToPage(int whichPage, int delta, int duration, boolean immediate) {
    if (mFirstLayout) { setCurrentPage(whichPage); return false; }
    whichPage = validateNewPage(whichPage);
    mNextPage = whichPage;                                  // ★标记目标页
    awakenScrollBars(duration);
    if (immediate) duration = 0;
    else if (duration == 0) duration = Math.abs(delta);
    mScroller.startScroll(/* currentScroll */, delta, duration);
    invalidate();
    return true;
}
```

**⑤ computeScrollHelper**：每帧由 `computeScroll()` 调用，推进滚动，到达后落地。

```java
// PagedView.java
protected boolean computeScrollHelper() {
    if (mScroller.computeScrollOffset()) {
        int newPos = mScroller.getCurrX();
        mOrientationHandler.setPrimary(this, VIEW_SCROLL_TO, newPos);  // 每帧 scrollTo
        // overscroll 边界吸收
        if (mAllowOverScroll) {
            if (newPos < mMinScroll && oldPos >= mMinScroll) {
                mEdgeGlowLeft.onAbsorb((int) mScroller.getCurrVelocity());
                abortScrollerAnimation(false);
            } /* 右侧同理 */
        }
        invalidate();
        return true;
    } else if (mNextPage != INVALID_PAGE) {
        int prevPage = mCurrentPage;
        mCurrentPage = validateNewPage(mNextPage);   // ★动画结束，目标页升格为当前页
        mNextPage = INVALID_PAGE;
        notifyPageSwitchListener(prevPage);          // 通知 onPageSwitch（更新指示器）
        if (!mIsBeingDragged) pageEndTransition();
    }
    return false;
}
```

判定阈值汇总：

| 常量 | 值 | 含义 |
|------|----|----|
| `RETURN_TO_ORIGINAL_PAGE_THRESHOLD` | 0.33 | 位移>页宽 33% 且反向飞 → 回原页 |
| `SIGNIFICANT_MOVE_THRESHOLD` | 0.4 | 位移>页宽 40% 视为大移动（够翻页） |
| `mFlingThresholdVelocity` | dimen | 速度超此值才算 fling |
| `mMinSnapVelocity` | dimen | snap 动画最低速度（时长下限） |

### 9.4 双屏翻页（Two Panel / 折叠屏）

`getPanelCount()` 在 Workspace 重写：

```java
// Workspace.java
public int getPanelCount() { /* 返回 isTwoPanelEnabled() ? 2 : 1 */ }
// isTwoPanelEnabled() 依据 DeviceProperties.isTwoPanels
```

`DeviceProperties.isTwoPanels = isTablet && isMultiDisplay`（折叠屏展开态）。PagedView 所有翻页逻辑按 `getPanelCount()` 步进：`finalPage = mCurrentPage ± getPanelCount()`，并保证 `mCurrentPage` 永远是最左可见页（`getLeftmostVisiblePageForIndex`）。`getPageScrolls` 里双屏只在最左页存 scroll，同屏右页复用——折叠屏一次翻两屏，逻辑完全复用单屏代码。

### 面试深问

**1. 为什么 snap 判定 fling 优先于大位移？**
源码注释：*"a large move to the left and fling to the right will register as a fling to the right"*。用户可能大幅左移后改主意右飞，此时按飞的方向走更符合预期。fling 速度比位移更能反映用户最终意图。

**2. RETURN_TO_ORIGINAL_PAGE_THRESHOLD 解决什么误操作？**
用户拖了一半（>33%）又快速反向飞，若直接按"大位移翻页"会误翻。该阈值让这种"拖了又后悔"的手势回到原页，避免桌面被意外打乱。

**3. mNextPage 和 mCurrentPage 为什么要分开？**
动画期间 `mCurrentPage` 还是旧页（指示器、alpha 都基于它），`mNextPage` 是目标。`computeScrollHelper` 在动画结束时才 `mCurrentPage = mNextPage` 并通知监听器。分开后动画中途查询当前页得到的是稳定值，不会跳变。

---

## 十、ReorderAlgorithm：拖拽重排（难点）

拖一个图标到拥挤区，其他图标怎么"让开"——这是桌面布局最精彩的算法。

### 10.1 重排三层调度

```
Workspace.onDragOver (每帧)
    │  1. pointToCellExact 找最近格子
    │  2. 判定是否在 reorderRadius 内
    │  3. 立即算 MODE_SHOW_REORDER_HINT（轻预览）
    │  4. 设 650ms Alarm → ReorderAlarmListener
    ▼                       │ (650ms 后手指还停同格)
    CellLayout.performReorder ◀────── performReorder(MODE_DRAG_OVER)
        │
        │  调 ReorderAlgorithm.calculateReorder(像素坐标, span, dragView)
        ▼
    ReorderAlgorithm.calculateReorder
        │  ① dropInPlaceSolution()       — 目标格空？直接落
        │  ② findReorderSolution(decX)   — 推开/移动别的图标
        │  ③ closestEmptySpaceReorder()  — 找最近纯空位
        │  按面积/优先级挑一个返回 ItemConfiguration
        ▼
    ItemConfiguration (所有图标的新坐标集合)
        │
        ▼  回到 CellLayout.performReorder
    ① MODE_SHOW_REORDER_HINT → 只播抖动 hint（ReorderPreviewAnimation）
    ② MODE_DRAG_OVER         → animateItemsToSolution 真把图标挪开
    ③ MODE_ON_DROP           → commitTempPlacement 落库
```

### 10.2 三方案择优：calculateReorder

```java
// celllayout/ReorderAlgorithm.java
public ItemConfiguration calculateReorder(ReorderParameters reorderParameters) {
    getDirectionVectorForDrop(reorderParameters, mCellLayout.mDirectionVector); // 算推开方向

    ItemConfiguration dropInPlaceSolution = dropInPlaceSolution(reorderParameters);     // ① 原地落
    ItemConfiguration swapSolution = findReorderSolution(reorderParameters, true);      // ② 推开
    ItemConfiguration closestSpaceSolution = closestEmptySpaceReorder(reorderParameters); // ③ 找空位

    // 优先用"推开"方案；但若它需缩小被拖项且面积不如"找空位"，退而求其次
    if (swapSolution.isSolution && swapSolution.area() >= closestSpaceSolution.area()) {
        return swapSolution;
    } else if (closestSpaceSolution.isSolution) {
        return closestSpaceSolution;
    } else if (dropInPlaceSolution.isSolution) {
        return dropInPlaceSolution;
    }
    return null;
}
```

| 方案 | 方法 | 含义 |
|------|------|------|
| 原地落 | `dropInPlaceSolution` | 目标区域本就空，直接放，不动任何图标 |
| 找空位 | `closestEmptySpaceReorder` | 全屏找最近能容下的纯空位放下，不动其他图标（欧氏距离打分） |
| 推开重排 | `findReorderSolution` | 把挡路图标推走，必要时缩小被拖 widget 的 span，递归尝试 |

`area()` 是 `spanX * spanY`——优先保留被拖项原始尺寸。

### 10.3 dropInPlaceSolution 与 closestEmptySpaceReorder

```java
// celllayout/ReorderAlgorithm.java
public ItemConfiguration dropInPlaceSolution(ReorderParameters p) {
    int[] result = mCellLayout.findNearestAreaIgnoreOccupied(p.getPixelX(), p.getPixelY(),
            p.getSpanX(), p.getSpanY(), new int[2]);
    ItemConfiguration solution = new ItemConfiguration();
    mCellLayout.copyCurrentStateToSolution(solution);
    // 目标区域是否全空（排除被拖项自己）
    solution.isSolution = !isConfigurationRegionOccupied(
            new Rect(result[0], result[1], result[0] + p.getSpanX(), result[1] + p.getSpanY()),
            solution, p.getDragView());
    if (solution.isSolution) {
        solution.cellX = result[0]; solution.cellY = result[1];
        solution.spanX = p.getSpanX(); solution.spanY = p.getSpanY();
    }
    return solution;
}

public ItemConfiguration closestEmptySpaceReorder(ReorderParameters p) {
    ItemConfiguration solution = new ItemConfiguration();
    int[] result = new int[2], resultSpan = new int[2];
    mCellLayout.findNearestVacantArea(p.getPixelX(), p.getPixelY(), p.getMinSpanX(),
            p.getMinSpanY(), p.getSpanX(), p.getSpanY(), result, resultSpan);
    if (result[0] >= 0 && result[1] >= 0) {
        mCellLayout.copyCurrentStateToSolution(solution);
        solution.cellX = result[0]; solution.cellY = result[1];
        solution.spanX = resultSpan[0]; solution.spanY = resultSpan[1];
        solution.isSolution = true;
    }
    return solution;
}
```

### 10.4 findReorderSolution：递归 + 推开

```java
// celllayout/ReorderAlgorithm.java
public ItemConfiguration findReorderSolution(ReorderParameters p, int[] direction, boolean decX) {
    return findReorderSolutionRecursive(p.getPixelX(), p.getPixelY(), p.getMinSpanX(),
            p.getMinSpanY(), p.getSpanX(), p.getSpanY(), direction,
            p.getDragView(), decX, p.getSolution());
}

private ItemConfiguration findReorderSolutionRecursive(int pixelX, int pixelY, int minSpanX,
        int minSpanY, int spanX, int spanY, int[] direction, View dragView, boolean decX,
        ItemConfiguration solution) {
    mCellLayout.copyCurrentStateToSolution(solution);          // 当前状态拷进解
    mCellLayout.getOccupied().copyTo(mCellLayout.mTmpOccupied);

    int[] result = mCellLayout.findNearestAreaIgnoreOccupied(pixelX, pixelY, spanX, spanY, new int[2]);

    boolean success = rearrangementExists(result[0], result[1], spanX, spanY, direction,
            dragView, solution);
    if (!success) {
        // 当前 span 放不下，缩小 span 再试：先 spanX-1，再 spanY-1，交替递归
        if (spanX > minSpanX && (minSpanY == spanY || decX)) {
            return findReorderSolutionRecursive(pixelX, pixelY, minSpanX, minSpanY, spanX - 1,
                    spanY, direction, dragView, false, solution);
        } else if (spanY > minSpanY) {
            return findReorderSolutionRecursive(pixelX, pixelY, minSpanX, minSpanY, spanX,
                    spanY - 1, direction, dragView, true, solution);
        }
        solution.isSolution = false;
    } else {
        solution.isSolution = true;
        solution.cellX = result[0]; solution.cellY = result[1];
        solution.spanX = spanX; solution.spanY = spanY;
    }
    return solution;
}
```

### 10.5 rearrangementExists：三策略择优推开

```java
// celllayout/ReorderAlgorithm.java
private boolean rearrangementExists(int cellX, int cellY, int spanX, int spanY, int[] direction,
        View ignoreView, ItemConfiguration solution) {
    if (cellX < 0 || cellY < 0) return false;

    ArrayList<View> intersectingViews = new ArrayList<>();
    Rect occupiedRect = new Rect(cellX, cellY, cellX + spanX, cellY + spanY);
    // 标记被拖项的目标位置
    if (ignoreView != null) {
        CellAndSpan c = solution.map.get(ignoreView);
        if (c != null) { c.cellX = cellX; c.cellY = cellY; }
    }
    // 找出与目标区域相交的所有图标（按 cellX/cellY 排序保证确定性）
    Comparator<View> comparator = Comparator.comparing(
            (View v) -> ((CellLayoutLayoutParams) v.getLayoutParams()).getCellX())
        .thenComparing(v -> ((CellLayoutLayoutParams) v.getLayoutParams()).getCellY());
    List<View> views = solution.map.keySet().stream().sorted(comparator).collect(Collectors.toList());
    for (View child : views) {
        if (child == ignoreView) continue;
        CellAndSpan c = solution.map.get(child);
        r1.set(c.cellX, c.cellY, c.cellX + c.spanX, c.cellY + c.spanY);
        if (Rect.intersects(r0, r1)) {
            if (!((CellLayoutLayoutParams) child.getLayoutParams()).canReorder) {
                return false;   // ★撞到 AllApps 按钮/QSB，整方案失败
            }
            intersectingViews.add(child);
        }
    }
    solution.intersectingViews = intersectingViews;

    // 策略 1：尝试 push 推开（簇整体移，保持 push 机械感）
    if (attemptPushInDirection(intersectingViews, occupiedRect, direction, ignoreView, solution)) {
        return true;
    }
    // 策略 2：作为块整体移到别处空位（不要求 push 机械感）
    if (addViewsToTempLocation(intersectingViews, occupiedRect, direction, ignoreView, solution)) {
        return true;
    }
    // 策略 3：逐个图标各自找空位
    for (View v : intersectingViews) {
        if (!addViewToTempLocation(v, occupiedRect, direction, solution)) return false;
    }
    return true;
}
```

### 10.6 pushViewsToTempLocation：簇连锁推挤（核心）

这是最难的算法。把相交图标当"簇(cluster)"整体推，途中撞到新图标就并入簇继续推：

```java
// celllayout/ReorderAlgorithm.java
private boolean pushViewsToTempLocation(ArrayList<View> views, Rect rectOccupiedByPotentialDrop,
        int[] direction, View dragView, ItemConfiguration currentState) {
    ViewCluster cluster = new ViewCluster(mCellLayout, views, currentState);
    Rect clusterRect = cluster.getBoundingRect();
    int whichEdge, pushDistance;
    boolean fail = false;

    // 确定簇的"领先边"和需要推进的距离
    if (direction[0] < 0) {            // 向左推
        whichEdge = ViewCluster.LEFT;
        pushDistance = clusterRect.right - rectOccupiedByPotentialDrop.left;
    } else if (direction[0] > 0) {     // 向右推
        whichEdge = ViewCluster.RIGHT;
        pushDistance = rectOccupiedByPotentialDrop.right - clusterRect.left;
    } else if (direction[1] < 0) {     // 向上推
        whichEdge = ViewCluster.TOP;
        pushDistance = clusterRect.bottom - rectOccupiedByPotentialDrop.top;
    } else {                           // 向下推
        whichEdge = ViewCluster.BOTTOM;
        pushDistance = rectOccupiedByPotentialDrop.bottom - clusterRect.top;
    }
    if (pushDistance <= 0) return false;

    // 把簇内图标在 tmpOccupied 标为未占用（腾出推动空间）
    for (View v : views) {
        mCellLayout.mTmpOccupied.markCells(currentState.map.get(v), false);
    }
    currentState.save();   // 保存现场，失败可回滚

    // 按推动方向排序簇外图标（领先边先接触的先处理）
    cluster.sortConfigurationForEdgePush(whichEdge);

    while (pushDistance > 0 && !fail) {
        for (View v : currentState.sortedViews) {
            if (!cluster.views.contains(v) && v != dragView) {
                if (cluster.isViewTouchingEdge(v, whichEdge)) {   // 簇边缘碰到新图标
                    if (!((CellLayoutLayoutParams) v.getLayoutParams()).canReorder) {
                        fail = true;   // 撞到 AllApps 按钮，整方案废
                        break;
                    }
                    cluster.addView(v);                            // ★并入簇
                    mCellLayout.mTmpOccupied.markCells(currentState.map.get(v), false);
                }
            }
        }
        pushDistance--;
        cluster.shift(whichEdge, 1);   // ★整簇推进 1 格
    }

    boolean foundSolution = false;
    clusterRect = cluster.getBoundingRect();
    // 唯一校验：推完的簇是否完全在网格内
    if (!fail && clusterRect.left >= 0 && clusterRect.right <= mCellLayout.getCountX()
            && clusterRect.top >= 0 && clusterRect.bottom <= mCellLayout.getCountY()) {
        foundSolution = true;
    } else {
        currentState.restore();   // 失败回滚
    }
    // 簇内图标重新标占用
    for (View v : cluster.views) {
        mCellLayout.mTmpOccupied.markCells(currentState.map.get(v), true);
    }
    return foundSolution;
}
```

设计精髓：算法只需校验"推完的簇是否还在网格内"，因为每步 `shift(1)` 都检查 `isViewTouchingEdge` 并并入新图标，保证簇不会穿过任何图标（push 机械感）。`canReorder=false` 的图标（AllApps 按钮、QSB）是"墙"，撞到即失败。

`ViewCluster` 的边缘检测用 4 条 `IntArray`（leftEdge/rightEdge/topEdge/bottomEdge）记录簇在每行/列的精确边界——不是简单外接矩形，而是凹凸不规则形状的精确轮廓：

```kotlin
// celllayout/ViewCluster.kt
class ViewCluster(mCellLayout: CellLayout, views: ArrayList<View>, val config: ItemConfiguration) {
    private val leftEdge = IntArray(mCellLayout.countY)    // 每行最左 x
    private val rightEdge = IntArray(mCellLayout.countY)
    private val topEdge = IntArray(mCellLayout.countX)     // 每列最上 y
    private val bottomEdge = IntArray(mCellLayout.countX)

    fun isViewTouchingEdge(v: View?, whichEdge: Int): Boolean {
        // 检查 v 的某条边是否与簇的对应 edge 重合
    }
    fun shift(whichEdge: Int, delta: Int) {
        // 簇内所有 CellAndSpan 沿方向移 delta，重置 edge
    }
    companion object {
        const val LEFT = 1 shl 0; const val TOP = 1 shl 1
        const val RIGHT = 1 shl 2; const val BOTTOM = 1 shl 3
    }
}
```

### 10.7 方向向量 mDirectionVector

推开方向由 `getDirectionVectorForDrop` 计算：用被拖项视觉中心相对目标格中心的偏移，经 `atan` 量化为 `{-1,0,1}×{-1,0,1}`：

```java
// celllayout/ReorderAlgorithm.java
private void computeDirectionVector(float deltaX, float deltaY, int[] result) {
    double angle = Math.atan(deltaY / deltaX);
    result[0] = 0; result[1] = 0;
    if (Math.abs(Math.cos(angle)) > 0.5f) result[0] = (int) Math.signum(deltaX);
    if (Math.abs(Math.sin(angle)) > 0.5f) result[1] = (int) Math.signum(deltaY);
}
```

手指从左来（deltaX>0）就往右推（result[0]=1）。`attemptPushInDirection` 还会在两分量都非零时拆成单分量分别试，保证一定能试到合适的纯方向。

### 10.8 临时坐标 vs 永久坐标的提交时机

重排期间严格区分预览和落库：

- `MODE_SHOW_REORDER_HINT` / `MODE_DRAG_OVER` → 操作 `mTmpOccupied` + `lp.setTmpCellX/Y` + `lp.useTmpCoords=true`，只动 `setup()` 用的临时坐标，`lp.getCellX()`（数据库坐标）不变。
- `MODE_ON_DROP` → `commitTempPlacement` 真正落库：

```java
// CellLayout.java
private void commitTempPlacement(View dragView) {
    mTmpOccupied.copyTo(mOccupied);                      // ★临时表升格为真实表
    int screenId = mCellLayoutContainer.getCellLayoutId(this);
    int container = Favorites.CONTAINER_DESKTOP;
    if (mContainerType == HOTSEAT) { screenId = -1; container = Favorites.CONTAINER_HOTSEAT; }

    int childCount = mShortcutsAndWidgets.getChildCount();
    for (int i = 0; i < childCount; i++) {
        View child = mShortcutsAndWidgets.getChildAt(i);
        CellLayoutLayoutParams lp = (CellLayoutLayoutParams) child.getLayoutParams();
        ItemInfo info = (ItemInfo) child.getTag();
        if (info != null && child != dragView) {
            CellPos presenterPos = mActivity.getCellPosMapper().mapModelToPresenter(info);
            boolean requiresDbUpdate = (presenterPos.cellX != lp.getTmpCellX()
                    || presenterPos.cellY != lp.getTmpCellY()
                    || info.spanX != lp.cellHSpan || info.spanY != lp.cellVSpan
                    || presenterPos.screenId != screenId);
            lp.setCellX(lp.getTmpCellX());   // ★临时坐标拷给永久坐标
            lp.setCellY(lp.getTmpCellY());
            if (requiresDbUpdate) {
                mActivity.getModelWriter().modifyItemInDatabase(info, container,
                        screenId, lp.getCellX(), lp.getCellY(), lp.cellHSpan, lp.cellVSpan);
            }
        }
    }
}
```

拖拽取消 → `revertTempState`：清抖动动画，所有 tmp 坐标还原回 cellX/Y。

### 10.9 Workspace.onDrop：落地协调

手指松开时 `Workspace#onDrop` 收尾整条链路（精简）：

```java
// Workspace.java
public void onDrop(final DragObject d, DragOptions options) {
    mDragViewVisualCenter = d.getVisualCenter(mDragViewVisualCenter);
    CellLayout dropTargetLayout = mDropToLayout;
    if (dropTargetLayout != null) mapPointFromDropLayout(dropTargetLayout, mDragViewVisualCenter);

    if (d.dragSource != this || mDragInfo == null) {
        onDropExternal(touchXY, dropTargetLayout, d);          // 从 AllApps/外部拖来
    } else {
        final View cell = mDragInfo.cell;
        boolean hasMovedLayouts = (getParentCellLayoutForView(cell) != dropTargetLayout);
        int container = hasMovedIntoHotseat ? CONTAINER_HOTSEAT : CONTAINER_DESKTOP;
        int screenId = (mTargetCell[0] < 0) ? mDragInfo.screenId : getCellLayoutId(dropTargetLayout);
        int spanX = mDragInfo.spanX, spanY = mDragInfo.spanY;

        mTargetCell = findNearestArea(/* center */, spanX, spanY, dropTargetLayout, mTargetCell);

        // 落在图标上？建文件夹/并入文件夹
        if (createUserFolderIfNecessary(...) || addToExistingFolderIfNecessary(...)) return;

        // 状态切换中途且非原地 → 回原位防止误打乱
        boolean returnToOriginalCellToPreventShuffling = !isFinishedSwitchingState()
                && !droppedOnOriginalCellDuringTransition
                && !dropTargetLayout.isRegionVacant(mTargetCell[0], mTargetCell[1], spanX, spanY);

        if (returnToOriginalCellToPreventShuffling) {
            mTargetCell[0] = mTargetCell[1] = -1;
        } else {
            mTargetCell = dropTargetLayout.performReorder(/* center */, minSpanX, minSpanY,
                    spanX, spanY, cell, mTargetCell, resultSpan, CellLayout.MODE_ON_DROP); // ★真正落地
        }

        boolean foundCell = mTargetCell[0] >= 0 && mTargetCell[1] >= 0;
        if (foundCell) {
            if (hasMovedLayouts) {
                parentCell.removeView(cell);                  // 从原屏移除
                addInScreen(cell, container, screenId, mTargetCell[0], mTargetCell[1],
                        info.spanX, info.spanY);               // 加到新屏
            }
            CellLayoutLayoutParams lp = (CellLayoutLayoutParams) cell.getLayoutParams();
            lp.setCellX(mTargetCell[0]); lp.setCellY(mTargetCell[1]);  // 更新坐标
            lp.isLockedToGrid = true;
            mLauncher.getModelWriter().modifyItemInDatabase(info, container, screenId,
                    lp.getCellX(), lp.getCellY(), item.spanX, item.spanY);  // ★写库
        } else {
            onNoCellFound(dropTargetLayout, d.dragInfo, d.logInstanceId);  // 放不下→回原位
        }
    }
    parent.onDropChild(cell);   // 标 dropped=true → 触发壁纸 COMMAND_DROP
}
```

### 10.10 reorderAlarm：650ms 延迟重排

`Workspace#manageReorderOnDragOver` 不立即重排，而是设 `REORDER_TIMEOUT=650ms` 的 Alarm：

```java
// Workspace.java
public static final int REORDER_TIMEOUT = 650;   // ms

protected void manageReorderOnDragOver(DragObject d, float targetCellDistance,
        boolean nearestDropOccupied, int minSpanX, int minSpanY, int reorderX, int reorderY) {
    if (!nearestDropOccupied) {
        // 目标格空：轻预览
        mDragTargetLayout.performReorder(/* center */, minSpanX, minSpanY, item.spanX, item.spanY,
                child, mTargetCell, span, CellLayout.MODE_SHOW_REORDER_HINT);
        mDragTargetLayout.visualizeDropLocation(mTargetCell[0], mTargetCell[1], span[0], span[1], d);
    } else if ((mDragMode == DRAG_MODE_NONE || mDragMode == DRAG_MODE_REORDER)
            && (mLastReorderX != reorderX || mLastReorderY != reorderY)
            && targetCellDistance < mDragTargetLayout.getReorderRadius(mTargetCell, item.spanX, item.spanY)) {
        mReorderAlarm.cancelAlarm();
        mLastReorderX = reorderX; mLastReorderY = reorderY;
        mDragTargetLayout.performReorder(/* center */, /* spans */, child, mTargetCell, new int[2],
                CellLayout.MODE_SHOW_REORDER_HINT);
        ReorderAlarmListener listener = new ReorderAlarmListener(mDragViewVisualCenter,
                minSpanX, minSpanY, item.spanX, item.spanY, d, child);
        mReorderAlarm.setOnAlarmListener(listener);
        mReorderAlarm.setAlarm(REORDER_TIMEOUT);   // ★停 650ms 才真正推开
    }
}
```

```java
// Workspace.java
class ReorderAlarmListener implements OnAlarmListener {
    public void onAlarm(Alarm alarm) {
        mTargetCell = findNearestArea(/* center */, minSpanX, minSpanY, mDragTargetLayout, mTargetCell);
        mTargetCell = mDragTargetLayout.performReorder(/* center */, minSpanX, minSpanY, spanX, spanY,
                child, mTargetCell, resultSpan, CellLayout.MODE_DRAG_OVER);  // ★真正挪位
        if (mTargetCell[0] < 0 || mTargetCell[1] < 0) {
            mDragTargetLayout.revertTempState();
        } else {
            setDragMode(DRAG_MODE_REORDER);
        }
        mDragTargetLayout.visualizeDropLocation(mTargetCell[0], mTargetCell[1],
                resultSpan[0], resultSpan[1], dragObject);
    }
}
```

650ms 避免手指快速划过时图标疯狂抖动。

### 10.11 文件夹半径 vs 重排半径

```java
// CellLayout.java
public float getFolderCreationRadius(int[] targetCell) {
    DeviceProfile grid = mActivity.getDeviceProfile();
    float iconVisibleRadius = ICON_VISIBLE_AREA_FACTOR * grid.getWorkspaceIconProfile().getIconSizePx() / 2;
    return (getReorderRadius(targetCell, 1, 1) + iconVisibleRadius) / 2;  // 介于重排半径和图标之间
}
public float getReorderRadius(int[] targetCell, int spanX, int spanY) {
    Rect cellBoundsWithSpacing = mTempRect;
    cellToRect(targetCell[0], targetCell[1], spanX, spanY, cellBoundsWithSpacing);
    cellBoundsWithSpacing.inset(-mBorderSpace.x / 2, -mBorderSpace.y / 2);  // 含 borderSpace
    if (canCreateFolder(getChildAt(targetCell[0], targetCell[1])) && spanX == 1 && spanY == 1) {
        // 单图标取较小维度的内切圆，避免太早触发重排
        int minRadius = Math.min(Math.min(centerPoint[0] - left, right - centerPoint[0]),
                                  Math.min(centerPoint[1] - top, bottom - centerPoint[1]));
        return minRadius;
    }
    return (float) Math.hypot(spanX * cellBoundsWithSpacing.width() / 2f,
            spanY * cellBoundsWithSpacing.height() / 2f);   // 对角线一半
}
```

- 距离 < `folderCreationRadius` 且目标格是图标 → 建文件夹
- `folderCreationRadius` ≤ 距离 < `reorderRadius` → 触发重排（推开）
- 距离 ≥ `reorderRadius` → 不响应

"精准砸图标上"建文件夹，"稍偏一点"图标让开。

### 面试深问

**1. 为什么三方案要按"推开→找空位→原地落"顺序，不是直接选最优？**
推开方案保留被拖项原始 span 且位置最接近手指，体验最好；但它可能失败（撞 AllApps 按钮）。找空位保证能放下但位置可能远。原地落最简单但要求目标格本就空。按用户体验降级排序，第一个成功的就用。

**2. push 算法为什么只需校验"簇在网格内"就算成功？**
`shift(1)` 每步都检查 `isViewTouchingEdge`，撞到新图标就 `addView` 并入簇。这保证簇推进过程中不会穿过任何图标（要么并入、要么被 canReorder=false 挡住失败）。所以最终只需验证簇整体没出界，无需逐图标检查重叠。

**3. 650ms 延迟为什么用 Alarm 而不是 Handler.postDelayed？**
Launcher 自实现的 `Alarm` 类支持 `cancelAlarm`/`setAlarm` 配对，手指移到新格时先 cancel 旧 Alarm 再设新的，避免多次重排叠加。Handler.postDelayed 也能 cancel 但语义不如 Alarm 清晰，且 Alarm 是 Launcher 复用组件（长按判定也用）。

---

## 十一、DeviceProfile：设备适配算法

> `DeviceProfile.java` 1987 行。注释：*"Defines the setup of the workspace, including spacing / sizes / etc."*

`DeviceProfile` 是针对**当前屏幕 + 当前方向**算出的一组布局参数。由 `InvariantDeviceProfile`（全局、设备无关的网格规格表）实例化。

### 11.1 两层配置：InvariantDeviceProfile → DeviceProfile

```
device_profiles.xml (预定义网格: 3×3, 4×4, 5×5, 6×5...)
        │ InvariantDeviceProfile 按 screen 尺寸选最匹配 GridOption
        ▼
InvariantDeviceProfile (IDP, 单例)
    numRows / numColumns / numHotseatIcons            ← 与方向无关的网格规格
    iconSize[4] / iconTextSize[4] / minCellSize[4]    ← 4 方向各一组数组
    INDEX_DEFAULT=0, INDEX_LANDSCAPE=1,
    INDEX_TWO_PANEL_PORTRAIT=2, INDEX_TWO_PANEL_LANDSCAPE=3
    isScalable / workspaceSpecsId                       ← 是否可缩放/响应式
        │ 配合 WindowManager 屏幕信息 → 选 typeIndex
        ▼
DeviceProfile (每个 Activity 一份，跟方向/折叠状态绑定)
    numRows / numColumns / cellWidthPx / cellHeightPx / iconSizePx / hotseatBarSizePx ...
    mIsResponsiveGrid / mIsScalableGrid / isVerticalBarLayout / isTaskbarPresent ...
```

IDP 的 4 个方向 index：

```java
// InvariantDeviceProfile.java
static final int COUNT_SIZES = 4;
static final int INDEX_DEFAULT = 0;            // 默认（竖屏手机）
static final int INDEX_LANDSCAPE = 1;          // 横屏
static final int INDEX_TWO_PANEL_PORTRAIT = 2; // 折叠屏竖屏双屏
static final int INDEX_TWO_PANEL_LANDSCAPE = 3;// 折叠屏横屏双屏
```

### 11.2 device_profiles.xml 结构

```xml
<!-- res/xml/device_profiles.xml -->
<profiles>
    <grid-option
        launcher:name="4_by_4"
        launcher:numRows="4"
        launcher:numColumns="4"
        launcher:numHotseatIcons="4"
        launcher:dbFile="launcher_4_by_4.db"
        launcher:defaultLayoutId="@xml/default_workspace_4x4"
        launcher:deviceCategory="phone|multi_display" >

        <display-option
            launcher:name="Short Stubby"
            launcher:minWidthDps="275"
            launcher:minHeightDps="420"
            launcher:iconImageSize="48"
            launcher:iconTextSize="13.0"
            launcher:canBeDefault="true" />
        <!-- 更多 display-option ... -->
    </grid-option>
</profiles>
```

两层结构：`grid-option`（网格规格）嵌套多个 `display-option`（屏幕尺寸适配）。`getPredefinedDeviceProfiles` 解析 XML：

```java
// InvariantDeviceProfile.java
private static List<DisplayOption> getPredefinedDeviceProfiles(Info displayInfo,
        String gridName, boolean allowDisabledGrid, boolean isFixedLandscapeMode) {
    ArrayList<DisplayOption> profiles = new ArrayList<>();
    try (XmlResourceParser parser = context.getResources().getXml(R.xml.device_profiles)) {
        // 遍历 <grid-option> → <display-option>
        while (... ) {
            if (GridOption.TAG_NAME.equals(parser.getName())) {
                GridOption gridOption = new GridOption(context, attrs, displayInfo);
                if (firstGridFilter(gridOption, deviceType, isFixedLandscapeMode)) {
                    // 收集该 grid 下所有 display-option
                    while (... ) profiles.add(new DisplayOption(gridOption, context, attrs));
                }
            }
        }
    }
    // 按 gridName 过滤，或取 canBeDefault
    // ...
    return filteredProfiles;
}
```

### 11.3 设备类型判定

```java
// util/DisplayController.java
public boolean isTablet(WindowBounds bounds) {
    return smallestSizeDp(bounds) >= MIN_TABLET_WIDTH            // 最短边 ≥ 600dp
            || context.getDisplay().getDisplayId() != DEFAULT_DISPLAY;  // 外接屏当平板
}
public float smallestSizeDp(WindowBounds bounds) {
    return dpiFromPx(Math.min(bounds.bounds.width(), bounds.bounds.height()), densityDpi);
}
```

```java
// util/window/WindowManagerProxy.java
public static final int MIN_TABLET_WIDTH = 600;   // dp 阈值
```

```kotlin
// deviceprofile/DeviceProperties.kt
val isTablet = info.isTablet(windowBounds)
val isTwoPanels = isTablet && isMultiDisplay   // 折叠屏展开 = 平板 + 多显示器
```

| 标志 | 判定 | 影响 |
|------|------|------|
| `isTablet` | 最短边 ≥ 600dp 或外接屏 | 决定 AllApps 是否双栏、Taskbar 是否显示 |
| `isTwoPanels` | isTablet && isMultiDisplay | 折叠屏展开，`getPanelCount()=2` |
| `isVerticalBarLayout` | 横屏 + transposeLayoutWithOrientation | 手机横屏 Hotseat 跑侧边 |

`MIN_TABLET_WIDTH=600dp` 是 Android 经典平板阈值（sw600dp），低于此视为手机布局。

### 11.4 选 profile：getBestMatch

IDP 为所有 supportedBounds 各建一个 DeviceProfile，运行时按当前屏幕选最匹配的：

```java
// InvariantDeviceProfile.java
public DeviceProfile getDeviceProfile(Context context) {
    Rect bounds = mWMProxy.getCurrentBounds(context);
    int rotation = mWMProxy.getRotation(context);
    return getBestMatch(bounds.width(), bounds.height(), rotation);
}
public DeviceProfile getBestMatch(float screenWidth, float screenHeight, int rotation) {
    DeviceProfile bestMatch = supportedProfiles.get(0);
    float minDiff = Float.MAX_VALUE;
    for (DeviceProfile profile : supportedProfiles) {
        // 宽高差之和最小的就是最匹配
        float diff = Math.abs(profile.getDeviceProperties().getWidthPx() - screenWidth)
                + Math.abs(profile.getDeviceProperties().getHeightPx() - screenHeight);
        if (diff < minDiff) { minDiff = diff; bestMatch = profile; }
        else if (diff == minDiff && profile.getDeviceProperties().getRotationHint() == rotation) {
            bestMatch = profile;   // 同分时优先匹配旋转方向
        }
    }
    return bestMatch;
}
```

### 11.5 网格尺寸核心算法

单格尺寸（`CellLayout#onMeasure` 调用）：

```java
// DeviceProfile.java
public static int calculateCellWidth(int width, int borderSpacing, int countX) {
    return (width - ((countX - 1) * borderSpacing)) / countX;
}
public static int calculateCellHeight(int height, int borderSpacing, int countY) {
    return (height - ((countY - 1) * borderSpacing)) / countY;
}
```

DeviceProfile 构造时按方向扣减出"真正能放网格的空间"：

```java
// DeviceProfile.java 构造（精简）
mIsResponsiveGrid = inv.workspaceSpecsId != INVALID_RESOURCE_HANDLE;  // 有 specs 才响应式
mIsScalableGrid = inv.isScalable && !isVerticalBarLayout() && !isExternalDisplay;

// 可用空间扣减
if (mIsResponsiveGrid) {
    int numWorkspaceColumns = getPanelCount() * inv.numColumns;  // 双屏翻倍列数
    int availableResponsiveWidth = mDeviceProperties.getAvailableWidthPx()
            - (isVerticalBarLayout() ? 0 : hotseatBarSizePx);
    int availableResponsiveHeight = mDeviceProperties.getAvailableHeightPx() - /* insets */;
    // 从 ResponsiveSpecs 查算 cellSize/padding
} else {
    // 经典网格：直接 calculateCellWidth/Height 均分
}
```

两种增强模式：

| 模式 | 字段 | 触发 | 行为 |
|------|------|------|------|
| 响应式网格 | `mIsResponsiveGrid` | `workspaceSpecsId` 有效 | 按屏幕宽高比从 spec 查算 padding/cellSize/gutter，自适应不同尺寸平板 |
| 可缩放网格 | `mIsScalableGrid` | `isScalable && !verticalBar` | 严格按 `minCellSize` 比例缩放，保证不同 dpi 视觉一致 |

### 11.6 双屏（Two Panel）适配

```java
// DeviceProfile.java
public int getPanelCount() {
    return mDeviceProperties.isTwoPanels() ? 2 : 1;
}
```

构造里 `int numWorkspaceColumns = getPanelCount() * inv.numColumns`——折叠屏展开按双倍列数算可用空间，每屏网格仍是 `numColumns × numRows`，但两屏并排显示。`PagedView` 翻页步长也变 2（第九章 9.4）。

### 面试深问

**1. InvariantDeviceProfile 为什么叫"不变量"？**
它的网格规格（numRows/numColumns/iconSize）在进程内全局唯一、与具体 Activity/方向无关，是"设备级常量"。DeviceProfile 才是"变量"——每个 Activity、每次旋转都重新算一份。IDP 变化（用户切网格）才触发 DB 迁移和重建。

**2. MIN_TABLET_WIDTH=600dp 这个阈值怎么来的？**
Android 资源限定符 `sw<N>dp` 的经典分界：sw600dp 是 7 寸平板最小宽度。低于此按手机布局（单栏 AllApps、Hotseat 横排），高于此按平板（双栏、Taskbar）。外接屏强制当平板是因为外接屏通常是大显示器。

**3. 响应式网格和可缩放网格什么关系？**
响应式（mIsResponsiveGrid）是新一代方案，按屏幕宽高比从 XML spec 精确查算每个尺寸；可缩放（mIsScalableGrid）是上一代，按 minCellSize 比例缩放。响应式优先级更高（`if (mIsResponsiveGrid) ... else if (mIsScalableGrid) ...`），新设备走响应式，老设备兜底可缩放。

---

## 十二、完整链路：图标从数据库到屏幕

把前十一章串起来，回答"一条数据库记录怎么变成屏幕上的格子"：

```
┌─────────────────────────────────────────────────────────────────────────┐
│ ① 数据库层 (Favorites 表)                                                │
│    一行: id, title, intent, container=DESKTOP, screen=1,               │
│          cellX=2, cellY=3, spanX=1, spanY=1, itemType=SHORTCUT         │
└──────────────────────────┬──────────────────────────────────────────────┘
                           │ LoaderTask (MODEL_EXECUTOR) 读库
                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ ② 内存模型层 (BgDataModel.itemsIdMap)                                    │
│    WorkspaceItemInfo { id, screenId=1, cellX=2, cellY=3, spanX=1, ... } │
└──────────────────────────┬──────────────────────────────────────────────┘
                           │ BaseLauncherBinder.bindWorkspace (主线程)
                           │   → Callbacks.bindWorkspaceItems
                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ ③ Launcher.bindWorkspaceItems                                            │
│    new BubbleTextView(context, itemInfo)                                 │
│    LauncherAppState.iconCache.getIcon(itemInfo) → 设到 BubbleTextView    │
│    child.setTag(itemInfo)   ★ ItemInfo 作为 tag 跟随 View 一生           │
└──────────────────────────┬──────────────────────────────────────────────┘
                           │ WorkspaceLayoutManager.addInScreenFromBind
                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ ④ WorkspaceLayoutManager.addInScreen                                     │
│    CellPos pos = getCellPosMapper().mapModelToPresenter(itemInfo)        │
│       → 处理 RTL / 双屏 offset，得展示坐标 (screen=1, cellX=2, cellY=3)  │
│    layout = getScreenWithId(1)  → 拿到第 2 个 CellLayout                 │
│    lp = new CellLayoutLayoutParams(cellX=2, cellY=3, spanX=1, spanY=1)   │
│    layout.addViewToCellLayout(child, -1, childId, lp, markCells=true)    │
└──────────────────────────┬──────────────────────────────────────────────┘
                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ ⑤ CellLayout.addViewToCellLayout                                        │
│    mShortcutsAndWidgets.addView(child, -1, lp)  → 进容器                  │
│    markCellsAsOccupiedForView(child)            → mOccupied.cells[2][3]=true│
└──────────────────────────┬──────────────────────────────────────────────┘
                           │ 下一次 layout 触发
                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ ⑥ 测量与摆放链                                                            │
│    CellLayout.onMeasure                                                   │
│      → DeviceProfile.calculateCellWidth/Height 算 mCellWidth/Height       │
│    ShortcutAndWidgetContainer.onMeasure → measureChild(child)             │
│      → lp.setup(cellW, cellH, ..., borderSpace)  ★第二章公式              │
│           x = 2 × cellWidth + 2 × borderSpace.x                           │
│           y = 3 × cellHeight + 3 × borderSpace.y                          │
│           width = cellWidth, height = cellHeight                          │
│    ShortcutAndWidgetContainer.onLayout → layoutChild(child)               │
│      → child.layout(lp.x, lp.y, x+w, y+h)  ★上屏                          │
└─────────────────────────────────────────────────────────────────────────┘
```

至此图标以正确尺寸 + 正确像素位置出现在第 2 屏第 (2,3) 格。任何坐标改动都要经 `ModelWriter.modifyItemInDatabase` 写回库才能持久化——**数据驱动 UI**。

### 面试深问

**1. 如果数据库里 screen=99 但 Workspace 只有 5 屏，会怎样？**
`addInScreen` 里 `getScreenWithId(99)` 返回 null，打 Log 并 `return`，该图标被丢弃不显示。这是防御设计：脏数据不应让 Launcher 崩溃。LoaderTask 通常会先保证 screenId 合法，但兜底逻辑不可少。

**2. bind 时为什么先 addView 后 measure/layout，不一次性完成？**
Android View 系统约定：addView 只是加入树，measure/layout 在下一次遍历统一做。批量 bind 多个图标时只触发一次 layout pass，性能远好过逐图标立即布局。

**3. 图标的 ItemInfo tag 为什么"跟随 View 一生"？**
拖拽、重排、写库、Accessibility 全靠 `child.getTag()` 拿 ItemInfo 反查 id/坐标/span。View 与数据强绑定，避免额外维护 View↔数据映射表。`onDrop` 里 `((ItemInfo) cell.getTag())` 直接拿数据写库。

---

## 附：核心源码索引

| 主题 | 文件 | 关键方法/字段 |
|------|------|--------------|
| 网格↔像素换算 | `celllayout/CellLayoutLayoutParams.java` | `setup()` |
| 占位表 | `util/GridOccupancy.java` | `markCells` / `findVacantCell` / `isRegionVacant` / `copyTo` |
| 单格尺寸 | `DeviceProfile.java` | `calculateCellWidth` / `calculateCellHeight` |
| 图标入屏 | `WorkspaceLayoutManager.java` | `addInScreen` / `addInScreenFromBind` |
| 图标增删 | `CellLayout.java` | `addViewToCellLayout` / `markCellsAsOccupiedForView` |
| 像素定位 | `ShortcutAndWidgetContainer.java` | `measureChild` / `layoutChild` |
| 多屏管理 | `Workspace.java` | `insertNewWorkspaceScreen` / `getScreenWithId` / `stripEmptyScreens` / `commitExtraEmptyScreen` |
| screenId 映射 | `Workspace.java` | `mWorkspaceScreens` / `mScreenOrder` / `getPageIndexForScreenId` / `getCellLayoutId` |
| 翻页滑动 | `PagedView.java` | `getPageScrolls` / `snapToPage` / `onTouchEvent` / `computeScrollHelper` |
| snap 阈值 | `PagedView.java` | `RETURN_TO_ORIGINAL_PAGE_THRESHOLD=0.33` / `SIGNIFICANT_MOVE_THRESHOLD=0.4` |
| 重排算法 | `celllayout/ReorderAlgorithm.java` | `calculateReorder` / `findReorderSolution` / `pushViewsToTempLocation` |
| 簇推挤 | `celllayout/ViewCluster.kt` | `isViewTouchingEdge` / `shift` / `sortConfigurationForEdgePush` |
| 重排解容器 | `celllayout/ItemConfiguration.kt` | `map` / `save` / `restore` / `area` |
| 重排调度 | `CellLayout.java` | `performReorder` / `commitTempPlacement` / `animateItemsToSolution` |
| 重排延迟 | `Workspace.java` | `REORDER_TIMEOUT=650` / `manageReorderOnDragOver` / `ReorderAlarmListener` |
| 半径判定 | `CellLayout.java` | `getReorderRadius` / `getFolderCreationRadius` |
| 拖拽落地 | `Workspace.java` | `onDragOver` / `onDrop` / `onDropExternal` |
| Hotseat | `Hotseat.java` | `resetLayout` / `getCellXFromOrder` / `setWorkspace` / `onInterceptTouchEvent` |
| 坐标映射 | `celllayout/CellPosMapper.java` | `mapModelToPresenter` / `mapPresenterToModel` / `TwoPanelCellPosMapper` |
| 设备类型 | `util/DisplayController.java` / `deviceprofile/DeviceProperties.kt` | `isTablet` / `isTwoPanels` |
| 平板阈值 | `util/window/WindowManagerProxy.java` | `MIN_TABLET_WIDTH=600` |
| 网格规格 | `InvariantDeviceProfile.java` | `getPredefinedDeviceProfiles` / `getBestMatch` / `INDEX_*` |
| 网格 XML | `res/xml/device_profiles.xml` | `<grid-option>` / `<display-option>` |
| IDP→DP | `DeviceProfile.java` | `mIsResponsiveGrid` / `mIsScalableGrid` / `getPanelCount` |
