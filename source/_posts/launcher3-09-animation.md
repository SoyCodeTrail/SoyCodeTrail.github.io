---
title: Launcher3 源码精读（09）：动画系统
category: client
platform: android
tags: ["AOSP", "Launcher3", "源码", "Framework", "Animation"]
readTime: 23分钟
featured: true
date: 2026-08-02
---

# Launcher3 动画系统

Launcher3 的动画系统不是一坨散落的 ObjectAnimator，而是一套分层的基础设施。最底层是插值器、首帧优化、可中断动画器这些"零件"；中间层是 PendingAnimation、PropertySetter、AnimatorPlaybackController 这些"组装工具"；最上层是 WorkspaceStateTransitionAnimation、FolderAnimationManager、AllAppsTransitionController 这些"具体业务"。本篇逐层拆解，从一行 `view.setAlpha()` 怎么变成动画，讲到手指拖动时整个桌面跟着手指走的原理。

源码版本基于 `/Users/soycodetrail/aosp-r4/packages/apps/Launcher3`。涉及文件分布在两个位置：动画基础设施在 `src/com/android/launcher3/`（LauncherAnimUtils、InterruptibleInOutAnimator、LogAccelerateInterpolator、LogDecelerateInterpolator、FirstFrameAnimatorHelper），动画框架在 `src/com/android/launcher3/anim/`（PendingAnimation、PropertySetter、AnimatorPlaybackController、SpringAnimationBuilder 等）。

---

## 一、LauncherAnimUtils：动画属性仓库

LauncherAnimUtils 本身不播放动画，它是**属性（Property）的集中存放点**。Android 的属性动画系统核心是 `Property<T, V>`——一个可读可写的字段抽象。Launcher 把所有常用属性预先定义成静态常量，业务代码直接引用，避免到处 `new FloatProperty`。

### 1.1 为什么用 Property 而不是直接 setAlpha

属性动画的工作机制是：`ObjectAnimator.ofFloat(view, View.ALPHA, 0f)` 内部会反复调用 `ALPHA.set(view, 值)`。如果直接传 `View.ALPHA`，框架用反射调用 `setAlpha`，有反射开销。Launcher 用 `FloatProperty`（API 24+ 的非反射版本）避免反射：

```java
// LauncherAnimUtils.java
public static final FloatProperty<View> VIEW_ALPHA =
        View.ALPHA instanceof FloatProperty ? (FloatProperty) View.ALPHA
                : new FloatProperty<View>("alpha") {        // 低版本兜底，自己包一层
                    @Override
                    public void setValue(View view, float v) {
                        view.setAlpha(v);                    // 直接调方法，不走反射
                    }
                    @Override
                    public Float get(View view) {
                        return view.getAlpha();
                    }
                };
```

这段代码先判断系统自带的 `View.ALPHA` 是不是 `FloatProperty`（高版本是），是就强转直接用；不是就自己包一个，保证所有版本都走非反射路径。`VIEW_TRANSLATE_X`、`VIEW_TRANSLATE_Y` 同理。

### 1.2 SCALE_PROPERTY：一次缩放两个轴

缩放动画有个细节：`View.SCALE_X` 和 `View.SCALE_Y` 是两个独立属性，如果分别做动画，要写两个 Animator。Launcher 封了一个合并版：

```java
// LauncherAnimUtils.java
public static final FloatProperty<View> SCALE_PROPERTY =
        new FloatProperty<View>("scale") {
            @Override
            public Float get(View view) {
                return view.getScaleX();                    // 读只用 X 代表
            }
            @Override
            public void setValue(View view, float scale) {
                view.setScaleX(scale);                      // 写时同时改 X 和 Y
                view.setScaleY(scale);
            }
        };
```

这样 `ObjectAnimator.ofFloat(icon, SCALE_PROPERTY, 1.2f)` 一个动画器就能让图标等比放大，业务代码少写一半。FolderAnimationManager 里 `getAnimator(mFolder.mContent, SCALE_PROPERTY, initialScale, finalScale)` 用的就是它。

### 1.3 MultiScalePropertyFactory：多源缩放合并

桌面缩放是个特殊情况：同一个 Workspace，可能同时被"状态切换动画"、"展开动画"、"Widget 过渡动画"等多个来源驱动缩放。如果都用同一个 `SCALE_PROPERTY`，后启动的动画会覆盖前一个，视觉上就跳变。

Launcher 的解法是 `MultiScalePropertyFactory`，给每个来源分配一个 `setterIndex`，最终缩放值是所有来源的**乘积**（再 clamp 到最小/最大值之间）：

```java
// LauncherAnimUtils.java
public static final MultiScalePropertyFactory<Workspace<?>> WORKSPACE_SCALE_PROPERTY_FACTORY =
        new MultiScalePropertyFactory<Workspace<?>>("workspace_scale_property");

public static final int SCALE_INDEX_UNFOLD_ANIMATION = 1;   // 折叠展开动画
public static final int SCALE_INDEX_WORKSPACE_STATE = 2;    // 状态切换动画
public static final int SCALE_INDEX_REVEAL_ANIMATION = 3;   // 揭示动画
public static final int SCALE_INDEX_WIDGET_TRANSITION = 4;  // Widget 过渡
```

工厂内部为每个 index 懒创建一个 `MultiScaleProperty`，setValue 时把其他所有 index 的值乘起来：

```java
// MultiScalePropertyFactory.java 的 MultiScaleProperty.setValue
public void setValue(T obj, float newValue) {
    if (mLastIndexSet != mInx) {                            // 切换了来源，重新算其他来源的聚合值
        mMinOfOthers = Float.MAX_VALUE;
        mMaxOfOthers = Float.MIN_VALUE;
        mMultiplicationOfOthers = 1.0f;
        mProperties.forEach((key, property) -> {
            if (key != mInx) {
                mMinOfOthers = Math.min(mMinOfOthers, property.mValue);
                mMaxOfOthers = Math.max(mMaxOfOthers, property.mValue);
                mMultiplicationOfOthers *= property.mValue; // 其他来源相乘
            }
        });
        mLastIndexSet = mInx;
    }
    float multValue = mMultiplicationOfOthers * newValue;   // 本来源乘进去
    mLastAggregatedValue = Utilities.boundToRange(multValue, minValue, maxValue);
    mValue = newValue;
    apply(obj, mLastAggregatedValue);                       // 实际setScaleX/Y
}
```

为什么用乘积而不是和？因为缩放是比例关系：A 动画想让桌面放大到 1.1 倍，B 动画想缩小到 0.9 倍，乘起来 0.99 是合理的复合效果。如果是求和 2.0 就完全错乱。WorkspaceStateTransitionAnimation 取的是 `SCALE_INDEX_WORKSPACE_STATE`：

```java
// WorkspaceStateTransitionAnimation.java
private static final FloatProperty<Workspace<?>> WORKSPACE_SCALE_PROPERTY =
        WORKSPACE_SCALE_PROPERTY_FACTORY.get(SCALE_INDEX_WORKSPACE_STATE);  // 取 index=2 的那个
```

### 1.4 其他常用属性

| 属性常量 | 类型 | 作用 |
|---------|------|------|
| `DRAWABLE_ALPHA` | IntProperty\<Drawable\> | 改 Drawable 透明度（非 View） |
| `LAYOUT_WIDTH` / `LAYOUT_HEIGHT` | IntProperty\<LayoutParams\> | 动画改布局尺寸 |
| `TEXT_COLOR` / `HINT_TEXT_COLOR` | IntProperty\<TextView\> | 文字颜色过渡 |
| `VIEW_BACKGROUND_COLOR` | IntProperty\<View\> | 背景色过渡 |
| `SCRIM_COLORS` | Property\<ScrimView, ScrimColors\> | 遮罩颜色 |
| `ROTATION_DRAWABLE_PERCENT` | FloatProperty\<ImageView\> | 用 level 控制旋转 |

### 1.5 ClampedProperty：范围限定包装器

有时动画值会超出业务范围（比如弹簧回弹时缩放短暂超过 1.0），但视觉上不希望超出。`ClampedProperty` 包装一个已有属性，强制夹值：

```java
// LauncherAnimUtils.java
public static class ClampedProperty<T> extends FloatProperty<T> {
    private final FloatProperty<T> mProperty;
    private final float mMinValue;
    private final float mMaxValue;

    @Override
    public void setValue(T t, float v) {
        mProperty.set(t, Utilities.boundToRange(v, mMinValue, mMaxValue));  // 强制夹值
    }
}
```

### 1.6 blockedFlingDurationFactor：反向 fling 加时长

```java
public static int blockedFlingDurationFactor(float velocity) {
    return (int) Utilities.boundToRange(Math.abs(velocity) / 2, 2f, 6f);
}
```

当手势被拦截（比如上滑到一半又想滑回来），因为要克服已有速度，动画时长要乘个系数。速度越大系数越大（2 到 6 之间），保证过渡不突兀。

### 面试深问

**Q1：为什么 MultiScalePropertyFactory 用乘积而 MultiValueAlpha 用最小值？**
缩放是比例叠加，两个都放大就乘起来更大，符合直觉。透明度是"多个遮挡"关系，取最小值（最不透明）才对——A 想让视图 0.5 透明，B 想让它 0.3 透明，实际显示 0.3（更透明的那方主导，因为透明度低=看不见）。

**Q2：get 方法返回的是 view.getScaleX() 而不是缓存的 mValue，为什么？**
注释写得很清楚：动画启动时用 get 取起始值，如果外部直接调了 setScaleX 绕过这个属性，缓存的 mValue 就过时了，动画会从错误位置跳变。返回真实值更安全。

**Q3：FloatProperty 相比 Property 反射版本，性能差多少？**
反射调用 `Method.invoke` 每帧都要查方法对象、装箱拆箱、检查权限，单次约几百纳秒。非反射直接调方法，单次几纳秒。一帧可能调几十上百次属性 setter，60fps 下累计差距明显，长动画能省可观 CPU。

---

## 二、InterruptibleInOutAnimator：可中断的双向动画器

这是 Launcher 最老的动画基础设施之一（2010 年），专门解决一个痛点：**普通 Animator 在反向播放时会逐帧镜像，视觉上不自然**。

### 2.1 痛点：普通反向动画的镜像问题

假设有个淡入动画，用减速插值器（开始快、结束慢）。如果用 `reverse()` 反向播放，框架是逐帧倒着取值——原本第 0.1 秒走到 0.5（快），现在第 0.1 秒从 1.0 走到 0.5（慢）。曲线被镜像了。

但业务上，淡出也应该是"开始快、结束慢"（加速离开的感觉？或者至少保持一致的节奏感）。InterruptibleInOutAnimator 保证进和出两个方向都用**同一个插值器的同一方向**。

### 2.2 状态机：STOPPED / IN / OUT

```java
// InterruptibleInOutAnimator.java
private static final int STOPPED = 0;   // 停止
private static final int IN = 1;        // 正在"进"
private static final int OUT = 2;       // 正在"出"
@Thunk int mDirection = STOPPED;
```

三个状态外加 `mFirstRun` 标记是否首次运行。核心是 `animate(direction)` 方法：

```java
// InterruptibleInOutAnimator.java
private void animate(int direction) {
    final long currentPlayTime = mAnimator.getCurrentPlayTime();   // 记录当前播放位置
    final float toValue = (direction == IN) ? mOriginalToValue : mOriginalFromValue;  // 终点取反
    final float startValue = mFirstRun ? mOriginalFromValue : mValue;                  // 起点用当前值

    cancel();                                            // 先停掉，再改值
    mDirection = direction;

    // 关键：剩余时长 = 总时长 - 已播放时长，保证从中间打断后时长连续
    long duration = mOriginalDuration - currentPlayTime;
    mAnimator.setDuration(Math.max(0, Math.min(duration, mOriginalDuration)));

    mAnimator.setFloatValues(startValue, toValue);       // 重新设起止值
    mAnimator.start();                                   // 重启
    mFirstRun = false;
}
```

### 2.3 为什么不会堆叠

普通 Animator 如果在上一个没结束时再 start，会出现两个动画同时改同一个值，视觉抖动。这里 `animate` 第一步就是 `cancel()`，确保同一时刻只有一个动画在跑。这就是"Interruptible"（可中断）的含义——新动画打断旧动画，从当前位置接力，而不是叠加。

### 2.4 时长连续的秘密：currentPlayTime 扣减

```java
long duration = mOriginalDuration - currentPlayTime;
```

假设总时长 500ms，已经播了 200ms（走到 40% 位置）。这时用户反向触发，新动画从当前 40% 位置出发，但时长不是重新 500ms，而是 500-200=300ms。这样视觉上是"匀速折返"，不会感觉突然变慢或变快。

### 2.5 实战：CellLayout 的拖拽尾迹

CellLayout（桌面格子布局）拖动图标时，会在拖动路径上留下一串逐渐淡出的绿色轮廓。每个轮廓用一个 InterruptibleInOutAnimator 控制透明度：

```java
// CellLayout.java
private final InterruptibleInOutAnimator[] mDragOutlineAnims =
        new InterruptibleInOutAnimator[mDragOutlines.length];

// 初始化时
final int duration = res.getInteger(R.integer.config_dragOutlineFadeTime);
final float fromAlphaValue = 0;
final float toAlphaValue = (float)res.getInteger(R.integer.config_dragOutlineMaxAlpha);
for (int i = 0; i < mDragOutlineAnims.length; i++) {
    final InterruptibleInOutAnimator anim =
            new InterruptibleInOutAnimator(duration, fromAlphaValue, toAlphaValue);
    anim.getAnimator().setInterpolator(mEaseOutInterpolator);
    final int thisIndex = i;
    anim.getAnimator().addUpdateListener(new AnimatorUpdateListener() {
        public void onAnimationUpdate(ValueAnimator animation) {
            mDragOutlineAlphas[thisIndex] = (Float) animation.getAnimatedValue();  // 回写透明度
            CellLayout.this.invalidate();                                          // 触发重绘
        }
    });
    mDragOutlineAnims[i] = anim;
}
```

为什么用可中断动画器？因为手指快速拖动时，同一个轮廓槽位会被反复重用——上一秒在 A 位置淡入，下一秒移到 B 位置又要淡入。如果每次都新建 Animator，旧的不 cancel 就堆叠了。InterruptibleInOutAnimator 保证同一个槽位始终只有一个动画，移动时无缝接力。

### 面试深问

**Q1：为什么不用 AnimatorSet 或 ObjectAnimator.reverse()？**
reverse() 是镜像播放，曲线被翻转。比如减速曲线变成加速曲线，视觉上"进"是慢出、"出"变成慢入，节奏感不一致。InterruptibleInOutAnimator 强制两个方向都用原曲线方向。

**Q2：mFirstRun 标志的作用？**
首次运行时起点必须是 `mOriginalFromValue`（预设起点），因为这时 mValue 还没被赋值。之后任何中断重启用 mValue（当前实际值）作起点，保证从断点接力而不是跳回起点。

**Q3：cancel 和 onAnimationEnd 的协作？**
构造时给 mAnimator 加了监听器，onAnimationEnd 时把 mDirection 设回 STOPPED。cancel() 内部会触发 end，所以 cancel 后状态自动归位，不用额外清理。

---

## 三、对数插值器：为什么用对数而非线性

插值器（TimeInterpolator）决定动画"时间进度"到"值进度"的映射。线性插值器是 `f(t)=t`，但人眼对线性运动感知不自然——会觉得"开始慢、中间快、结束慢"才舒服。

### 3.1 LogDecelerateInterpolator：减速曲线

```java
// LogDecelerateInterpolator.java
int mBase;
int mDrift;
final float mLogScale;

public LogDecelerateInterpolator(int base, int drift) {
    mBase = base;
    mDrift = drift;
    mLogScale = 1f / computeLog(1, mBase, mDrift);   // 归一化系数，让 t=1 时输出=1
}

static float computeLog(float t, int base, int drift) {
    return (float) -Math.pow(base, -t) + 1 + (drift * t);  // 核心公式
}

@Override
public float getInterpolation(float t) {
    return Float.compare(t, 1f) == 0 ? 1f : computeLog(t, mBase, mDrift) * mLogScale;
}
```

### 3.2 公式拆解

`computeLog(t) = -base^(-t) + 1 + drift*t`，分三部分理解：

- `-base^(-t)`：当 base>1，t 从 0 到 1，`base^(-t)` 从 1 衰减到 `1/base`。取负后从 -1 升到 `-1/base`。这是对数曲线的主体——开始变化快、后面趋缓（减速）。
- `+1`：把整体抬到非负区间。
- `+drift*t`：线性漂移项，drift>0 时给结尾加点线性成分，让曲线不至于太平。

`mLogScale = 1 / computeLog(1)` 把曲线归一化，保证 t=1 时输出正好 1。

### 3.3 LogAccelerateInterpolator：加速曲线

```java
// LogAccelerateInterpolator.java
@Override
public float getInterpolation(float t) {
    // 注意是 1 - computeLog(1-t)，把减速曲线关于中心点翻转 = 加速曲线
    return Float.compare(t, 1f) == 0 ? 1f : 1 - computeLog(1 - t, mBase, mDrift) * mLogScale;
}
```

加速就是减速的镜像：把输入 `t` 换成 `1-t`，输出再 `1-`。这样开头慢、结尾快。

### 3.4 为什么对数符合视觉感知

人眼对运动的感知遵循 **Weber-Fechner 定律**：感知强度与物理量的对数成正比。也就是说，位置从 0 到 0.5 的位移，主观感受比从 0.5 到 1.0 的位移"大"。线性动画会让用户觉得"开始很快冲过来，然后拖沓"。

减速插值器让前半段实际位移大（补偿人眼觉得它小），后半段位移小（人眼本来就敏感），整体感知匀速。这就是为什么所有"进场"动画几乎都用减速曲线。

### 3.5 base 和 drift 的调节

| 参数 | 效果 |
|------|------|
| base 越大（如 100） | 曲线越陡，前段变化越剧烈 |
| base 接近 1 | 接近线性 |
| drift > 0 | 给尾部加线性成分，减缓"完全停住"的感觉 |
| drift = 0 | 纯对数曲线 |

### 3.6 边界处理：为什么 t=1 要短路

```java
return Float.compare(t, 1f) == 0 ? 1f : ...;
```

注释说"由于浮点精度，t=1 时计算结果可能不完全是 1"。如果不短路，动画最后一帧可能停在 0.9999，视图永远差一点不到最终状态。短路保证收尾干净。

### 面试深问

**Q1：对数插值器和 Android 自带的 DecelerateInterpolator 有什么区别？**
自带的 `DecelerateInterpolator(factor)` 是 `1-(1-t)^factor`，是幂函数曲线。对数插值器是指数曲线 `base^(-t)`，形状更"弯"，前段加速更猛。Launcher 选对数是为了更明显的"快速到位然后缓缓停"的拖拽手感。

**Q2：为什么加速是减速的镜像翻转，而不是另写公式？**
数学上，加速曲线就是减速曲线关于 `(0.5, 0.5)` 中心点对称。`f_accel(t) = 1 - f_decel(1-t)` 是标准变换，避免重复造轮子，也保证两条曲线形状一致、节奏对称。

**Q3：drift 线性项会不会破坏对数特性？**
会弱化但不会破坏。drift 是叠加在线性项上的小修正，目的是让曲线尾部不至于完全水平（纯对数曲线会无限趋近但永远到不了，叠加线性保证有限时间内到达）。整体仍是"前快后慢"的对数主导形状。

---

## 四、FirstFrameAnimatorHelper：首帧防抖

动画卡顿最常发生在第一帧。原因：动画启动那一帧，系统要布局、测量、加载资源，开销大，导致第一帧耗时远超 16ms，后续帧被迫追赶，视觉上"跳一下"。

### 4.1 设计思路

FirstFrameAnimatorHelper 监听根视图的每一帧绘制（onDraw 计数），在动画前两帧做特殊处理：

```java
// FirstFrameAnimatorHelper.java
public class FirstFrameAnimatorHelper implements OnDrawListener, OnAttachStateChangeListener {
    private View mRootView;
    private long mGlobalFrameCount;                      // 全局帧计数器，onDraw 时自增

    public FirstFrameAnimatorHelper(View target) {
        target.addOnAttachStateChangeListener(this);
        if (target.isAttachedToWindow()) {
            onViewAttachedToWindow(target);
        }
    }

    public <T extends ValueAnimator> T addTo(T anim) {
        anim.addUpdateListener(new MyListener());        // 给动画加内部监听器
        return anim;
    }

    @Override
    public void onDraw() {
        mGlobalFrameCount ++;                             // 每画一帧计数+1
    }
}
```

### 4.2 三阶段帧处理

MyListener 是真正的逻辑核心，分三个阶段：

**阶段一：第一帧（frameNum == 0）强制回到 t=0**

```java
// FirstFrameAnimatorHelper.java 的 MyListener.onAnimationUpdate
if (mStartTime == -1) {
    mStartFrame = mGlobalFrameCount;                     // 记录动画开始的帧号
    mStartTime = currentTime;
}

if (frameNum == 0 && currentTime < mStartTime + MAX_DELAY && currentPlayTime > 0) {
    mRootView.invalidate();                              // 强制重绘，保证动画继续推进
    animation.setCurrentPlayTime(0);                     // 强制把播放时间拉回 0
}
```

为什么第一帧 currentPlayTime 可能 >0？因为动画 start 后到第一次 onUpdate 之间，可能已经过了几毫秒，框架按时间差算出了非 0 的 playTime。但这第一帧视觉上应该从头开始，所以强制拉回 0。同时 invalidate 确保下一帧还会绘制（动画的第一帧不一定触发 invalidate）。

**阶段二：第二帧（frameNum == 1）压缩时间差**

```java
int singleFrameMS = getSingleFrameMs(mRootView.getContext());  // 一帧的毫秒数（16ms/8ms）
if (frameNum == 1 && currentTime < mStartTime + MAX_DELAY
        && !mAdjustedSecondFrameTime
        && currentTime > mStartTime + singleFrameMS
        && currentPlayTime > singleFrameMS) {
    animation.setCurrentPlayTime(singleFrameMS);         // 假装只过了一帧
    mAdjustedSecondFrameTime = true;
}
```

如果第一帧因为布局开销花了 50ms（而不是 16ms），到了第二帧 currentPlayTime 可能已经是 50ms，动画值跳了一大截。这里强制设成 singleFrameMS（16ms），假装只过了正常一帧，避免跳跃。后续帧正常追赶。

**阶段三：第三帧及之后移除自己**

```java
if (frameNum > 1) {
    mRootView.post(() -> animation.removeUpdateListener(this));  // 干完活就走
}
```

前两帧修正完，动画进入稳态，监听器没用了，post 出去移除，避免每帧回调开销。

### 4.3 MAX_DELAY 防死等

```java
private static final int MAX_DELAY = 1000;               // 最多等 1 秒
```

如果 Activity 不在前台，onDraw 永远不调用，frameNum 卡在 0，监听器会一直把 playTime 拉回 0，动画永远启动不了。MAX_DELAY 保证超过 1 秒就放弃修正，让动画按实际时间走。

### 4.4 为什么挂在根视图的 OnDrawListener

帧计数必须反映"真实绘制"而不是动画更新。动画 onUpdate 频率可能高于绘制（vsync 同步前），用 onDraw 计数才能准确判断"屏幕上到底显示了第几帧"。

### 面试深问

**Q1：为什么是前两帧特别处理，不是前三帧？**
第一帧解决"启动延迟导致的初始 playTime 偏移"，第二帧解决"首帧重绘开销导致的时间跳跃"。到第三帧时布局已稳定，每帧耗时就近 16ms，不需要修正。这是经验值，针对 Android 渲染管线的实测结果。

**Q2：setCurrentPlayTime 和 setCurrentFraction 的区别？**
setCurrentPlayTime 设的是原始时间（毫秒），框架会用插值器算 fraction 再算值。setCurrentFraction 直接设 fraction（0-1），跳过插值器的"时间到 fraction"映射。这里用 setCurrentPlayTime 是因为要保留插值器曲线——第一帧应该停在插值器对 t=0 的输出值。

**Q3：removeUpdateListener 为什么要 post 而不是直接移除？**
onAnimationUpdate 是在遍历监听器列表时调用的，直接在回调里改列表会 ConcurrentModificationException。post 到下个消息循环执行，避开遍历。

---

## 五、PendingAnimation：声明式动画拼装

PendingAnimation 是 Launcher 动画系统的核心组装工具。它不是"立即播放的动画"，而是"一组等待启动的动画声明"——你往里 add 各种 Animator，最后调 buildAnim() 或 createPlaybackController() 一次性启动。

### 5.1 为什么需要声明式

考虑状态切换：从 NORMAL 到 ALL_APPS，要同时做"Workspace 缩小、Workspace 上移、AllApps 容器下拉、遮罩变暗、Hotseat 淡出"等十几个动画。如果手动 new AnimatorSet、挨个 add，代码冗长且每个 StateHandler 各写一套。

PendingAnimation 提供统一接口：各 StateHandler 往同一个 PendingAnimation 里 add 自己负责的动画，最后统一启动。这是**声明式**——先描述"要什么"，再统一"执行"。

### 5.2 继承自 AnimatedPropertySetter

```java
// PendingAnimation.java
public class PendingAnimation extends AnimatedPropertySetter {
    private final ArrayList<Holder> mAnimHolders = new ArrayList<>();  // 动画持有者列表
    private final long mDuration;                                       // 统一时长

    public PendingAnimation(long duration) {
        mDuration = duration;
    }
}
```

PendingAnimation 继承 AnimatedPropertySetter（继承 PropertySetter），所以它既能像 PropertySetter 那样调 setFloat/setViewAlpha（这些方法内部自动创建 ObjectAnimator 并 add），也能直接 add 已有的 Animator。两种风格混用。

### 5.3 add 方法：三重载

```java
// PendingAnimation.java
public void add(Animator anim, TimeInterpolator interpolator, SpringProperty springProperty) {
    anim.setInterpolator(interpolator);
    add(anim, springProperty);
}

public void add(Animator anim, TimeInterpolator interpolator) {
    add(anim, interpolator, SpringProperty.DEFAULT);
}

@Override
public void add(Animator anim) {
    add(anim, SpringProperty.DEFAULT);
}

public void add(Animator a, SpringProperty springProperty) {
    mAnim.play(a.setDuration(mDuration));                                    // 加入 AnimatorSet，统一时长
    addAnimationHoldersRecur(a, mDuration, springProperty, mAnimHolders);    // 递归建 Holder
}
```

核心在最后一行 `addAnimationHoldersRecur`：把每个子 Animator 包装成 Holder，记录它的 SpringProperty（是否需要弹簧）。这个 Holder 列表后续给 AnimatorPlaybackController 用，实现手势跟随。

### 5.4 buildAnim 与占位动画

```java
// PendingAnimation.java
@Override
public AnimatorSet buildAnim() {
    if (mAnimHolders.isEmpty()) {
        // 一个动画都没 add，补个占位的，保证时长被尊重
        add(ValueAnimator.ofFloat(0, 1).setDuration(mDuration));
    }
    return super.buildAnim();
}
```

为什么需要占位？如果某个状态切换实际啥也没动（比如两个状态视觉相同），直接 buildAnim 返回空 AnimatorSet，启动后立即结束，duration 字段失效，依赖时序的回调会错乱。补一个 0 到 1 的空 ValueAnimator，让它跑满 mDuration，保证时间结构完整。

### 5.5 createPlaybackController：转手势控制

```java
// PendingAnimation.java
public AnimatorPlaybackController createPlaybackController() {
    return new AnimatorPlaybackController(buildAnim(), mDuration, mAnimHolders);
}
```

这是 PendingAnimation 和手势系统的桥梁。buildAnim() 出来的 AnimatorSet 不是直接 start，而是包进 AnimatorPlaybackController，让外部能用手势（setPlayFraction）控制进度。

### 5.6 与 StateManager 的协作

StateManager 是状态机核心，它用 PendingAnimation 拼装状态切换动画：

```java
// StateManager.java
public AnimatorSet createAtomicAnimation(
        S fromState, S toState, StateAnimationConfig config) {
    PendingAnimation builder = new PendingAnimation(config.duration);     // 1. 建空壳
    prepareForAtomicAnimation(fromState, toState, config);

    for (StateHandler<S> handler : getStateHandlers()) {                   // 2. 每个 handler 贡献动画
        handler.setStateWithAnimation(toState, config, builder);
    }
    return builder.buildAnim();                                            // 3. 统一构建
}
```

`getStateHandlers()` 返回所有 StateHandler（WorkspaceStateTransitionAnimation、AllAppsTransitionController 等）。每个 handler 的 setStateWithAnimation 往同一个 builder 里 add 自己负责的动画。最后 buildAnim 得到完整 AnimatorSet。

手势控制的版本：

```java
// StateManager.java
private PendingAnimation createAnimationToNewWorkspaceInternal(final S state) {
    PendingAnimation builder = new PendingAnimation(mConfig.duration);
    if (!mConfig.hasAnimationFlag(SKIP_ALL_ANIMATIONS)) {
        for (StateHandler<S> handler : getStateHandlers()) {
            handler.setStateWithAnimation(state, mConfig, builder);        // 同样往 builder 里 add
        }
    }
    builder.addListener(createStateAnimationListener(state));
    mConfig.setAnimation(builder.buildAnim(), state);
    return builder;
}
```

然后上层调 `builder.createPlaybackController()` 拿到控制器，交给手势监听器驱动 setPlayFraction。

### 5.7 addFloat 与 addAnimatedFloat 的区别

```java
// PendingAnimation.java
public <T> void addFloat(T target, FloatProperty<T> property, float from, float to,
        TimeInterpolator interpolator) {
    Animator anim = ObjectAnimator.ofFloat(target, property, from, to);    // 普通 ObjectAnimator
    anim.setInterpolator(interpolator);
    add(anim);
}

public void addAnimatedFloat(AnimatedFloat target, float from, float to,
        TimeInterpolator interpolator) {
    Animator anim = target.animateToValue(from, to);                       // 用 AnimatedFloat 自己的 animator
    anim.setInterpolator(interpolator);
    add(anim);
}
```

addAnimatedFloat 的注释说：用 AnimatedFloat 自己提供的 animator，这样 AnimatedFloat 内部能跟踪这个 animator，允许从 AnimatedFloat 侧取消并重新动画。这对 AnimatedFloat 这种"可动画的浮点字段"很关键——它要知道当前有没有动画在跑（isAnimating）。

### 5.8 logAnimationProgressToTrace：Trace 调试

```java
// PendingAnimation.java
public void logAnimationProgressToTrace(String counterName) {
    if (Trace.isEnabled()) {
        super.addOnFrameListener(
                animation -> Trace.setCounter(
                        counterName, (long) (animation.getAnimatedFraction() * 100)));  // 0-100 计数器
    }
}
```

开启 Trace 时，每帧把动画进度（0-100）写进系统 trace counter，用 Perfetto 可视化。性能排查利器。

### 面试深问

**Q1：为什么 PendingAnimation 不直接持有 AnimatorSet 而是 extends AnimatedPropertySetter？**
AnimatedPropertySetter 已经持有 AnimatorSet（mAnim）和进度动画器（mProgressAnimator），PendingAnimation 复用这套，额外加 mAnimHolders 列表和 mDuration。继承避免重复实现 setFloat/setInt/buildAnim，符合"模板方法"模式。

**Q2：buildAnim 后还能继续 add 吗？**
技术上能（mAnim 还在），但语义上不该。buildAnim 会把 mProgressAnimator 加进 mAnim 并置 null，之后再 add 的动画不会进 mProgressAnimator 的回调链。设计约定是"声明完就 build，build 完就播"。

**Q3：mAnimHolders 为什么用 ArrayList 而不是数组？**
add 阶段数量动态增长，ArrayList 合适。buildAnim/createPlaybackController 时 AnimatorPlaybackController 会 toArray 成 Holder[]，之后用数组遍历更快（避免拆箱和边界检查）。两边各取所长。

---

## 六、PropertySetter：动画与立即设置的统一抽象

PropertySetter 解决另一个痛点：同一份状态设置代码，有时要动画过渡，有时要立即生效。

### 6.1 场景

状态切换有两种触发：用户点按（要动画）、配置变更或恢复（要立即）。如果写两套代码——一套 setWithAnim、一套 setNoAnim——逻辑重复且易错。PropertySetter 用多态统一：传 AnimatedPropertySetter 就动画，传 NO_ANIM_PROPERTY_SETTER 就立即。

### 6.2 抽象基类：默认立即设置

```java
// PropertySetter.java
public abstract class PropertySetter {

    public static final PropertySetter NO_ANIM_PROPERTY_SETTER = new PropertySetter() {
        @Override
        public void add(Animator animatorSet) {
            animatorSet.setDuration(0);                  // 时长归零
            animatorSet.start();
            animatorSet.end();                           // 立即跑到结尾
        }
    };

    protected static final AnimatorSet NO_OP = new AnimatorSet();   // 空操作占位

    public <T> Animator setFloat(T target, FloatProperty<T> property, float value,
            TimeInterpolator interpolator) {
        property.setValue(target, value);                // 直接赋值，不动画
        return NO_OP;
    }
}
```

注意 setFloat 的实现：直接 `property.setValue`，立即生效，返回 NO_OP（空 AnimatorSet）。interpolator 参数被忽略——因为没有动画，插值器无意义。这就是"立即设置"的语义。

### 6.3 AnimatedPropertySetter：动画版本

```java
// AnimatedPropertySetter.java
public class AnimatedPropertySetter extends PropertySetter {
    protected final AnimatorSet mAnim = new AnimatorSet();          // 收集所有动画
    protected ValueAnimator mProgressAnimator;                       // 进度回调载体

    @Override
    public <T> Animator setFloat(T target, FloatProperty<T> property, float value,
            TimeInterceptor interpolator) {
        if (property.get(target) == value) {                        // 值没变，短路
            return NO_OP;
        }
        Animator anim = ObjectAnimator.ofFloat(target, property, value);  // 建动画
        anim.setInterpolator(interpolator);
        add(anim);                                                   // 加进集合
        return anim;
    }
}
```

同样的 setFloat 签名，这里创建 ObjectAnimator 并加入 mAnim。业务代码完全一样，传不同的 PropertySetter 实例就切换行为。

### 6.4 setViewAlpha 的可见性联动

透明度动画有个副作用：alpha 降到 0 后视图应该 INVISIBLE（不接收触摸、不绘制），升到非 0 应该 VISIBLE。PropertySetter 处理这个：

```java
// PropertySetter.java（基类，立即版）
public Animator setViewAlpha(View view, float alpha, TimeInterpolator interpolator) {
    if (view != null) {
        view.setAlpha(alpha);
        AlphaUpdateListener.updateVisibility(view);     // 立即更新可见性
    }
    return NO_OP;
}

// AnimatedPropertySetter.java（动画版）
@Override
public Animator setViewAlpha(View view, float alpha, TimeInterpolator interpolator) {
    if (view == null) return NO_OP;
    if (Float.compare(view.getAlpha(), alpha) == 0) {   // 值没变，短路
        AlphaUpdateListener.updateVisibility(view);
        return NO_OP;
    }
    ObjectAnimator anim = ObjectAnimator.ofFloat(view, View.ALPHA, alpha);
    anim.addListener(new AlphaUpdateListener(view));    // 动画过程中持续更新可见性
    anim.setInterpolator(interpolator);
    add(anim);
    return anim;
}
```

动画版给 animator 加 AlphaUpdateListener（既是 AnimatorListener 又是 UpdateListener），每帧和结束时都 updateVisibility。AlphaUpdateListener 的逻辑：

```java
// AlphaUpdateListener.java
public static final float ALPHA_CUTOFF_THRESHOLD = 0.01f;

public static void updateVisibility(View view) {
    updateVisibility(view, View.INVISIBLE);
}

public static void updateVisibility(View view, int hiddenVisibility) {
    if (view.getAlpha() < ALPHA_CUTOFF_THRESHOLD && view.getVisibility() != hiddenVisibility) {
        view.setVisibility(hiddenVisibility);           // alpha<0.01，隐藏
    } else if (view.getAlpha() > ALPHA_CUTOFF_THRESHOLD && view.getVisibility() != View.VISIBLE) {
        // ViewGroup 要临时屏蔽子 view 焦点，避免隐藏时误触
        if (view instanceof ViewGroup) {
            ViewGroup viewGroup = ((ViewGroup) view);
            int oldFocusability = viewGroup.getDescendantFocusability();
            viewGroup.setDescendantFocusability(ViewGroup.FOCUS_BLOCK_DESCENDANTS);
            viewGroup.setVisibility(View.VISIBLE);
            viewGroup.setDescendantFocusability(oldFocusability);
        } else {
            view.setVisibility(View.VISIBLE);
        }
    }
}
```

阈值 0.01 而不是 0：避免浮点精度导致 alpha=0.001 时还可见。ViewGroup 显式设焦点屏蔽，因为 setVisibility(VISIBLE) 可能触发子 view 抢焦点。

### 6.5 mProgressAnimator：帧回调载体

AnimatedPropertySetter 有个 mProgressAnimator，它本身不驱动任何属性，纯粹是"每帧回调"的载体：

```java
// AnimatedPropertySetter.java
public void addOnFrameCallback(Runnable runnable) {
    addOnFrameListener(anim -> runnable.run());         // 包装成 UpdateListener
}

public void addOnFrameListener(ValueAnimator.AnimatorUpdateListener listener) {
    getProgressAnimator().addUpdateListener(listener);
}

private ValueAnimator getProgressAnimator() {
    if (mProgressAnimator == null) {
        mProgressAnimator = ValueAnimator.ofFloat(0, 1);  // 懒创建
    }
    return mProgressAnimator;
}
```

业务可以用 addOnFrameCallback 注册"动画每帧要执行的副作用"（比如根据进度算某个值）。buildAnim 时 mProgressAnimator 被加到 mAnim 末尾：

```java
// AnimatedPropertySetter.java
public AnimatorSet buildAnim() {
    // 进度动画放最后，保证帧回调在其他动画 update 之后执行
    if (mProgressAnimator != null) {
        add(mProgressAnimator);
        mProgressAnimator = null;
    }
    return mAnim;
}
```

注释解释为什么放最后：保证 addOnFrameListener 在所有属性动画都更新完之后才跑，这样回调里读到的属性值是最新一帧的。

### 6.6 实战：WorkspaceStateTransitionAnimation

```java
// WorkspaceStateTransitionAnimation.java
public void setState(LauncherState toState) {
    setWorkspaceProperty(toState, NO_ANIM_PROPERTY_SETTER, new StateAnimationConfig());  // 立即
}

public void setStateWithAnimation(
        LauncherState toState, StateAnimationConfig config, PendingAnimation animation) {
    setWorkspaceProperty(toState, animation, config);    // 动画（PendingAnimation 是 AnimatedPropertySetter 子类）
}

private void setWorkspaceProperty(LauncherState state, PropertySetter propertySetter,
        StateAnimationConfig config) {
    // ...
    propertySetter.setFloat(mWorkspace, WORKSPACE_SCALE_PROPERTY, mNewScale,
            scaleInterpolator);                          // 同一行代码，setter 不同行为不同
    propertySetter.setFloat(mWorkspace, VIEW_TRANSLATE_X,
            scaleAndTranslation.translationX, translationInterpolator);
    // ...
}
```

`setWorkspaceProperty` 只写一份，第三个参数 propertySetter 决定是动画还是立即。这就是多态的威力。

### 面试深问

**Q1：NO_ANIM_PROPERTY_SETTER 的 add 方法为什么先 start 再 end？**
setDuration(0) 后 start 会触发 onUpdate 一次（fraction=1，因为时长 0），但可能不触发 onAnimationEnd。显式 end 保证 listener 的 onAnimationEnd 被调用，依赖结束回调的逻辑才正确。

**Q2：setFloat 里 property.get(target)==value 短路，为什么 setViewAlpha 也有？**
避免创建无意义动画。如果 alpha 已经是目标值，建个 ObjectAnimator 等于白跑，浪费 CPU 且可能触发不必要的 invalidate。短路直接返回 NO_OP。

**Q3：PropertySetter 为什么是 abstract 而不是直接用 NO_ANIM 版？**
强制子类实现 add（动画收集方式不同）。NO_ANIM 是匿名子类，AnimatedPropertySetter 是具名子类，两者 add 行为迥异（一个立即播、一个存起来）。abstract 保证没人忘记实现 add。

---

## 七、AnimatorPlaybackController：手势跟随的核心

这是 Launcher 动画系统最精妙的部分。它把一个 AnimatorSet 包装成"可用进度值控制"的播放器——外部传 0 到 1 的 fraction，动画就走到对应位置。这是手势跟随的基础：手指位移换算成 fraction，动画就跟着手指走。

### 7.1 为什么需要手势跟随

普通动画是"启动后自己跑到结束"，时间驱动。但手势交互需要"动画跟手指"——手指拖一半，动画走一半；手指回拖，动画倒退；手指抬起，动画继续跑完或回弹。

如果用手势直接改 view 属性（translationY 等），每个属性都要手动算，代码爆炸。AnimatorPlaybackController 的思路：把整套状态切换动画预建好（用 PendingAnimation），然后不让它自己跑，改用手势进度驱动它的播放位置。一套动画既支持自动播放也支持手势拖动。

### 7.2 核心结构：AnimationPlayer 驱动 Holder

```java
// AnimatorPlaybackController.java
public class AnimatorPlaybackController implements ValueAnimator.AnimatorUpdateListener {

    private final ValueAnimator mAnimationPlayer;       // 进度驱动器（0 到 1）
    private final long mDuration;                        // 名义时长
    private final AnimatorSet mAnim;                     // 被控制的目标动画集
    private final Holder[] mChildAnimations;             // 所有子动画的包装

    AnimatorPlaybackController(AnimatorSet anim, long duration, ArrayList<Holder> childAnims) {
        mAnim = anim;
        mDuration = duration;
        mAnimationPlayer = ValueAnimator.ofFloat(0, 1);  // 进度从 0 到 1
        mAnimationPlayer.setInterpolator(LINEAR);        // 线性！进度映射由子动画自己的插值器负责
        mAnimationPlayer.addListener(new OnAnimationEndDispatcher());
        mAnimationPlayer.addUpdateListener(this);        // 自己监听自己
        mChildAnimations = childAnims.toArray(new Holder[childAnims.size()]);
    }
}
```

关键设计：mAnimationPlayer 是唯一的"主时钟"，线性跑 0 到 1。它的 onUpdate 回调里调 setPlayFraction，把进度分发给所有子动画。子动画各自有自己的插值器，负责把"全局进度"映射成"自己的值"。

### 7.3 setPlayFraction：进度分发

```java
// AnimatorPlaybackController.java
@Override
public void onAnimationUpdate(ValueAnimator valueAnimator) {
    setPlayFraction((float) valueAnimator.getAnimatedValue());   // player 的值传给 fraction
}

public void setPlayFraction(float fraction) {
    mCurrentFraction = fraction;
    if (mTargetCancelled) {                              // 目标动画被取消，不应用进度
        return;
    }
    float progress = boundToRange(fraction, 0, 1);
    for (Holder holder : mChildAnimations) {
        holder.setProgress(progress);                    // 每个子动画设进度
    }
}
```

这就是手势跟随的入口。AbstractStateChangeTouchController 在 onDrag 时：

```java
// AbstractStateChangeTouchController.java
protected void updateProgress(float fraction) {
    if (mCurrentAnimation == null) {
        return;
    }
    mCurrentAnimation.setPlayFraction(fraction);         // 手指位移换算的 fraction 直接喂进来
}
```

手指位移怎么换算 fraction？mProgressMultiplier 是"位移像素到进度"的比率，onDrag 里 `fraction = displacement * mProgressMultiplier`。手指拖 100px 对应 fraction 0.3，动画就走到 30%。

### 7.4 Holder：子动画的进度映射

```java
// AnimatorPlaybackController.java
static class Holder {
    public final ValueAnimator anim;
    public final SpringProperty springProperty;
    public final TimeInterpolator interpolator;          // 子动画原始插值器
    public final float globalEndProgress;                // 该子动画在全局进度中的结束点
    public ProgressMapper mapper;                        // 进度映射函数

    Holder(Animator anim, float globalDuration, SpringProperty springProperty) {
        this.anim = (ValueAnimator) anim;
        this.springProperty = springProperty;
        this.interpolator = this.anim.getInterpolator();
        this.globalEndProgress = anim.getDuration() / globalDuration;   // 占全局的多少
        this.mapper = ProgressMapper.DEFAULT;
    }

    public void setProgress(float progress) {
        anim.setCurrentFraction(mapper.getProgress(progress, globalEndProgress));  // 设子动画 fraction
    }
}
```

globalEndProgress 解决"子动画时长不等"的问题。假设全局 500ms，某子动画只有 200ms，那它的 globalEndProgress = 200/500 = 0.4。全局进度 0 到 0.4 对应它完整播放，0.4 到 1 它已经结束。

### 7.5 ProgressMapper.DEFAULT

```java
// AnimatorPlaybackController.java
private interface ProgressMapper {
    ProgressMapper DEFAULT = (progress, globalEndProgress) ->
            progress > globalEndProgress ? 1 : (progress / globalEndProgress);

    float getProgress(float progress, float globalProgress);
}
```

默认映射：全局进度除以该子动画的结束进度。如果全局进度超过子动画结束点，子动画 fraction 锁定 1（已完成）。这就是为什么不同时长的子动画能同步——它们各自的 fraction 由全局进度按比例换算。

### 7.6 用 setCurrentFraction 而非 setCurrentPlayTime

Holder.setProgress 调的是 `anim.setCurrentFraction`，不是 setCurrentPlayTime。区别：setCurrentPlayTime 设时间，框架用插值器算 fraction 再算值；setCurrentFraction 直接设 fraction，跳过插值器的"时间→fraction"映射。

为什么这样？因为子动画的插值器已经在 Holder.interpolator 里记着了，AnimatorPlaybackController 要的是"用这个插值器，但 fraction 由外部控制"。实际是 holder.anim 自己保留了插值器，setCurrentFraction 时框架会用 anim 的插值器把 fraction 再插值一次——这部分逻辑见 7.7。

### 7.7 startWithVelocity：松手后的弹簧接管

手势结束时，如果速度够大，动画应该带着惯性继续。这里有个分支：某些动画用普通插值器继续，某些（标记了 SpringProperty）切换成弹簧物理：

```java
// AnimatorPlaybackController.java
public void startWithVelocity(Context context, boolean goingToEnd,
        float velocityPxPerMs, float endDistance, long animationDuration) {
    float distanceInverse = 1 / Math.abs(endDistance);
    float velocityProgressPerMs = velocityPxPerMs * distanceInverse;   // 像素速度转进度速度
    float oneFrameProgress = velocityProgressPerMs * getSingleFrameMs(context);
    float nextFrameProgress = boundToRange(getProgressFraction()
            + oneFrameProgress, 0f, 1f);

    int springFlag = goingToEnd
            ? SpringProperty.FLAG_CAN_SPRING_ON_END
            : SpringProperty.FLAG_CAN_SPRING_ON_START;

    long springDuration = animationDuration;
    for (Holder h : mChildAnimations) {
        if ((h.springProperty.flags & springFlag) != 0) {              // 这个子动画要弹簧
            SpringAnimationBuilder s = new SpringAnimationBuilder(context)
                    .setStartValue(mCurrentFraction)
                    .setEndValue(goingToEnd ? 1 : 0)
                    .setStartVelocity(velocityProgressPerMs)
                    .setMinimumVisibleChange(distanceInverse)
                    .setDampingRatio(h.springProperty.mDampingRatio)
                    .setStiffness(h.springProperty.mStiffness)
                    .computeParams();

            long expectedDurationL = s.getDuration();
            springDuration = Math.max(expectedDurationL, springDuration);

            float expectedDuration = expectedDurationL;
            h.mapper = (progress, globalEndProgress) -> {              // 替换映射函数为弹簧
                if (expectedDuration <= 0 || oneFrameProgress >= 1) {
                    return 1;
                } else {
                    return Utilities.mapToRange(
                            mAnimationPlayer.getCurrentPlayTime() / expectedDuration,
                            0, 1,
                            Math.abs(oneFrameProgress), 1,
                            LINEAR);
                }
            };
            h.anim.setInterpolator(s::getInterpolatedValue);           // 插值器换成弹簧曲线
        }
    }

    mAnimationPlayer.setFloatValues(nextFrameProgress, goingToEnd ? 1f : 0f);
    // ...设置时长和插值器后 start
}
```

精妙之处：不新建动画，而是**替换 Holder 的 mapper 和 anim 的插值器**。同一个 mAnimationPlayer 跑，但子动画的"进度→值"映射从线性变成弹簧曲线。这样手势松手后的"惯性+回弹"无缝衔接，不会跳变。

### 7.8 dispatchOnStart/End/Cancel：手动派发监听

普通 AnimatorSet 的 listener 是自动派发的。但 AnimatorPlaybackController 手动控制进度时，AnimatorSet 不会触发 listener（因为它没真正"跑"）。所以要手动派发：

```java
// AnimatorPlaybackController.java
public AnimatorPlaybackController dispatchOnStart() {
    callListenerCommandRecursively(mAnim, AnimatorListener::onAnimationStart);
    return this;
}

public AnimatorPlaybackController dispatchOnEnd() {
    callListenerCommandRecursively(mAnim, AnimatorListener::onAnimationEnd);
    return this;
}

public static void callListenerCommandRecursively(
        Animator anim, BiConsumer<AnimatorListener, Animator> command) {
    callAnimatorCommandRecursively(anim, a -> {
        for (AnimatorListener l : nonNullList(a.getListeners())) {
            command.accept(l, a);                                      // 对每个 listener 执行命令
        }
    });
}

private static void callAnimatorCommandRecursively(Animator anim, Consumer<Animator> command) {
    command.accept(anim);
    if (anim instanceof AnimatorSet) {                                 // 递归处理 AnimatorSet 的子动画
        for (Animator child : nonNullList(((AnimatorSet) anim).getChildAnimations())) {
            callAnimatorCommandRecursively(child, command);
        }
    }
}
```

业务代码注册的 listener（比如状态切换完成的回调）才能被正确触发。OnAnimationEndDispatcher 负责在合适时机调 dispatchOnEnd。

### 7.9 OnAnimationEndDispatcher：等弹簧结束

```java
// AnimatorPlaybackController.java
private class OnAnimationEndDispatcher extends AnimationSuccessListener {
    boolean mDispatched = false;

    @Override
    public void onAnimationStart(Animator animation) {
        mCancelled = false;
        mDispatched = false;
    }

    @Override
    public void onAnimationSuccess(Animator animator) {
        // 等主 player 和所有弹簧都结束才派发
        if (!mDispatched) {
            dispatchOnEnd();
            if (mEndAction != null) {
                mEndAction.run();
            }
            mDispatched = true;
        }
    }
}
```

继承 AnimationSuccessListener，只在"非取消"时触发 onAnimationSuccess。mDispatched 保证只派发一次。

### 7.10 forceFinishIfCloseToEnd：近完成强制收尾

```java
// AnimatorPlaybackController.java
private static final float ANIMATION_COMPLETE_THRESHOLD = 0.95f;

public void forceFinishIfCloseToEnd() {
    if (mAnimationPlayer.isRunning()
            && mAnimationPlayer.getAnimatedFraction() > ANIMATION_COMPLETE_THRESHOLD) {
        mAnimationPlayer.end();                         // 已经 95% 了，直接结束
    }
}
```

动画快结束时（>95%）还跑剩余 5% 浪费帧，直接 end 跳到结尾，视觉上无差别但省时间。

### 7.11 整体协作流程

```
手指按下
  → AbstractStateChangeTouchController 拦截触摸
  → StateManager.createAnimationToNewWorkspace(state, duration)
     → new PendingAnimation(duration)
     → 各 StateHandler.setStateWithAnimation 往里 add 动画
     → builder.createPlaybackController() 得到 APC
     → mCurrentAnimation = APC
手指拖动 onDrag(displacement)
  → fraction = displacement * mProgressMultiplier
  → mCurrentAnimation.setPlayFraction(fraction)
     → Holder.setProgress(progress) 遍历所有子动画设 fraction
     → 视图属性实时变化，动画跟手指
手指抬起 onDragEnd(velocity)
  → 如果速度大、方向对：APC.startWithVelocity(...) 切弹簧惯性
  → 否则 APC.start() 或 APC.reverse() 自动跑完
  → OnAnimationEndDispatcher 派发结束，状态正式切换
```

### 面试深问

**Q1：为什么 mAnimationPlayer 用 LINEAR 而子动画各自有插值器？**
mAnimationPlayer 是"主时钟"，负责线性推进全局进度。子动画的视觉曲线（加速、减速、弹簧）由各自的插值器在"进度→值"环节实现。分层后主时钟简单可控，视觉曲线灵活可配。

**Q2：setCurrentFraction 会触发插值器吗？**
会。ValueAnimator.setCurrentFraction(fraction) 内部会调 mInterpolator.getInterpolation(fraction) 再设值。所以 Holder 存了 interpolator，进度→值经过两次映射：全局进度→子动画 fraction（mapper）→插值后值（子动画插值器）。这就是为什么手势拖动时视觉曲线还在。

**Q3：startWithVelocity 为什么不新建弹簧动画而是替换 mapper？**
新建会中断当前 mAnimationPlayer，时序和监听器都乱。替换 mapper 让同一个 player 继续，只是子动画的曲线变了，衔接无缝。这是"数据驱动"思路——不改动画对象，改映射函数。

---

## 八、SpringAnimationBuilder：自己实现的弹簧曲线

Android DynamicAnimation 提供 SpringAnimation，但它是"自己跑"的物理动画，无法被 AnimatorPlaybackController 控制（不能 setCurrentFraction）。Launcher 需要弹簧曲线但又要在手势体系内用，于是 SpringAnimationBuilder 把弹簧物理**预计算成固定时长的 ValueAnimator**。

### 8.1 弹簧运动方程

```java
// SpringAnimationBuilder.java 的注释
// 弹簧方程：
//   x = e^(-beta*t/2) * (a cos(gamma * t) + b sin(gamma * t)
//   v = e^(-beta*t/2) * ((2 * a * gamma + beta * b) * sin(gamma * t)
//                  + (a * beta - 2 * b * gamma) * cos(gamma * t)) / 2
//   a = x(0)
//   b = beta * x(0) / (2 * gamma) + v(0) / gamma
```

这是欠阻尼弹簧（dampingRatio < 1）的标准解：位移是指数衰减包络乘以余弦/正弦振荡。beta 是阻尼系数，gamma 是阻尼角频率。

### 8.2 参数配置

```java
// SpringAnimationBuilder.java
private float mStiffness = SpringForce.STIFFNESS_MEDIUM;              // 默认中等刚度
private float mDampingRatio = SpringForce.DAMPING_RATIO_MEDIUM_BOUNCY; // 默认中等弹性
private float mMinVisibleChange = 1;

private static final float THRESHOLD_MULTIPLIER = 0.65f;              // 值阈值乘数
```

默认值用 SpringForce 的常量。可配置项通过 builder 链式设置：

```java
// SpringAnimationBuilder.java
public SpringAnimationBuilder setStiffness(float stiffness) {
    if (stiffness <= 0) {
        throw new IllegalArgumentException("Spring stiffness constant must be positive.");
    }
    mStiffness = stiffness;
    return this;
}

public SpringAnimationBuilder setDampingRatio(float dampingRatio) {
    if (dampingRatio <= 0 || dampingRatio >= 1) {                     // 必须 (0,1)，欠阻尼
        throw new IllegalArgumentException("Damping ratio must be between 0 and 1");
    }
    mDampingRatio = dampingRatio;
    return this;
}
```

注意 dampingRatio 限制在 (0,1)，即只支持欠阻尼（会回弹）。临界阻尼(1)和过阻尼(>1)不支持，因为欠阻尼才有"弹性回弹"的视觉效果。

### 8.3 computeParams：预计算时长和系数

```java
// SpringAnimationBuilder.java
public SpringAnimationBuilder computeParams() {
    int singleFrameMs = RefreshRateTracker.getSingleFrameMs(mContext);
    double naturalFreq = Math.sqrt(mStiffness);                       // 自然频率 = sqrt(stiffness)
    double dampedFreq = naturalFreq * Math.sqrt(1 - mDampingRatio * mDampingRatio); // 阻尼频率

    beta = 2 * mDampingRatio * naturalFreq;                           // beta = 2*ζ*ω
    gamma = dampedFreq;                                               // gamma = ωd
    a = mStartValue - mEndValue;                                      // 初始位移（相对终点）
    b = beta * a / (2 * gamma) + mVelocity / gamma;                   // 初始速度项

    va = a * beta / 2 - b * gamma;                                    // 速度方程的系数
    vb = a * gamma + beta * b / 2;

    mValueThreshold = mMinVisibleChange * THRESHOLD_MULTIPLIER;       // 值阈值
    mVelocityThreshold = mValueThreshold * 1000.0 / singleFrameMs;    // 速度阈值

    // 求弹簧到达平衡的时长（秒）
    double duration = Math.atan2(-a, b) / gamma;
    double piByG = Math.PI / gamma;
    while (duration < 0 || Math.abs(exponentialComponent(duration) * cosSinV(duration))
            >= mVelocityThreshold) {
        duration += piByG;                                            // 每次加半个振荡周期
    }

    // 二分搜索找最短时长
    double edgeTime = Math.max(0, duration - piByG / 2);
    double minDiff = singleFrameMs / 2000.0;
    do {
        if ((duration - edgeTime) < minDiff) break;
        double mid = (edgeTime + duration) / 2;
        if (isAtEquilibrium(mid)) {
            duration = mid;
        } else {
            edgeTime = mid;
        }
    } while (true);

    mDuration = (float) duration;
    return this;
}
```

这段数学较密，分步：

1. **算物理常数**：naturalFreq、dampedFreq、beta、gamma 是弹簧系统的特征参数。
2. **算初始系数 a、b**：由初始位移和速度决定振荡的幅度和相位。
3. **算阈值**：值阈值和速度阈值，用于判断"弹簧是否停了"。速度阈值的设计——如果一帧内位移小于值阈值，速度就算停了。
4. **求时长**：先用 atan2 算首个过零点，然后每次加半周期，直到速度衰减到阈值内。这是粗略上界。
5. **二分搜索**：在上界和上界-半周期之间二分，找最短的"已平衡"时长，避免动画过长。

### 8.4 getInterpolatedValue：取值

```java
// SpringAnimationBuilder.java
public float getInterpolatedValue(float fraction) {
    return getValue(mDuration * fraction);                  // fraction(0-1) 转时间，再算位移
}

private float getValue(float time) {
    return (float) (exponentialComponent(time) * cosSinX(time)) + mEndValue;
}

private double exponentialComponent(double t) {
    return Math.pow(Math.E, - beta * t / 2);                // 衰减包络 e^(-beta*t/2)
}

private double cosSin(double t, double cosFactor, double sinFactor) {
    double angle = t * gamma;
    return cosFactor * Math.cos(angle) + sinFactor * Math.sin(angle);  // 振荡项
}
```

`getValue(time) = 衰减包络 * 振荡 + 终点值`。衰减包络让振荡幅度随时间减小，最终停在终点。

### 8.5 build：转成 ValueAnimator

```java
// SpringAnimationBuilder.java
public <T> ValueAnimator build(T target, FloatProperty<T> property) {
    computeParams();

    ValueAnimator animator = ValueAnimator.ofFloat(0, mDuration);     // 0 到时长
    animator.setDuration(getDuration()).setInterpolator(LINEAR);      // 线性！曲线自己算
    animator.addUpdateListener(anim -> {
        float value = getInterpolatedValue(anim.getAnimatedFraction());  // fraction 转弹簧值
        if (Float.isNaN(value)) {
            value = 0f;                                                // 异常兜底
        }
        property.set(target, value);
    });
    animator.addListener(new AnimationSuccessListener() {
        @Override
        public void onAnimationSuccess(Animator animation) {
            property.set(target, mEndValue);                           // 结束时强制设终点
        }
    });
    return animator;
}
```

关键：animator 用 LINEAR 插值器，因为弹簧曲线由 getInterpolatedValue 自己实现。这样产出的 ValueAnimator 可以被 AnimatorPlaybackController 控制（能 setCurrentFraction），同时视觉是弹簧曲线。这是"把物理动画伪装成时间动画"的巧妙设计。

### 8.6 实战：Workspace 的 hint 缩放

```java
// WorkspaceStateTransitionAnimation.java
public static <T extends View> ValueAnimator getSpringScaleAnimator(Launcher launcher, T v,
        float scale, FloatProperty<T> property) {
    ResourceProvider rp = DynamicResource.provider(launcher);
    float damping = rp.getFloat(R.dimen.hint_scale_damping_ratio);    // 从资源读阻尼
    float stiffness = rp.getFloat(R.dimen.hint_scale_stiffness);      // 从资源读刚度
    float velocityPxPerS = rp.getDimension(R.dimen.hint_scale_velocity_dp_per_s);

    return new SpringAnimationBuilder(v.getContext())
            .setStiffness(stiffness)
            .setDampingRatio(damping)
            .setMinimumVisibleChange(MIN_VISIBLE_CHANGE_SCALE)        // 用 SCALE 级别的最小可见变化
            .setEndValue(scale)
            .setStartValue(property.get(v))
            .setStartVelocity(velocityPxPerS)
            .build(v, property);
}
```

从 HINT_STATE 回 NORMAL 时桌面缩放用弹簧，给"轻按预览然后松手弹回"的手感。damping 和 stiffness 从 dimen 资源读，方便不同设备调参。

### 8.7 SpringProperty：弹簧标记

SpringProperty 本身不是动画，是标记某个动画"在什么时机可以变弹簧"：

```java
// SpringProperty.java
public class SpringProperty {
    public static final SpringProperty DEFAULT = new SpringProperty();

    public static final int FLAG_CAN_SPRING_ON_END = 1 << 0;     // 正向结束时可以变弹簧
    public static final int FLAG_CAN_SPRING_ON_START = 1 << 1;   // 反向（回退）时可以变弹簧

    public final int flags;
    float mDampingRatio = SpringForce.DAMPING_RATIO_MEDIUM_BOUNCY;
    float mStiffness = SpringForce.STIFFNESS_MEDIUM;
}
```

AnimatorPlaybackController.startWithVelocity 时检查这个 flag，决定该子动画要不要切弹簧。DEFAULT（flags=0）表示永不切弹簧。

### 面试深问

**Q1：为什么不直接用 Android 的 SpringAnimation？**
SpringAnimation 是物理驱动、自己跑、时长不定，无法 setCurrentFraction。Launcher 的手势体系需要"可控进度"的动画。SpringAnimationBuilder 把弹簧物理预计算成固定时长 ValueAnimator，兼具弹簧曲线和可控性。

**Q2：dampingRatio 为什么限制 (0,1)？**
<1 是欠阻尼，会回弹（视觉弹性）。=1 临界阻尼，最快到达不回弹。>1 过阻尼，缓慢到达。Launcher 要弹性手感，所以只要欠阻尼。代码显式抛异常拒绝其他值。

**Q3：mVelocityThreshold 为什么是 mValueThreshold * 1000 / singleFrameMs？**
思路：如果速度慢到"一帧内位移 < 值阈值"，那这个位移人眼看不见，速度就算停了。换算：值阈值/帧是"每帧位移阈值"，乘 1000/帧毫秒 = 每秒位移阈值，即速度阈值。

---

## 九、FlingSpringAnim：fling 接弹簧

FlingSpringAnim 处理另一种物理动画组合：先 fling（惯性滑动，有摩擦减速），速度降下来后接弹簧拉到目标。典型场景：上滑 AllApps 时松手，列表先惯性冲一段，然后弹簧吸到最终位置。

### 9.1 两段式结构

```java
// FlingSpringAnim.java
public <K> FlingSpringAnim(K object, Context context, FloatPropertyCompat<K> property,
        float startPosition, float targetPosition, float startVelocityPxPerS,
        float minVisChange, float minValue, float maxValue, float damping, float stiffness,
        OnAnimationEndListener onEndListener) {
    ResourceProvider rp = DynamicResource.provider(context);
    float friction = rp.getFloat(R.dimen.swipe_up_rect_xy_fling_friction);  // 摩擦系数从资源读

    mFlingAnim = new FlingAnimation(object, property)                       // 第一段：fling
            .setFriction(friction)
            .setMinimumVisibleChange(minVisChange)
            .setStartVelocity(startVelocityPxPerS)
            .setMinValue(minValue)
            .setMaxValue(maxValue);
    mTargetPosition = targetPosition;

    // 已经过冲了目标，跳过 fling 直接弹簧
    mSkipFlingAnim = startPosition <= minValue && startVelocityPxPerS < 0
            || startPosition >= maxValue && startVelocityPxPerS > 0;

    mFlingAnim.addEndListener(((animation, canceled, value, velocity) -> {
        mSpringAnim = new SpringAnimation(object, property)                 // 第二段：弹簧
                .setStartValue(value)                                       // 从 fling 结束位置开始
                .setStartVelocity(velocity)                                 // 带 fling 剩余速度
                .setSpring(new SpringForce(mTargetPosition)                 // 拉向目标
                        .setStiffness(stiffness)
                        .setDampingRatio(damping));
        mSpringAnim.addEndListener(onEndListener);
        mSpringAnim.animateToFinalPosition(mTargetPosition);
    }));
}
```

两段：FlingAnimation（DynamicAnimation）先跑，结束时（速度降下来或撞到边界）启动 SpringAnimation 拉到目标。弹簧的起始速度等于 fling 结束速度，保证衔接无跳跃。

### 9.2 mSkipFlingAnim：跳过 fling 的优化

```java
mSkipFlingAnim = startPosition <= minValue && startVelocityPxPerS < 0
        || startPosition >= maxValue && startVelocityPxPerS > 0;

public void start() {
    mFlingAnim.start();
    if (mSkipFlingAnim) {
        mFlingAnim.cancel();                // 启动后立即 cancel，触发 endListener 直接进弹簧
    }
}
```

如果起步时已经超过 fling 的边界且速度方向继续外冲，fling 没意义（立即被边界夹住），直接跳到弹簧段。start 后立即 cancel 是为了触发 endListener（FlingAnimation 的 endListener 里才建 SpringAnimation），巧妙复用流程。

### 9.3 updatePosition：动态更新目标

```java
// FlingSpringAnim.java
public void updatePosition(float startPosition, float targetPosition) {
    mFlingAnim.setMinValue(Math.min(startPosition, targetPosition))
            .setMaxValue(Math.max(startPosition, targetPosition));
    mTargetPosition = targetPosition;
    if (mSpringAnim != null) {
        mSpringAnim.animateToFinalPosition(mTargetPosition);   // 弹簧段也能改目标
    }
}
```

动画进行中，外部布局变化导致目标位置变了（比如 AllApps 列表高度变），调 updatePosition 更新。fling 段改边界，弹簧段改最终位置，两边都自适应。

### 面试深问

**Q1：为什么 fling 后要接弹簧，不直接 fling 到目标？**
FlingAnimation 是匀减速，到目标时速度可能不为 0，会硬停（视觉跳变）或过冲后回不来。弹簧能"拉回"，速度自然归零，手感顺滑。两段组合：fling 提供惯性冲量，弹簧提供精确停靠。

**Q2：mSkipFlingAnim 用 start+cancel 而不是直接建弹簧，为什么不绕开？**
FlingAnimation 的 endListener 里才建 SpringAnimation 并设起始值/速度。如果绕开，要重复这段逻辑。start+cancel 复用 endListener 流程，保证起始值（value）和速度（velocity）正确传递。

**Q3：SpringAnimation 和 SpringAnimationBuilder 什么关系？**
SpringAnimation 是 DynamicAnimation 的物理弹簧，自己跑、时长不定。SpringAnimationBuilder 是 Launcher 自己实现的，预计算弹簧曲线成 ValueAnimator，可被手势体系控制。FlingSpringAnim 用前者（fling 段也是 DynamicAnimation，体系一致）；AnimatorPlaybackController 用后者（需要可控进度）。

---

## 十、典型动画案例

### 10.1 图标拖拽尾迹（InterruptibleInOutAnimator）

已在 2.5 节详述。要点：CellLayout 用一组 InterruptibleInOutAnimator 控制 dragOutline 的透明度，拖动时同一槽位无缝接力，避免动画堆叠。

### 10.2 文件夹打开/关闭过渡（FolderAnimationManager）

FolderAnimationManager 是最复杂的业务动画之一。打开文件夹时，文件夹图标位置→展开成完整文件夹，涉及背景色、缩放、位移、reveal 裁剪、图标位移、文字淡入、阴影等多维度同步。

#### 10.2.1 整体结构

```java
// FolderAnimationManager.java
public AnimatorSet createAnimatorSet(boolean isOpening) {
    mIsOpening = isOpening;
    // ... 大量几何计算（initialScale, initialX, initialY 等）

    AnimatorSet a = new AnimatorSet();

    // 1. 文字 alpha（每个图标）
    for (View icon : mFolder.getItemsOnPage(mFolder.mContent.getCurrentPage())) {
        BubbleTextView titleText = getBubbleTextView(icon);
        if (mIsOpening) {
            titleText.setTextVisibility(false);
        }
        ObjectAnimator anim = titleText.createTextAlphaAnimator(mIsOpening);
        anim.addListener(colorResetListener);                        // 结束重置
        play(a, anim);
    }

    // 2. 背景色
    mBgColorAnimator = getAnimator(mFolderBackground, "color", initialColor, finalColor);
    play(a, mBgColorAnimator);

    // 3. 整体位移（从图标位置滑到文件夹位置）
    play(a, getAnimator(mFolder, View.TRANSLATION_X, xDistance, 0f));
    play(a, getAnimator(mFolder, View.TRANSLATION_Y, yDistance, 0f));

    // 4. 内容缩放（从预览缩放到 1.0）
    play(a, getAnimator(mFolder.mContent, SCALE_PROPERTY, initialScale, finalScale));
    play(a, getAnimator(mFolder.mFooter, SCALE_PROPERTY, initialScale, finalScale));

    // 5. reveal 裁剪（背景和内容各一个）
    play(a, shapeDelegate.createRevealAnimator(
            mFolder, startRect, endRect, finalRadius, !mIsOpening));

    // 6. 阴影（中途出现）
    int midDuration = mDuration / 2;
    Animator z = getAnimator(mFolder, View.TRANSLATION_Z, -mFolder.getElevation(), 0);
    play(a, z, mIsOpening ? midDuration : 0, midDuration);

    // 7. 预览图标各自位移+缩放
    addPreviewItemAnimators(a, initialScale / scaleRelativeToDragLayer, ...);

    return a;
}
```

#### 10.2.2 getAnimator：方向自适应

```java
// FolderAnimationManager.java
private Animator getAnimator(View view, Property property, float v1, float v2) {
    return mIsOpening
            ? ObjectAnimator.ofFloat(view, property, v1, v2)         // 打开：v1→v2
            : ObjectAnimator.ofFloat(view, property, v2, v1);        // 关闭：v2→v1（反向）
}
```

打开和关闭用同一套代码，只是起止值对调。这样关闭动画严格是打开动画的逆过程，视觉对称。

#### 10.2.3 reveal 动画：RevealOutlineAnimation

文件夹打开时背景从圆形（图标轮廓）变圆角矩形（文件夹），用 ViewOutlineProvider + 裁剪实现：

```java
// RevealOutlineAnimation.java
public ValueAnimator createRevealAnimator(final View revealView, boolean isReversed,
        float startProgress) {
    ValueAnimator va = isReversed
            ? ValueAnimator.ofFloat(1f - startProgress, 0f)          // 关闭：1→0
            : ValueAnimator.ofFloat(startProgress, 1f);              // 打开：0→1
    final float elevation = revealView.getElevation();

    va.addListener(new AnimatorListenerAdapter() {
        public void onAnimationStart(Animator animation) {
            // 保存原状态，设新的 outline provider 并开启裁剪
            revealView.setOutlineProvider(RevealOutlineAnimation.this);
            revealView.setClipToOutline(true);
        }
        public void onAnimationEnd(Animator animation) {
            // 恢复原状态
            revealView.setOutlineProvider(mOldOutlineProvider);
            revealView.setClipToOutline(mIsClippedToOutline);
        }
    });

    va.addUpdateListener(v -> {
        float progress = (Float) v.getAnimatedValue();
        setProgress(progress);                                       // 子类实现具体形状
        revealView.invalidateOutline();                              // 触发重新计算 outline
    });
    return va;
}
```

RoundedRectRevealOutlineProvider 实现具体的形状插值：

```java
// RoundedRectRevealOutlineProvider.java
@Override
public void setProgress(float progress) {
    mOutlineRadius = (1 - progress) * mStartRadius + progress * mEndRadius;  // 半径线性插值

    mOutline.left = (int) ((1 - progress) * mStartRect.left + progress * mEndRect.left);
    mOutline.top = (int) ((1 - progress) * mStartRect.top + progress * mEndRect.top);
    mOutline.right = (int) ((1 - progress) * mStartRect.right + progress * mEndRect.right);
    mOutline.bottom = (int) ((1 - progress) * mStartRect.bottom + progress * mEndRect.bottom);
}
```

每个边界线性插值，从 startRect 渐变到 endRect。invalidateOutline 让 View 重算 outline 并按新形状裁剪，视觉上就是"圆形撑开成圆角矩形"。

#### 10.2.4 clip 状态保存与恢复

```java
// FolderAnimationManager.java
a.addListener(new AnimatorListenerAdapter() {
    private boolean mFolderClipChildren;        // 动画前保存
    // ...

    @Override
    public void onAnimationStart(Animator animator) {
        mFolderClipChildren = mFolder.getClipChildren();
        // ...
        mFolder.setClipChildren(false);          // 动画时关裁剪，让子 view 能溢出
        mFolder.setClipToPadding(false);
        mContent.setClipChildren(false);
        mCellLayout.setClipToPadding(false);
    }

    @Override
    public void onAnimationEnd(Animator animation) {
        mFolder.setTranslationX(0.0f);           // 结束重置所有变换
        mFolder.mContent.setScaleX(1f);
        // ...
        mFolder.setClipChildren(mFolderClipChildren);  // 恢复裁剪状态
    }
});
```

动画期间关掉裁剪，让图标能"溢出"文件夹边界（预览图标从外部飞入）。结束时恢复，避免影响正常显示。注释特别提到：必须在 onAnimationStart 保存、onAnimationEnd 恢复，因为这两个回调在不同帧执行，保证"取消 A 启动 B"时 A 的 end 能在 B 的 start 前重置状态。

#### 10.2.5 预览图标的同步飞入

```java
// FolderAnimationManager.java 的 addPreviewItemAnimators
for (int i = 0; i < numItemsInPreview; ++i) {
    final View v = itemsInPreview.get(i);
    // 算每个图标在文件夹预览里的位置 → 文件夹展开后的位置
    rule.computePreviewItemDrawingParams(i, numItemsInFirstPagePreview, mTmpParams);

    final float xDistance = previewPosX - vLp.x;     // 要位移的 X
    final float yDistance = previewPosY - vLp.y;     // 要位移的 Y

    Animator translationX = getAnimator(v, View.TRANSLATION_X, xDistance, 0f);
    translationX.setInterpolator(previewItemInterpolator);
    play(animatorSet, translationX);

    Animator scaleAnimator = getAnimator(v, SCALE_PROPERTY, initialScale, finalScale);
    scaleAnimator.setInterpolator(previewItemInterpolator);
    play(animatorSet, scaleAnimator);
}
```

每个预览图标独立算位移和缩放，用单独的 previewItemInterpolator（大文件夹用不同插值器让预览图标"先到位"）。打开时图标从文件夹预览位置飞到各自格子，关闭时反向。这就是"图标从预览展开成网格"的视觉效果来源。

### 10.3 Workspace 翻页的视差（PageTranslationProvider）

视差（parallax）是"前景动得快、背景动得慢"的层次感。Launcher 的 Workspace 翻页通过 PageTranslationProvider 给每页不同位移实现。

#### 10.3.1 默认无位移

```java
// LauncherState.java
protected static final PageTranslationProvider DEFAULT_PAGE_TRANSLATION_PROVIDER =
        new PageTranslationProvider(DECELERATE_2) {
            @Override
            public float getPageTranslation(int pageIndex) {
                return 0;                              // 默认每页不额外位移
            }
        };
```

#### 10.3.2 双屏设备的视差

```java
// LauncherState.java
public PageTranslationProvider getWorkspacePageTranslationProvider(Launcher launcher) {
    if (!(this == SPRING_LOADED || this == EDIT_MODE)
            || !launcher.getDeviceProfile().getDeviceProperties().isTwoPanels()) {
        return DEFAULT_PAGE_TRANSLATION_PROVIDER;      // 非双屏或非编辑态，无视差
    }
    final float quarterPageSpacing = launcher.getWorkspace().getPageSpacing() / 4f;
    return new PageTranslationProvider(DECELERATE_2) {
        @Override
        public float getPageTranslation(int pageIndex) {
            boolean isRtl = launcher.getWorkspace().mIsRtl;
            boolean isFirstPage = pageIndex % 2 == 0;
            // 左页往左偏、右页往右偏，制造分离感
            return ((isFirstPage && !isRtl) || (!isFirstPage && isRtl)) ? -quarterPageSpacing
                    : quarterPageSpacing;
        }
    };
}
```

双屏折叠设备在编辑态时，左右两页分别向外偏移四分之一页间距，强化"两个独立面板"的视觉。这是视差的简化版——不是连续的背景慢移，而是离散的页面分离。

#### 10.3.3 应用到每页

```java
// WorkspaceStateTransitionAnimation.java
private void applyPageTranslation(CellLayout cellLayout, int childIndex,
        PageTranslationProvider pageTranslationProvider, PropertySetter propertySetter,
        StateAnimationConfig config) {
    float pageTranslation = pageTranslationProvider.getPageTranslation(childIndex);
    Interpolator translationInterpolator = config.getInterpolator(
            ANIM_WORKSPACE_PAGE_TRANSLATE_X, pageTranslationProvider.interpolator);
    propertySetter.setFloat(cellLayout, VIEW_TRANSLATE_X, pageTranslation,
            translationInterpolator);                 // 每页设不同 translationX
}
```

遍历 Workspace 的每个 CellLayout（每页），按 pageIndex 取位移值，setFloat 设进去。动画时所有页同步过渡到各自的位移，形成层次。

#### 10.3.4 PageAlphaProvider：每页不同透明度

类似地，每页透明度也可不同（比如第一页固定 pin 的 Widget）：

```java
// LauncherState.java
protected static final PageAlphaProvider DEFAULT_ALPHA_PROVIDER =
        new PageAlphaProvider(ACCELERATE_2) {
            @Override
            public float getPageAlpha(int pageIndex) {
                return 1;                              // 默认全不透明
            }
        };
```

```java
// WorkspaceStateTransitionAnimation.java
private void applyChildState(LauncherState state, CellLayout cl, int childIndex,
        PageAlphaProvider pageAlphaProvider, PropertySetter propertySetter,
        StateAnimationConfig config) {
    float pageAlpha = pageAlphaProvider.getPageAlpha(childIndex);
    // ...
    propertySetter.setFloat(cl.getShortcutsAndWidgets(), VIEW_ALPHA,
            pageAlpha, fadeInterpolator);              // 每页设不同 alpha
}
```

第一页有 pin widget 时，切到 AllApps 那页 alpha 保持较高（`FIRST_PAGE_PINNED_WIDGET_DISABLED_ALPHA = 0.3f`），其他页淡到 0，保证 widget 半透明可见。

### 10.4 AllApps 上滑（AllAppsTransitionController）

AllApps 是从 Workspace 上滑拉出的应用列表。整个过渡由单一变量 `mProgress`（0 到 1）驱动：0=AllApps 完全展开，1=Workspace 完全可见。

#### 10.4.1 mProgress 驱动位移

```java
// AllAppsTransitionController.java
// mProgress = 0：AllApps 容器拉到顶（完全展开）
// mProgress = 1：AllApps 容器拉到底（完全隐藏，显示 Workspace）
private float mShiftRange;      // 随屏幕方向变化
private float mProgress;        // [0, 1]，mShiftRange * mProgress = 实际位移

public void setProgress(float progress) {
    mProgress = progress;
    boolean fromBackground =
            mLauncher.getStateManager().getCurrentStableState() == BACKGROUND_APP;
    // 从其他 app 切来时，允许 AllApps 滑满全屏
    float shiftRange = fromBackground
            ? mLauncher.getDeviceProfile().getDeviceProperties().getHeightPx()
            : mShiftRange;
    getAppsViewProgressTranslationY().setValue(mProgress * shiftRange);   // 位移 = 进度 * 范围
    mLauncher.onAllAppsTransition(1 - progress);                          // 通知 Launcher 进度

    boolean hasScrim = progress < NAV_BAR_COLOR_FORCE_UPDATE_THRESHOLD
            && mLauncher.getAppsView().getNavBarScrimHeight() > 0;
    mLauncher.getSystemUiController().updateUiState(
            UI_STATE_ALL_APPS, hasScrim ? mNavScrimFlag : 0);             // 更新导航栏色
}
```

单一变量驱动一切：位移、Launcher 回调、系统 UI 状态。这是"数据驱动 UI"的典型——状态机或手势只需改 mProgress，视觉自动跟随。

#### 10.4.2 与状态机的对接

```java
// AllAppsTransitionController.java
@Override
public void setState(LauncherState toState) {
    setProgress(state.getVerticalProgress(mLauncher));   // 立即设
}

public void setStateWithAnimation(LauncherState toState,
        StateAnimationConfig config, PendingAnimation animation) {
    // ...
    float targetProgress = toState.getVerticalProgress(mLauncher);
    if (Float.compare(mProgress, targetProgress) == 0) {
        return;                                          // 已在目标，不动
    }
    Animator anim = createSpringAnimation(mProgress, targetProgress);  // 弹簧过渡
    // ...
    animation.add(anim);                                 // 加入 PendingAnimation
}
```

setState（立即）直接 setProgress；setStateWithAnimation（动画）建弹簧 Animator 加入 PendingAnimation，与其他 StateHandler 的动画（Workspace 缩放等）同步播放。

#### 10.4.3 getVerticalProgress：状态到进度

```java
// LauncherState.java
public float getVerticalProgress(Launcher launcher) {
    return 1;                                            // 基类默认：Workspace 可见
}
// ALL_APPS 覆盖：return 0（AllApps 展开）
// NORMAL 不覆盖：return 1
```

每个状态声明自己的 verticalProgress，AllAppsTransitionController 据此驱动。

### 10.5 案例总结表

| 场景 | 主导组件 | 关键机制 |
|------|---------|---------|
| 拖拽尾迹 | InterruptibleInOutAnimator | 可中断接力，避免堆叠 |
| 文件夹开合 | FolderAnimationManager + RevealOutlineAnimation | 多维度同步，reveal 裁剪 |
| 翻页视差 | PageTranslationProvider | 每页不同 translationX |
| AllApps 上滑 | AllAppsTransitionController | 单一 mProgress 驱动 |
| 状态切换 | StateManager + PendingAnimation | 声明式拼装，多 handler 协作 |
| 手势跟随 | AnimatorPlaybackController | setPlayFraction 驱动 |
| 弹性回弹 | SpringAnimationBuilder | 弹簧曲线预计算成 ValueAnimator |

### 面试深问

**Q1：文件夹动画为什么要在 onAnimationStart 才保存 clip 状态，而不是创建 animator 前？**
注释明确：onAnimationStart 和 onAnimationEnd 在不同帧执行。如果取消动画 A 再启动 B，B 的 onAnimationStart 可能在 A 的 onAnimationEnd 之前。在 start 保存、end 恢复，保证 A.end 先于 B.start 执行时，A 已恢复状态，B 读到的是干净状态。

**Q2：AllApps 为什么用单一 mProgress 而不直接动画 translationY？**
解耦。mProgress 是业务进度（0=展开、1=收起），translationY 是视觉表现。中间层让"从其他 app 切来时滑满屏"这种特殊逻辑只改 shiftRange 不改进度语义。同时其他系统（导航栏色）也依赖 mProgress，单变量驱动多消费者。

**Q3：Workspace 视差为什么只在双屏设备启用？**
单屏 Workspace 翻页是整页滑动，本身就有视差感（页间相对运动）。双屏折叠设备两页同时可见，不分离会"粘"在一起像一页，向外偏移强化"两个独立面板"的折叠设备心智。

---

## 十一、辅助工具类

### 11.1 AnimatedFloat：可动画的浮点字段

AnimatedFloat 是"一个能被动画驱动的 float"。它持有当前值 value，提供 animateToValue 产动画，并跟踪当前有没有动画在跑。

```java
// AnimatedFloat.java
public class AnimatedFloat {
    public static final FloatProperty<AnimatedFloat> VALUE =
            new FloatProperty<AnimatedFloat>("value") {
                @Override
                public void setValue(AnimatedFloat obj, float v) {
                    obj.updateValue(v);
                }
                @Override
                public Float get(AnimatedFloat obj) {
                    return obj.value;
                }
            };

    private final Consumer<Float> mUpdateCallback;
    private ObjectAnimator mValueAnimator;
    private Float mEndValue;                            // 动画进行时的目标值

    public float value;                                 // 当前值，可直接访问

    public ObjectAnimator animateToValue(float start, float end) {
        cancelAnimation();                              // 先取消旧动画
        mValueAnimator = ObjectAnimator.ofFloat(this, VALUE, start, end);
        mValueAnimator.addListener(new AnimatorListenerAdapter() {
            @Override
            public void onAnimationStart(Animator animator) {
                if (mValueAnimator == animator) {
                    mEndValue = end;                    // 记目标值
                }
            }
            @Override
            public void onAnimationEnd(Animator animator) {
                if (mValueAnimator == animator) {
                    mValueAnimator = null;
                    mEndValue = null;
                }
            }
        });
        return mValueAnimator;
    }

    public void updateValue(float v) {
        if (Float.compare(v, value) != 0) {             // 值变了才回调
            value = v;
            mUpdateCallback.accept(value);
        }
    }

    public void cancelAnimation() {
        if (mValueAnimator != null) {
            mValueAnimator.cancel();
            if (mValueAnimator != null) {               // null 检查防 onAnimationEnd 里置 null
                mValueAnimator.setValues();             // 清属性值，防 APC 的 setCurrentFraction 再触发
                mValueAnimator = null;
            }
        }
    }
}
```

设计要点：

- **VALUE 是 FloatProperty**：可被 ObjectAnimator 驱动，也能被 AnimatorPlaybackController 的 setCurrentFraction 控制。
- **mEndValue 跟踪目标**：isAnimatingToValue 判断"是否在动画到某值"，避免重复启动同目标动画。
- **cancelAnimation 清 setValues**：注释解释，清空属性值后，AnimatorPlaybackController 再调 setCurrentFraction 不会触发 updateValue，防止已取消的动画被"幽灵"驱动。
- **updateValue 值相等不回调**：避免无谓的通知。

### 11.2 AnimationSuccessListener：成功才回调

```java
// AnimationSuccessListener.java
public abstract class AnimationSuccessListener extends AnimatorListenerAdapter {
    protected boolean mCancelled = false;

    @Override
    @CallSuper
    public void onAnimationCancel(Animator animation) {
        mCancelled = true;                              // 标记取消
    }

    @Override
    public void onAnimationEnd(Animator animation) {
        if (!mCancelled) {                              // 非取消才算成功
            onAnimationSuccess(animation);
        }
    }

    public abstract void onAnimationSuccess(Animator animator);
}
```

区分"自然结束"和"被取消"。业务常常只想在动画正常播完时执行副作用（比如切换状态），取消时不该执行。继承这个类只实现 onAnimationSuccess 即可。

### 11.3 AnimatorListeners：常用监听器工厂

```java
// AnimatorListeners.java
public static AnimatorListener forSuccessCallback(Runnable callback) {
    return new RunnableSuccessListener(callback);       // 成功才跑
}

public static AnimatorListener forEndCallback(Consumer<Boolean> callback) {
    return new EndStateCallbackWrapper(callback);       // 结束（含取消）都跑，传成功与否
}

public static AnimatorListener forEndCallback(Runnable callback) {
    return new AnimatorListenerAdapter() {              // 结束就跑，不关心成功
        @Override
        public void onAnimationEnd(Animator animation) {
            callback.run();
        }
    };
}
```

三种语义：成功回调、带状态的结束回调、纯结束回调。EndStateCallbackWrapper 用 `SUCCESS_TRANSITION_PROGRESS = 0.5f` 判断成功：

```java
// AnimatorListeners.java 的 EndStateCallbackWrapper
@Override
public void onAnimationEnd(Animator anim) {
    if (!mListenerCalled) {
        mListenerCalled = true;
        mListener.accept(anim instanceof ValueAnimator
                ? ((ValueAnimator) anim).getAnimatedFraction() > SUCCESS_TRANSITION_PROGRESS
                : true);                                // fraction>0.5 算成功
    }
}
```

动画播到一半以上就算"成功过渡"，这是 Launcher 的业务约定——手势拖过半松手就算切到目标状态。

### 11.4 PropertyListBuilder：属性列表构建器

```java
// PropertyListBuilder.java
public PropertyListBuilder translationX(float value) {
    mProperties.add(PropertyValuesHolder.ofFloat(View.TRANSLATION_X, value));
    return this;
}

public PropertyListBuilder scale(float value) {
    return scaleX(value).scaleY(value);                 // 同时加 X 和 Y
}

public ObjectAnimator build(View view) {
    return ObjectAnimator.ofPropertyValuesHolder(view,
            mProperties.toArray(new PropertyValuesHolder[mProperties.size()]));
}
```

用 PropertyValuesHolder 把多个属性打包进一个 ObjectAnimator，比多个 Animator 高效（一次更新计算所有属性）。

### 11.5 PropertyResetListener：结束重置属性

```java
// PropertyResetListener.java
public class PropertyResetListener<T, V> extends AnimatorListenerAdapter {
    private Property<T, V> mPropertyToReset;
    private V mResetToValue;

    @Override
    public void onAnimationEnd(Animator animation) {
        mPropertyToReset.set((T) ((ObjectAnimator) animation).getTarget(), mResetToValue);
    }
}
```

动画结束后把某属性强制重置到指定值。Folder 里给文字 alpha 加这个，保证动画结束文字 alpha 回到 1（可点击状态），即使动画中途被取消。

### 面试深问

**Q1：AnimatedFloat 的 cancelAnimation 为什么要 setValues() 清空？**
注释明说：防止 AnimatorPlaybackController 的 setCurrentFraction 继续触发。APC 持有子动画引用，cancel 后 APC 不知道，仍可能调 setCurrentFraction。setValues() 清空属性值后，setCurrentFraction 找不到目标属性，updateValue 不触发，避免幽灵更新。

**Q2：SUCCESS_TRANSITION_PROGRESS=0.5 为什么是 0.5 而不是 1？**
手势场景下，动画可能没跑到 1 就结束（比如 APC.end()）。0.5 是业务阈值——拖过半就算意图切换。这和 LauncherAnimUtils.SUCCESS_TRANSITION_PROGRESS 一致，全 Launcher 统一。

**Q3：PropertyListBuilder 比 multiple ObjectAnimator 好在哪？**
PropertyValuesHolder 在一个 ObjectAnimator 内共享时间轴和插值器，一次 setValue 调用更新多个属性，减少对象创建和回调次数。多个 ObjectAnimator 各自独立，开销大且同步要靠 AnimatorSet。

---

## 十二、设计哲学总结

### 12.1 分层与抽象

Launcher 动画系统五层：

1. **属性层**（LauncherAnimUtils、MultiScalePropertyFactory）：定义"能动画什么"。
2. **插值与优化层**（LogInterpolators、FirstFrameAnimatorHelper）：定义"怎么动得自然"。
3. **设置抽象层**（PropertySetter、AnimatedPropertySetter）：定义"怎么统一动画与立即"。
4. **组装层**（PendingAnimation）：定义"怎么声明一组动画"。
5. **控制层**（AnimatorPlaybackController、SpringAnimationBuilder）：定义"怎么用手势/物理驱动"。

每层只解决一个问题，上层复用下层。业务代码（WorkspaceStateTransitionAnimation 等）只关心"要什么效果"，底层细节由框架处理。

### 12.2 数据驱动

多处体现：AllApps 的 mProgress、AnimatorPlaybackController 的 mCurrentFraction、MultiScalePropertyFactory 的多源乘积。状态/进度是单一数据源，视觉是数据的函数。手势、状态机、自动播放都改数据，UI 自动响应。这比"命令式地逐个 set 属性"健壮得多。

### 12.3 声明式拼装

PendingAnimation 是声明式的代表：不关心动画怎么播，只描述"这些动画一起跑"。StateManager 的 createAtomicAnimation 用它收集所有 StateHandler 的动画，最后统一构建。新增一个 StateHandler 不影响其他，扩展性强。

### 12.4 可控与物理的统一

SpringAnimationBuilder 把物理弹簧预计算成可控 ValueAnimator，FlingSpringAnim 用 DynamicAnimation 原生物理。两者在不同场景各司其职：手势体系内要可控（SpringAnimationBuilder），纯松手惯性要原生物理（FlingSpringAnim）。统一在于都产出符合 AnimatorPlaybackController 接口的动画。

### 12.5 防御性设计

- FirstFrameAnimatorHelper 的 MAX_DELAY 防死等。
- AnimatedFloat 的 setValues 防幽灵更新。
- PropertyResetListener 防取消后状态错乱。
- ClampedProperty 防超界。
- AlphaUpdateListener 的阈值 0.01 防浮点残留。

每个边界条件都有对应防御，保证动画在各种异常（取消、重叠、前后台切换）下不出错。

### 面试深问

**Q1：Launcher 动画系统最核心的抽象是什么？**
AnimatorPlaybackController。它把"动画"和"进度控制"解耦——任何 AnimatorSet 都能被包装成"可用 fraction 控制"的播放器。这让同一套动画既支持自动播放也支持手势拖动，是手势跟随的基础。

**Q2：为什么 Launcher 不用 Android 的 Transition 框架？**
Transition 框架面向"布局变化"，自动 diff 场景树。Launcher 的动画是"状态机驱动"的，变化点明确（状态切换），且需要精细控制（手势跟随、弹簧）。Transition 的自动 diff 太重且不可控，Launcher 选择自己造轻量可控的轮子。

**Q3：如果新增一个动画效果（比如图标抖动），该接到哪一层？**
看性质。如果是状态切换的一部分，接到 StateHandler 的 setStateWithAnimation，用 PendingAnimation 声明。如果是独立交互（长按抖动），直接在 DragLayer 或对应 View 用 ObjectAnimator + 合适插值器，可选用 FirstFrameAnimatorHelper 优化首帧。不需要动核心框架层。
