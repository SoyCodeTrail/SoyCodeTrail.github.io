---
title: Launcher3 源码精读：从数据加载到 UI 渲染的完整链路
category: client
platform: android
tags: ["AOSP", "Launcher", "源码", "Framework"]
readTime: 20分钟
featured: true
date: 2026-07-28
---

# Launcher3 源码精读：数据加载到 UI 渲染

基于 AOSP android-16.0.0_r4 源码，拆解 Launcher 的核心架构。

## 整体架构

Launcher3 采用经典的 MVC 分层：

- **Model**：`LauncherModel` + `BgDataModel`，后台线程加载数据
- **View**：`Workspace` / `CellLayout` / `BubbleTextView`
- **Controller**：`Launcher` Activity 统一调度

## 数据加载流程

### LoaderTask 五步流水线

```
LoaderTask.run()
  → loadWorkspace()      读 favorites 表
  → loadAllApps()        查 PackageManager
  → loadDeepShortcuts()  查 ShortcutManager
  → bindWorkspace()      回主线程渲染
```

### BgDataModel 核心数据结构

```java
class BgDataModel {
    val itemsIdMap = mutableMapOf<Int, ItemInfo>()  // id → 桌面项
    val workspaceItems = mutableListOf<WorkspaceItemInfo>()
    val appWidgets = mutableListOf<LauncherAppWidgetInfo>()
    val folders = mutableMapOf<Long, FolderInfo>()
}
```

## ItemInfo 继承体系

| 类 | 用途 |
|----|------|
| `ItemInfo` | 基类（cellX/cellY/container）|
| `WorkspaceItemInfo` | 桌面快捷方式 |
| `LauncherAppWidgetInfo` | 小组件 |
| `FolderInfo` | 文件夹 |

### container 字段映射

| 值 | 含义 |
|----|------|
| -100 | 桌面（CONTAINER_DESKTOP）|
| -101 | 底部栏（CONTAINER_HOTSEAT）|
| 正数 | 文件夹（folder.id）|

## 关键设计

### 为什么用 LoaderTask 而不是 LiveData

应用可能有几百个图标，同步加载会卡 UI。LoaderTask 在后台线程跑完五步后，通过 `BaseLauncherBinder` 回主线程批量 bind。

### WorkspaceData sealed class

新版用 Kotlin sealed class 实现可变/不可变双态快照，跨线程安全传递。
