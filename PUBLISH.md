# Chrome Web Store 发布指南

## 一、准备工作

### 1. 注册开发者账号

1. 访问 [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. 使用 Google 账号登录
3. 支付一次性 **$5** 开发者注册费
4. 完成开发者账号设置

### 2. 启用隐私政策托管（GitHub Pages）

隐私政策是 **必需** 的（因为扩展申请了 `<all_urls>` 权限）。已创建 `docs/privacy-policy.html`。

启用步骤：

1. 打开 GitHub 仓库 → **Settings** → **Pages**
2. Source 选择 **Deploy from a branch**
3. Branch 选择 `main`，文件夹选择 `/docs`，点击 **Save**
4. 等待约 1-2 分钟，访问 `https://pipi32167.github.io/SmartReader/privacy-policy.html` 确认可用

> 该链接将在 Chrome Web Store 的「隐私政策」字段中填写。

---

## 二、准备商店素材

### 必需素材

| 素材 | 规格 | 数量 | 说明 |
|------|------|------|------|
| **商店图标** | 128×128 PNG | 1 张 | ✅ 已准备 (`public/icons/icon128.png`) |
| **截图** | 1280×800 或 640×400 | 至少 1 张，最多 5 张 | 需手动截取，见下方说明 |
| **扩展描述** | 文本 | 1 份 | 见下方模板 |
| **隐私政策链接** | URL | 1 个 | `https://pipi32167.github.io/SmartReader/privacy-policy.html` |
| **联系邮箱** | 邮箱 | 1 个 | 你的邮箱地址 |

### 截图要求

需要在真实浏览器环境中使用扩展并截图。推荐尺寸 **1280×800**（或 640×400）。

建议截取以下场景（至少 1-2 张）：

1. **Popup 界面**：点击扩展图标，展示提示词列表和自定义输入区域
2. **Sidepanel 界面**：选择一个提示词后，AI 正在生成或已完成总结的侧边面板
3. **Options 设置页**：展示 API 配置和提示词管理界面
4. **Markdown 输出**：展示生成的格式化 Markdown 内容

> 💡 截图必须展示扩展的真实使用场景，不要使用占位图。

### 可选素材

| 素材 | 规格 | 说明 |
|------|------|------|
| **推广图片** | 440×280 PNG/JPEG | 在商店中展示的小图 |
| **Marquee 横幅** | 1400×560 PNG/JPEG | 商店详情页顶部大图 |
| **宣传视频** | YouTube 链接 | 可选，可提升转化率 |

---

## 三、扩展描述模板

复制以下内容到 Chrome Web Store 的「详细描述」字段：

```
SmartReader 是一款基于 Chrome Extension Manifest V3 的 AI 阅读助手，帮助你在浏览网页时快速获取内容摘要、深入分析，并通过 AI 回答你的任何问题。

## 核心功能

📝 **网页内容总结**
一键将当前网页内容提取为 Markdown，发送到你配置的 AI API（OpenAI、Claude、Kimi 等兼容端点），获得精炼的总结。

💬 **智能问答**
不仅总结，还能基于网页内容回答你的特定问题。支持多轮对话，在侧边面板中连续追问。

📄 **PDF 支持**
遇到 PDF 页面？SmartReader 自动提取文本内容并同样支持 AI 总结与问答。

⚡ **流式响应**
AI 回答实时逐字显示在侧边面板，无需等待完整响应。

🎯 **自定义提示词**
在设置页面创建、编辑和管理你的专属提示词模板。支持 ${html}（网页内容）和 ${text}（选中文字）变量。

📜 **对话历史**
所有 AI 对话自动保存在本地 SQLite 数据库，随时回溯、搜索和删除。

## 隐私说明

• 所有数据存储在你的本地设备（Origin Private File System），不发送至 SmartReader 服务器
• 网页内容仅发送到你自行配置的 AI API 端点
• 你的 API Key 仅保存在本地，不会泄露给第三方

## 开源

SmartReader 是开源项目，代码托管于 GitHub：
https://github.com/pipi32167/SmartReader
```

---

## 四、打包 ZIP

已准备好构建产物：`SmartReader-v1.0.1.zip`

如需重新打包：

```bash
npm run build
cd dist && zip -r ../SmartReader-v1.0.1.zip . -x "*.map"
```

---

## 五、上传与提交审核

### 步骤

1. 访问 [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. 点击 **New item** → 上传 `SmartReader-v1.0.1.zip`
3. 填写商店列表信息：
   - **Store listing**（中文）：填写中文名称、描述、截图
   - **Store listing**（English）：可同时填写英文版本（可选但推荐）
   - **Privacy** → **Privacy policy URL**：`https://pipi32167.github.io/SmartReader/privacy-policy.html`
   - **Distribution**：选择 **Public**（公开）或 **Unlisted**（不公开列出）
4. 点击 **Submit for review**

### 审核时间

通常 **1-3 个工作日**，复杂情况可能更久。

### 常见被拒原因及应对

| 原因 | 应对 |
|------|------|
| `<all_urls>` 权限理由不充分 | 已在描述中说明：「允许在任何网页上使用内容提取功能」 |
| 缺少隐私政策 | 已准备，确保 GitHub Pages 可访问 |
| 截图不符合要求 | 截图必须展示扩展真实功能，不能是占位图 |
| 描述含糊不清 | 使用上方提供的描述模板 |
| 远程代码 | ✅ 本扩展无远程代码注入，仅调用用户配置的 API（fetch） |

---

## 六、审核通过后

审核通过后，扩展会在 Chrome Web Store 上架。你可以在 Dashboard 中：

- 查看下载量和评分
- 回复用户评论
- 发布更新版本（重新上传 ZIP + 提交审核）

---

## 七、后续更新流程

每次发布新版本时：

1. 更新 `manifest.json` 和 `package.json` 中的版本号
2. `npm run build` 重新构建
3. 重新打包 ZIP
4. 在 Developer Dashboard → 对应扩展 → **Package** → 上传新 ZIP
5. 提交审核

审核通常比首次更快（几小时到 1 天）。
