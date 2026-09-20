# pi-scenes

> [pi coding agent](https://pi.dev) 场景切换器：**通用层 + 分场景层**的 extension / skill 打包切换。
> 写代码时 `/scene coding`，办公时 `/scene office`——一键换装，热重载生效。

[![pi-package](https://img.shields.io/badge/pi-package-00b57a)](https://pi.dev/packages)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## 为什么

pi 的 `packages` / `skills` 是全局平铺的：所有已安装扩展、所有 skill 同时生效。
于是上下文越来越肥——写代码时被办公 skill 占 token，办公时被代码 skill 干扰。

**pi-scenes 给资源加了「场景」维度**：

```
生效资源 = 通用层(common) ∪ 当前场景(scene)
```

- **通用层**：任何场景下恒加载的 extension + skill（如配额显示、会话延续）
- **场景层**：每个场景自己的一组 extension + skill，激活才加载
- 切换 = 改写 `settings.json` 的 `packages`/`skills` → `ctx.reload()` 热重载，**无需重启 pi**
- 数据模型预留 `extends` 继承链，为将来「主场景 → 子场景」层级铺路

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
```

首次运行 `/scene` 会询问是否生成模板，生成后编辑场景定义：

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
`/scene init` 会创建 `~/.pi/agent/scenes/{common,coding,office}/skills/` 骨架。

## 工作原理

```
/scene coding
   │
   ├─ 读 scenes.json → 生效集合 = common ∪ coding（extends 链自动展开）
   ├─ 缺失的包 → confirm 后逐个 `pi install`（全局 scope pi 不自动装）
   ├─ 改写 settings.json（见下方「注入与回收」）
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

## 回退方案

```bash
pi remove npm:pi-scenes          # 卸载扩展
cp ~/.pi/agent/settings.json.scenes-bak ~/.pi/agent/settings.json   # 如需恢复
```

managed 注入的条目在卸载前建议先 `/scene off` + 手工清理 `packages`/`skills` 里不想保留的条目；`scenes.json` / `scenes-state.json` / `scenes/` 目录留着不影响 pi 运行。

## 开发

```bash
git clone https://github.com/Feng-H/pi-scenes && cd pi-scenes
npm test          # node:test，核心注入/回收逻辑全覆盖（无需 TUI）
```

测试用 `PI_SCENES_DIR` 环境变量隔离基目录，不碰真实 `~/.pi/agent`。

## License

MIT
