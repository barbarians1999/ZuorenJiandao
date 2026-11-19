<p align="center">
  <img src="public/zuoren-jiandao-icon.png" width="96" alt="左人剪刀 ZuorenJiandao" />
</p>

<h1 align="center">左人剪刀 (ZuorenJiandao)</h1>

<p align="center">
  <strong>简体中文</strong> · <a href="README.md">English</a>
</p>

<p align="center">
  <strong>本地优先的 Windows 桌面视频剪辑软件 · 专注本地剪辑与外部 MCP 协作</strong>
</p>

<p align="center">
  <a href="https://github.com/barbarians1999/ZuorenJiandao/releases"><img alt="GitHub Releases" src="https://img.shields.io/github/v/release/barbarians1999/ZuorenJiandao?label=Release&color=FF8A3D" /></a>
  <img alt="Local First" src="https://img.shields.io/badge/data-local_first-111827?style=flat" />
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows_x64-0078D6?style=flat" />
  <img alt="Electron" src="https://img.shields.io/badge/Electron-43-47848F?style=flat&logo=electron&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-19-149ECA?style=flat&logo=react&logoColor=white" />
  <img alt="Remotion" src="https://img.shields.io/badge/Remotion-4-0B84F3?style=flat" />
  <img alt="License" src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat" />
</p>

---

## 与原版 OpenChatCut 的核心区别

**左人剪刀（ZuorenJiandao）** 基于开源项目 [OpenChatCut](https://github.com/0xsline/OpenChatCut) 深度裁剪与重构，定位为**纯本地桌面视频剪辑工具**：

- **移除内置 AI 与云端依赖**：完全移除了内置 AI 对话面板、云端大模型服务商/API Key 配置以及在线生成式 AI 路由，**无需配置任何大模型 API 密钥**即可开箱使用。
- **保留纯本地剪辑与外部 MCP 协作**：软件自身专注时间线剪辑、预览、工程持久化与成品导出；如需结合 AI 助手辅助操作时间线，可通过顶部**插头按钮**或 **设置 → 外部控制** 开启外部 MCP 接口，由外部客户端（如 Codex、Claude Code）下发编辑指令，所有修改都会直接落到可撤销、可手动微调的真实时间线工程中。
- **针对 Windows 桌面端稳定性优化**：强化了 SQLite 耐用工程存储、文件写入防锁重试、导出断点恢复、矮屏/小窗口自适应缩放以及硬件加速（如 AMD AMF）导出链路。

---

## 核心功能

- **多轨时间线编辑**：支持多视频轨、音频轨、字幕轨、特效与独立马赛克专轨；提供吸附、主轨磁吸、联动开关、波纹/滚动裁剪、滑移、片段变速与撤销/重做历史。
- **预览与声音保真**：时间线实时预览支持 J/K/L 多倍速播放及音频保音高处理，减少人声加速变调问题。
- **字幕与文字稿工作流**：支持字幕列表编辑、粘贴文字稿对齐、本机离线 Whisper 语音识别与 SRT 导入导出。
- **本地视觉与音频工具**：内置矩形/椭圆/纯色背景、独立马赛克区域控制、WebGL 特效与转场、关键帧、遮罩、本地语义素材检索与人像分割（完全在本机运行，素材不上传云端）。
- **可靠保存与多样导出**：支持 MP4 视频（含硬件加速）、纯音频、SRT 字幕、FCPXML 工程交换格式及可编辑工程导出；支持后台导出队列、导出后自动质量检查及写入失败后的断点复用重试。

---

## 下载与安装（Windows 64 位）

1. 前往 [Releases 页面](https://github.com/barbarians1999/ZuorenJiandao/releases) 下载最新版本的 Windows 安装程序（例如 `ZuorenJiandao-Setup-0.3.1-x64.exe`）。
2. 双击运行安装程序。
   > **提示**：当前版本安装包暂未附带商业数字签名。如果 Windows 弹出“Windows 已保护你的电脑”蓝色提示框，点击 **更多信息 → 仍要运行** 即可正常安装。

---

## 外部 MCP 连接说明

软件启动后会在本机暴露外部 MCP 服务（默认地址见 `.mcp.json`：`http://localhost:5199/api/external-mcp/mcp`）。
可以在软件界面右上角点击**外部控制（插头图标）**或在 **设置 → 外部控制** 中查看连接状态和客户端接入方式；连接操作由用户主动控制。

---

## 本地开发与构建

环境要求：**Node.js 24**、**pnpm**。

```bash
# 安装依赖
pnpm install

# 启动开发环境（桌面端）
npm run desktop:dev

# 类型检查与代码规范检查
npx tsc -b --pretty false
npm run lint

# 构建 Windows 桌面端发布产物
npm run desktop:dist:win
```

开发规范、本地数据目录策略与功能边界请参考 [DEVELOPMENT_BOUNDARIES.md](DEVELOPMENT_BOUNDARIES.md)。

---

## 致谢与开源协议

- 上游项目：[0xsline/OpenChatCut](https://github.com/0xsline/OpenChatCut)
- 开源协议：[AGPL-3.0-or-later](LICENSE)
