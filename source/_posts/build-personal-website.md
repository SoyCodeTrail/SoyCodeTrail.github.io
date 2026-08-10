---
title: 一台服务器搭起个人技术博客：Vue3 + Supabase + Nginx 全栈实战
category: client
platform: web
tags: ["Vue3", "Nginx", "Supabase", "部署", "全栈"]
readTime: 20分钟
featured: true
date: 2026-07-28
---

一台云服务器（2 核 2G 就够），一个 Vue3 前端，一个 Supabase 后端，一个 Nginx 做反向代理——整套个人技术博客就跑起来了。这篇文章把从零到上线的完整流程拆开讲，包括前端构建、后端配置、Nginx 反代、博客发布系统。

## 技术选型：为什么是这套组合

| 层 | 技术 | 选型理由 |
|----|------|---------|
| 前端 | Vue 3 + Vite | 轻量、构建快、生态成熟 |
| 后端 | Supabase（PostgreSQL）| 免费额度够用、自带认证和 REST API、不用自己维护数据库 |
| AI 服务 | 智谱 GLM API | 国内可直连、有免费额度 |
| Web 服务器 | Nginx | 静态文件 + 反向代理，2G 内存跑得飞起 |
| 服务器 | 腾讯云轻量 2C2G | 便宜、香港节点免备案 |

核心思路：**前端是纯静态文件（dist/），后端用 Supabase 云数据库，服务器只跑 Nginx + 一个 Node.js AI 代理**。这样服务器负载极低，2G 内存绰绰有余。

## 第一步：服务器准备

### 买服务器

腾讯云/阿里云的轻量应用服务器都行，选最便宜的 2 核 2G。如果不想备案，选香港或海外节点。

系统选 Ubuntu 22.04 LTS。

### 初始化 SSH

```bash
# 本地生成密钥对（如果还没有）
ssh-keygen -t ed25519 -C "your_email@example.com"

# 通过云控制台的 VNC 终端登录服务器，添加公钥
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo '你的公钥内容' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

然后本地配 SSH 别名，省得每次输 IP：

```bash
# ~/.ssh/config
Host my-server
    HostName 你的服务器IP
    User ubuntu
    IdentityFile ~/.ssh/id_ed25519
```

之后 `ssh my-server` 就能连上。

### 禁用密码登录（安全加固）

```bash
# 服务器上
sudo sed -i 's/PasswordAuthentication yes/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart sshd
```

## 第二步：前端项目搭建

### 创建 Vue3 项目

```bash
npm create vite@latest my-blog -- --template vue-ts
cd my-blog
npm install
```

### 安装核心依赖

```bash
# Supabase 客户端
npm install @supabase/supabase-js

# 路由和状态管理
npm install vue-router pinia

# Markdown 渲染（博客文章用）
npm install markdown-it

# UI 增强
npm install highlight.js katex
```

### 项目结构

```
src/
├── views/           # 页面组件
│   ├── HomeView.vue
│   ├── BlogCategoryView.vue   # 博客分类页
│   └── BlogPostView.vue       # 文章详情页
├── api/
│   └── blog.ts      # Supabase 文章查询
├── data/
│   └── blog.ts      # 分类/平台静态数据
├── router/
│   └── index.ts     # 路由配置
├── layouts/
│   └── AppLayout.vue # 导航布局
└── lib/
    └── supabase.ts   # Supabase 客户端
```

### Supabase 客户端配置

```typescript
// src/lib/supabase.ts
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
```

环境变量 `.env.production`：

```bash
VITE_SUPABASE_URL=https://你的项目.supabase.co
VITE_SUPABASE_ANON_KEY=你的anon_key
```

## 第三步：Supabase 后端配置

### 创建 articles 表

在 Supabase Dashboard 的 SQL Editor 里执行：

```sql
create table if not exists public.articles (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  excerpt text,
  content text,
  category_slug text,
  tags text[] default '{}',
  author_id uuid,
  is_published boolean default false,
  is_featured boolean default false,
  view_count integer default 0,
  like_count integer default 0,
  published_at timestamptz,
  created_at timestamptz default now()
);

-- 启用行级安全
alter table public.articles enable row level security;

-- 只允许读取已发布的文章
create policy "articles_read_published"
  on public.articles for select
  using (is_published = true);
```

### 获取 API Key

在 Supabase Dashboard → Settings → API 里拿到：
- **Project URL**：`https://xxx.supabase.co`
- **anon key**：前端用（受 RLS 保护）
- **API key（sb_secret_）**：脚本发布用（绕过 RLS）

## 第四步：博客发布系统

### 发布脚本

在项目根目录创建 `scripts/publish-blog.mjs`，核心逻辑：

1. 读取 `posts/` 下的 Markdown 文件
2. 解析 frontmatter（标题、分类、标签）
3. 通过 Supabase REST API 写入 articles 表
4. 同标题文章自动更新

### 写文章格式

```markdown
---
title: 文章标题
category: client
platform: android
tags: ["标签1", "标签2"]
readTime: 10分钟
---

## 正文从二级标题开始

正文内容...
```

### 发布命令

```bash
# 发布
node scripts/publish-blog.mjs posts/文章.md

# 存草稿
node scripts/publish-blog.mjs posts/文章.md --draft

# 查看所有文章
node scripts/publish-blog.mjs --list
```

发布后网站实时显示，不用重新构建。

## 第五步：Nginx 配置

### 安装 Nginx

```bash
sudo apt update
sudo apt install -y nginx
```

### 站点配置

```nginx
# /etc/nginx/sites-enabled/my-blog.conf
server {
    listen 80;
    server_name 你的域名或IP;

    root /var/www/my-blog/dist;
    index index.html;

    # 静态文件压缩
    gzip_static on;
    gzip on;
    gzip_types text/plain text/css application/javascript application/json;

    # 上传大小限制
    client_max_body_size 20m;

    # API 反向代理（如果需要后端服务）
    location /api {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # SPA 路由兜底（关键）
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

`try_files $uri $uri/ /index.html` 这行是重点——Vue Router 的 history 模式要求所有路由都回到 index.html，没有这行刷新子路由会 404。

### 启用站点

```bash
sudo ln -s /etc/nginx/sites-available/my-blog.conf /etc/nginx/sites-enabled/
sudo nginx -t          # 测试配置
sudo systemctl reload nginx
```

## 第六步：部署前端

### 本地构建

```bash
cd ~/my-blog
npm run build
# 生成 dist/ 目录
```

### 上传到服务器

```bash
# 打包上传
scp -r dist/* my-server:/tmp/blog-dist/

# 服务器上替换
ssh my-server << 'EOF'
sudo rm -rf /var/www/my-blog/dist.bak
sudo mv /var/www/my-blog/dist /var/www/my-blog/dist.bak
sudo mkdir -p /var/www/my-blog/dist
sudo cp -r /tmp/blog-dist/* /var/www/my-blog/dist/
sudo chown -R www-data:www-data /var/www/my-blog/dist
sudo systemctl reload nginx
rm -rf /tmp/blog-dist
EOF
```

### 部署脚本（一键发布）

写个脚本把构建+上传+替换一键搞定：

```bash
#!/bin/bash
# deploy.sh
cd ~/my-blog
npm run build
scp -r dist/* my-server:/tmp/blog-dist/
ssh my-server "sudo rm -rf /var/www/my-blog/dist.bak && \
  sudo mv /var/www/my-blog/dist /var/www/my-blog/dist.bak && \
  sudo mkdir -p /var/www/my-blog/dist && \
  sudo cp -r /tmp/blog-dist/* /var/www/my-blog/dist/ && \
  sudo chown -R www-data:www-data /var/www/my-blog/dist && \
  sudo systemctl reload nginx && \
  rm -rf /tmp/blog-dist"
echo "✅ 部署完成"
```

之后改完代码跑一下 `./deploy.sh` 就行。

## 第七步：Node.js 后端服务（可选）

如果需要 AI 代理或其他后端接口，用 systemd 管理一个 Node.js 进程：

### 服务文件

```ini
# /etc/systemd/system/blog-server.service
[Unit]
Description=Blog API Server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/opt/blog-server
ExecStart=/usr/bin/node /opt/blog-server/index.js
Restart=always
RestartSec=10
EnvironmentFile=/etc/blog-server.env

[Install]
WantedBy=multi-user.target
```

### 环境变量

```bash
# /etc/blog-server.env
AI_API_KEY=你的API密钥
AI_BASE_URL=https://open.bigmodel.cn/api/paas/v4
PORT=8787
```

### 启动

```bash
sudo systemctl enable blog-server
sudo systemctl start blog-server
sudo systemctl status blog-server
```

开机自动启动，挂了自动重启。

## 第八步：域名与 HTTPS（可选）

### 配置域名 DNS

在域名服务商那里加 A 记录，指向服务器 IP。

### 申请 HTTPS 证书

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 你的域名.com
```

Certbot 会自动修改 Nginx 配置、申请证书、设置自动续期。一步到位。

## 整体架构图

```
用户浏览器
    │
    ▼
  Nginx (80/443)
    ├── 静态文件 → /var/www/my-blog/dist/
    └── /api/* → 反代到 127.0.0.1:8787 (Node.js)
                    │
                    ▼
                AI API（智谱 GLM）

前端 Vue3
    │
    ▼
  Supabase（云端）
    └── articles 表（博客文章）
```

## 成本估算

| 项目 | 费用 |
|------|------|
| 云服务器 2C2G | 约 50-100 元/月 |
| 域名 | 约 50-80 元/年 |
| Supabase | 免费额度（500MB 数据库 + 50K 请求/月）|
| AI API | 智谱 GLM 有免费额度 |
| Nginx / Node.js | 开源免费 |
| **总计** | **约 60-110 元/月** |

## 常见问题

### 刷新页面 404

Nginx 缺少 `try_files $uri $uri/ /index.html`。Vue Router history 模式必须配这行。

### 文章发布了网站看不到

检查 articles 表的 `is_published` 是不是 `true`。RLS 策略只允许读已发布的。

### Nginx 502

后端 Node.js 服务挂了。`sudo systemctl status blog-server` 查状态，看日志 `sudo journalctl -u blog-server -n 50`。

### SSH 连不上

检查安全组有没有开 22 端口。如果禁了密码登录又丢了密钥，用云控制台的 VNC 终端进去恢复。

## 这套方案适合谁

- 想搭个人博客但不想花太多钱的开发者
- 前端会 Vue/React，后端不想自己维护数据库的
- 想要博客发布系统（写 Markdown 跑脚本就发布）的
- 预算每月 100 元以内的

整个搭建过程大概一个周末能搞定。最花时间的不是写代码，是配 Nginx 和调通 Supabase 的 RLS 策略。
