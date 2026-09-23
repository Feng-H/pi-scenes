/**
 * scenes.ts — pi 场景切换器：通用层 + 分场景层的 extension / skill 打包切换。
 *
 * 核心思想：
 *   生效资源 = 通用层(common) ∪ 当前场景(scene)
 *   切换场景 = 改写 settings 的 packages/skills 数组 → ctx.reload() 热重载
 *
 * 双层模型（v0.7）：资产层（user 全局）与激活层（project 项目）分离
 *   旧版（≤0.6）把场景条目全部写进 ~/.pi/agent/settings.json —— 换目录启动 pi
 *   场景也跟着带过去。v0.7 起 /scene <name> 默认作用于当前项目（<cwd>/.pi），
 *   --global 才写全局。分层规则：
 *   · npm/local 条目（工具型扩展，不占系统提示）→ 全局层：装一次全局可用
 *   · git 多技能包（object form，全量暴露会污染系统提示）→ 双写：
 *     全局锚点 {source, autoload:false, skills:[]}（零暴露 + 共享全局克隆）
 *     项目 delta {source, autoload:false, skills:[场景子集]}（pi 原生 delta 机制：
 *     project 条目 autoload:false 时基于 user 级安装做增量启用，见 pi packages.md
 *     "project entry acts as a filtering delta over the personal package"）
 *   · 场景 scaffold 技能目录 → 项目层：<cwd>/.pi/scenes/<名>/skills
 *   · common 通用层 skills → 全局层（任何项目恒加载）
 *   两层互斥单激活：切换时先摘净两层旧 managed 再写新层；资产锚点不摘
 *   （零暴露无害，保留可让下次切换零下载秒切）。
 *
 * 分层模型（前向兼容「主场景→子场景」层级）：
 *   common  —— 通用层：任何场景下都恒加载的 packages + skills
 *   scenes  —— 平铺的场景表；每个场景可选 `extends: "<父场景名>"` 继承链
 *              （v0.1 未在文档主推，但解析器已实现 union 合并 + 环检测，
 *                未来「主场景/子场景」直接落地为 extends 链，无需改数据结构）
 *
 * 注入与回收（关键安全设计）：
 *   本扩展绝不整包覆盖 settings.json，只做「摘旧 + 补新」：
 *   - scenes-state.json 记录上次注入的条目（managed）
 *   - 切换时先从 packages/skills 里精确摘掉 managed 条目
 *   - 再追加新目标集合中「原本不存在」的条目
 *   - 用户手工配置的条目永不触碰；若目标条目用户已手配，视为 borrowed，切走时保留
 *
 * 命令：
 *   /scene              弹出选择器（当前场景高亮 ●）
 *   /scene <name>       切换到指定场景（默认项目级；参数 Tab 补全：/scene c<Tab> → /scene coding）
 *   /scene <name> --global  切换为全局场景（所有项目生效，≤0.6 语义）
 *   /scene off|none     关闭场景（摘两层，仅保留通用层；资产锚点保留）
 *   /scene status       显示当前激活与生效资源（项目/全局两级）
 *   /scene migrate      把 ≤0.6 遗留的全局场景转为当前项目场景
 *   /scene init         生成模板 scenes.json 与场景 skill 目录骨架
 *   /scene stats        用量仪表盘（会话数/工具调用/反思评分/未纳管观察）
 *   /scene evolve       生成进化提案并逐条确认应用（备份 + 热重载）
 *   /scene evolve auto  开关：会话结束自动应用进化（opt-in，不动 common/无工具包）
 *
 * 可发现性（v0.4.1）：命令 description 在注册时动态拼入场景名清单；
 * 参数 Tab 补全列出全部场景（icon+描述+当前标记）与子命令 ——
 * 不需要记忆任何场景名，空格后 Tab 即见全表。
 *
 * 自进化（v0.2）：
 *   采集：tool_call 归因（静态扫描安装源码建 tool→pkg 表）+
 *         settings 未纳管条目观察 + 会话结束 LLM 反思 skill 有用性
 *   提案：吸收（未纳管 ≥2 次）→ 淘汰（连续 20 会话零调用且有过工具信号）
 *   保护：common 层与无工具信号的包（command-only）永不自动变更
 *
 * 文件：
 *   ~/.pi/agent/scenes.json        场景定义（用户编辑；含 evolve 阈值配置）
 *   ~/.pi/agent/scenes-state.json  全局层激活状态 + managed 追踪（本扩展维护）
 *   ~/.pi/agent/scenes-usage.json  用量记账与自进化数据（本扩展维护）
 *   ~/.pi/agent/settings.json      pi 全局设置（资产层：npm 扩展 + 锚点 + common skills）
 *   ~/.pi/agent/scenes/<名>/skills 全局场景 skill 目录（--global 模式与 vendor 源）
 *   <cwd>/.pi/settings.json        项目设置（激活层：delta 条目 + 场景 skills 相对路径）
 *   <cwd>/.pi/scenes-state.json    项目层激活状态 + managed 追踪（本扩展维护）
 *   <cwd>/.pi/scenes/<名>/skills   项目场景 skill 目录（vendor 复制目标）
 *
 * 环境变量：
 *   PI_SCENES_DIR          覆盖全局基目录（默认 ~/.pi/agent，测试用）
 *   PI_SCENES_PROJECT_DIR  覆盖项目基目录（默认 <cwd>/.pi，测试用）
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── 类型 ────────────────────────────────────────────────────

/** packages 数组条目：字符串 spec，或 object form（带资源过滤） */
export type PackageEntry = string | { source: string; [k: string]: unknown };

export interface SceneDef {
	description?: string;
	/** 状态栏徽标与选择器里的场景前缀（建议 emoji，如 💻）；缺省 ◆ */
	icon?: string;
	/** 前向兼容：继承父场景（主场景→子场景层级），资源按链 union 合并 */
	extends?: string;
	packages?: PackageEntry[];
	/** skill 文件/目录路径，支持 ~ 前缀 */
	skills?: string[];
}

export interface EvolveConfig {
	/** 连续多少个会话零调用后提议淘汰（默认 20） */
	patience?: number;
	/** 未纳管条目出现多少次后提议吸收（默认 2） */
	absorbThreshold?: number;
	/** skill 反思多少次「未用到」后提议淘汰（默认 5） */
	skillUnusedThreshold?: number;
}

export interface ScenesFile {
	common?: SceneDef;
	scenes?: Record<string, SceneDef>;
	/** 自进化配置（v0.2） */
	evolve?: EvolveConfig;
}

export interface ResourceUsage {
	toolCalls?: number;
	lastUsed?: string;
	sessionsSeen?: number;
	absentStreak?: number;
	reflections?: { useful: number; unused: number };
}

export interface UsageFile {
	autoEvolve?: boolean;
	perScene: Record<string, { sessions: number; lastActive: string }>;
	perResource: Record<string, ResourceUsage>;
	/** 在 settings 中出现但不在任何场景定义的条目（吸收候选） */
	unmanagedSeen: Record<string, { count: number; lastSeen: string; scenes: string[] }>;
	/** 当前会话记账（跨 reload 存续）：seen = 本会话用过的资源 key */
	_current?: { file: string; scene: string | null; seen: string[] };
}

export type Proposal =
	| { kind: "absorb"; scene: string; entry: PackageEntry; reason: string }
	| { kind: "retire"; scene: string; key: string; label: string; skillPath?: string; reason: string };

export interface SceneState {
	/** 当前激活场景名；null = 仅通用层 */
	active: string | null;
	/** 本扩展注入 settings 的条目（切走时精确摘除） */
	managed: { packages: PackageEntry[]; skills: string[] };
	/** v0.7 资产锚点（git 包 {source, autoload:false, skills:[]}）：零暴露 + 共享全局
	 *  克隆；off/切换不摘，让下次切换零下载秒切。仅全局层 state 使用。 */
	anchors?: PackageEntry[];
	/** state 结构版本：2 = v0.7+ 双层模型；缺省 = ≤0.6 遗留（全局场景模式） */
	version?: number;
	/** ≤0.6 遗留全局场景的迁移提示是否已弹过（仅全局层 state 使用） */
	migrateNotified?: boolean;
}

export interface ApplyResult {
	addedPackages: PackageEntry[];
	addedSkills: string[];
	removedPackages: PackageEntry[];
	removedSkills: string[];
	borrowedPackages: PackageEntry[];
	borrowedSkills: string[];
}

// ── 工具函数 ────────────────────────────────────────────────

function expandHome(p: string): string {
	if (p === "~") return os.homedir();
	if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
	return p;
}

/** 稳定字符串化（key 排序），用于 object 条目的相等性判断 */
function canonical(v: unknown): string {
	if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
	if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
	const obj = v as Record<string, unknown>;
	const keys = Object.keys(obj).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

function sameEntry(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	return canonical(a) === canonical(b);
}

function removeFrom<T>(arr: T[] | undefined, targets: T[]): T[] {
	if (!arr) return [];
	return arr.filter((item) => !targets.some((t) => sameEntry(item, t)));
}

function specOf(e: PackageEntry): string {
	return typeof e === "string" ? e : e.source;
}

/** 包条目的身份候选（用于工具归因匹配） */
function packageIdentity(entry: PackageEntry): string[] {
	const spec = typeof entry === "string" ? entry : entry?.source ?? "";
	if (!spec) return [];
	const loc = specLocation(spec);
	if (loc.kind === "npm" && loc.npmName) return [loc.npmName];
	if (loc.kind === "git" && loc.gitDir) return [path.basename(loc.gitDir)];
	if (loc.kind === "local" && loc.localPath) return [path.basename(expandHome(loc.localPath))];
	return [];
}

/** skill 名：SKILL.md frontmatter name → 一级标题 → 文件名 */
/** 身份级判等：同一包的不同写法（裸名 vs @版本 pin）视为同一资源 */
function sameResource(a: PackageEntry, b: PackageEntry): boolean {
	if (sameEntry(a, b)) return true;
	const ia = packageIdentity(a);
	const ib = packageIdentity(b);
	return ia.length > 0 && ia.some((x) => ib.includes(x));
}

/** 身份级去重（keep-first：common 优先于场景、子场景优先于父场景） */
function dedupeByIdentity(entries: PackageEntry[]): PackageEntry[] {
	const out: PackageEntry[] = [];
	for (const e of entries) if (!out.some((x) => sameResource(x, e))) out.push(e);
	return out;
}

function skillNameOf(file: string): string {
	try {
		const head = fs.readFileSync(file, "utf8").slice(0, 4000);
		const m = head.match(/^name:\s*["']?([^"'\n#]+?)["']?\s*$/m);
		if (m) return m[1].trim();
		const t = head.match(/^#\s+(.+)$/m);
		if (t) return t[1].trim();
	} catch {}
	return path.basename(file).replace(/\.md$/i, "");
}

/** 展开场景 skill 条目为单个 skill 清单（目录→子 SKILL.md / .md 文件） */
function listSkillChildren(skillPaths: string[]): { id: string; label: string }[] {
	const out: { id: string; label: string }[] = [];
	for (const p of skillPaths) {
		let stt: fs.Stats;
		try {
			stt = fs.statSync(p);
		} catch {
			continue;
		}
		if (stt.isFile()) {
			if (/\.md$/i.test(p)) out.push({ id: p, label: skillNameOf(p) });
			continue;
		}
		let ents: fs.Dirent[];
		try {
			ents = fs.readdirSync(p, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of ents) {
			if (e.isDirectory()) {
				const sk = path.join(p, e.name, "SKILL.md");
				if (fs.existsSync(sk)) out.push({ id: sk, label: skillNameOf(sk) });
			} else if (/\.md$/i.test(e.name) && !/^SKILL\.md$/i.test(e.name)) {
				out.push({ id: path.join(p, e.name), label: skillNameOf(path.join(p, e.name)) });
			}
		}
	}
	return out;
}

function extractText(resp: unknown): string {
	const r = resp as any;
	const c = r?.choices?.[0]?.message?.content ?? r?.content ?? r?.text ?? "";
	if (typeof c === "string") return c;
	if (Array.isArray(c)) return c.filter((x: any) => x?.type === "text").map((x: any) => x.text).join("");
	return "";
}

function parseJsonLoose(text: string): any | null {
	const stripped = text.replace(/```(?:json)?/g, "");
	const start = stripped.indexOf("{");
	const end = stripped.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	try {
		return JSON.parse(stripped.slice(start, end + 1));
	} catch {
		return null;
	}
}

/** 递归收集 JS/TS 源文件（限量，避免大包扫描过久） */
function collectJsFiles(root: string, out: string[], budget: { n: number }): void {
	if (budget.n <= 0) return;
	let ents: fs.Dirent[];
	try {
		ents = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return;
	}
	const subdirs: string[] = [];
	for (const e of ents) {
		if (budget.n <= 0) return;
		if (e.isFile() && /\.(ts|js|mjs|cjs)$/.test(e.name)) {
			out.push(path.join(root, e.name));
			budget.n -= 1;
		} else if (e.isDirectory() && !["node_modules", ".git"].includes(e.name)) {
			subdirs.push(path.join(root, e.name));
		}
	}
	for (const d of subdirs) {
		collectJsFiles(d, out, budget);
		if (budget.n <= 0) return;
	}
}

/**
 * 进化提案（纯函数）：
 * - 吸收：unmanaged 条目出现 ≥ absorbThreshold 次 → 提议加入观察到的场景
 * - 淘汰：场景层包 absentStreak ≥ patience 且有工具信号（toolCalls>0 或归因表有工具）→ 提议移出
 * - 保护：common 层永不淘汰；无任何工具信号的包（command-only，如 pi-anywhere）永不淘汰
 * - skill：反思 useful==0 且 unused ≥ skillUnusedThreshold → 提议移出
 */
export function computeProposals(
	cfg: ScenesFile,
	usage: UsageFile,
	opts: { patience?: number; absorbThreshold?: number; skillUnusedThreshold?: number; hasTools?: Set<string> } = {},
): Proposal[] {
	const patience = opts.patience ?? cfg.evolve?.patience ?? 20;
	const absorbThreshold = opts.absorbThreshold ?? cfg.evolve?.absorbThreshold ?? 2;
	const skillUnused = opts.skillUnusedThreshold ?? cfg.evolve?.skillUnusedThreshold ?? 5;
	const proposals: Proposal[] = [];

	for (const [key, u] of Object.entries(usage.unmanagedSeen ?? {})) {
		if (u.count < absorbThreshold) continue;
		const scene = u.scenes[u.scenes.length - 1];
		if (!scene || !cfg.scenes?.[scene]) continue;
		let entry: PackageEntry;
		try {
			entry = JSON.parse(key) as PackageEntry;
		} catch {
			continue;
		}
		proposals.push({ kind: "absorb", scene, entry, reason: `${u.count} 个会话在场但不在任何场景定义` });
	}

	for (const [scene, def] of Object.entries(cfg.scenes ?? {})) {
		for (const e of def.packages ?? []) {
			const key = canonical(e);
			const r = usage.perResource?.[key];
			const signalCapable = (r?.toolCalls ?? 0) > 0 || opts.hasTools?.has(key);
			if (!r || !signalCapable) continue;
			if ((r.absentStreak ?? 0) >= patience) {
				proposals.push({ kind: "retire", scene, key, label: specOf(e), reason: `连续 ${r.absentStreak} 个会话零调用（累计 ${r.toolCalls ?? 0} 次）` });
			}
		}
		for (const p of def.skills ?? []) {
			const rl = usage.perResource?.[expandHome(p)]?.reflections;
			if (!rl || rl.useful > 0 || rl.unused < skillUnused) continue;
			proposals.push({ kind: "retire", scene, key: expandHome(p), label: p, skillPath: p, reason: `反思 ${rl.unused} 次均未用到` });
		}
	}
	return proposals;
}

/** 应用提案（纯函数）：返回新 cfg，不改原对象 */
export function applyProposals(cfg: ScenesFile, proposals: Proposal[]): ScenesFile {
	const next: ScenesFile = structuredClone(cfg);
	next.scenes ??= {};
	for (const p of proposals) {
		const def = (next.scenes[p.scene] ??= {});
		if (p.kind === "absorb") {
			def.packages ??= [];
			if (!def.packages.some((x) => sameEntry(x, p.entry))) def.packages.push(p.entry);
		} else if (p.skillPath) {
			def.skills = (def.skills ?? []).filter((s) => s !== p.skillPath);
		} else {
			def.packages = (def.packages ?? []).filter((e) => canonical(e) !== p.key);
		}
	}
	return next;
}

function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as T;
	} catch {
		return fallback;
	}
}

/** 原子写 JSON（tmp + rename），避免写一半被读到 */
function writeJson(file: string, data: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
	fs.renameSync(tmp, file);
}

/** spec → 包名 / 本地路径，用于「是否已安装」探测 */
function specLocation(spec: string): { kind: "npm" | "git" | "local"; npmName?: string; gitDir?: string; localPath?: string } {
	if (spec.startsWith("npm:")) {
		return { kind: "npm", npmName: spec.slice(4).split("@")[0] || spec.slice(4) };
	}
	// git:github.com/user/repo[@ref] / git:https://... / git:git@host:path[.git]
	if (spec.startsWith("git:")) {
		let rest = spec.slice(4);
		if (rest.startsWith("https://")) rest = rest.slice("https://".length);
		if (rest.startsWith("git@")) {
			const m = rest.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
			if (m) return { kind: "git", gitDir: path.join(m[1], m[2]) };
		}
		// github.com/user/repo@ref 或 host/path 形式
		const noRef = rest.split("@")[0].replace(/\.git$/, "");
		const parts = noRef.split("/");
		if (parts.length >= 3) return { kind: "git", gitDir: path.join(parts[0], ...parts.slice(1)) };
		return { kind: "npm", npmName: noRef };
	}
	if (spec.startsWith("/") || spec.startsWith("./") || spec.startsWith("../")) {
		return { kind: "local", localPath: spec };
	}
	// 裸名视为 npm 包（settings 示例支持 "pi-skills" 这种写法）
	return { kind: "npm", npmName: spec };
}

// ── 核心（纯逻辑，可单测；所有路径由 baseDir 注入） ──────────

export interface CorePaths {
	baseDir: string;
	scenesFile: string;
	stateFile: string;
	usageFile: string;
	settingsFile: string;
	scenesRoot: string; // ~/.pi/agent/scenes（全局场景 skill 目录约定根）
	npmDir: string; // ~/.pi/agent/npm
	gitRoot: string; // ~/.pi/agent/git
	// v0.7 项目层（激活层）
	projectDir: string; // <cwd>/.pi
	projectSettingsFile: string; // <cwd>/.pi/settings.json
	projectStateFile: string; // <cwd>/.pi/scenes-state.json
	projectScenesRoot: string; // <cwd>/.pi/scenes
}

export function makeCore(baseDir: string, projectDir?: string) {
	const projDir = projectDir || process.env.PI_SCENES_PROJECT_DIR || path.join(process.cwd(), ".pi");
	const paths: CorePaths = {
		baseDir,
		scenesFile: path.join(baseDir, "scenes.json"),
		stateFile: path.join(baseDir, "scenes-state.json"),
		usageFile: path.join(baseDir, "scenes-usage.json"),
		settingsFile: path.join(baseDir, "settings.json"),
		scenesRoot: path.join(baseDir, "scenes"),
		npmDir: path.join(baseDir, "npm"),
		gitRoot: path.join(baseDir, "git"),
		projectDir: projDir,
		projectSettingsFile: path.join(projDir, "settings.json"),
		projectStateFile: path.join(projDir, "scenes-state.json"),
		projectScenesRoot: path.join(projDir, "scenes"),
	};

	function loadScenes(): ScenesFile {
		return readJson<ScenesFile>(paths.scenesFile, {});
	}

	function saveScenes(cfg: ScenesFile): void {
		writeJson(paths.scenesFile, cfg);
	}

	function loadStateFrom(file: string): SceneState {
		const s = readJson<Partial<SceneState>>(file, {});
		return {
			active: s.active ?? null,
			managed: {
				packages: Array.isArray(s.managed?.packages) ? s.managed!.packages : [],
				skills: Array.isArray(s.managed?.skills) ? s.managed!.skills : [],
			},
			anchors: Array.isArray(s.anchors) ? s.anchors : [],
			version: s.version,
			migrateNotified: s.migrateNotified,
		};
	}

	/** 全局层状态（v0.6 及之前唯一的状态文件；loadState 为其兼容别名） */
	function loadUserState(): SceneState {
		return loadStateFrom(paths.stateFile);
	}

	function saveUserState(st: SceneState): void {
		writeJson(paths.stateFile, st);
	}

	/** 项目层状态（v0.7 激活层） */
	function loadProjectState(): SceneState {
		return loadStateFrom(paths.projectStateFile);
	}

	function saveProjectState(st: SceneState): void {
		writeJson(paths.projectStateFile, st);
	}

	/** 生效激活：项目层优先，其次全局层（两层互斥单激活，但演进/边界下取项目优先） */
	function effectiveActive(): string | null {
		return loadProjectState().active ?? loadUserState().active;
	}

	/** 生效激活的落层 */
	function effectiveScope(): "project" | "user" {
		return loadProjectState().active ? "project" : "user";
	}

	function loadUsage(): UsageFile {
		const u = readJson<Partial<UsageFile>>(paths.usageFile, {});
		return {
			autoEvolve: u.autoEvolve ?? false,
			perScene: u.perScene ?? {},
			perResource: u.perResource ?? {},
			unmanagedSeen: u.unmanagedSeen ?? {},
			_current: u._current,
		};
	}

	function saveUsage(usage: UsageFile): void {
		writeJson(paths.usageFile, usage);
	}

	/** 解析场景（沿 extends 链 union 合并，带环检测）——主场景/子场景的落点 */
	function resolveScene(name: string, cfg: ScenesFile): SceneDef {
		const merged: SceneDef = { packages: [], skills: [] };
		const seen = new Set<string>();
		let cur: string | null = name;
		while (cur) {
			if (seen.has(cur)) throw new Error(`场景 extends 链存在环：${cur}`);
			seen.add(cur);
			const def = cfg.scenes?.[cur];
			if (!def) throw new Error(`场景不存在：${cur}`);
			merged.packages = dedupeEntries([...(merged.packages ?? []), ...(def.packages ?? [])]);
			merged.skills = [...new Set([...(merged.skills ?? []), ...(def.skills ?? [])])];
			if (def.description && !merged.description) merged.description = def.description;
			cur = def.extends ?? null;
		}
		return merged;
	}

	function dedupeEntries(entries: PackageEntry[]): PackageEntry[] {
		const out: PackageEntry[] = [];
		for (const e of entries) if (!out.some((x) => sameEntry(x, e))) out.push(e);
		return out;
	}

	/** 生效集合 = 通用层 ∪ 场景链（skills 展开 ~，去重；拆分 common/scene 归属供双层落点） */
	function computeTarget(active: string | null, cfg: ScenesFile): { packages: PackageEntry[]; skills: string[]; commonSkills: string[]; sceneSkills: string[] } {
		const common = cfg.common ?? {};
		let scene: SceneDef = {};
		if (active) scene = resolveScene(active, cfg);
		const packages = dedupeByIdentity(dedupeEntries([...(common.packages ?? []), ...(scene.packages ?? [])]));
		const commonSkills = [...new Set([...(common.skills ?? [])].map(expandHome))];
		const sceneSkills = [...new Set([...(scene.skills ?? [])].map(expandHome))];
		const skills = [...new Set([...commonSkills, ...sceneSkills])];
		return { packages, skills, commonSkills, sceneSkills };
	}

	/** 包是否已安装（探测 npm 目录 / git clone 目录 / 本地路径） */
	function isPackageInstalled(entry: PackageEntry): boolean {
		const spec = typeof entry === "string" ? entry : entry?.source;
		if (!spec) return false;
		const loc = specLocation(expandHome(spec));
		if (loc.kind === "npm" && loc.npmName) {
			return fs.existsSync(path.join(paths.npmDir, "node_modules", loc.npmName, "package.json"));
		}
		if (loc.kind === "git" && loc.gitDir) {
			return fs.existsSync(path.join(paths.gitRoot, loc.gitDir));
		}
		if (loc.kind === "local" && loc.localPath) {
			return fs.existsSync(expandHome(loc.localPath));
		}
		return false;
	}

	/** object form 带资源过滤字段（git 多技能包）判定：项目层 delta 候选 */
	function isFilteredEntry(e: PackageEntry): boolean {
		if (typeof e !== "object" || e === null) return false;
		return ["skills", "extensions", "prompts", "themes"].some((k) => Array.isArray((e as Record<string, unknown>)[k]));
	}

	/** 场景 skill 路径 → 项目层映射：全局 scenesRoot 下的路径转项目相对（相对 <cwd>/.pi 解析），
	 *  其余（用户自定义绝对/~ 路径）原样写入项目 settings */
	function mapSceneSkillToProject(p: string): { entry: string; dir?: string; globalDir?: string } {
		const scenesRootAbs = expandHome(paths.scenesRoot);
		const abs = expandHome(p);
		if (abs === scenesRootAbs || abs.startsWith(scenesRootAbs + path.sep)) {
			const rel = path.relative(scenesRootAbs, abs); // e.g. "coding/skills"
			return {
				entry: path.posix.join("scenes", rel.split(path.sep).join("/")),
				dir: path.join(paths.projectScenesRoot, rel),
				globalDir: abs,
			};
		}
		return { entry: p };
	}

	/** 幂等复制目录内容（仅复制目标缺失项，不覆盖用户已有）：返回复制文件数 */
	function copyTreeIfMissing(src: string, dst: string): number {
		let st: fs.Stats;
		try {
			st = fs.statSync(src);
		} catch {
			return 0;
		}
		if (!st.isDirectory()) return 0;
		fs.mkdirSync(dst, { recursive: true });
		let n = 0;
		for (const e of fs.readdirSync(src, { withFileTypes: true })) {
			const s = path.join(src, e.name);
			const d = path.join(dst, e.name);
			if (fs.existsSync(d)) continue;
			if (e.isDirectory()) n += copyTreeIfMissing(s, d);
			else {
				fs.copyFileSync(s, d);
				n++;
			}
		}
		return n;
	}

	/**
	 * 把目标集合落进 settings（v0.7 双层）：
	 * 1. 摘掉两层 state.managed 里的旧条目（精确匹配；两层互斥单激活）
	 * 2. 按层落点追加（项目层 filtered 条目加 autoload:false 转 delta；全局层
	 *    补资产锚点；场景 scaffold skills 映射为项目相对路径 + 幂等复制 vendor 资产）
	 * 3. preInstallPackages = 安装缺失包动作之前的快照；
	 *    pi install 会自己往 settings 写条目，diff 出来的（在目标集合内的）也归 managed
	 * 返回统计。两份 settings.json 先备份再原子写。
	 *
	 * scope："project"（默认项目级，v0.7 产品语义）| "user"（--global，≤0.6 兼容语义）。
	 * 为向后兼容旧调用（三参），签名默认值取 "user"；命令层显式传 scope。
	 */
	function applyToSettings(
		target: { packages: PackageEntry[]; skills: string[]; commonSkills?: string[]; sceneSkills?: string[] },
		active: string | null,
		preInstallPackages: PackageEntry[] | undefined,
		scope: "user" | "project" = "user",
	): ApplyResult {
		const useProject = scope === "project";
		const sceneSkills = target.sceneSkills ?? [];
		const userSettings = readJson<Record<string, unknown>>(paths.settingsFile, {});
		const projSettings = readJson<Record<string, unknown>>(paths.projectSettingsFile, {});
		const oldUserPkgs = Array.isArray(userSettings.packages) ? (userSettings.packages as PackageEntry[]) : [];
		const oldUserSkills = Array.isArray(userSettings.skills) ? (userSettings.skills as string[]) : [];
		const oldProjPkgs = Array.isArray(projSettings.packages) ? (projSettings.packages as PackageEntry[]) : [];
		const oldProjSkills = Array.isArray(projSettings.skills) ? (projSettings.skills as string[]) : [];
		const prevUser = loadUserState();
		const prevProj = loadProjectState();

		// 1) 摘旧：两层 managed 都摘（互斥单激活；资产锚点 anchors 不摘）
		let userPkgs = removeFrom(oldUserPkgs, prevUser.managed.packages);
		let userSkills = removeFrom(oldUserSkills, prevUser.managed.skills);
		let projPkgs = removeFrom(oldProjPkgs, prevProj.managed.packages);
		let projSkills = removeFrom(oldProjSkills, prevProj.managed.skills);
		let anchors = prevUser.anchors ?? [];
		// 全局模式：目标 filtered 条目替换同包锚点（sameEntry 精确匹配锚点写法，
		// 不碰用户手配的同包裸 spec —— 后者走 borrowed 语义保留）
		if (!useProject) {
			for (const a of [...anchors]) {
				if (!target.packages.some((t) => isFilteredEntry(t) && sameResource(t, a))) continue;
				userPkgs = userPkgs.filter((x) => !sameEntry(x, a));
				anchors = anchors.filter((x) => x !== a);
			}
		}

		const result: ApplyResult = {
			addedPackages: [],
			addedSkills: [],
			removedPackages: [...oldUserPkgs.filter((p) => !userPkgs.some((x) => sameEntry(x, p))), ...oldProjPkgs.filter((p) => !projPkgs.some((x) => sameEntry(x, p)))],
			removedSkills: [...oldUserSkills.filter((s) => !userSkills.includes(s)), ...oldProjSkills.filter((s) => !projSkills.includes(s))],
			borrowedPackages: [],
			borrowedSkills: [],
		};

		// 2) 补新：包条目按层落点
		const newUserManagedPkgs: PackageEntry[] = [];
		const newProjManagedPkgs: PackageEntry[] = [];
		for (const raw of target.packages) {
			// 项目模式下 filtered 条目 → delta 形态（autoload:false 复用全局克隆 + 白名单启用）
			const e: PackageEntry = useProject && isFilteredEntry(raw) ? { ...(raw as Record<string, unknown>), autoload: false } : raw;
			const landed = useProject && isFilteredEntry(raw);
			let pkgsRef = landed ? projPkgs : userPkgs;
			const sink = landed ? newProjManagedPkgs : newUserManagedPkgs;
			const preList = preInstallPackages ?? (landed ? oldProjPkgs : oldUserPkgs);
			if (pkgsRef.some((x) => sameEntry(x, e))) {
				// 已存在：若来自 pi install 在本次切换中的写入（pre 快照里没有）→ 纳管
				const inPre = preList.some((x) => sameEntry(x, e));
				if (!inPre) sink.push(e);
				else result.borrowedPackages.push(e);
			} else if (typeof e === "object" && e !== null && pkgsRef.some((x) => sameResource(x, e))) {
				// 目标是对象形态（带 skills/extensions 等资源过滤），现存的同包条目是裸 spec：
				// - 裸 spec 是 pi install 在本次切换中刚写入的（不在 pre 快照里）→ 替换为对象形态，
				//   否则 anthropics/skills 这类多技能包会全量加载，场景级裁剪失效；
				// - 裸 spec 是用户先前手配的（在快照里）→ 尊重用户全局选择，视为借用。
				const preExisting = preList.some((x) => sameResource(x, e));
				if (!preExisting) {
					if (landed) {
						projPkgs = projPkgs.filter((x) => !sameResource(x, e));
						pkgsRef = projPkgs;
					} else {
						userPkgs = userPkgs.filter((x) => !sameResource(x, e));
						pkgsRef = userPkgs;
					}
					pkgsRef.push(e);
					sink.push(e);
					result.addedPackages.push(e);
				} else {
					result.borrowedPackages.push(e);
				}
			} else if (pkgsRef.some((x) => sameResource(x, e))) {
				// 同包不同写法（如用户手动 pin 了版本）：视为借用，避免重复注入与重复加载
				result.borrowedPackages.push(e);
			} else {
				pkgsRef.push(e);
				sink.push(e);
				result.addedPackages.push(e);
			}
			// 项目层 delta 落地 → 全局层确保资产锚点（零暴露 + 共享全局克隆的 delta base）
			if (landed) {
				const anchor: PackageEntry = { source: specOf(raw), autoload: false, skills: [] };
				const anchored = userPkgs.some((x) => sameResource(x, raw)) || anchors.some((a) => sameResource(a, anchor));
				if (!anchored) {
					userPkgs.push(anchor);
					anchors.push(anchor);
				}
			}
		}

		// skills 按层落点：场景 scaffold 目录（项目模式）映射为项目相对路径 + 幂等复制 vendor
		const newUserManagedSkills: string[] = [];
		const newProjManagedSkills: string[] = [];
		for (const s of target.skills) {
			const isSceneSkill = sceneSkills.includes(s);
			if (useProject && isSceneSkill) {
				const m = mapSceneSkillToProject(s);
				if (projSkills.includes(m.entry)) {
					result.borrowedSkills.push(m.entry);
				} else {
					projSkills.push(m.entry);
					newProjManagedSkills.push(m.entry);
					result.addedSkills.push(m.entry);
				}
				// vendor 资产：全局 scaffold 目录 → 项目目录（幂等，不覆盖用户已有）
				if (m.dir && m.globalDir) copyTreeIfMissing(m.globalDir, m.dir);
			} else {
				if (userSkills.includes(s)) {
					result.borrowedSkills.push(s);
				} else {
					userSkills.push(s);
					newUserManagedSkills.push(s);
					result.addedSkills.push(s);
				}
			}
		}

		// 3) 落盘：备份 → 原子写（两层）
		for (const f of [paths.settingsFile, paths.projectSettingsFile]) {
			if (fs.existsSync(f)) fs.copyFileSync(f, `${f}.scenes-bak`);
		}
		userSettings.packages = userPkgs;
		userSettings.skills = userSkills;
		writeJson(paths.settingsFile, userSettings);
		projSettings.packages = projPkgs;
		projSettings.skills = projSkills;
		writeJson(paths.projectSettingsFile, projSettings);

		saveUserState({
			active: useProject ? null : active,
			managed: { packages: newUserManagedPkgs, skills: newUserManagedSkills },
			anchors,
			version: 2,
		});
		saveProjectState({
			active: useProject ? active : null,
			managed: { packages: newProjManagedPkgs, skills: newProjManagedSkills },
			version: 2,
		});
		return result;
	}

	// v0.6 兼容别名：loadState/saveState = 全局层（既有测试引用面不变）
	const loadState = loadUserState;
	const saveState = saveUserState;

	/** 用量记账：新会话开始（session_file 变化才计数；reload 同文件不重复计） */
	function beginSession(sessionFile: string | null, settingsPackages: PackageEntry[] | undefined): void {
		const active = effectiveActive();
		const usage = loadUsage();
		const file = sessionFile ?? "ephemeral";
		if (usage._current?.file === file) return;
		const now = new Date().toISOString();
		if (active) {
			const s = (usage.perScene[active] ??= { sessions: 0, lastActive: now });
			s.sessions += 1;
			s.lastActive = now;
		}
		// 未纳管观察：在 settings 但不在 target 且不在任何场景定义 → 吸收候选
		const cfg = loadScenes();
		const target = computeTarget(active, cfg);
		const definedAnywhere: PackageEntry[] = [
			...(cfg.common?.packages ?? []),
			...Object.values(cfg.scenes ?? {}).flatMap((d) => d.packages ?? []),
		];
		for (const e of settingsPackages ?? []) {
			if (target.packages.some((t) => sameEntry(t, e))) continue;
			if (definedAnywhere.some((t) => sameEntry(t, e))) continue;
			const key = canonical(e);
			const u = (usage.unmanagedSeen[key] ??= { count: 0, lastSeen: now, scenes: [] });
			u.count += 1;
			u.lastSeen = now;
			if (active && !u.scenes.includes(active)) u.scenes.push(active);
		}
		usage._current = { file, scene: active, seen: [] };
		saveUsage(usage);
	}

	/** 工具调用归因记账：toolName → 包 → 若在当前 target 中则计数并标记本会话 seen */
	function recordToolUse(toolName: string, toolMap: Map<string, string>): boolean {
		const pkg = toolMap.get(toolName);
		if (!pkg) return false;
		const cfg = loadScenes();
		const target = computeTarget(effectiveActive(), cfg);
		const entry = target.packages.find((e) => packageIdentity(e).includes(pkg));
		if (!entry) return false;
		const key = canonical(entry);
		const usage = loadUsage();
		const r = (usage.perResource[key] ??= {});
		r.toolCalls = (r.toolCalls ?? 0) + 1;
		r.lastUsed = new Date().toISOString();
		if (usage._current && !usage._current.seen.includes(key)) usage._current.seen.push(key);
		saveUsage(usage);
		return true;
	}

	/** 反思记账：skill 子项有用/无用计数，用到则父目录条目标记 seen（重置 streak） */
	function recordReflection(used: string[], unused: string[]): void {
		const cfg = loadScenes();
		const target = computeTarget(effectiveActive(), cfg);
		const usage = loadUsage();
		const now = new Date().toISOString();
		const markParent = (id: string) => {
			const parent = target.skills.find((p) => id === p || id.startsWith(p + path.sep));
			if (parent && usage._current && !usage._current.seen.includes(parent)) usage._current.seen.push(parent);
		};
		for (const id of used) {
			const r = (usage.perResource[id] ??= {});
			r.reflections ??= { useful: 0, unused: 0 };
			r.reflections.useful += 1;
			r.lastUsed = now;
			markParent(id);
		}
		for (const id of unused) {
			const r = (usage.perResource[id] ??= {});
			r.reflections ??= { useful: 0, unused: 0 };
			r.reflections.unused += 1;
		}
		saveUsage(usage);
	}

	/** 会话结束：结算 absentStreak（reload 不结算，会话仍在继续） */
	function endSession(reason: string): void {
		if (reason === "reload") return;
		const cfg = loadScenes();
		const target = computeTarget(effectiveActive(), cfg);
		const usage = loadUsage();
		const seen = usage._current?.seen ?? [];
		const keys = [...target.packages.map((e) => canonical(e)), ...target.skills];
		for (const key of keys) {
			const r = (usage.perResource[key] ??= {});
			if (seen.includes(key)) {
				r.absentStreak = 0;
				r.sessionsSeen = (r.sessionsSeen ?? 0) + 1;
			} else {
				r.absentStreak = (r.absentStreak ?? 0) + 1;
			}
		}
		usage._current = undefined;
		saveUsage(usage);
	}

	/** 检测配置中「同一包多种写法」的冲突（如 common 写 @1.0.3、场景写裸名） */
	function findSpecCollisions(cfg: ScenesFile): Array<{ id: string; entries: Array<{ where: string; spec: string }> }> {
		const byId = new Map<string, Map<string, Array<{ where: string; spec: string }>>>();
		const add = (layer: string, e: PackageEntry) => {
			for (const id of packageIdentity(e)) {
				const m = byId.get(id) ?? new Map();
				const k = canonical(e);
				m.set(k, [...(m.get(k) ?? []), { where: layer, spec: specOf(e) }]);
				byId.set(id, m);
			}
		};
		(cfg.common?.packages ?? []).forEach((e) => add("common", e));
		for (const [name, def] of Object.entries(cfg.scenes ?? {})) (def.packages ?? []).forEach((e) => add(name, e));
		const out: Array<{ id: string; entries: Array<{ where: string; spec: string }> }> = [];
		for (const [id, m] of byId) {
			if (m.size > 1) out.push({ id, entries: [...m.values()].flat() });
		}
		return out;
	}

	/**
	 * 身份级缺失判定：磁盘已装，或 settings 已手配同包另一种写法（切换时按 borrowed 借用）。
	 * 必须在 pi install 之前做：否则 pi install 会向 settings 追加第二种写法，
	 * 同一扩展被加载两份 → pi 启动时工具重名冲突退出。
	 */
	function findMissingPackages(target: PackageEntry[], settingsPackages: PackageEntry[]): PackageEntry[] {
		return target.filter((e) => !isPackageInstalled(e) && !settingsPackages.some((x) => sameResource(x, e)));
	}

	/**
	 * 检测 settings.json 里同一包多种写法并存（如本地路径 + npm 写法）。
	 * 该状态会让 pi 启动时加载同一扩展两份、工具重名冲突退出，切换前必须拦截。
	 */
	function findSettingsDuplicates(pkgs: PackageEntry[]): Array<{ id: string; entries: string[] }> {
		const out: Array<{ id: string; entries: string[] }> = [];
		for (let i = 0; i < pkgs.length; i++) {
			for (let j = i + 1; j < pkgs.length; j++) {
				if (!sameResource(pkgs[i], pkgs[j])) continue;
				const id = packageIdentity(pkgs[i])[0] ?? specOf(pkgs[i]);
				let found = out.find((x) => x.id === id);
				if (!found) {
					found = { id, entries: [] };
					out.push(found);
				}
				for (const s of [specOf(pkgs[i]), specOf(pkgs[j])]) if (!found.entries.includes(s)) found.entries.push(s);
			}
		}
		return out;
	}

	/** 静态扫描安装目录，建 tool/command → 包名归因表 */
	function buildToolMap(): { tools: Map<string, string>; commands: Map<string, string> } {
		const tools = new Map<string, string>();
		const commands = new Map<string, string>();
		const roots: Array<{ dir: string; name: string }> = [];
		const nm = path.join(paths.npmDir, "node_modules");
		if (fs.existsSync(nm)) {
			for (const e of fs.readdirSync(nm, { withFileTypes: true })) {
				if (e.isDirectory() && e.name.startsWith("@")) {
					for (const c of fs.readdirSync(path.join(nm, e.name), { withFileTypes: true })) {
						if (c.isDirectory()) roots.push({ dir: path.join(nm, e.name, c.name), name: `${e.name}/${c.name}` });
					}
				} else if (e.isDirectory()) {
					roots.push({ dir: path.join(nm, e.name), name: e.name });
				}
			}
		}
		const walkGit = (dir: string, depth: number): void => {
			if (depth > 4) return;
			let ents: fs.Dirent[];
			try {
				ents = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return;
			}
			if (ents.some((e) => e.isFile() && e.name === "package.json")) {
				roots.push({ dir, name: path.basename(dir) });
				return;
			}
			for (const e of ents) if (e.isDirectory() && !e.name.startsWith(".")) walkGit(path.join(dir, e.name), depth + 1);
		};
		if (fs.existsSync(paths.gitRoot)) walkGit(paths.gitRoot, 0);

		for (const root of roots) {
			const files: string[] = [];
			collectJsFiles(root.dir, files, { n: 60 });
			for (const f of files) {
				let src: string;
				try {
					src = fs.readFileSync(f, "utf8");
				} catch {
					continue;
				}
			for (const m of src.matchAll(/registerTool\s*\(\s*\{[\s\S]{0,600}?name\s*:\s*["'`]([^"'`]+)["'`]/g)) {
					if (!tools.has(m[1])) tools.set(m[1], root.name);
			}
			for (const m of src.matchAll(/registerCommand\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
					if (!commands.has(m[1])) commands.set(m[1], root.name);
			}
			}
		}
		return { tools, commands };
	}

	/**
	 * 生成模板 scenes.json + 场景 skill 目录骨架 + 预置精选技能。
	 * 预设均为真实存在的包（npm/git，2026-09 核验）；git 技能包用 object form
	 * 按场景裁剪 skills 子集（anthropics/skills 16M 全量 / openclaw/agent-skills 1.9M）。
	 * 预置技能 vendored 自高质量开源技能（MIT，见各自 SKILL.md 尾部归属声明）。
	 */
	function scaffold(): string[] {
		const created: string[] = [];
		const template: ScenesFile = {
			common: {
				description: "通用层：任何场景都恒加载的基础设施",
				packages: [
					"npm:pi-scenes", // 场景切换器自身（常驻才能随时切）
					"npm:pi-carryover", // 跨会话工作承接（上次干到哪、下次接着干）
				],
				skills: ["~/.pi/agent/scenes/common/skills"],
			},
			scenes: {
				coding: {
					description: "写代码：实时代码反馈、子代理委派、并行分支、变更审查",
					icon: "💻",
					packages: [
						"npm:pi-lens", // LSP/linter/格式化实时代码反馈
						"npm:pi-subagents", // 单代理委派 + 脚本化多代理工作流
						"npm:pi-git-worktree", // git worktree 并行开发
						"npm:pi-simplify", // 近期变更代码审查（清晰度/一致性/可维护性）
						{
							source: "git:github.com/openclaw/agent-skills", // OpenClaw 官方编码工作流技能（1.9M）
							skills: ["skills/autoreview", "skills/handoff"], // 独立代码审查 / 跨代理任务交接
						},
						{
							source: "git:github.com/anthropics/skills", // Anthropic 官方技能库（16M），按需子集
							skills: ["skills/frontend-design", "skills/webapp-testing", "skills/mcp-builder"],
						},
					],
					skills: ["~/.pi/agent/scenes/coding/skills"],
				},
				office: {
					description: "办公：文档解析与生成、内部沟通",
					icon: "📄",
					packages: [
						"npm:pi-docparser", // PDF/Office 文档解析抽取
						{
							source: "git:github.com/anthropics/skills", // 官方办公四件套 + 内部沟通文档模板
							skills: ["skills/docx", "skills/pptx", "skills/xlsx", "skills/pdf", "skills/internal-comms"],
						},
					],
					skills: ["~/.pi/agent/scenes/office/skills"],
				},
				pm: {
					description: "产品经理：竞品调研、目标规划与需求跟踪",
					icon: "🎯",
					packages: [
						"npm:pi-web-access", // 网页搜索/抓取/PDF/YouTube（竞品与市场调研）
						"npm:pi-goal-x", // /goal 目标规划 + 独立完成度审计（roadmap/需求跟踪）
						"npm:@juicesharp/rpiv-todo", // 需求/任务清单实时 overlay（抗 /reload 与压缩）
						"npm:@juicesharp/rpiv-ask-user-question", // 结构化提问：类型化选项代替自由猜测（需求澄清）
					],
					skills: ["~/.pi/agent/scenes/pm/skills"],
				},
				research: {
					description: "咨询调研：多源检索、并行多角度深挖、学术文献",
					icon: "🔍",
					packages: [
						"npm:pi-web-access", // 搜索/URL 抓取/PDF/视频理解（调研核心）
						"npm:pi-subagents", // 多角度并行调研（每个子代理一源）
					],
					skills: ["~/.pi/agent/scenes/research/skills"], // scaffold 预置 arxiv-research / openalex-paper-search
				},
				writing: {
					description: "写作：素材检索、事实核查、文体打磨",
					icon: "📝",
					packages: [
						"npm:pi-web-access", // 素材检索与事实核查（引用溯源）
						{
							source: "git:github.com/anthropics/skills", // 官方文档共创工作流（三阶段：上下文采集→迭代精炼→读者验证）
							skills: ["skills/doc-coauthoring"],
						},
					],
					skills: ["~/.pi/agent/scenes/writing/skills"], // scaffold 预置 humanizer
				},
				data: {
					description: "数据分析：表格抽取、MCP 接数据库/BI",
					icon: "📊",
					packages: [
						"npm:pi-docparser", // Excel/CSV/PDF 表格结构化抽取
						"npm:pi-mcp-adapter", // 接任意 MCP server（数据库/BI/内部数据服务）
					],
					skills: ["~/.pi/agent/scenes/data/skills"],
				},
			},
		};
		if (!fs.existsSync(paths.scenesFile)) {
			writeJson(paths.scenesFile, template);
			created.push(paths.scenesFile);
		}
		for (const s of ["common", "coding", "office", "pm", "research", "writing", "data"]) {
			const dir = path.join(paths.scenesRoot, s, "skills");
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
				created.push(dir);
			}
		}
		// 预置精选技能：从包内 assets/scene-skills/<场景>/ 复制到场景 skill 目录。
		// 仅在目标不存在时写入（幂等，不覆盖用户已有同名技能）；复制后归用户所有，可改可删。
		try {
			const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
			const assetsRoot = path.join(pkgRoot, "assets", "scene-skills");
			if (fs.existsSync(assetsRoot)) {
				for (const scene of fs.readdirSync(assetsRoot)) {
					const srcScene = path.join(assetsRoot, scene);
					if (!fs.statSync(srcScene).isDirectory()) continue;
					for (const skill of fs.readdirSync(srcScene)) {
						const src = path.join(srcScene, skill);
						const dst = path.join(paths.scenesRoot, scene, "skills", skill);
						if (!fs.existsSync(path.join(src, "SKILL.md")) || fs.existsSync(dst)) continue;
						fs.cpSync(src, dst, { recursive: true });
						created.push(dst);
					}
				}
			}
		} catch {
			// 资产复制失败不阻断 scaffold（如测试环境无 assets）
		}
		return created;
	}

	return {
		paths,
		loadScenes,
		saveScenes,
		loadState,
		saveState,
		loadUserState,
		saveUserState,
		loadProjectState,
		saveProjectState,
		effectiveActive,
		effectiveScope,
		loadUsage,
		saveUsage,
		resolveScene,
		computeTarget,
		isPackageInstalled,
		findMissingPackages,
		findSettingsDuplicates,
		applyToSettings,
		findSpecCollisions,
		beginSession,
		recordToolUse,
		recordReflection,
		endSession,
		buildToolMap,
		scaffold,
	};
}

// ── 扩展入口 ────────────────────────────────────────────────

const PICKER_OFF = "∅  仅通用层（关闭场景）";
const PICKER_CANCEL = "—— 取消";

export default function (pi: ExtensionAPI) {
	const baseDir = process.env.PI_SCENES_DIR || path.join(os.homedir(), ".pi", "agent");
	const core = makeCore(baseDir);

	/**
	 * 状态栏常驻场景徽标：项目场景 ◆ <名>（默认层级）；全局场景 ◇ <名> ⌘（--global）。
	 * 切换后用户始终知道自己在哪个场景、哪一层。off 时清除；
	 * session_start 时幂等重放（重启 pi 后恢复）。
	 */
	function updateSceneBadge(ctx: any): void {
		try {
			const ui = ctx?.ui;
			if (!ui || typeof ui.setStatus !== "function") return;
			const proj = core.loadProjectState().active;
			const user = core.loadUserState().active;
			const active = proj ?? user;
			if (active) {
				const icon = core.loadScenes().scenes?.[active]?.icon?.trim() || (proj ? "◆" : "◇");
				const text = `${icon} ${active}${proj ? "" : " ⌘"}`;
				ui.setStatus("pi-scene", ui.theme?.fg ? ui.theme.fg("accent", text) : text);
			} else {
				ui.setStatus("pi-scene", undefined);
			}
		} catch {}
	}

	/** 读两层 settings 的 packages（供缺失判定与冲突检测） */
	function readAllSettingsPackages(): { user: PackageEntry[]; project: PackageEntry[] } {
		const u = readJson<Record<string, unknown>>(core.paths.settingsFile, {});
		const p = readJson<Record<string, unknown>>(core.paths.projectSettingsFile, {});
		return {
			user: Array.isArray(u.packages) ? (u.packages as PackageEntry[]) : [],
			project: Array.isArray(p.packages) ? (p.packages as PackageEntry[]) : [],
		};
	}

	/** 执行切换（name=null 表示仅通用层；scope=project 项目级默认 / user 全局） */
	async function doSwitch(ctx: any, name: string | null, scope: "user" | "project"): Promise<void> {
		const cfg = core.loadScenes();
		if (name && !cfg.scenes?.[name]) {
			ctx.ui.notify(`场景不存在：${name}（可用：${Object.keys(cfg.scenes ?? {}).join(", ") || "无"}）`, "error");
			return;
		}
		const scopeLabel = scope === "project" ? "（项目级，仅当前目录生效）" : "（全局，所有项目生效）";
		const label = name
			? `「${name}」${cfg.scenes?.[name]?.description ? ` — ${cfg.scenes[name].description}` : ""}${scopeLabel}`
			: `仅通用层${scopeLabel}`;

		const target = core.computeTarget(name, cfg);

		// 同包多种写法：身份级去重已保证只加载首个，但提醒用户统一配置
		const collisions = core.findSpecCollisions(cfg);
		if (collisions.length > 0) {
			ctx.ui.notify(
				`⚠️ scenes.json 里同一包存在多种写法（已自动按首个生效，不重复加载）：\n${collisions
					.map((c) => `  · ${c.id}: ${c.entries.map((e) => `${e.where}=${e.spec}`).join(" | ")}`)
					.join("\n")}\n建议统一写法，避免困惑`,
				"info",
			);
		}

		const pre = readAllSettingsPackages();
		const prePkgs = [...pre.project, ...pre.user];

		// settings 层内同包异写法并存（跨层同包是 v0.7 设计内：delta + 锚点）：
		// pi 启动会加载同一扩展两份、工具重名冲突退出 —— 先拦截并给出修复指引
		const dups = [
			...core.findSettingsDuplicates(pre.user).map((d) => ({ ...d, where: "全局" })),
			...core.findSettingsDuplicates(pre.project).map((d) => ({ ...d, where: "项目" })),
		];
		if (dups.length > 0) {
			ctx.ui.notify(
				`⚠️ settings 里同一包存在多种写法并存，pi 启动时会因工具重名冲突而退出，请先手动删除其中一种：\n${dups
					.map((d) => `  · [${d.where}] ${d.id}: ${d.entries.join(" | ")}`)
					.join("\n")}\n修复后再切换场景`,
				"error",
			);
			return;
		}

		// 缺失包：确认后逐个 pi install（全局 scope pi 不自动装，必须显式装）
		// 身份级判定：settings 已手配同包异写法（如本地路径）→ 视为可用，跳过安装；
		// 否则 pi install 会向 settings 追加第二种写法 → 同一扩展加载两份 → pi 启动冲突退出
		const missing = core.findMissingPackages(target.packages, prePkgs);
		let preInstallPackages: PackageEntry[] | undefined;
		if (missing.length > 0) {
			const ok = await ctx.ui.confirm(
				"场景包未安装",
				`以下 ${missing.length} 个包尚未安装，现在安装吗？（统一装到全局 ~/.pi/agent，所有项目共享缓存）\n${missing.map((m) => `  · ${specOf(m)}`).join("\n")}`,
			);
			if (!ok) {
				ctx.ui.notify("已取消切换（未做任何修改）", "info");
				return;
			}
			preInstallPackages = prePkgs;
			for (const m of missing) {
				const r = spawnSync("pi", ["install", specOf(m)], { stdio: "inherit" });
				if (r.status !== 0) {
					ctx.ui.notify(`安装失败：${specOf(m)}（exit ${r.status}），已中止切换`, "error");
					return;
				}
			}
			const post = readAllSettingsPackages();
			const still = core.findMissingPackages(target.packages, [...post.project, ...post.user]);
			if (still.length > 0) {
				ctx.ui.notify(`仍有包未安装：${still.map(specOf).join(", ")}，已中止切换`, "error");
				return;
			}
		}

		const r = core.applyToSettings(target, name, preInstallPackages, scope);
		updateSceneBadge(ctx);
		ctx.ui.notify(
			`已切换到 ${label}\n  +${r.addedPackages.length} 包 +${r.addedSkills.length} skill · -${r.removedPackages.length} 包 -${r.removedSkills.length} skill\n  正在热重载…`,
			"info",
		);
		await ctx.reload();
		return;
	}

	/**
	 * 参数 Tab 补全（pi 原生 getArgumentCompletions）：
	 * - 空前缀：列出全部场景（label 带 icon，description 带描述与「当前」标记）+ 全部子命令
	 * - 前缀过滤（大小写不敏感，value 整体替换参数文本）：/scene c<Tab> → /scene coding
	 * - 多词子命令：/scene evolve a<Tab> → /scene evolve auto
	 * - 无匹配返回 null（pi 停用补全弹窗，不打断输入）
	 */
	function sceneCompletions(prefix: string): Array<{ value: string; label: string; description?: string }> | null {
		const p = (prefix ?? "").trim().toLowerCase();
		let cfg: ScenesFile = {};
		let active: string | null = null;
		try {
			cfg = core.loadScenes();
			active = core.effectiveActive();
		} catch {}
		const items: Array<{ value: string; label: string; description?: string }> = [];
		for (const [name, def] of Object.entries(cfg.scenes ?? {})) {
			const icon = def?.icon?.trim() || "◆";
			const desc = def?.description ? (active === name ? `当前 · ${def.description}` : def.description) : active === name ? "当前场景" : undefined;
			items.push({ value: name, label: `${icon} ${name}`, description: desc });
		}
		const subs: Array<[string, string]> = [
			["off", "关闭场景（摘两层，仅保留通用层；资产锚点保留）"],
			["status", "查看当前场景与生效资源（项目/全局两级）"],
			["migrate", "把 ≤0.6 遗留的全局场景转为当前项目场景"],
			["init", "生成模板 scenes.json 与 skill 骨架"],
			["stats", "用量仪表盘（会话/工具调用/反思）"],
			["evolve", "生成并应用进化提案"],
			["evolve auto", "开关：会话结束自动应用进化"],
		];
		for (const [value, description] of subs) items.push({ value, label: value, description });
		const filtered = items.filter((i) => i.value.toLowerCase().startsWith(p));
		return filtered.length > 0 ? filtered : null;
	}

	/** 命令提示行（palette 一行可见）：动态拼入当前场景名清单，注册时求值 */
	function sceneCommandDescription(): string {
		let names: string[] = [];
		try {
			names = Object.keys(core.loadScenes().scenes ?? {});
		} catch {}
		return `切换场景（空格后 Tab 列出并补全）：${names.join("/") || "<name>"}`;
	}

	/** 解析 --global/-g 标志：返回 [是否全局, 去掉标志后的参数] */
	function parseScopeFlag(arg: string): [boolean, string] {
		const global = /(?:^|\s)--global(?:\s|$)|(?:^|\s)-g(?:\s|$)/.test(arg);
		return [global, arg.replace(/\s*(?:--global|-g)\s*/g, " ").trim()];
	}

	const sceneCommand = {
		title: "场景切换",
		description: sceneCommandDescription(),
		getArgumentCompletions: sceneCompletions,
		handler: async (args: string, ctx: any) => {
			const [wantGlobal, arg] = parseScopeFlag((args ?? "").trim());
			const scope: "user" | "project" = wantGlobal ? "user" : "project";

			if (arg === "init") {
				const created = core.scaffold();
				ctx.ui.notify(
					created.length
						? `已生成模板：\n${created.map((c) => `  · ${c}`).join("\n")}\n编辑 ${core.paths.scenesFile} 配置你的场景`
						: "scenes.json 已存在，未覆盖",
					"info",
				);
				return;
			}

			if (!fs.existsSync(core.paths.scenesFile)) {
				const ok = await ctx.ui.confirm(
					"未找到 scenes.json",
					`是否生成模板？\n${core.paths.scenesFile}`,
				);
				if (ok) {
					const created = core.scaffold();
					ctx.ui.notify(`已生成：\n${created.map((c) => `  · ${c}`).join("\n")}\n编辑后用 /scene <name> 切换`, "info");
				}
				return;
			}

			if (arg === "status") {
				const cfg = core.loadScenes();
			const proj = core.loadProjectState();
			const user = core.loadUserState();
			const active = core.effectiveActive();
				const target = core.computeTarget(active, cfg);
				const collisions = core.findSpecCollisions(cfg);
				const lines = [
					`项目场景（${core.paths.projectDir}）：${proj.active ? `${cfg.scenes?.[proj.active]?.icon?.trim() || "◆"} ${proj.active}` : "（无）"}`,
					`全局场景（--global）：${user.active ? `${cfg.scenes?.[user.active]?.icon?.trim() || "◇"} ${user.active}` : "（无）"}`,
					`生效场景：${active ? `${cfg.scenes?.[active]?.icon?.trim() || "◆"} ${active}` : "（无，仅通用层）"}`,
					`生效 packages（${target.packages.length}）：${target.packages.map(specOf).join(", ") || "—"}`,
					`生效 skills（${target.skills.length}）：${target.skills.join(", ") || "—"}`,
					`可用场景：${Object.keys(cfg.scenes ?? {}).join(", ") || "—"}`,
				];
				if ((user.anchors?.length ?? 0) > 0) {
					lines.push(`资产锚点（零暴露，全局缓存共享）：${user.anchors!.map(specOf).join(", ")}`);
				}
				if (collisions.length > 0) {
					lines.push(`⚠️ 同包多种写法（已按首个生效）：${collisions.map((c) => `${c.id}(${c.entries.map((e) => e.spec).join("|")})`).join("、")}`);
				}
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (arg === "stats") {
				showStats(ctx);
				return;
			}

			if (arg === "evolve auto") {
				const usage = core.loadUsage();
				usage.autoEvolve = !usage.autoEvolve;
				core.saveUsage(usage);
				ctx.ui.notify(
						usage.autoEvolve
							? "自动进化已开启：会话结束自动应用吸收/淘汰（不动 common 与无工具信号的包；变更下次重载生效）"
							: "自动进化已关闭",
					"info",
				);
				return;
			}

			if (arg === "evolve") {
				await runEvolve(ctx);
				return;
			}

			if (arg === "off" || arg === "none") {
				// off 无论何种 scope 都摘两层（用户意图 = 全部关掉）；资产锚点保留
				await doSwitch(ctx, null, scope);
				return;
			}

			if (arg === "migrate") {
				const user = core.loadUserState();
				if (!user.active) {
					ctx.ui.notify("没有 ≤0.6 遗留的全局场景，无需迁移", "info");
				return;
				}
				const ok = await ctx.ui.confirm(
					"迁移全局场景为项目场景",
					`检测到全局场景「${user.active}」（≤0.6 模式，所有目录生效）。\n转为当前目录的项目场景？\n· 资产（包与克隆）不动，仍在全局共享\n· 激活条目移到 ${core.paths.projectSettingsFile}`,
				);
				if (!ok) return;
				await doSwitch(ctx, user.active, "project");
				return;
			}

			if (arg) {
				await doSwitch(ctx, arg, scope);
				return;
			}

			// 无参数：选择器（默认项目级；● 当前项目场景 / ◐ 当前全局场景 / ○ 未激活）
			const cfg = core.loadScenes();
			const projActive = core.loadProjectState().active;
			const userActive = core.loadUserState().active;
			const active = projActive ?? userActive;
			const names = Object.keys(cfg.scenes ?? {});
			if (names.length === 0) {
				ctx.ui.notify(`scenes.json 里还没有定义场景，编辑 ${core.paths.scenesFile}`, "info");
				return;
			}
			// 选择器条目同步显示场景 icon（label→name 映射解析，免字符串切片）
			const labelToName = new Map<string, string>();
			const items: string[] = names.map((n) => {
				const d = cfg.scenes![n]?.description ?? "";
				const icon = cfg.scenes![n]?.icon?.trim() || "◆";
				const cur = projActive === n ? "●" : userActive === n ? "◐" : "○";
				const layer = projActive === n ? " [项目]" : userActive === n ? " [全局]" : "";
				const label = `${cur} ${icon} ${n}${d ? ` · ${d}` : ""}${layer}`;
				labelToName.set(label, n);
				return label;
			});
			const extra = [PICKER_OFF + (active === null ? "  [当前]" : ""), PICKER_CANCEL];
			const choice = await ctx.ui.select(`切换场景（写入 ${core.paths.projectSettingsFile}）`, [...items, ...extra]);
			if (!choice || choice === PICKER_CANCEL) return;
			if (choice.startsWith(PICKER_OFF)) {
				if (active === null) {
					ctx.ui.notify("当前已是仅通用层", "info");
					return;
				}
				await doSwitch(ctx, null, "project");
				return;
			}
			// label → 场景名（含 icon/描述的完整条目作为 key，避免解析歧义）
			const name = labelToName.get(choice);
			if (!name) return;
			if (active === name && projActive === name) {
				ctx.ui.notify(`当前已在项目场景「${name}」`, "info");
				return;
			}
			await doSwitch(ctx, name, "project");
		},
	};

	pi.registerCommand("scene", sceneCommand);

	// ── v0.2：用量采集与自进化 ──────────────────────────────

	let toolMapCache: { at: number; value: { tools: Map<string, string>; commands: Map<string, string> } } | null = null;
	function getToolMap() {
		if (toolMapCache && Date.now() - toolMapCache.at < 5 * 60_000) return toolMapCache.value;
		const value = core.buildToolMap();
		toolMapCache = { at: Date.now(), value };
		return value;
	}

	function hasToolsForTarget(): Set<string> {
		const cfg = core.loadScenes();
		const target = core.computeTarget(core.effectiveActive(), cfg);
		const owners = new Set(getToolMap().tools.values());
		return new Set(target.packages.filter((e) => packageIdentity(e).some((id) => owners.has(id))).map((e) => canonical(e)));
	}

	function backupScenes(): void {
		try {
			if (fs.existsSync(core.paths.scenesFile)) fs.copyFileSync(core.paths.scenesFile, `${core.paths.scenesFile}.scenes-bak`);
		} catch {}
	}

	function shortLabel(k: string): string {
		try {
			const v = JSON.parse(k);
			if (typeof v === "string") return v;
			if (v && typeof v === "object" && v.source) return v.source;
		} catch {}
		return k.split(path.sep).slice(-2).join("/");
	}

	function showStats(ctx: any): void {
		const usage = core.loadUsage();
		const lines: string[] = [];
		const scenes = Object.entries(usage.perScene);
		lines.push(`场景：${scenes.length ? scenes.map(([n, s]) => `${n} ${s.sessions} 次(最近 ${s.lastActive.slice(0, 10)})`).join(" · ") : "—"}`);
		const res = Object.entries(usage.perResource).filter(([, r]) => (r.toolCalls ?? 0) > 0 || r.reflections);
		lines.push(`资源用量（${res.length}）：`);
		for (const [k, r] of res.slice(0, 20)) {
			const refl = r.reflections ? ` · 反思 ✓${r.reflections.useful}/✗${r.reflections.unused}` : "";
			lines.push(`  ${shortLabel(k)}： 调用 ${r.toolCalls ?? 0} · 连续未用 ${r.absentStreak ?? "?"}${refl}`);
		}
		const unm = Object.entries(usage.unmanagedSeen).filter(([, u]) => u.count > 0);
		if (unm.length) lines.push(`未纳管观察：${unm.map(([k, u]) => `${shortLabel(k)} ×${u.count}(${u.scenes.join("/") || "?"})`).join(" · ")}`);
		lines.push(`自动进化：${usage.autoEvolve ? "on" : "off"}（/scene evolve auto 切换）`);
		ctx.ui.notify(lines.join("\n"), "info");
	}

	async function runEvolve(ctx: any): Promise<void> {
		const cfg = core.loadScenes();
		const usage = core.loadUsage();
		const proposals = computeProposals(cfg, usage, { hasTools: hasToolsForTarget() });
		if (proposals.length === 0) {
			ctx.ui.notify("暂无进化提案（观察积累中，用 /scene stats 查看用量）", "info");
			return;
		}
		const accepted: Proposal[] = [];
		for (const p of proposals) {
			const head =
				p.kind === "absorb"
					? `吸收：scenes.${p.scene}.packages += ${specOf(p.entry)}`
					: `淘汰：scenes.${p.scene}.${p.skillPath ? "skills" : "packages"} -= ${p.label}`;
			const ok = await ctx.ui.confirm("场景进化提案", `${head}\n依据：${p.reason}\n\n应用这条吗？`);
			if (ok) accepted.push(p);
		}
		if (!accepted.length) {
			ctx.ui.notify("已取消（未做任何修改）", "info");
			return;
		}
		const next = applyProposals(cfg, accepted);
		backupScenes();
		core.saveScenes(next);
		const active = core.effectiveActive();
		core.applyToSettings(core.computeTarget(active, next), active, undefined, core.effectiveScope());
		ctx.ui.notify(`已应用 ${accepted.length} 条提案，正在热重载…`, "info");
		await ctx.reload();
	}

	function buildDigest(ctx: any): string {
		let entries: any[] = [];
		try {
			entries = ctx.sessionManager?.getEntries?.() ?? [];
		} catch {}
		const msgs = entries.filter((e) => e?.type === "message").slice(-40);
		return msgs
			.map((e) => {
				const role = e.message?.role ?? "?";
				const content = e.message?.content;
				const text =
					typeof content === "string"
						? content
						: Array.isArray(content)
							? content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join(" ")
							: "";
				return `${role}: ${text.replace(/\s+/g, " ").slice(0, 160)}`;
			})
			.join("\n")
			.slice(0, 6000);
	}

	async function runReflection(ctx: any): Promise<void> {
		const cfg = core.loadScenes();
		const target = core.computeTarget(core.effectiveActive(), cfg);
		const skills = listSkillChildren(target.skills);
		if (!skills.length) return;
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth?.ok || !auth.apiKey) return;
		const sys =
				"你是 pi 资源使用分析器。根据会话记录判断哪些已加载 skill 实际被用到或对完成任务有帮助。只输出紧凑 JSON，禁止任何其他文字。";
		const user = `已加载 skill 清单：\n${skills.map((s) => `- ${s.label}`).join("\n")}\n\n会话尾部摘录：\n${buildDigest(ctx)}\n\n请输出 {"used":["<label>",...],"unused":["<label>",...]}。used=实际用到或明显有帮助；unused=完全未涉及。`;
		// 动态 import：测试环境（无 node_modules）不触达；pi 运行时由 jiti alias 解析
		const { complete } = await import("@earendil-works/pi-ai/compat");
		const resp = await complete(
			ctx.model,
			{ systemPrompt: sys, messages: [{ role: "user", content: user }] },
			{ apiKey: auth.apiKey, headers: auth.headers, env: auth.env, signal: AbortSignal.timeout(30_000), cacheRetention: "none" },
		);
		const parsed = parseJsonLoose(extractText(resp));
		if (!parsed || !Array.isArray(parsed.used) || !Array.isArray(parsed.unused)) return;
		const byLabel = new Map(skills.map((s) => [s.label, s.id]));
		const used = (parsed.used as unknown[]).map((l) => byLabel.get(String(l))).filter(Boolean) as string[];
		const unused = (parsed.unused as unknown[]).map((l) => byLabel.get(String(l))).filter(Boolean) as string[];
		core.recordReflection(used, unused);
	}

	function maybeAutoEvolve(ctx: any, reason: string): void {
		const usage = core.loadUsage();
		if (!usage.autoEvolve) return;
		const cfg = core.loadScenes();
		const proposals = computeProposals(cfg, usage, { hasTools: hasToolsForTarget() });
		if (!proposals.length) return;
		const next = applyProposals(cfg, proposals);
		backupScenes();
		core.saveScenes(next);
		const active = core.effectiveActive();
		core.applyToSettings(core.computeTarget(active, next), active, undefined, core.effectiveScope());
		// 不在 shutdown 里 ctx.reload()（会递归触发 shutdown）；变更下次自然重载生效
		if (reason !== "quit") {
			try {
				ctx.ui.notify(
						`自动进化已应用 ${proposals.length} 条提案（下次重载生效）：\n${proposals.map((p) => (p.kind === "absorb" ? `+ ${specOf(p.entry)} → ${p.scene}` : `- ${p.label} (${p.scene})`)).join("\n")}`,
						"info",
				);
			} catch {}
		}
	}

	/** ≤0.6 遗留全局场景的一次性迁移提示（不自动改配置，只提醒一次） */
	function notifyLegacyMigration(ctx: any): void {
		try {
			const user = core.loadUserState();
			// version 缺省 = 0.6.x 写入的全局场景；v0.7 起 --global 切换会写 version:2
			if (user.active && user.version !== 2 && !user.migrateNotified) {
				core.saveUserState({ ...user, migrateNotified: true });
				ctx.ui?.notify(
					`检测到全局场景「${user.active}」（pi-scenes ≤0.6 模式，所有目录生效）。\nv0.7 起场景默认项目级：/scene migrate 转为当前项目场景，或 /scene off 关闭。`,
					"info",
				);
			}
		} catch {}
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			const all = readAllSettingsPackages();
			core.beginSession(ctx.sessionManager?.getSessionFile?.() ?? null, [...all.project, ...all.user]);
		} catch {}
		updateSceneBadge(ctx);
		notifyLegacyMigration(ctx);
	});

	pi.on("tool_call", async (event) => {
		try {
			core.recordToolUse((event as any).toolName, getToolMap().tools);
		} catch {}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		const reason = (event as any)?.reason ?? "quit";
		if (reason === "reload") return;
		try {
			await runReflection(ctx);
		} catch {}
		try {
			core.endSession(reason);
		} catch {}
		try {
			maybeAutoEvolve(ctx, reason);
		} catch {}
	});
}
