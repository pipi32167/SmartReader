# SmartReader

[![Version](https://img.shields.io/badge/version-1.0.1-blue)](https://github.com/pipi32167/SmartReader)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Chrome Extension](https://img.shields.io/badge/chrome%20extension-MV3-orange)]()

> 一款基于 Chrome Extension Manifest V3 的浏览器扩展，使用 AI API 总结网页内容并回答你的问题。

[English Documentation](./README.md)

---

## ✨ 功能特性

- **网页内容总结** — 将页面内容提取为 Markdown，生成 AI 驱动的摘要
- **网页内容问答** — 针对当前页面提问，获取流式回答
- **PDF 支持** — 提取并总结 PDF 文件的文本内容
- **自定义提示词** — 创建和管理自己的提示词模板，支持变量（`${html}`、`${text}`）
- **流式响应** — 在侧边面板中实时显示 AI 回复
- **历史记录管理** — 在本地保存 AI 对话，方便日后查阅
- **侧边面板 UI** — 简洁、无干扰的侧边面板界面，支持 Markdown 渲染
- **多窗口感知** — 侧边面板消息按窗口过滤，防止跨窗口干扰

---

## 📦 安装

### 从源码安装（开发者模式）

1. 克隆本仓库：
   ```bash
   git clone https://github.com/pipi32167/SmartReader.git
   cd SmartReader
   ```

2. 安装依赖并构建：
   ```bash
   npm install
   npm run build
   ```

3. 打开 Chrome，访问 `chrome://extensions/`

4. 开启右上角的**开发者模式**

5. 点击**加载已解压的扩展程序**，选择 `dist/` 文件夹

6. SmartReader 扩展图标将出现在 Chrome 工具栏中

---

## 🚀 使用说明

1. **配置 API** — 点击扩展图标 → "设置"（或右键 → 选项），输入兼容 OpenAI 的 API 端点、密钥和模型。

   ![LLM 提供商配置](screenshots/LLM_provider.png)

2. **总结页面** — 打开任意网页，点击 SmartReader 图标，选择一个提示词（如"总结此页面"）。AI 回复将以流式方式展示在侧边面板中。

   ![使用预定义提示词询问页面](screenshots/ask_page_with_predefined_prompt.png)

3. **提出问题** — 使用自定义提示词，如"关键要点是什么？"，或创建你自己的提示词。你也可以针对页面上选中的文本提问。

   ![使用即时提示词询问页面](screenshots/ask_page_with_instant_prompt.png)

   ![使用预定义提示词询问选中文本](screenshots/ask_selected_text_with_predefined_prompt.png)

   收到回答后，你可以在侧边面板中继续追问。

   ![追问](screenshots/follow-up_questions.png)

4. **处理 PDF** — 在 Chrome 中查看 PDF 时，SmartReader 会提取其文本并像普通网页一样处理。

5. **查看历史** — 所有 AI 交互都保存在本地，可以在选项页面中查看。

   ![历史记录](screenshots/history.png)

---

## ⚙️ 配置

前往**选项**页面进行以下配置：

| 设置项 | 说明 |
|--------|------|
| Base URL | 兼容 OpenAI 的 API 端点（例如：`https://api.openai.com/v1`） |
| API Key | 你的 API 密钥 |
| Model | 模型名称（例如：`gpt-4o`、`gpt-3.5-turbo`） |

你也可以在选项页面管理自定义提示词和查看对话历史。

![预定义提示词管理](screenshots/predefined_prompt_management.png)

### 提示词变量

提示词模板支持两个变量：

- `${html}` — 页面内容转换后的 Markdown（截断至 30,000 字符）
- `${text}` — 用户在页面上当前选中的文本

---

## 🛠️ 开发

### 前置条件

- [Node.js](https://nodejs.org/) (v18+)
- [npm](https://www.npmjs.com/)

### 脚本命令

```bash
# 开发模式（监听文件变化）
npm run dev

# 生产构建
npm run build

# 清理构建输出
npm run clean

# 运行测试
npm test
```

### 项目结构

```
public/
  manifest.json          # Chrome 扩展清单（MV3）
  icons/                 # 扩展图标
src/
  background/
    service-worker.ts    # Service Worker：AI 请求、数据库代理、PDF 处理
  content/
    content-script.ts    # Content Script：提取页面内容并转换为 Markdown
  offscreen/
    offscreen.ts         # Offscreen Document：运行 sql.js + pdfjs-dist，OPFS 持久化
  popup/
    popup.ts             # 弹出窗口：提示词列表、自定义输入、打开侧边面板
  sidepanel/
    sidepanel.ts         # 侧边面板：接收流式消息、渲染 Markdown
  options/
    options.ts           # 选项页面：API 配置与提示词管理
  shared/
    types.ts             # TypeScript 接口与 MessageType 常量
    constants.ts         # 默认 API 配置、默认提示词
    utils.ts             # 工具函数
    html-to-markdown.ts  # 自定义 HTML 转 Markdown 转换器
```

---

## 🧪 测试

本项目使用 [Vitest](https://vitest.dev/) 配合 `jsdom` 进行单元测试。

```bash
npm test
```

`src/shared/` 下的共享逻辑模块遵循测试驱动开发（TDD）原则。新增共享工具函数时，请同时添加对应的 `*.test.ts` 测试文件。

---

## 🏗️ 架构亮点

### 为什么使用 Offscreen Document？

Manifest V3 的 Service Worker 无法执行 WASM，也无法访问 OPFS。SmartReader 使用 **Offscreen Document** 来托管 `sql.js` 和 `pdfjs-dist`，并将 SQLite 数据库持久化到 OPFS（文件名：`smartreader.db`）。Service Worker 通过 `chrome.runtime.sendMessage` 将所有数据库操作代理到该文档。

### 通信流程

```
Popup → Service Worker → Content Script → Service Worker → AI API
                                               ↓
                                         Side Panel（流式传输）
```

### PDF 处理流程

1. Service Worker 下载 PDF 并转为 Base64
2. 首次尝试：以 OpenAI `file` 类型 content part 直接上传
3. 降级方案：通过 Offscreen Document 中的 `pdfjs-dist` 提取文本，然后作为文本提示词重试

---

## 📄 许可证

[MIT](LICENSE)

---

## 🤝 贡献

欢迎提交 Issue 或 Pull Request！

贡献时请注意：
- 遵循现有的代码风格
- 共享逻辑的修改请添加测试
- 提交前运行 `npm test` 确保所有测试通过
