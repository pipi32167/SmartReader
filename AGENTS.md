<!-- From: /Users/million/work/million/chrome-exts/SmartReader/AGENTS.md -->
# SmartReader — Agent Guide

SmartReader 是一款基于 Chrome Extension Manifest V3 的浏览器扩展，用于总结网页内容并通过 AI API 回答用户提问。它能够将网页内容提取为 Markdown，发送到兼容 OpenAI 的 API 端点，并将流式响应展示在侧边面板中。扩展同时支持对 PDF 文件的文本提取、OCR 识别与摘要。

当前版本：**1.0.9**

---

## Technology Stack

- **TypeScript** — ES2022，ES 模块（`"type": "module"`）
- **Vite** — 构建工具与打包器
- **Vitest + jsdom** — 单元测试
- **Chrome Extension Manifest V3**
- **sql.js (WASM)** — 在 Offscreen Document 中运行的 SQLite 数据库
- **pdfjs-dist** — PDF 文本提取与页面渲染（运行在 Offscreen Document 中）
- **Tesseract.js** — OCR 识别扫描型 PDF（运行在 Offscreen Document 中，语言包从 CDN 加载，使用 `chi_sim+eng`）
- **marked** — 侧边面板中的 Markdown 渲染
- **@mozilla/readability** — 内容脚本中用于提取网页正文（Firefox Reader View 算法）
- **turndown** — 依赖树中存在，当前主要由自定义 `html-to-markdown` 替代
- **OPFS** — Origin Private File System，用于持久化 SQLite 数据库

---

## Project Structure

```
public/
  manifest.json          # Chrome 扩展清单（MV3）
  icons/                 # 扩展图标（16px / 48px / 128px）
src/
  background/
    service-worker.ts    # Service Worker：中央协调器、AI 流式请求、DB 代理、PDF 处理、历史记录管理
  content/
    content-script.ts    # Content Script：提取页面内容并转换为 Markdown，检测选中文字和多媒体链接
  offscreen/
    offscreen.html       # Offscreen Document HTML 外壳
    offscreen.ts         # Offscreen Document：运行 sql.js + pdfjs-dist + Tesseract.js，OPFS 持久化
  popup/
    popup.html           # 弹出窗口 UI
    popup.ts             # 弹出窗口逻辑：提示词列表、自定义输入、打开侧边面板、检测上下文状态
    popup.css
  sidepanel/
    sidepanel.html       # 侧边面板 UI
    sidepanel.ts         # 侧边面板逻辑：接收流式消息、渲染 Markdown、历史记录浏览、追问/重试
    sidepanel.css
  options/
    options.html         # 设置页面 UI
    options.ts           # 设置页面逻辑：API 配置与提示词管理（支持拖拽排序）
    options.css
  shared/
    types.ts             # TypeScript 接口与 MessageType 常量
    constants.ts         # 默认 API 配置、默认提示词、MAX_CONTENT_LENGTH、DB_FILENAME
    utils.ts             # escapeHtml、truncate、debounce、formatDate、arrayBufferToBase64
    utils.test.ts        # utils.ts 的单元测试
    html-to-markdown.ts  # 自定义 HTML 转 Markdown 转换器（支持 Shadow DOM、表格、音视频等）
    html-to-markdown.test.ts # 转换器的单元测试
    pdf-to-html.ts       # 将 PDF 页面文本组装为语义化 HTML
    pdf-to-html.test.ts  # PDF HTML 构建器的单元测试
  types/
    sql.js.d.ts          # sql.js 的最小类型声明
dist/                    # Vite 构建输出（自动生成）
```

---

## Build Commands

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

Vite 配置（`vite.config.ts`）定义了多个 Rollup 入口：
- `service-worker` → `dist/service-worker.js`
- `content-script` → `dist/content-script.js`
- `popup` / `sidepanel` / `options` / `offscreen` → `dist/*.html` + assets

自定义 Vite 插件在构建完成后执行后处理：
- 将 `sql-wasm.wasm` 复制到 `dist/`
- 将 `pdf.worker.mjs` 复制到 `dist/`（pdfjs-dist v5 Web Worker 所需）
- 将嵌套的 HTML 文件从 `dist/src/` 移动到 `dist/` 根目录
- 修正 HTML 文件中的相对资源路径（`../../assets/` → `./assets/`）

---

## Architecture Overview

### 为什么使用 Offscreen Document？
Manifest V3 的 Service Worker 无法执行 WASM，也无法访问 OPFS 或 DOM。因此扩展使用 **Offscreen Document**（`src/offscreen/offscreen.ts`）来托管 `sql.js`、`pdfjs-dist` 和 `Tesseract.js`，并通过 OPFS 读写 SQLite 数据库。Service Worker 通过 `chrome.runtime.sendMessage` 将所有数据库操作、PDF 文本提取和 PDF→Markdown 转换代理到该文档。

### 通信流程

1. **Popup** 向 **Service Worker** 发送 `EXECUTE_PROMPT` 或 `SHOW_PAGE_MARKDOWN`。
2. **Service Worker** 注入或与 **Content Script** 通信，获取页面内容；如果是 PDF，则下载后送到 Offscreen Document 转换。
3. **Service Worker** 替换提示词变量（`${html}`、`${text}`），并向 AI API 发起流式请求。
4. **Service Worker** 向 **Side Panel** 发送 `STREAM_CHUNK` / `STREAM_COMPLETE` / `STREAM_ERROR` 消息（按 `windowId` 过滤）。
5. **Side Panel** 使用 `marked` 渲染内容，并提供复制/中止/追问/重试控制。

### PDF 处理流程
当检测到当前标签页为 PDF 时（检测逻辑：URL 模式匹配 + 可选的 HEAD 请求验证 `Content-Type: application/pdf`）：
1. Service Worker 下载 PDF 并转为 Base64（限制 32MB）。
2. 将 PDF 字节发送到 Offscreen Document，由 `pdfjs-dist` 逐页提取文本；若某页文本极少（< 50 字符），则将该页渲染到 Canvas 并用 `Tesseract.js`（`chi_sim+eng`）进行 OCR。最大处理 50 页。
3. 提取的文本经 `buildPdfHtml` 组装为语义化 HTML，再通过 `htmlToMarkdown` 转为 Markdown。
4. `executePrompt` 会将转换后的 Markdown 作为 `${html}` 变量填入提示词。
5. `SHOW_PAGE_MARKDOWN`（popup「查看 Markdown」）会直接显示转换后的 Markdown。

### Service Worker 核心状态
- `conversations: Map<number, ConversationState>` — 按 `windowId` 维护对话状态，包括消息历史、AbortController、API 配置、历史记录 ID 等。
- 支持多轮追问（`SEND_FOLLOW_UP`）：追加用户消息后继续流式请求。
- 支持重试（`RETRY_MESSAGE`）：从历史记录加载上下文，截断到指定消息索引后重新生成。
- AI 自动生成标题：首次对话完成后，调用 AI 生成不超过 15 个字的标题。

---

## Database Schema
SQLite 数据库在 Offscreen Document 中初始化，持久化到 OPFS（文件名：`smartreader.db`）。

- `api_config(id, base_url, api_key, model, updated_at)` — 单行配置表
- `prompts(id, title, prompt, sort_order, created_at, updated_at)` — 用户自定义提示词模板表（支持拖拽排序）
- `history(id, title, url, prompt, response, messages, created_at, updated_at)` — AI 对话历史记录表，`messages` 存储 JSON 格式的完整对话数组

数据库迁移逻辑在 `offscreen.ts` 的 `migrateHistoryTable()` 中处理（如新增 `messages`、`updated_at` 列）。

---

## Code Style Guidelines

- **语言**：UI 字符串、用户可见消息及大部分注释使用 **中文（zh-CN）**；日志消息通常使用英文并带 `[Component]` 前缀（如 `[Service Worker]`、`[SidePanel]`）。
- **导入**：尽可能使用显式类型导入（`import type { … }`）。
- **严格 TypeScript**：已启用 `strict: true`，避免使用 `any`，除非必要。
- **模块格式**：仅使用 ES 模块（`"type": "module"`）。
- **DOM 就绪**：UI 入口点均在 `DOMContentLoaded` 事件后初始化。
- **消息处理器**：`chrome.runtime.onMessage` 监听器在异步发送响应时，必须返回 `true`。
- **错误处理**：Offscreen Document 使用 `normalizeError()` 统一序列化错误对象，确保日志和消息传递不丢失信息。

---

## Testing

- **框架**：Vitest，使用 `jsdom` 环境。
- **命令**：`npm test`
- **当前覆盖范围**：
  - `src/shared/html-to-markdown.ts` — 标题、链接、图片、列表、表格、媒体元素、隐藏元素移除以及嵌套 Shadow DOM
  - `src/shared/pdf-to-html.ts` — 单页/多页 HTML 组装、HTML 转义、段落拆分逻辑
  - `src/shared/utils.ts` — `arrayBufferToBase64` 的大缓冲区处理、空输入、编码正确性
- 新增共享工具函数时，应在同目录下添加对应的 `*.test.ts` 文件。

---

## TDD Principles

本项目的共享逻辑模块（`src/shared/` 下的纯函数与工具类）遵循 **测试驱动开发（TDD）** 原则。

### 核心流程

1. **Red**：先写测试——在实现功能之前，先编写一个会失败的测试用例，明确输入、输出和边界条件。
2. **Green**：再写实现——编写最小化的代码让测试通过，不追求过度设计。
3. **Refactor**：最后重构——在测试绿灯的前提下优化代码结构，消除重复，提升可读性。

### 实践规范

- **测试与实现同位**：每个 `*.ts` 文件旁应放置对应的 `*.test.ts`，例如 `utils.ts` ↔ `utils.test.ts`。
- **测试即文档**：用 `describe` 和 `it` 的嵌套结构清晰描述功能行为，让测试用例本身成为可执行的规格说明。
- **边界优先**：每个测试套件必须覆盖正常路径、空值/异常输入、以及边界条件（如空字符串、超大输入、特殊字符）。
- **快速反馈**：共享逻辑应保持无副作用、无外部依赖（不直接调用 Chrome API、DOM 操作或网络请求），以便在 `jsdom` 环境中快速运行单元测试。
- **Chrome API 与集成逻辑**：涉及 `chrome.*` API、Service Worker 消息流、Offscreen Document 的代码，以集成测试或手动验证为主，不强求单元测试覆盖率。

### 运行规范

- 提交前执行 `npm test`，确保所有测试通过。
- 新功能 PR 必须包含对应的测试文件（纯逻辑部分）。

---

## Key Conventions

### Message Types
所有跨组件消息均在 `src/shared/types.ts` 中通过 `MessageType` 对象进行类型定义。新增消息类型时应首先在此处添加。

完整的消息类型列表：
- `GET_PAGE_CONTENT` / `GET_SELECTION` — Content Script 获取页面内容/选中文字
- `PING_OFFSCREEN` / `OFFSCREEN_READY` / `OFFSCREEN_HTML_LOADED` — Offscreen 生命周期
- `DB_INIT` / `DB_QUERY` / `DB_EXEC` — 数据库操作
- `EXECUTE_PROMPT` / `SHOW_PAGE_MARKDOWN` — 执行提示词 / 显示页面 Markdown
- `GET_PROMPTS` / `SAVE_PROMPT` / `DELETE_PROMPT` / `REORDER_PROMPTS` — 提示词 CRUD 与排序
- `GET_API_CONFIG` / `SAVE_API_CONFIG` / `TEST_API_CONNECTION` — API 配置 CRUD
- `EXTRACT_PDF_TEXT` / `CONVERT_PDF_TO_MARKDOWN` — PDF 处理
- `GET_HISTORY_LIST` / `GET_HISTORY_DETAIL` / `DELETE_HISTORY` / `CLEAR_HISTORY` / `UPDATE_HISTORY` — 历史记录 CRUD
- `ABORT_STREAM` — 中止 AI 流式响应
- `SEND_FOLLOW_UP` / `RETRY_MESSAGE` — 追问与重试
- `STREAM_START` / `STREAM_CHUNK` / `STREAM_COMPLETE` / `STREAM_ERROR` / `STREAM_ABORTED` — 流式消息
- `SHOW_HISTORY_VIEW` — Popup 通知 Side Panel 切换到历史视图

### Prompt Variables
提示词模板支持两个变量：
- `${html}` — 页面内容转换后的 Markdown（截断至 `MAX_CONTENT_LENGTH`，目前为 1,000,000 字符）
- `${text}` — 用户当前选中的文本

### Side Panel Window Filtering
侧边面板只处理 `windowId` 与当前窗口匹配的消息流，防止多窗口打开时出现跨窗口干扰。

### Offscreen Lifecycle
Service Worker 在使用 Offscreen Document 前会先 ping 检测。如果文档已过期（来自上一次扩展加载），则关闭并重新创建。初始化有 30 秒超时保护。

### Service Worker Keep-Alive
在 AI 流式响应期间，Service Worker 会启动一个 4 秒的定时器，通过读写 `chrome.storage.local` 防止 Chrome 中途终止 Worker。

---

## Security Considerations

- **CSP**：Manifest 允许 `'self'` 和 `'wasm-unsafe-eval'` 作为脚本来源，因为 `sql.js` 依赖 WASM。
- **API Key 存储**：API 密钥以明文形式存储在本地 SQLite（OPFS）中；安全性等同于浏览器本地存储边界。
- **XSS 防护**：`escapeHtml`（使用 DOM text node）在将不受信任的文本插入 UI 前进行转义。AI 返回的 Markdown 输出通过 `marked` 渲染；若新增插件，需确保渲染路径保持净化。
- **Content Script 注入**：Service Worker 通过 `chrome.scripting.executeScript` 动态注入 `content-script.js`，而非仅依赖 Manifest 中的 `matches`。

---

## Adding New Features

1. **新增消息流？** 在 `src/shared/types.ts` 中添加类型，在 Service Worker 中处理，并在消费端（popup / sidepanel / options / offscreen）实现。
2. **新增数据库表？** 在 `src/offscreen/offscreen.ts` 的 `initializeSchema()` 中添加 `CREATE TABLE` 语句。
3. **新增 UI 页面？** 在 `src/` 下添加 HTML 入口，在 `vite.config.ts` 的 `rollupOptions.input` 中注册，并在 `manifest.json` 中引用（如需要）。
4. **新增共享工具？** 放置在 `src/shared/` 下；如果是纯逻辑，添加对应的 `*.test.ts`。
