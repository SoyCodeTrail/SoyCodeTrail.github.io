---
title: 拾错本 - AI 智能错题本 App
category: vibe-coding
platform: vibe-works
tags: ["Flutter", "Dart", "GLM-4V"]
excerpt: 拍照采集错题，AI 自动识别题目内容和科目，支持举一反三、试卷组卷、PDF 打印导出。
screenshot: ""
demoUrl: "https://soycodetrail.top/拾错本.apk"
repoUrl: "https://github.com/soycodetrail/smart-wrong-book"
techStack: ["Flutter 3.44", "Dart", "智谱 GLM-4V", "百度 OCR", "Provider"]
_type: project
date: 2026-07-28
---

## 项目简介

给孩子用的智能错题本 App。拍试卷上的错题，AI 自动识别题目文字、科目、难度，生成解题分析。支持举一反三、分类管理、试卷 PDF 打印、多供应商切换。

## 技术亮点

- **双引擎架构**：图片识别引擎（GLM-4V/百度OCR）与智能助手引擎（GLM-4-Flash/DeepSeek）独立配置
- **PDF 终极排版**：中文字体离线打包、图片自适应缩放、试卷模式答题区、随机励志名言
- **举一反三**：AI 基于错题生成变式题，可收入错题本
- **多平台编译**：Android + Web + macOS，GitHub Actions 自动构建

## 开发过程

全程用 AI 辅助开发，从项目搭建到功能实现到 Bug 修复，AI 完成了约 80% 的代码编写。用 Claude Code 做主力，配合手动调试和测试。3 天从零到可用。
