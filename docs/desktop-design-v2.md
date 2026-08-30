# ToolSpan Desktop 设计系统 v2

本文是 ToolSpan Desktop（Tauri 2 + React 19 + Tailwind 4）UI 的**唯一设计事实源**。它以 `apps/desktop/src/styles.css`、`apps/desktop/src-tauri/src/app.rs`、`apps/desktop/src-tauri/tauri.conf.json`、`apps/desktop/src/i18n/resources.ts` 与 `apps/desktop/src/lib/theme.tsx` 的当前实现为准；若实现与本文冲突，以本文为权威并同步修正实现。

本文不承诺超出已实现范围的样式或交互；未在此描述的能力视为不存在。

---

## 1. 产品画布

- **窗口**：固定 `1000 × 650`（`minWidth: 900` / `minHeight: 600`），可缩放（resizable），无全屏默认。
- **应用标识**：`identifier: top.aiqushi.toolspan`；产品名 `ToolSpan`；版本 `0.7.1`。
- **导航结构**：7 个导航页 + 系统托盘（见第 7 章）+ 7 步 First Run onboarding。
  1. Overview（概览）
  2. Connection（连接）
  3. Workspaces（工作区）
  4. Jobs（作业）
  5. Artifacts（制品）
  6. Logs（日志）
  7. Settings（设置）
- **布局骨架**：`.app-frame` 双列网格 `52px minmax(0, 1fr)` —— 左侧窄 rail（品牌块 + 7 个导航项 + 主题切换 + 状态点），右侧 workspace 区（sticky titlebar + 主内容）。
- **内容宽度**：`.main-content` 最大 `1180px` 居中，`padding: 26px 30px 42px`。
- **CSP**：`default-src 'self'; connect-src 'self' ipc: http://ipc.localhost; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'`。

## 2. 主题（Theme）

- **三态主题**：`light` / `dark` / `system`，由 Settings 页的 Seg 分段控件切换（Sun / Moon / Monitor 图标）。
- **解析规则**（`src/lib/theme.tsx`）：
  - `system` → 跟随 `matchMedia("(prefers-color-scheme: dark)")`，并实时监听 change 事件；
  - 解析结果写入 `document.documentElement.dataset.theme`（`light`/`dark`）；
  - 原始偏好写入 `dataset.themePreference`；`colorScheme` 同步设置；偏好持久化到 `localStorage`。
- **动效偏好**：`data-reduced-motion="true"` 或 `prefers-reduced-motion: reduce` 时，所有动画/过渡降级为 `.01ms`。

## 3. 色彩 Token

### 3.1 语义基础层（`:root`，29 个变量）

| Token | Light | Dark |
| --- | --- | --- |
| `--bg` | `#f6f8fb` | `#0f172a` |
| `--panel` | `#ffffff` | `#1e293b` |
| `--panel-muted` | `#f8fafc` | `#1a2438` |
| `--panel-accent` | `#eff6ff` | `#172554` |
| `--text` | `#0f172a` | `#f1f5f9` |
| `--muted` | `#475569` | `#cbd5e1` |
| `--faint` | `#64748b` | `#94a3b8` |
| `--border` | `#e2e8f0` | `#2e3d54` |
| `--border-strong` | `#cbd5e1` | `#475569` |
| `--primary` | `#2563eb` | `#3b82f6` |
| `--primary-hover` | `#1d4ed8` | `#60a5fa` |
| `--primary-soft` | `#eff6ff` | `#172554` |
| `--positive` | `#047857` | `#34d399` |
| `--positive-soft` | `#ecfdf5` | `#0c2b22` |
| `--warning` | `#b45309` | `#fbbf24` |
| `--warning-soft` | `#fffbeb` | `#2c2410` |
| `--danger` | `#dc2626` | `#f87171` |
| `--danger-soft` | `#fef2f2` | `#2f1518` |
| `--info` | `#0369a1` | `#38bdf8` |
| `--info-soft` | `#f0f9ff` | `#0c2433` |
| `--shadow` | `0 1px 2px rgb(15 23 42 / 5%), 0 4px 12px rgb(15 23 42 / 6%)` | `0 1px 2px rgb(0 0 0 / 25%), 0 8px 24px rgb(0 0 0 / 30%)` |

语义映射：`--positive`（成功/健康）、`--warning`（注意/等待）、`--danger`（错误/风险）、`--info`（信息/运行中）。

### 3.2 品牌扩展层（v4 Token 追加）

- **Primary 十级色阶**：`--primary-50 #eff6ff` → `--primary-100 #dbeafe` → `--primary-200 #bfdbfe` → `--primary-300 #93c5fd` → `--primary-400 #60a5fa` → `--primary-500 #3b82f6` → `--primary-600 #2563eb` → `--primary-700 #1d4ed8` → `--primary-800 #1e40af` → `--primary-900 #1e3a8a` → `--primary-950 #172554`。
- **渐变**：`--gradient-brand: linear-gradient(135deg, #2563eb, #0ea5e9)`（dark: `#3b82f6 → #38bdf8`）；`--gradient-success: linear-gradient(135deg, #047857, #0d9488)`（dark: `#34d399 → #2dd4bf`）。
- **渐变面积约束**：仅用于品牌 mark、概览指标卡图标、Setup 推荐路径图标、状态横幅图标，总面积 ≤ 8%。
- **其他**：`--surface-3 #eef2f7`（dark `#24334a`）、`--overlay`、`--shadow-xs/sm/md/lg`（蓝调投影）、`--positive-border / --warning-border / --danger-border / --info-border`、`--dur-slow: 320ms`、`--ease-spring: cubic-bezier(0.22, 1.6, 0.36, 1)`。
- **状态边框**：`--positive-border #a7f3d0` / `--warning-border #fde68a` / `--danger-border #fecaca` / `--info-border #bae6fd`（dark 对应 `#134e3f` / `#4a3a10` / `#5c2327` / `#14445f`）。

## 4. 字体与排版

- **字体栈**：`system-ui, -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif`；等宽：`"Cascadia Code", "SFMono-Regular", Consolas, monospace`。
- **基准字号**：`body 14px`；v2 排版体系 13–14px；等宽/日志 10–11.5px。
- **标题**：`h1 22px`（letter-spacing `-0.02em`）、`h2 15px`、`h3 13px`。
- **数字**：`.table, .mono-box, .log-line time, .seg__count, .badge, .metric-card strong` 使用 `font-variant-numeric: tabular-nums`。
- **焦点可见性**：`button:focus-visible, input:focus-visible, [role="combobox"]:focus-visible, a:focus-visible` 使用 `box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 26%, transparent)`。
- **间距**：4pt 体系派生（8/10/12/14/16/18/20/24px 等），卡片内边距 16–18px，页面 padding 26/30/42px。

## 5. 组件库

以下为 v2 组件（`styles.css` 类契约；组件源码见 `apps/desktop/src/components/`）：

| 组件 | 关键类 / 结构 | 说明 |
| --- | --- | --- |
| Button | `.button` + `--primary / --ghost / --danger / --compact / --icon / --subtle / --xs` | 主/幽灵/危险/紧凑/图标/柔和/极小；loading 态带 `.button__spinner` |
| Badge | `.badge` + `--positive / --warning / --danger / --info` | 带可选 `.badge__dot`（pulse 动画） |
| Card | `.card` + `--muted / --accent / --interactive` | 交互卡 hover 上浮 + 蓝调阴影 |
| Notice | `.notice` + `--info / --warn / --danger / --success` | 四态信息横幅 |
| Seg（分段控件） | `.seg` / `.seg__item` / `.seg__count` | 单选切换，用于主题与日志暂停 |
| StatusDot | `.status-dot`（`data-state`） | running 呼吸动画 / stopped / attention / unavailable |
| Switch（开关） | `.switch` | 34×19 滑块开关 |
| Toggle | `.toggle__track / .toggle__thumb` | 36×20 轨道 + spring 位移 |
| Stepper | `.stepper__node --done/--active` | 向导步骤条 |
| EmptyState | `.empty-state` + `--compact` | 教育性空态（图标 + 标题 + 描述 + 动作） |
| CodeBlock | `.code-block` / `--terminal` | 浅色/深色终端代码块，可带行号 `.code-block__ln` |
| SecretInput | `.secret-wrap` / `.secret-toggle` | 密钥输入 + 眼睛切换 |
| ConfirmPhrase | `.confirm-phrase` | 高风险确认短语（warning 边框） |
| StatusBanner | `.status-banner` + `--running / --ok / --warn / --err` | 状态横幅（图标 + 标题 + 描述 + 动作） |
| NavBadge | `.nav-badge` | 导航角标（primary 圆点） |
| Toast | `.toast-region` / `.toast` | 底部居中浮动反馈 |
| Field / Input | `.field__wrap / .field__input / .field__helper / .field__error` | 独立于 onboarding 的字段体系 |
| Modal | `.dialog-overlay / .dialog-content`（Radix AlertDialog） | 居中模态，带 `.modal-icon` |
| Tabs | `.tab-list / .tab.is-active` | 底部下划线激活 |

### 5.1 面板（Connection 页三卡）

`.card.panel` 结构：`.panel__head`（标题 + 操作）/ `.panel__body`（内容）/ `.panel__foot`（底部操作，可选 `--spread`）。

### 5.2 表格（Jobs / Artifacts 页）

`.table`：大写表头（`text-transform: uppercase`）、行 hover 高亮、`.table__cell-actions` 右对齐操作、`.table__muted` 次要文本、`.table__mono` 等宽单元格；`.table-wrap` 横向滚动 + `overscroll-behavior: contain`。

### 5.3 工作区卡片

`.ws-grid`（auto-fill minmax 250px）→ `.ws-card`（图标 36px + 名称 + 等宽路径 + meta）；`.ws-card--add` 虚线添加卡。

## 6. First Run（Onboarding）

- **容器**：`.onboarding-shell` 全屏居中，顶部 `radial-gradient` 用 `--primary-soft` 晕染。
- **卡片**：`.onboarding-card` 620px 宽、min-height 470px。
- **流程**：7 步向导（`.stepper` 进度条 + `.progress-track` 宽度动画）→ 欢迎/路径选择/根目录 picker/密码设置（含 `.password-strength` 三档强度条）/清单 review/成功页（`.success-orbit` 圆环 + URL 复制）。
- **密码规则**：Rust 边界强制最少 12 字符、拒绝超过 bcrypt 72 UTF-8 bytes；UI 用 `.password-guidance` 展示规则并逐条打勾。

## 7. 系统托盘（System Tray）

### 7.1 状态与图标

托盘图标按 Core 状态三态切换（`include_bytes!` 内嵌，运行时 `Image::from_bytes` 解码，Tauri 启用 `image-png` feature）：

| 状态键 | 图标文件 | 颜色 | 语义 |
| --- | --- | --- | --- |
| `running` | `icons/tray-running.{png,ico}` | `--tray-active #3b82f6`（蓝，primary-500） | Core 运行中 |
| `stopped` | `icons/tray-stopped.{png,ico}` | `--tray-idle #9ca3af`（gray-400） | Core 已停止 |
| `attention` | `icons/tray-attention.{png,ico}` | `--tray-attention #f59e0b`（amber-500） | 操作失败/需注意 |

图标规格：32px PNG（运行时）+ ICO 16/24/32 多尺寸（打包）；图标整体色即状态色，不拆分前景/背景。

### 7.2 菜单结构

`build_tray`（`app.rs`）固定 4 分组（分隔线分隔）：

```text
[status]      ToolSpan — Running / Stopped / Attention（禁用，纯展示）
──────────
[show]        Show（显示并聚焦主窗口）
──────────
[start]       Start      ← 仅非 running 时启用
[restart]     Restart    ← 仅 running 时启用
[stop]        Stop       ← 仅 running 时启用
──────────
[copy-mcp-url] Copy MCP URL ← 仅 running 时启用
[open-logs]   Open logs
──────────
[quit]        Quit
```

启用态规则由 `update_tray_status` 统一维护：`start` 与 `restart/stop/copy` 互斥；`status` 始终禁用；`show/open-logs/quit` 始终可用。启动时默认 `stopped` 态。

### 7.3 交互

- **左键单击图标** → `show_main_window`（显示 + 取消最小化 + 聚焦）。
- **`show`** → 同上。
- **`start / restart / stop`** → 异步调用对应 Host method（`runtime.start` / `runtime.restart` / `runtime.stop`），完成后按结果更新状态：成功 → `running`/`stopped`，失败 → `attention`；并向 renderer 发送 `tray://runtime-result`（`{method, status, ok}`）。
- **`copy-mcp-url`** → emit `tray://copy-mcp-url` 给 renderer 处理。
- **`open-logs`** → 显示主窗口 + emit `tray://open-logs`。

### 7.4 Quit 安全流程（有界兜底）

1. 关闭主窗口（`CloseRequested`）→ `api.prevent_close()` 阻止直接退出，转 `request_safe_quit`。
2. `request_safe_quit`：若 Core 由 Desktop 托管（`ownership_nonce` 存在）→ 显示主窗口 + `quit_gate.begin_request()` 记录代次 + emit `tray://quit-requested`（`{managedCore: true}`）给 renderer 弹确认框 + 启动 10s 兜底线程（`QUIT_CONFIRMATION_DEADLINE = 10s`）。
3. renderer 侧 `confirm_quit(stop_managed)` / `acknowledge_quit_request`：确认 → 先 stop 托管 Core（`runtime.stop`，失败返回 `RUNTIME_STOP_FAILED`）再 `app.exit(0)`；取消 → 返回 `Ok(())` 不退出。
4. 兜底线程：若 10s 内 renderer 未确认（WebView 未加载/未注册/无响应），`is_unacknowledged(generation)` 为真则直接执行 `confirm_quit_internal(..., true)` 有界停止序列，保证退出收敛而不是永久挂起。
5. 若 Core 未被 Desktop 托管（外部 Core）→ `app.exit(0)` 直接退出，不打扰。
6. **已知观察（v0.7.1 release 记录）**：Core stopped 状态下托盘 Quit 的 `runtime.stop` 握手可能挂起（Core/desktop-host 层，非托盘回归）；Owner 决策按现状发布并已记入 release notes。

### 7.5 无障碍

- 菜单项全部使用 `MenuItem::with_id` 显式 id，不依赖位置索引。
- 所有文本状态（status 行）在菜单内可见，不依赖图标颜色传达状态。
- `prefers-reduced-motion` 生效时托盘动画无特例（托盘本身无动画）。

### 7.6 实现对照矩阵

| 规范项 | 实现位置 |
| --- | --- |
| 三态图标切换 | `app.rs` `update_tray_status`（`TRAY_RUNNING_PNG / TRAY_STOPPED_PNG / TRAY_ATTENTION_PNG`） |
| 菜单结构 | `app.rs` `build_tray`（`MenuBuilder` + `MenuItem::with_id`） |
| 启用/禁用态 | `app.rs` `update_tray_status`（`set_enabled`） |
| 左键显示窗口 | `app.rs` `on_tray_icon_event`（`TrayIconEvent::Click` + `MouseButton::Left`） |
| Start/Restart/Stop | `app.rs` `run_tray_runtime`（Host method 调用 + 状态回写） |
| Quit 确认 + 10s 兜底 | `app.rs` `request_safe_quit` / `spawn_quit_confirmation_deadline`；`commands.rs` `confirm_quit_internal` / `QuitGate` |
| 图标文件 | `apps/desktop/src-tauri/icons/tray-{running,stopped,attention}.{png,ico}` |

## 8. 页面级布局契约

- **Overview**：`.metrics-grid`（4 列指标卡）+ `.quick-actions` + Setup 进度卡（`.setup-banner` / `.setup-progress-card`）+ 端点卡（`.endpoint-card` 含复制字段）。
- **Connection**：`.setup-banner` 入口 + 三路径 Setup Center（`.setup-path-grid` 3 列卡片）+ 面板三卡（`.card.panel`）+ Host Tabs（`.tab-list`）。
- **Workspaces**：`.ws-grid` 卡片网格 + `.search-field` + `.select-trigger` 筛选。
- **Jobs**：`.table` 表格 + 行内输出折叠（`.job-row-detail`）+ 状态点。
- **Artifacts**：`.artifact-grid` 双列卡片 + 路径摘要（`.path-summary`）。
- **Logs**：`.log-viewer`（深色终端 `#10151d`/`#d8e0eb`，light 下 `#17202c`）+ `.log-line`（时间/源/级别/消息 4 列网格）+ `.tail-status` 暂停 Toggle。
- **Settings**：`.settings-grid` 双列 + `.settings-card`（左侧 58px 图标位）+ 设置行（`.setting-row`，含 Switch 主题 Seg）。

### 8.1 窄屏降级（`@media (max-width: 960px)`）

- `.metrics-grid` / `.setup-path-grid` / `.domain-choice-grid` → 2 列；`.manual-setup-list dl` → 2 列。
- `.setup-target-fields` / `.setup-gates-grid` / `.setup-agent-grid` / `.setup-endpoint-preview` → 1 列。
- `.page-header` 换行、操作区占满整行；`.setup-banner` / `.status-banner` 换行堆叠。
- `.stepper__label` 允许换行；`.setup-apply-card` 纵向堆叠。

## 9. 国际化与无障碍基线

- **i18n**：`en` / `zh-CN` 双语言资源（`src/i18n/resources.ts`），key parity 由 `check:i18n` 校验（3/3）。
- **a11y 门禁**：axe 扫描（`test:a11y`）serious/critical 为 0；交互元素均提供 `aria-label` / `aria-pressed` / `aria-current`；存在 skip-link。
- **动效**：全部动画通过 `prefers-reduced-motion` / `data-reduced-motion` 降级。

## 10. 验证门禁

- Renderer 单测 / typecheck / build：`npm --prefix apps/desktop run test|typecheck|build`。
- i18n key parity：`npm --prefix apps/desktop run check:i18n`（3/3）。
- a11y：`npm --prefix apps/desktop run test:a11y`（10/10，serious/critical 0）。
- 视觉 fixture：`npm --prefix apps/desktop run test:visual`（8/8 synthetic fixtures，含 1000×650 布局与无横向溢出）。
- Desktop 总验证：`npm run verify:desktop:source`（16 checks）。

> 版本备注：本文件 2026-08-24 起作为托盘设计事实源补建（v0.7.1 托盘设计落地时原计划落档，文件当时缺失，现按源码补建）。设计 token、组件库与页面契约均以当前源码为准，变更时应同步更新本文。
