# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

个人长片与科普纪录片创作者（在 Windows/macOS/Linux 桌面端用本机主力工具处理 20–60 分钟重度工程，包含多轨音视频素材、大量历史/科普画中画与密集字幕精修）。

## Product Purpose

提供本地离线优先的桌面视频剪辑工作台，让个人创作者从素材整理、时间轴精剪、密集字幕校对到本机硬件加速导出都能在一个流畅、可预测的界面里闭环完成，不依赖云端与外网资源。

## Positioning

面向重度长片个人创作者的本地优先剪辑器：原生整合多轨精剪、文稿/手动密集字幕编辑、高速混合硬件导出（`direct-cut` / `overlay-hybrid`）与外部 AI Agent（MCP）协同入口。

## Operating Context

- 单人桌面剪辑环境（Electron 43 + React 19 + Vite 8 + Remotion 预览/渲染 + 本地 FFmpeg/Whisper）。
- 典型工程规模：20–60 分钟、数百段音视频片段与近千句连续字幕（如 45 分钟《托洛茨基》工程）。
- 窗口尺寸：常规桌面宽屏（1440×900）与紧凑窗口（1024×680）均需完整可用。
- 交互习惯：高度依赖键盘快捷键（`Space`、`J/K/L`、`Ctrl+B`、`S`、方向键微调）与时间轴高频拖动定位。

## Capabilities and Constraints

- **核心底线（用户确认）**：所有真实剪辑功能必须保留并可达，严禁为了“表面极简”偷偷删除功能。
- 必须覆盖的编辑器核心功能域：工程顶栏（返回、重命名、保存状态、撤销/重做、设置、导出记录、应用工具、导出）、左侧资源库（我的素材/特效/字幕与文字/音效/子草稿/扩展中心）、中央画布预览（规格、安全框、播控、画质切换、全屏）、右侧面板（字幕列表/片段与字幕属性双模式）、底部多轨时间轴（草稿标签、时间码、缩放、画幅适配、字幕总开关、编辑模式/轨道/分割/智能镜头/删除/子草稿/磁吸/吸附/更多/录音/变速、标尺与多轨内容）。
- 本地离线优先：内置字体资产、本机硬编与本地模型，不引入外网字体或外部运行时依赖。
- 工程约束：现有前端不依赖 Tailwind CSS，采用 CSS 变量多皮肤体系（`src/skins.ts` 的 `--cc-*` 令牌）与统一动作注册表（`src/shortcuts/actionRegistry.ts`、`src/shortcuts/shortcutScope.ts`）。

## Brand Commitments

- 产品名：**左人剪刀 (ZuorenJiandao)**。
- 体验承诺：预期与实际严格一致；拒绝脱离真实功能的“假概念海报”。
- 当前待决视觉探索：用户希望对比「轻盈、现代化、年轻化」与「稳定、可靠、成熟」两套在结构与气质上真正拉开差距的方向，且品质需明显超越现版界面。

## Evidence on Hand

- 现版真实编辑器实拍：`release/project-open-tail-20261123/samples/verified-restored-1-editor.png`、`release/desktop-acceptance-20261118/editor-1440x850.png`。
- 现行主题与界面代码：`src/skins.ts`、`src/editor/EditorWorkspaceView.tsx`、`src/editor/editor-ui-polish.css`、`src/components/TopBar.tsx`、`src/components/PreviewPanel.tsx`、`src/components/timeline/TimelineToolbar.tsx`。

## Product Principles

1. 画面预览与时间轴永远是第一主角，界面外框与装饰退后服务创作。
2. 高频操作一触直达，低频管理按需收纳，绝不为追求极简而删除真实能力。
3. 所见即所得：设计小样必须基于真实控件清单、真实内容素材与真实可运行布局验证。
4. 键盘、焦点与指针同等重要：弹层、弹窗与区域快捷键严格闭环，兼容中文输入法。
5. 长时间重度剪辑低视觉疲劳：克制使用强调色，只在真正激活或需要决策的位置发声。

## Accessibility & Inclusion

面向非程序员创作者，采用直观通俗的中文标签；提供清晰键盘焦点环（`:focus-visible`）、完整快捷键与中文 IME 输入法防误触，并兼容深色与日间浅色皮肤。
