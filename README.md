# pi-scenes

[![npm version](https://img.shields.io/npm/v/pi-scenes.svg?color=blue)](https://www.npmjs.com/package/pi-scenes)
[![npm downloads](https://img.shields.io/npm/dt/pi-scenes.svg?color=green)](https://www.npmjs.com/package/pi-scenes)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![pi-package](https://img.shields.io/badge/pi-package-00b57a)](https://pi.dev/packages)

**[English](#what-it-is) | [简体中文](#中文说明)**

> Scenario switcher for [pi](https://pi.dev): bundle extensions & skills into a **common layer + per-scene layers**, switch with one command, hot-reloaded.

## What it is

pi loads every installed extension and every skill globally — the prompt grows fat, and office skills leak tokens while you code. **pi-scenes adds a scenario dimension on top:**

```
active resources = common layer ∪ current scene
```

- **Common layer** — extensions + skills that stay loaded in *every* scenario (quota display, session carryover…)
- **Scene layers** — per-scenario bundles (coding / office / writing…), loaded only while active
- Switching rewrites `packages`/`skills` in `settings.json`, then `ctx.reload()` hot-reloads — **no pi restart, session untouched**
- The data model reserves an `extends` chain (with cycle detection) for future **parent → child scene** hierarchies

## Install

```bash
pi install npm:pi-scenes
```

Or straight from git (no build step — pi loads the TypeScript source via jiti):

```bash
pi install git:github.com/Feng-H/pi-scenes
```

Then `/reload` and `/scene` is live.

## Quick start

```
/scene            # picker: all scenes, ● current, ○ switchable
/scene coding     # switch directly to the coding scene
/scene office     # switch to the office scene
/scene off        # common layer only (scene off)
/scene status     # show active scene + effective packages/skills
/scene init       # scaffold scenes.json template + scene skill dirs
/scene stats      # usage dashboard: sessions, tool calls, reflections
/scene evolve     # generate & apply evolution proposals (confirm-first)
/scene evolve auto # toggle auto-apply at session end (opt-in)
```

First run of `/scene` offers to generate the template. It ships with **seven preset scenes + common** (all packages verified on npm, 2026-09):

| Layer | Preset packages | Why |
|---|---|---|
| `common` | `npm:pi-scenes`, `npm:pi-carryover` | the switcher itself + cross-session carryover — always needed |
| `coding` | `npm:pi-lens`, `npm:pi-subagents`, `npm:pi-git-worktree` | live LSP/lint feedback, delegated sub-agents, parallel worktrees |
| `office` | `npm:pi-docparser` | PDF/Office document parsing |
| `pm` | `npm:pi-web-access`, `npm:pi-goal-x`, `npm:@juicesharp/rpiv-todo` | market/competitor research, goal planning & audit, live todo overlay |
| `research` | `npm:pi-web-access`, `npm:pi-subagents` | multi-source search/fetch/PDF/video, parallel multi-angle digging |
| `writing` | `npm:pi-web-access` | source gathering & fact-checking with citations |
| `data` | `npm:pi-docparser`, `npm:pi-mcp-adapter` | table extraction, connect any MCP server (DB/BI) |

Edit it to fit your setup (each scene also gets a skill dir scaffold at `~/.pi/agent/scenes/<name>/skills/`):

```jsonc
// ~/.pi/agent/scenes.json
{
  "common": {                              // ── common layer: always loaded
    "description": "common",
    "packages": ["npm:pi-zai-usage"],
    "skills": ["~/.pi/agent/scenes/common/skills"]
  },
  "scenes": {                              // ── scene layers: stacked when active
    "coding": {
      "description": "coding",
      "packages": ["npm:pi-carryover"],
      "skills": ["~/.pi/agent/scenes/coding/skills"]
    },
    "office": {
      "description": "office work",
      "packages": [
        { "source": "npm:pi-docparser", "skills": ["doc-parse"] }   // object form = load only part of a package
      ],
      "skills": ["~/.pi/agent/scenes/office/skills"]
    }
  }
}
```

Drop `SKILL.md` folders (or `.md` files) into a scene's skill directory; the whole directory toggles with the scene. `/scene init` scaffolds `~/.pi/agent/scenes/{common,coding,office,pm,research,writing,data}/skills/`.

### Status-bar scene badge

A successful switch sets a persistent footer badge (`◆ coding`), restored automatically at every session start and cleared by `/scene off`. The status bar should answer *"which scene am I in"* — not display tool internals.

Scenes often bundle tool-heavy extensions whose own footer output crowds the bar. If you use the preset `coding` scene, pi-lens's diagnostics widget and `LSP Inactive` status can be silenced **without losing any AI-side value** (turn-end error injection, `lens_diagnostics`, symbol navigation) via `~/.pi-lens/config.json`:

```json
{ "ui": { "hideLspStatus": true }, "widget": { "visible": false } }
```

pi-scenes never edits a third-party package's global config — the badge stays the only thing pi-scenes itself puts on your status bar.

## Self-evolution (usage-driven)

Scenes are not static. pi-scenes observes what you actually use and proposes updates:

- **Collect (passive)** — every `tool_call` is attributed to its package (via a static scan of installed sources); packages present in settings but absent from every scene definition are tracked as *absorb candidates*; at each session end a tiny LLM call reflects on which loaded skills were actually useful (a few hundred tokens, 30s timeout, fails silently).
- **Propose** — `/scene evolve` generates proposals:
  - **absorb**: an unmanaged package seen in ≥2 sessions joins the scene it was observed in
  - **retire**: a scene package with zero calls for 20 consecutive sessions (and a tool signal — command-only packages are protected) is proposed for removal; a skill the LLM never found useful (5+ "unused" reflections, 0 "useful") likewise
  - **protected**: the `common` layer and packages without tool signals (e.g. `/anywhere`-style command-only extensions) are **never** auto-changed
- **Apply (confirm-first)** — each proposal shows a `scenes.json` diff and asks; accepted edits are backed up (`scenes.json.scenes-bak`) and hot-reloaded. `/scene evolve auto` opts into silent application at session end (changes take effect on the next natural reload).

Tunables live in `scenes.json`:

```jsonc
{
  "evolve": {
    "patience": 20,           // sessions of zero usage before retire
    "absorbThreshold": 2,     // unmanaged sightings before absorb
    "skillUnusedThreshold": 5 // "unused" reflections before skill retire
  }
}
```

Usage data: `~/.pi/agent/scenes-usage.json` (machine-local, inert). View anytime with `/scene stats`.

### Install ≠ load (two-layer model)

- **Loading is driven by `settings.json` only.** Switching = rewrite the `packages`/`skills` arrays + `ctx.reload()`; resources absent from the arrays are never loaded — no tools registered, no prompt tokens spent. Scene skill dirs (`~/.pi/agent/scenes/<name>/skills`) are not auto-discovered by pi, so they toggle with the scene.
- **Files stay on disk.** Switching away never uninstalls (`pi remove` for that); a switched-away package under `~/.pi/agent/npm/` is an inert file — instant switch-back, zero runtime cost.

In short: **installed forever, loaded per scene**. One caveat: extensions you installed manually (your own entries in settings) are yours — pi-scenes treats them as `borrowed`, never touches them, so they stay loaded in *every* scene.

**Package updates are scene-independent.** Every package — whichever scene lists it — is installed once, globally, under `~/.pi/agent/npm/`; scenes only flip the `settings.json` switch. So `pi update --extensions` works no matter which scene is active (pi's update banner scans installed packages, not the active scene), and since scene definitions use version-less specs (`npm:<pkg>`), the new version loads on the next switch/reload. One caveat: `0.x` caret ranges don't cross minor versions — if the banner persists after updating, pin it explicitly: `pi install npm:<pkg>@<version>`.

### Duplicate & conflict handling

- Same spec in `common` and a scene → deduplicated at the union (loaded once).
- Same package, different spellings (e.g. `npm:x@1.0.3` vs bare `npm:x`) → identity-level dedupe keeps the first (common > scene); a manually pinned variant in settings is treated as `borrowed` (no duplicate injection). `/scene` and `/scene status` warn about such spelling mismatches so you can unify them.
- **Local path vs npm spelling (v0.2.1):** if settings already loads a package via a local path (e.g. your dev checkout `/Users/you/dev/pi-carryover`), a scene preset listing `npm:pi-carryover` will *borrow* your entry instead of installing — `pi install` is skipped so a second spelling is never appended to settings. This matters because two spellings of one package = the same extension loaded twice = pi exits at startup with a tool-name conflict. If settings ever ends up in that state (e.g. a manual `pi install` added the duplicate), `/scene` refuses to switch and tells you exactly which entries to delete.
- **Hotfix (v0.2.2):** `/scene <name>` crashed with `Extension "command:scene" error: target.filter is not a function` — the v0.2.1 refactor passed `computeTarget()`'s `{packages, skills}` object where the old call site used `target.packages`. Any scene switch hit this. Fixed, plus a command-layer smoke test (isolated via `PI_SCENES_DIR` + dynamic import in a dedicated test file, because the extension's default export resolves its base dir at module-evaluation time — a static import in tests would read/write your real `~/.pi/agent`).

## How it works

```
/scene coding
   │
   ├─ read scenes.json → target set = common ∪ coding (extends chains resolved)
   ├─ missing packages → confirm → `pi install` each (global scope isn't auto-installed)
   ├─ rewrite settings.json (see "Injection & reclamation")
   └─ await ctx.reload()  → extensions/skills hot-reload, session uninterrupted
```

### Injection & reclamation (your manual config stays untouched)

- `~/.pi/agent/scenes-state.json` records the entries this extension injected (`managed`)
- On switch: **precisely remove old managed entries first, then append new target entries that are absent**
- Packages/skills you configured by hand are never touched; if a scene target overlaps a manual entry, it's `borrowed` and survives switching away
- `settings.json` is backed up to `settings.json.scenes-bak` before every write; writes are atomic (tmp + rename)

### Field reference

| Field | Description |
|---|---|
| `common.packages` / `common.skills` | common-layer resources, always loaded |
| `scenes.<name>.packages` | accepts `"npm:<pkg>"`, `"git:github.com/u/r"`, local paths, and object form (resource filtering, same grammar as pi settings) |
| `scenes.<name>.skills` | paths/directories, `~` expanded |
| `scenes.<name>.extends` | 🧪 inherit a parent scene (union merge + cycle detection) — forward-compatible entry for parent→child hierarchies |
| `evolve.patience` / `evolve.absorbThreshold` / `evolve.skillUnusedThreshold` | self-evolution tunables (see "Self-evolution") |

## Rollback

```bash
pi remove npm:pi-scenes                            # uninstall the extension
cp ~/.pi/agent/settings.json.scenes-bak ~/.pi/agent/settings.json   # restore if needed
```

Before uninstalling, `/scene off` and prune entries you don't want to keep from `packages`/`skills`. `scenes.json` / `scenes-state.json` / the `scenes/` tree are inert leftovers — safe to keep or delete.

## Development

```bash
git clone https://github.com/Feng-H/pi-scenes && cd pi-scenes
npm test          # node:test, 19 cases: injection/reclaim + usage/evolution + conflict guards + command-layer smoke (no TUI needed)
```

Tests isolate via the `PI_SCENES_DIR` env var — your real `~/.pi/agent` is never touched.

## License

MIT

---

# 中文说明

> [pi](https://pi.dev) 场景切换器：**通用层 + 分场景层**的 extension / skill 打包切换。
> 写代码时 `/scene coding`，办公时 `/scene office`——一键换装，热重载生效。

## 这是什么

pi 的 `packages` / `skills` 是全局平铺的：所有已安装扩展、所有 skill 同时生效。
于是上下文越来越肥——写代码时被办公 skill 占 token，办公时被代码 skill 干扰。

**pi-scenes 给资源加了「场景」维度**：

```
生效资源 = 通用层(common) ∪ 当前场景(scene)
```

- **通用层**：任何场景下恒加载的 extension + skill（如配额显示、会话延续）
- **场景层**：每个场景自己的一组 extension + skill，激活才加载
- 切换 = 改写 `settings.json` 的 `packages`/`skills` → `ctx.reload()` 热重载，**无需重启 pi**
- 数据模型预留 `extends` 继承链（带环检测），为将来「主场景 → 子场景」层级铺路

## 安装

```bash
pi install npm:pi-scenes
```

或从 git 直装（无需构建，直接加载 TS 源码）：

```bash
pi install git:github.com/Feng-H/pi-scenes
```

然后 `/reload`，`/scene` 生效。

## 快速开始

```
/scene            # 弹出选择器：列出所有场景，● 当前，○ 可切
/scene coding     # 直接切到 coding 场景
/scene office     # 切到办公场景
/scene off        # 仅保留通用层（关闭场景）
/scene status     # 查看当前激活 + 生效的 packages/skills 清单
/scene init       # 生成模板 scenes.json + 场景 skill 目录骨架
/scene stats      # 用量仪表盘：会话数 / 工具调用 / 反思评分
/scene evolve     # 生成并应用进化提案（逐条确认）
/scene evolve auto # 开关：会话结束自动应用（opt-in）
```

首次运行 `/scene` 会询问是否生成模板，生成后编辑场景定义。模板内置 **七个预设场景 + 通用层**（包均在 npm 核验存在，2026-09）：

| 层 | 预设 packages | 理由 |
|---|---|---|
| `common` | `npm:pi-scenes`、`npm:pi-carryover` | 切换器自身 + 跨会话承接，恒需 |
| `coding` | `npm:pi-lens`、`npm:pi-subagents`、`npm:pi-git-worktree` | LSP/lint 实时反馈、子代理委派、worktree 并行开发 |
| `office` | `npm:pi-docparser` | PDF/Office 文档解析 |
| `pm` | `npm:pi-web-access`、`npm:pi-goal-x`、`npm:@juicesharp/rpiv-todo` | 竞品/市场调研、目标规划与完成度审计、需求/任务清单 overlay |
| `research` | `npm:pi-web-access`、`npm:pi-subagents` | 多源搜索/抓取/PDF/视频，并行多角度深挖 |
| `writing` | `npm:pi-web-access` | 素材检索与事实核查（引用溯源） |
| `data` | `npm:pi-docparser`、`npm:pi-mcp-adapter` | 表格结构化抽取、接任意 MCP server（数据库/BI） |

每个场景同时生成 skill 目录骨架 `~/.pi/agent/scenes/<名>/skills/`，按需编辑：

```jsonc
// ~/.pi/agent/scenes.json
{
  "common": {                              // ── 通用层：所有场景恒加载
    "description": "通用层",
    "packages": ["npm:pi-zai-usage"],
    "skills": ["~/.pi/agent/scenes/common/skills"]
  },
  "scenes": {                              // ── 场景层：激活才叠加
    "coding": {
      "description": "写代码",
      "packages": ["npm:pi-carryover"],
      "skills": ["~/.pi/agent/scenes/coding/skills"]
    },
    "office": {
      "description": "办公",
      "packages": [
        { "source": "npm:pi-docparser", "skills": ["doc-parse"] }   // object form = 只加载该包部分资源
      ],
      "skills": ["~/.pi/agent/scenes/office/skills"]
    }
  }
}
```

场景 skill 目录里放 `SKILL.md` 文件夹（或 `.md` 文件）即可，切换场景时整目录启停。
`/scene init` 会创建 `~/.pi/agent/scenes/{common,coding,office,pm,research,writing,data}/skills/` 骨架。

### 状态栏场景徽标

切换成功后状态栏常驻徽标（`◆ coding`），每次会话启动自动恢复，`/scene off` 清除。状态栏应该回答「我现在在哪个场景」——而不是展示工具的内部状态。

场景常打包工具型扩展，它们自己的 footer 输出会把状态栏拼得很吵。若使用预设 `coding` 场景，pi-lens 的诊断 widget 与 `LSP Inactive` 状态可在**不损失任何 AI 侧价值**（turn-end 错误注入、`lens_diagnostics`、符号导航）的前提下静音，写入 `~/.pi-lens/config.json`：

```json
{ "ui": { "hideLspStatus": true }, "widget": { "visible": false } }
```

pi-scenes 绝不改第三方包的全局配置——徽标是它放到状态栏上的唯一东西。

## 自进化（用量驱动）

场景不是静态的。pi-scenes 观察你的实际使用并提议更新：

- **采集（被动，零感知）**——每次 `tool_call` 通过静态扫描安装源码归因到包；settings 里存在但不在任何场景定义的包记为*吸收候选*；每个会话结束用一次小 LLM 调用反思哪些已加载 skill 真正有用（几百 token、30s 超时、失败静默）。
- **提案**——`/scene evolve` 生成提案：
  - **吸收**：未纳管的包在 ≥2 个会话中出现 → 提议加入观察到的场景
  - **淘汰**：场景包连续 20 个会话零调用（且必须有过工具信号——纯命令包受保护）→ 提议移出；skill 反思 5 次以上「未用到」且 0 次「有用」→ 提议移出
  - **保护**：`common` 通用层与无工具信号的包（如只有 `/anywhere` 命令的扩展）**永不被自动变更**，只能用户手动改
- **应用（确认优先）**——每条提案展示 `scenes.json` diff 并逐条确认；接受后自动备份（`scenes.json.scenes-bak`）并热重载。`/scene evolve auto` 开启会话结束静默应用（下次自然重载生效）。

阈值在 `scenes.json` 可调：

```jsonc
{
  "evolve": {
    "patience": 20,           // 连续零调用会话数 → 淘汰
    "absorbThreshold": 2,     // 未纳管出现次数 → 吸收
    "skillUnusedThreshold": 5 // skill 反思未用到次数 → 淘汰
  }
}
```

用量数据：`~/.pi/agent/scenes-usage.json`（本机局部、惰性）。随时 `/scene stats` 查看。

### 安装 ≠ 加载（两层模型）

- **加载只看 settings.json。** 切换 = 改写 packages/skills 数组 + `ctx.reload()`；不在数组里的资源不会被加载——不注册工具、不占 prompt token。场景 skill 目录（`~/.pi/agent/scenes/<名>/skills`）不是 pi 自动发现路径，天然随场景启停。
- **磁盘文件保留。** 切走不卸载（彻底清理用 `pi remove`）；不在 settings 里的包只是惰性文件——切回秒级，零运行时成本。

一句话：**永远安装，只按场景加载**。注意：你手工 `pi install` 的条目属于你自己——pi-scenes 视为 `borrowed`，永不触碰，因此在**所有**场景都保持加载。

**包更新与场景无关。** 无论包被哪个场景引用，都只在全局安装一份（`~/.pi/agent/npm/`），场景只是拨动 `settings.json` 里的开关。因此 `pi update --extensions` 与当前在哪个场景无关（pi 的更新提示扫的是已安装包，不是活跃场景），且场景定义写的是不带版本的 `npm:<pkg>`，更新后下次切换/重载自动加载新版。注意 `0.x` 的 caret 范围不跨 minor——若更新提示反复出现，显式装指定版本：`pi install npm:<pkg>@<版本>`。

### 重复与冲突处理

- 同一写法在 common 与场景重复 → 并集时去重，只加载一次。
- 同包异写法（如 `npm:x@1.0.3` 与裸名 `npm:x`）→ 身份级去重取首个（common 优先）；settings 里手动 pin 的异写法条目视为 `borrowed`，不重复注入。`/scene` 切换与 `/scene status` 会对异写法发出提醒，建议统一。
- **本地路径与 npm 写法并存（v0.2.1）：** 若 settings 已通过本地路径加载某包（如你的开发目录 `/Users/you/dev/pi-carryover`），场景预设里的 `npm:pi-carryover` 会*借用*你的条目而不安装——跳过 `pi install`，绝不向 settings 追加第二种写法。这一点很关键：同一包双写法 = 同一扩展被加载两份 = pi 启动时工具重名冲突退出。若 settings 已陷入该状态（如手动 `pi install` 造成的重复），`/scene` 会拒绝切换并明确告知需要删除哪个条目。
- **热修（v0.2.2）：** `/scene <name>` 曾报 `Extension "command:scene" error: target.filter is not a function`——v0.2.1 重构时把 `computeTarget()` 返回的 `{packages, skills}` 对象传给了旧调用点用 `target.packages` 的地方，任何场景切换必触发。已修复，并补 command 层冒烟测试（独立测试文件 + `PI_SCENES_DIR` 环境变量 + 动态 import 隔离：扩展 default export 在模块求值时解析 base 目录，测试里静态 import 会直接读写真实 `~/.pi/agent`）。

## 工作原理

```
/scene coding
   │
   ├─ 读 scenes.json → 生效集合 = common ∪ coding（extends 链自动展开）
   ├─ 缺失的包 → confirm 后逐个 `pi install`（全局 scope pi 不自动装）
   ├─ 改写 settings.json（见「注入与回收」）
   └─ await ctx.reload()  → 扩展/skill 热重载，会话不中断
```

### 注入与回收（不动你的手工配置）

- `~/.pi/agent/scenes-state.json` 记录本扩展上次注入 `settings.json` 的条目（`managed`）
- 切换时：**先精确摘除 managed 旧条目，再追加新目标中缺失的条目**
- 你手工配置的 packages/skills **永不触碰**；若场景目标与你手配重合，该条目视为 `borrowed`，切走时保留
- 每次写 `settings.json` 前自动备份为 `settings.json.scenes-bak`，写入走 tmp+rename 原子替换

### 字段说明

| 字段 | 说明 |
|---|---|
| `common.packages` / `common.skills` | 通用层资源，恒加载 |
| `scenes.<name>.packages` | 支持 `"npm:<pkg>"`、`"git:github.com/u/r"`、本地路径字符串，及 object form（资源过滤，同 pi settings 规范） |
| `scenes.<name>.skills` | 路径/目录数组，支持 `~` 展开 |
| `scenes.<name>.extends` | 🧪 继承父场景（union 合并，带环检测）——「主场景→子场景」层级的前向兼容入口 |
| `evolve.patience` / `evolve.absorbThreshold` / `evolve.skillUnusedThreshold` | 自进化阈值（见「自进化」节） |

## 回退方案

```bash
pi remove npm:pi-scenes          # 卸载扩展
cp ~/.pi/agent/settings.json.scenes-bak ~/.pi/agent/settings.json   # 如需恢复
```

managed 注入的条目在卸载前建议先 `/scene off` + 手工清理 `packages`/`skills` 里不想保留的条目；`scenes.json` / `scenes-state.json` / `scenes/` 目录留着不影响 pi 运行。

## 开发

```bash
git clone https://github.com/Feng-H/pi-scenes && cd pi-scenes
npm test          # node:test，19 用例：注入/回收 + 用量/进化 + 异写法冲突防护 + command 层冒烟（无需 TUI）
```

测试用 `PI_SCENES_DIR` 环境变量隔离基目录，不碰真实 `~/.pi/agent`。

## License

MIT
