---
title: Launcher3 源码精读（00）：总览与阅读指南
category: client
platform: android
tags: ["AOSP", "Launcher3", "源码", "Framework"]
readTime: 15分钟
featured: true
date: 2026-08-02
---

# 00 - Launcher3 源码精读总览

> 精读 AOSP Launcher3 源码，把"做过 Launcher"升级为"懂 Launcher 原理"
> 源码版本：android-16.0.0_r4（`~/aosp-r4/packages/apps/Launcher3`）
> 用途：面试讲解素材 + 对照荣耀 MagicOS Launcher 的设计差异
> 飞书知识库：https://zcn93dhcbthz.feishu.cn/wiki/X5irwPfgjiSRdGklFBPchPo4nMh

## 📚 13 大模块文档

| 文档 | 行数 | 核心内容 |
|------|------|---------|
| [[01-核心架构]] | 1778 | Launcher/LauncherModel/LoaderTask/Provider |
| [[02-桌面布局]] | 2038 | Workspace/CellLayout/Hotseat/DeviceProfile |
| [[03-数据模型]] | 1957 | BgDataModel/ItemInfo/IconCache/加载流程 |
| [[04-应用抽屉]] | 2603 | AllApps/排序/搜索/A-Z 滚动条 |
| [[05-拖拽机制]] | 2048 | DragController/DropTarget/重排/跨屏 |
| [[06-状态机]] | 1748 | LauncherState/StateManager/动画切换 |
| [[07-快捷方式与小组件]] | 2149 | Popup/Deep Shortcut/Widget/resize |
| [[08-文件夹机制]] | 1996 | Folder/FolderIcon/创建/开合动画/预览 |
| [[09-动画系统]] | 1997 | PendingAnimation/PropertySetter/弹簧/对数插值 |
| [[10-触摸与手势]] | 1501 | DragLayer分发/TouchController/滑动检测/长按 |
| [[11-自定义视图]] | 1833 | BubbleTextView/FloatingView/DropTargetBar |
| [[12-图标与通知系统]] | 2178 | IconCache/FastBitmapDrawable/红点/AdaptiveIcon |
| [[13-包管理与安装]] | 1379 | 安装监听/承诺图标/ItemInstallQueue |

**总计：约 23000 行，覆盖 Launcher3 全部核心模块。**

## 📐 补充时序图

- [[14-应用启动与远程动效时序图]] — 点击图标 → Launcher 附带 RemoteAnimation runner → ATMS/WMS Transitions → Shell 兼容桥接 → 图标→应用窗口展开动效（aosp-r4 / Android 16，新旧 API 桥接细节已核对）

## 关键认知（读完应掌握）

### 数据流（最重要）
```
数据库 favorites 表
  ↓ LoaderTask 查询（后台线程）
BgDataModel（内存数据结构：itemsIdMap）
  ↓ BaseLauncherBinder（主线程）
Workspace/CellLayout（UI 渲染）
```

### 视图层级
```
Launcher (Activity)
└─ LauncherRootView
   └─ DragLayer（触摸总控 + 浮层容器）
      ├─ Workspace（多屏桌面）
      │  └─ CellLayout（单页网格）
      │     └─ ShortcutAndWidgetContainer
      │        └─ BubbleTextView（应用图标）
      ├─ Hotseat（底部栏）
      ├─ DropTargetBar（拖拽时的删除栏）
      └─ AbstractFloatingView（Folder/AllApps/Popup 等浮层）
```

### 这个版本（r4）相比旧教程的关键差异

1. **BgDataModel 已 Kotlin 化**，新增 WorkspaceData sealed class
2. **LauncherAppState 已废弃**，改用 Dagger 注入
3. **container 字段**：CONTAINER_DESKTOP=-100、HOTSEAT=-101、ALL_APPS_PREDICTION=-102，文件夹是动态 folder.id
4. **IconCache 下沉到 iconloaderlib**（SystemUI 共享）
5. **通知系统重构**：NotificationRepository + ListenableStream
6. **包监听改用 LauncherApps.Callback**（不再用 PackageInstalledReceiver）

## 与荣耀 Launcher 的对照

| AOSP Launcher3 | 荣耀 MagicOS Launcher |
|---------------|----------------------|
| LoaderTask 异步加载 | 你用协程重构，主线程负载降 20% |
| IconCache 两级缓存 | 你用 HPROF+MD5 分析过 Bitmap 内存 |
| DeviceProfile 网格适配 | 你适配过折叠屏/平板 |
| LauncherModel 单线程 | 你建过自动化性能平台 |
| favorites ContentProvider | 你做过解耦上架 SDK 化 |

## 源码索引

```
~/aosp-r4/packages/apps/Launcher3/src/com/android/launcher3/
├── Launcher.java              主 Activity
├── LauncherModel.kt           数据模型
├── LauncherProvider.java      数据库
├── Workspace.java             桌面分页
├── CellLayout.java            单页网格
├── Hotseat.java               底部栏
├── DeviceProfile.java         设备适配
├── BubbleTextView.java        应用图标视图
├── model/                     数据层
├── allapps/                   应用抽屉
├── dragndrop/                 拖拽
├── folder/                    文件夹
├── anim/                      动画
├── touch/                     触摸
├── statemanager/              状态机
├── states/                    具体状态
├── views/                     自定义视图
├── icons/                     图标缓存
├── graphics/                  图形渲染
├── notification/              通知红点
└── pm/                        包管理
```
