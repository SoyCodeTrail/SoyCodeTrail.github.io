# 豆奶与程序猫 · 技术博客

> Android 系统开发 / Flutter / Vue / AI 编程的实战笔记与学习路线。

🌐 **在线访问**：https://soycodetrail.github.io

---

## 👋 关于我 / 关注我

我是 **豆奶与程序猫**，一个喜欢把踩过的坑写成笔记的技术人。如果文章内容对你有帮助，欢迎在下面任意平台找到我，一起交流学习 👇

| 平台 | 账号 / 方式 |
|------|------------|
| 💬 **微信** | `Yishisiweikongjian`（扫码或搜索添加，备注「学习」更快通过） |
| 📕 **小红书** | [豆奶与程序猫](https://www.xiaohongshu.com/search_result?keyword=%E8%B1%86%E5%A5%B6%E4%B8%8E%E7%A8%8B%E5%BA%8F%E7%8C%AB)（搜索关注，私信“邀请码”领取学习资源） |
| 📧 **邮箱** | 1019296134@qq.com |
| 💻 **GitHub** | [@soycodetrail](https://github.com/soycodetrail) |

> 每篇文章的**末尾**都放了微信二维码和小红书入口，看到喜欢的文章顺手关注一下就好～

---

## 📚 文章导航（31 篇）

博客内容涵盖以下几条主线，完整列表见站点 [首页](https://soycodetrail.github.io) 与 [标签页](https://soycodetrail.github.io/tags/)：

- **Android 系统 / Framework**：AOSP 源码下载与编译、SystemUI、Launcher3 系列（架构 / 布局 / 数据模型 / 拖拽 / 动画 / 通知 等 15 篇）、Boot 到 Launcher 全流程
- **跨端开发**：Flutter 全栈指南、Flutter 多端架构、Dart/动画
- **前端 / 全栈**：Vue3 + Supabase + Nginx 个人博客搭建、Vibe Coding 建站
- **AI / 编程入门**：零基础学 AI 与编程路线、LLM Agent 开发、Claude Code 图表技能、Vibe Coding 工具集

---

## 🛠️ 技术栈

- 静态站点生成器：[Hexo](https://hexo.io)
- 托管：[GitHub Pages](https://pages.github.com)（用户页 `soycodetrail.github.io`）
- 部署：源码在 `source` 分支，`hexo deploy` 一键把构建产物发布到 `master` 分支（GitHub Pages 服务分支）
  - 注：因当前 GitHub 令牌缺少 `workflow` 作用域，未使用 GitHub Actions CI；后续若授予该作用域，可切回 Actions 自动部署
- RSS 订阅：`/atom.xml` · 站点地图：`/sitemap.xml`

---

## 💻 本地预览 / 修改

```bash
npm install          # 安装依赖
npm run server       # 本地预览 http://localhost:4000
npm run build        # 生成静态文件到 public/
```

新增文章：把 `.md` 文件放进 `source/_posts/`，frontmatter 示例：

```markdown
---
title: 文章标题
category: client          # 分类
tags: ["标签1", "标签2"]
readTime: 15分钟
date: 2026-08-11
---

正文…
```

---

## 📄 许可证

文章版权归作者所有，转载请注明出处并保留署名。
