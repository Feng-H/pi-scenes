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
- **Project-scoped by default (v0.7)** — `/scene office` writes activation entries to `<cwd>/.pi/settings.json`, so a scene belongs to *this* directory only; opening a fresh directory starts clean. `--global` keeps the ≤0.6 all-projects behavior
- **Asset/activation split (v0.7)** — packages are installed once globally and shared across projects; git skill bundles are pinned as zero-exposure *anchors* (`{source, autoload:false, skills:[]}`) in user settings, while the project layer writes a *delta* (`{source, autoload:false, skills:[...]}`) that enables just the scene's whitelist — one clone, per-project curation, via pi's native delta mechanism
- **Scene-scoped prompt templates (v0.8)** — each scene can also bundle workflow templates (`prompts` field): fixed checklists that pin down step-by-step procedures so the model can't take shortcuts. Scene = **tools + skills + workflow templates** as one unit
- Switching rewrites `packages`/`skills` in `settings.json`, then `ctx.reload()` hot-reloads — **no pi restart, session untouched**; prompt templates take a different path: injected via pi's `resources_discover` event with **zero settings writes**
- Every switch stamps a persistent **status-bar badge** (`◆ coding`, or a per-scene `icon` like `💻 coding`) so the bar always answers *"which scene am I in"* — restored at session start, cleared by `/scene off`
- **Zero-memory discoverability (v0.4.1)** — the command hint lists your scene names, and Tab completion shows every scene (icon + description + current marker) plus subcommands: type `/scene c` + Tab → `/scene coding`
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
/scene            # picker: all scenes, ● current project scene, ◐ global, ○ inactive
/scene <Tab>      # tab-complete: lists all scenes (icon + description) and subcommands
/scene c<Tab>     # completes to /scene coding — no scene names to memorize
/scene coding     # switch to the coding scene (project-scoped: <cwd>/.pi only)
/scene coding --global  # switch as a global scene (every project, ≤0.6 behavior)
/scene office     # switch to the office scene
/scene off        # common layer only (clears both layers; anchors kept)
/scene status     # show project/global scenes + effective packages/skills
/scene migrate    # convert a ≤0.6 legacy global scene into this project's scene
/scene init       # scaffold scenes.json template + scene skill dirs
/scene stats      # usage dashboard: sessions, tool calls, reflections
/scene evolve     # generate & apply evolution proposals (confirm-first)
/scene evolve auto # toggle auto-apply at session end (opt-in)
```

First run of `/scene` offers to generate the template. It ships with **eight preset scenes + common** — a curated best-practice collection (all packages verified on npm/GitHub, 2026-09). v0.6.0 upgrades the presets with a full skill layer: git skill bundles install per scene with object-form resource filters, and research/writing ship vendored starter skills:

| Scene | Extensions | Skills | Prompt templates (v0.8) |
|---|---|---|---|
| `common` | `npm:pi-scenes`, `npm:pi-carryover` | — (your own dir) | — |
| `coding` | `npm:pi-lens`, `npm:pi-subagents`, `npm:pi-git-worktree`, `npm:pi-simplify` | `anthropics/skills` → frontend-design, webapp-testing, mcp-builder | `/pre-commit` |
| `office` | `npm:pi-docparser` | `anthropics/skills` → docx, pptx, xlsx, pdf, internal-comms | `/doc-from-notes` |
| `pm` | `npm:pi-web-access`, `npm:pi-goal-x`, `npm:@juicesharp/rpiv-todo`, `npm:@juicesharp/rpiv-ask-user-question` | — | `/prd-skeleton` |
| `research` | `npm:pi-web-access`, `npm:pi-subagents` | 预置：arxiv-research, openalex-paper-search | `/deep-dive` |
| `writing` | `npm:pi-web-access` | `anthropics/skills` → doc-coauthoring；预置：humanizer | `/fact-check` |
| `data` | `npm:pi-docparser`, `npm:pi-mcp-adapter` | — | `/data-audit` |
| `learning` | `npm:pi-web-access`, `npm:pi-subagents` | 预置：eli5 | `/feynman`, `/socratic`, `/flashcards` |

Each preset template is a fixed procedure that forbids step-skipping (e.g. `/pre-commit` = build → test → diff review → commit message, each step ✅/❌ with evidence). After switching scenes, try the scene's template command directly; drop your own `.md` files into `~/.pi/agent/scenes/<name>/prompts/` to add more.

Design notes:

- **Skills over extensions** — skills are progressively disclosed (only name+description stay in context, ~30 tokens each), while extensions inject full tool definitions. The template leans on the cheap layer for scene depth.
- **One git bundle, many scenes** — `git:github.com/anthropics/skills` is declared with a different `skills` filter per scene; the clone is shared, and switching swaps only the settings entry.
- **Vendored starter skills** (`assets/scene-skills/`, MIT with attribution) — research/writing had no pi-native skill packages, so scaffold copies curated ports (blader/humanizer, Hermes arXiv/OpenAlex) into your scene skill dirs. They are yours: edit or delete freely.
- **Object-form authority (v0.6.0 core fix)** — when a scene declares `{source, skills:[...]}` and a plain spec for the same package appears (e.g. written by `pi install` during the switch), the scene's filtered form replaces it, so multi-skill bundles never load unfiltered. A plain spec you configured yourself is still respected (borrowed, never taken over).

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
      "icon": "💻",
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

### Project vs global scopes (v0.7)

Scenes default to **project scope**: activation entries land in `<cwd>/.pi/settings.json`, scene skill dirs in `<cwd>/.pi/scenes/<name>/skills` (vendored skills are copied there on first switch — power-of-copy, edit freely). A new directory starts with the common layer only; nothing leaks across projects.

Under the hood the two settings layers split cleanly:

| Layer | File | What lands there |
|---|---|---|
| asset | `~/.pi/agent/settings.json` | npm/local extensions (tools, not prompt tokens), common-layer skills, zero-exposure anchors for git skill bundles |
| activation | `<cwd>/.pi/settings.json` | per-scene delta entries (`autoload:false` + skills whitelist), scene skill dir paths |

Anchors make re-switching instant: the git clone stays warm in `~/.pi/agent/git`, so switching scenes in another project never re-downloads 15MB. `/scene off` keeps anchors on purpose (they expose zero skills); `/scene <name> --global` replaces an anchor with a full whitelist entry for all-project activation. Layers are mutually exclusive — switching always reclaims both layers' previous managed entries first, then writes the new one.

Upgrading from ≤0.6? The first session shows a one-time notice; `/scene migrate` converts the legacy global scene into this project's scene in one step.

### Resource loading: shared vs copied (no symlinks, ever)

What actually lands on disk when you switch scenes:

| Resource | Mechanism | On disk in the project |
|---|---|---|
| Scene extensions (npm/git packages, e.g. `anthropics/skills` skill bundles) | **Declared, never copied** — settings entries point at the single global install (`~/.pi/agent/{npm,git}`); pi loads code/SKILL.md straight from there | nothing |
| Scene skill dirs (scaffold presets + anything you drop in `~/.pi/agent/scenes/<name>/skills`) | **Copied once per project** on first switch (idempotent — only missing files, never overwrites your edits) | `<cwd>/.pi/scenes/<name>/skills/` |
| Custom skill paths outside the scenes root (e.g. `~/my-shared-skills`) | Referenced as-is, not copied | — |

Two consequences worth internalizing:

- **Loaded ≠ present.** Switching scenes swaps the *declarations*; disks keep whatever was copied before. After office→coding, the office skill dir still sits in `<cwd>/.pi/scenes/office/` but has no settings entry pointing at it — never scanned, never loaded, zero prompt cost. It only means switching back is instant.
- **Copies are yours.** A vendored skill copied into the project can be edited or deleted freely; upgrading pi-scenes never touches it. Want your improvement everywhere? Edit the global source (`~/.pi/agent/scenes/<name>/skills/`) and let other projects copy it on their first switch.

### Known limitation: cross-scene npm extensions are a global singleton

Skill exposure (the main point of scenes) is fully project-scoped via deltas. npm *extensions*, however, register their activation entries in the global layer — one slot per package. Running two pi instances in different projects with different scenes (A on `coding`, B on `office`): whichever switches last removes the other's npm entries from global settings on its next reload (skills stay fine; extensions like pi-lens/pi-docparser swap). Single-project workflows never hit this. If you need concurrent per-project extension sets, tell me — a future version can project-scope npm extensions at the cost of per-project `node_modules`.

### Status-bar scene badge

A successful switch sets a persistent footer badge (`◆ coding`), restored automatically at every session start and cleared by `/scene off`. The status bar should answer *"which scene am I in"* — not display tool internals.

The prefix is customizable per scene via the `icon` field — emoji works great (`💻 coding`). The scaffolded presets ship with `💻 📄 🎯 🔍 📝 📊`, and the picker plus `/scene status` display the same icon; unset scenes fall back to `◆`.

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
                         ↘ pi asks resources_discover → scene's prompt templates
                           appear as /commands (no settings writes; switching
                           away stops returning them → they vanish)
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
| `scenes.<name>.icon` | status-bar badge & picker prefix (emoji recommended; default `◆`) |
| `scenes.<name>.skills` | paths/directories, `~` expanded |
| `scenes.<name>.prompts` | prompt-template files/directories (`.md`), `~` expanded; injected via `resources_discover`, never written to settings (v0.8) |
| `scenes.<name>.extends` | 🧪 inherit a parent scene (union merge + cycle detection) — forward-compatible entry for parent→child hierarchies |
| `evolve.patience` / `evolve.absorbThreshold` / `evolve.skillUnusedThreshold` | self-evolution tunables (see "Self-evolution") |

## Scene-scoped prompt templates (v0.8)

Fixed workflows (release checklists, review procedures, research protocols) belong to scenes too. v0.8 adds a `prompts` field per scene, turning a scene into **tools + skills + workflow templates** as one unit.

```jsonc
"scenes": {
  "research": {
    "packages": ["npm:pi-web-access"],
    "skills": ["~/.pi/agent/scenes/research/skills"],
    "prompts": ["~/.pi/agent/scenes/research/prompts"]  // ← new
  }
}
```

**How it's wired — zero settings pollution.** The extension listens to pi's `resources_discover` event: on every startup/reload pi asks which extra resource paths to load, and pi-scenes answers with the active scene's `promptPaths`. Switching away simply stops returning them — templates vanish with **no settings writes, no cleanup, no residue** (unlike packages/skills, which land in settings.json).

- Scaffold preseeds one workflow template per preset scene (`/pre-commit` for coding, `/deep-dive` for research, `/fact-check` for writing, `/prd-skeleton` for pm, `/doc-from-notes` for office, `/data-audit` for data), vendored into `~/.pi/agent/scenes/<scene>/prompts/` (idempotent copy, yours to edit)
- Same-name resolution: your hand-written templates (`~/.pi/agent/prompts/`, project `.pi/prompts/`) and package templates **win over** scene templates — user intent beats presets
- Why templates at all: they pin down step-by-step procedures so the model can't take shortcuts; human remembers the command name, the template carries the checklist

## Rollback

```bash
pi remove npm:pi-scenes                            # uninstall the extension
cp ~/.pi/agent/settings.json.scenes-bak ~/.pi/agent/settings.json   # restore if needed
```

Before uninstalling, `/scene off` and prune entries you don't want to keep from `packages`/`skills`. `scenes.json` / `scenes-state.json` / the `scenes/` tree are inert leftovers — safe to keep or delete.

## Development

```bash
git clone https://github.com/Feng-H/pi-scenes && cd pi-scenes
npm test          # node:test, 32 cases: injection/reclaim + usage/evolution + conflict guards + command-layer smoke (no TUI needed)
```

Tests isolate via the `PI_SCENES_DIR` env var — your real `~/.pi/agent` is never touched.

## License

MIT

---

# 中文说明

> [pi](https://pi.dev) 场景切换器：**通用层 + 分场景层**的 extension / skill / prompt 模板打包切换。
> 写代码时 `/scene coding`，办公时 `/scene office`——一键换装，热重载生效；v0.8 起场景还携带流程模板（`/pre-commit`、`/deep-dive`…），步骤清单固化、AI 无法跳步。

## 这是什么

pi 的 `packages` / `skills` 是全局平铺的：所有已安装扩展、所有 skill 同时生效。
于是上下文越来越肥——写代码时被办公 skill 占 token，办公时被代码 skill 干扰。

**pi-scenes 给资源加了「场景」维度**：

```
生效资源 = 通用层(common) ∪ 当前场景(scene)
```

- **通用层**：任何场景下恒加载的 extension + skill（如配额显示、会话延续）
- **场景层**：每个场景自己的一组 extension + skill，激活才加载
- **默认项目级（v0.7）**——`/scene office` 把激活条目写进 `<cwd>/.pi/settings.json`，场景只属于当前目录；新建目录零残留、干净启动。`--global` 保留 ≤0.6 的全目录生效语义
- **资产/激活分离（v0.7）**——包只全局装一份、所有项目共享；git 技能包在全局层钉为零暴露**锚点**（`{source, autoload:false, skills:[]}`），项目层写 **delta**（`{source, autoload:false, skills:[白名单]}`）按场景启用——借 pi 原生 delta 机制做到「一份克隆、每项目各自的精选」
- **场景化 prompt 模板（v0.8）**——每个场景可携带流程模板（`prompts` 字段）：把固定流程的步骤清单固化成 `/命令`，模型无法挑最快路径跳步。场景成为**工具 + 技能 + 流程模板**三位一体
- 切换 = 改写 `settings.json` 的 `packages`/`skills` → `ctx.reload()` 热重载，**无需重启 pi**；prompt 模板走另一条路：经 pi 的 `resources_discover` 事件动态注入，**零 settings 写入**
- 每次切换成功后状态栏常驻**场景徽标**（`◆ coding`，或每场景自定义 `icon` 如 `💻 coding`），状态栏随时回答「我现在在哪个场景」——会话启动自动恢复，`/scene off` 清除
- **零记忆可发现性（v0.4.1）**——命令提示行直接拼入场景名清单；Tab 补全列出全部场景（icon + 描述 + 当前标记）与子命令：`/scene c` + Tab → `/scene coding`
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
/scene            # 弹出选择器：● 当前项目场景，◐ 当前全局场景，○ 可切
/scene <Tab>      # Tab 补全：列出全部场景（icon + 描述）与子命令
/scene c<Tab>     # 补齐为 /scene coding —— 无需记忆任何场景名
/scene coding     # 切到 coding 场景（项目级：只写入 <cwd>/.pi）
/scene coding --global  # 切为全局场景（所有目录生效，≤0.6 语义）
/scene office     # 切到办公场景
/scene off        # 仅保留通用层（摘两层；资产锚点保留）
/scene status     # 查看项目/全局两级场景 + 生效 packages/skills
/scene migrate    # 把 ≤0.6 遗留的全局场景转为当前项目场景
/scene init       # 生成模板 scenes.json + 场景 skill 目录骨架
/scene stats      # 用量仪表盘：会话数 / 工具调用 / 反思评分
/scene evolve     # 生成并应用进化提案（逐条确认）
/scene evolve auto # 开关：会话结束自动应用（opt-in）
```

首次运行 `/scene` 会询问是否生成模板，生成后编辑场景定义。模板内置 **八个预设场景 + 通用层**（包均在 npm 核验存在，2026-09）：

| 层 | 预设 packages | 理由 |
|---|---|---|
| `common` | `npm:pi-scenes`、`npm:pi-carryover` | 切换器自身 + 跨会话承接，恒需 |
| `coding` | `npm:pi-lens`、`npm:pi-subagents`、`npm:pi-git-worktree` | LSP/lint 实时反馈、子代理委派、worktree 并行开发 |
| `office` | `npm:pi-docparser` | PDF/Office 文档解析 |
| `pm` | `npm:pi-web-access`、`npm:pi-goal-x`、`npm:@juicesharp/rpiv-todo` | 竞品/市场调研、目标规划与完成度审计、需求/任务清单 overlay |
| `research` | `npm:pi-web-access`、`npm:pi-subagents` | 多源搜索/抓取/PDF/视频，并行多角度深挖 |
| `writing` | `npm:pi-web-access` | 素材检索与事实核查（引用溯源） |
| `data` | `npm:pi-docparser`、`npm:pi-mcp-adapter` | 表格结构化抽取、接任意 MCP server（数据库/BI） |
| `learning` | `npm:pi-web-access`、`npm:pi-subagents` | 学习材料获取、并行多视角学习；预置 skill：eli5（大白话解释） |

v0.8 起每个预设场景还携带流程模板（coding→`/pre-commit`、office→`/doc-from-notes`、pm→`/prd-skeleton`、research→`/deep-dive`、writing→`/fact-check`、data→`/data-audit`；v0.9 learning 场景→`/feynman` 费曼内化 + `/socratic` 苏格拉底检验 + `/flashcards` 闪卡复习，三件套），切换后直接可用；自己加模板只需往 `~/.pi/agent/scenes/<名>/prompts/` 丢 `.md` 文件。

每个场景同时生成 skill / prompts 目录骨架 `~/.pi/agent/scenes/<名>/{skills,prompts}/`，按需编辑：

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
      "icon": "💻",
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

### 资源加载方式：大件共享、小件复制、全程无软链接

切换场景时各资源到底怎么落到磁盘：

| 资源 | 机制 | 项目磁盘上 |
|---|---|---|
| 场景扩展（npm/git 包，如 anthropics/skills 技能包） | **声明式引用，永不复制**——settings 条目指向全局唯一安装（`~/.pi/agent/{npm,git}`），pi 直接从那里加载代码/SKILL.md | 什么都没有 |
| 场景技能目录（脚手架预置 + 你投进 `~/.pi/agent/scenes/<名>/skills` 的一切） | **每项目首次切换时复制一次**（幂等——只补缺失文件，绝不覆盖你的修改） | `<cwd>/.pi/scenes/<名>/skills/` |
| scenesRoot 之外的自定义技能路径（如 `~/my-shared-skills`） | 原样引用，不复制 | — |

两个值得记住的推论：

- **「存在」≠「加载」。** 切换换的是声明，磁盘留着切过的所有副本。office→coding 后，office 技能目录仍在 `<cwd>/.pi/scenes/office/`，但没有任何 settings 条目指向它——不被扫描、不被加载、零提示成本；意义仅是切回时秒级。
- **复制即所有。** 复制进项目的技能随意改删，升级 pi-scenes 永远不会碰它；想让改进全局生效，改全局源（`~/.pi/agent/scenes/<名>/skills/`），其他项目首切时自然复制到。

### 已知限制：跨场景 npm 扩展是全局单例

技能暴露（场景的核心差异）已通过 delta 完全项目级隔离；但 npm 扩展的激活条目在全局层——每包一个坑位。两个 pi 实例在不同项目跑不同场景（A 用 coding、B 用 office）时，后切换的一方会把先切换方的 npm 条目从全局 settings 摘掉（技能不受影响；pi-lens/pi-docparser 这类扩展会互换）。单项目工作流永远碰不到这个问题；确实需要多项目并行各自扩展集的，可以做到（代价：每项目重复装 node_modules），需要请在 issue 里说一声。

### 状态栏场景徽标

切换成功后状态栏常驻徽标（项目场景 `◆ coding`，全局场景 `◇ coding ⌘`），每次会话启动自动恢复，`/scene off` 清除。状态栏应该回答「我现在在哪个场景、哪一层」——而不是展示工具的内部状态。

徽标前缀可按场景用 `icon` 字段定制——emoji 完全可用（`💻 coding`）。脚手架预设自带 `💻 📄 🎯 🔍 📝 📊`，选择器与 `/scene status` 同步显示同一 icon；未配置的场景回退 `◆`。

场景常打包工具型扩展，它们自己的 footer 输出会把状态栏拼得很吵。若使用预设 `coding` 场景，pi-lens 的诊断 widget 与 `LSP Inactive` 状态可在**不损失任何 AI 侧价值**（turn-end 错误注入、`lens_diagnostics`、符号导航）的前提下静音，写入 `~/.pi-lens/config.json`：

```json
{ "ui": { "hideLspStatus": true }, "widget": { "visible": false } }
```

pi-scenes 绝不改第三方包的全局配置——徽标是它放到状态栏上的唯一东西。

### 项目级 vs 全局（v0.7）

场景默认**项目级**：激活条目写入 `<cwd>/.pi/settings.json`，场景技能目录在 `<cwd>/.pi/scenes/<名>/skills`（预置技能首次切换时复制过去，复制即所有，随意改删）。新建目录只有通用层，项目间零泄漏。

两层 settings 各司其职：

| 层 | 文件 | 落点内容 |
|---|---|---|
| 资产层 | `~/.pi/agent/settings.json` | npm/本地扩展（工具不占提示 token）、通用层 skills、git 技能包零暴露锚点 |
| 激活层 | `<cwd>/.pi/settings.json` | 场景 delta 条目（`autoload:false` + skills 白名单）、场景技能目录路径 |

锚点让重切秒级：git 克隆常驻 `~/.pi/agent/git`，换个项目再切同一场景不会重新下载 15M。`/scene off` 有意保留锚点（零技能暴露、零成本）；`/scene <名> --global` 会把锚点替换为完整白名单条目（全目录生效）。两层互斥：任何切换都先摘净两层旧 managed 再写新层。

从 ≤0.6 升级？首个会话会提示一次；`/scene migrate` 一步把遗留全局场景转为当前项目场景。

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
                         ↘ pi 询问 resources_discover → 场景流程模板出现为
                           /命令（零 settings 写入；切走后不再返回 → 自动消失）
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
| `scenes.<name>.icon` | 状态栏徽标与选择器前缀（建议 emoji；缺省 `◆`） |
| `scenes.<name>.skills` | 路径/目录数组，支持 `~` 展开 |
| `scenes.<name>.prompts` | prompt 模板文件/目录（`.md`），支持 `~` 展开；经 `resources_discover` 动态注入，永不写 settings（v0.8） |
| `scenes.<name>.extends` | 🧪 继承父场景（union 合并，带环检测）——「主场景→子场景」层级的前向兼容入口 |
| `evolve.patience` / `evolve.absorbThreshold` / `evolve.skillUnusedThreshold` | 自进化阈值（见「自进化」节） |

## 场景化 prompt 模板（v0.8）

固定流程（发版体检、审查步骤、调研套路）也属于场景。v0.8 为每个场景新增 `prompts` 字段，场景成为**工具 + 技能 + 流程模板**三位一体：

```jsonc
"scenes": {
  "research": {
    "packages": ["npm:pi-web-access"],
    "skills": ["~/.pi/agent/scenes/research/skills"],
    "prompts": ["~/.pi/agent/scenes/research/prompts"]  // ← 新增
  }
}
```

**接线方式——零 settings 污染。** 与 packages/skills 落 settings.json 不同，模板走 pi 的 `resources_discover` 事件：每次启动/重载 pi 会询问各扩展需要加载哪些额外资源，pi-scenes 按当前激活场景返回模板路径。切走场景后不再返回——模板自动消失，**不写 settings、无需清理、零残留**。

- scaffold 为每个预设场景预置一个流程模板（coding→`/pre-commit`、research→`/deep-dive`、writing→`/fact-check`、pm→`/prd-skeleton`、office→`/doc-from-notes`、data→`/data-audit`），vendored 复制到 `~/.pi/agent/scenes/<场景>/prompts/`（幂等，复制后归你所有，可改可删）
- 同名解析：你手写的模板（`~/.pi/agent/prompts/`、项目 `.pi/prompts/`）与包模板**优先于**场景模板——用户意图压过预设
- 为什么需要模板：把步骤清单固化成模板，模型就无法挑最快路径跳步；人只记命令名，清单由模板携带

## 回退方案

```bash
pi remove npm:pi-scenes          # 卸载扩展
cp ~/.pi/agent/settings.json.scenes-bak ~/.pi/agent/settings.json   # 如需恢复
```

managed 注入的条目在卸载前建议先 `/scene off` + 手工清理 `packages`/`skills` 里不想保留的条目；`scenes.json` / `scenes-state.json` / `scenes/` 目录留着不影响 pi 运行。

## 开发

```bash
git clone https://github.com/Feng-H/pi-scenes && cd pi-scenes
npm test          # node:test，32 用例：注入/回收 + 用量/进化 + 异写法冲突防护 + 对象形态替换语义 + scaffold 预置技能 + command 层冒烟（无需 TUI）
```

测试用 `PI_SCENES_DIR` 环境变量隔离基目录，不碰真实 `~/.pi/agent`。

## License

MIT
