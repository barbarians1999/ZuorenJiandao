<p align="center">
  <img src="public/zuoren-jiandao-icon.png" width="96" alt="ZuorenJiandao" />
</p>

<h1 align="center">ZuorenJiandao (左人剪刀)</h1>

<p align="center">
  <a href="README_ZH.md">简体中文</a> · <strong>English</strong>
</p>

<p align="center">
  <strong>Local-first Windows desktop video editor · Focused on offline editing and external MCP control</strong>
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

## Key Differences from Upstream OpenChatCut

**ZuorenJiandao (左人剪刀)** is a focused local-first desktop fork derived from [OpenChatCut](https://github.com/0xsline/OpenChatCut):

- **No Built-in AI Chat or Cloud API Keys**: Embedded AI chat panels, cloud LLM/provider configuration, and generative AI media routes have been removed. No external API key is required to edit, preview, or export.
- **Pure Local Editing + External MCP Control**: The application handles timeline editing, preview playback, project persistence, and rendering locally. External AI agents (such as Codex or Claude Code) can optionally connect via MCP (see the top-bar plug button or **Settings → External Control**) and issue deterministic edits onto the real, undoable timeline.
- **Windows Desktop Hardening**: Includes SQLite-backed durable project storage, Windows transient file-lock retries, post-render export destination recovery, responsive layout scaling on compact windows (e.g. `1024×680`), and hardware-accelerated export support (such as AMD AMF).

---

## Features

- **Multitrack Timeline**: Video, audio, caption, effect, and dedicated mosaic tracks with snapping, magnetic main track, directional linkage, rolling trim, slip, and rate stretch.
- **Pitch-Preserved Preview Playback**: Live Player speed/J-K-L playback routes video audio through pitch-preserved HTML5 audio to avoid chipmunk distortion on human speech.
- **Captions & Transcript Workflow**: Cue list editing, pasted transcript alignment, local offline Whisper speech recognition, and SRT import/export.
- **Local Visual & Audio Tools**: Shapes, solid backgrounds, standalone mosaic regions, WebGL effects & transitions, keyframes, masks, on-device segmentation, and local semantic media search (everything stays on your machine).
- **Reliable Persistence & Exports**: Background export queue with mid-stage cancellation (`finalizing` / `verifying`), post-render retry/rebind if destination writing fails, auto-QA frame checks, and MP4 / audio / SRT / FCPXML exports.

---

## Download & Install (Windows x64)

1. Download the latest Windows installer (`ZuorenJiandao-Setup-0.3.2-x64.exe`) from [GitHub Releases](https://github.com/barbarians1999/ZuorenJiandao/releases).
2. Double-click to install.
   > **Note**: The installer is currently unsigned (`NotSigned`). If Windows SmartScreen displays a prompt, click **More info → Run anyway** to proceed.

---

## External MCP Endpoint

When running, the local external MCP endpoint is available by default at `http://localhost:5199/api/external-mcp/mcp` (see `.mcp.json`). Use the plug icon in the editor top bar or **Settings → External Control** to inspect connection details.

---

## Local Development & Build

Requirements: **Node.js 24** and **pnpm**.

```bash
# Install dependencies
pnpm install

# Run desktop dev environment
npm run desktop:dev

# Typecheck & lint
npx tsc -b --pretty false
npm run lint

# Build Windows installer & unpacked output
npm run desktop:dist:win
```

See [DEVELOPMENT_BOUNDARIES.md](DEVELOPMENT_BOUNDARIES.md) for feature, storage, and delivery guidelines.

---

## Attribution & License

- Forked from [0xsline/OpenChatCut](https://github.com/0xsline/OpenChatCut)
- Licensed under [AGPL-3.0-or-later](LICENSE)
