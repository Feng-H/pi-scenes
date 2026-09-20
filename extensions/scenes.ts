/**
 * scenes.ts — pi 场景切换器：通用层 + 分场景层的 extension / skill 打包切换。
 *
 * 核心思想：
 *   生效资源 = 通用层(common) ∪ 当前场景(scene)
 *   切换场景 = 改写 ~/.pi/agent/settings.json 的 packages/skills 数组 → ctx.reload() 热重载
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
 *   /scene <name>       切换到指定场景
 *   /scene off|none     仅保留通用层（关闭场景）
 *   /scene status       显示当前激活与生效资源
 *   /scene init         生成模板 scenes.json 与场景 skill 目录骨架
 *
 * 文件：
 *   ~/.pi/agent/scenes.json        场景定义（用户编辑）
 *   ~/.pi/agent/scenes-state.json  激活状态 + managed 追踪（本扩展维护）
 *   ~/.pi/agent/settings.json      pi 全局设置（仅动 packages/skills 两个数组）
 *   ~/.pi/agent/scenes/<名>/skills 各场景专属 skill 目录（约定，可自由改路径）
 *
 * 环境变量：
 *   PI_SCENES_DIR  覆盖基目录（默认 ~/.pi/agent，测试用）
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── 类型 ────────────────────────────────────────────────────

/** packages 数组条目：字符串 spec，或 object form（带资源过滤） */
export type PackageEntry = string | { source: string; [k: string]: unknown };

export interface SceneDef {
	description?: string;
	/** 前向兼容：继承父场景（主场景→子场景层级），资源按链 union 合并 */
	extends?: string;
	packages?: PackageEntry[];
	/** skill 文件/目录路径，支持 ~ 前缀 */
	skills?: string[];
}

export interface ScenesFile {
	common?: SceneDef;
	scenes?: Record<string, SceneDef>;
}

export interface SceneState {
	/** 当前激活场景名；null = 仅通用层 */
	active: string | null;
	/** 本扩展注入 settings 的条目（切走时精确摘除） */
	managed: { packages: PackageEntry[]; skills: string[] };
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
	settingsFile: string;
	scenesRoot: string; // ~/.pi/agent/scenes（场景 skill 目录约定根）
	npmDir: string; // ~/.pi/agent/npm
	gitRoot: string; // ~/.pi/agent/git
}

export function makeCore(baseDir: string) {
	const paths: CorePaths = {
		baseDir,
		scenesFile: path.join(baseDir, "scenes.json"),
		stateFile: path.join(baseDir, "scenes-state.json"),
		settingsFile: path.join(baseDir, "settings.json"),
		scenesRoot: path.join(baseDir, "scenes"),
		npmDir: path.join(baseDir, "npm"),
		gitRoot: path.join(baseDir, "git"),
	};

	function loadScenes(): ScenesFile {
		return readJson<ScenesFile>(paths.scenesFile, {});
	}

	function saveScenes(cfg: ScenesFile): void {
		writeJson(paths.scenesFile, cfg);
	}

	function loadState(): SceneState {
		const s = readJson<Partial<SceneState>>(paths.stateFile, {});
		return {
			active: s.active ?? null,
			managed: {
				packages: Array.isArray(s.managed?.packages) ? s.managed!.packages : [],
				skills: Array.isArray(s.managed?.skills) ? s.managed!.skills : [],
			},
		};
	}

	function saveState(st: SceneState): void {
		writeJson(paths.stateFile, st);
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

	/** 生效集合 = 通用层 ∪ 场景链（skills 展开 ~，去重） */
	function computeTarget(active: string | null, cfg: ScenesFile): { packages: PackageEntry[]; skills: string[] } {
		const common = cfg.common ?? {};
		let scene: SceneDef = {};
		if (active) scene = resolveScene(active, cfg);
		const packages = dedupeEntries([...(common.packages ?? []), ...(scene.packages ?? [])]);
		const skills = [...new Set([...(common.skills ?? []), ...(scene.skills ?? [])].map(expandHome))];
		return { packages, skills };
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

	/**
	 * 把目标集合落进 settings.json：
	 * 1. 摘掉 state.managed 里的旧条目（精确匹配）
	 * 2. 追加目标中原本不存在的条目，记入新 managed
	 * 3. preInstallPackages = 安装缺失包动作之前的快照；
	 *    pi install 会自己往 settings 写条目，diff 出来的（在目标集合内的）也归 managed
	 * 返回统计。settings.json 先备份再原子写。
	 */
	function applyToSettings(
		target: { packages: PackageEntry[]; skills: string[] },
		active: string | null,
		preInstallPackages: PackageEntry[] | undefined,
	): ApplyResult {
		const settings = readJson<Record<string, unknown>>(paths.settingsFile, {});
		const oldPkgs = Array.isArray(settings.packages) ? (settings.packages as PackageEntry[]) : [];
		const oldSkills = Array.isArray(settings.skills) ? (settings.skills as string[]) : [];
		const prevManaged = loadState().managed;

		// 1) 摘旧
		let pkgs = removeFrom(oldPkgs, prevManaged.packages);
		let skills = removeFrom(oldSkills, prevManaged.skills);

		// 2) 补新（用户已手配的视为 borrowed，不纳管）
		const result: ApplyResult = {
			addedPackages: [],
			addedSkills: [],
			removedPackages: oldPkgs.filter((p) => !pkgs.some((x) => sameEntry(x, p))),
			removedSkills: oldSkills.filter((s) => !skills.includes(s)),
			borrowedPackages: [],
			borrowedSkills: [],
		};
		const newManagedPkgs: PackageEntry[] = [];
		for (const e of target.packages) {
			if (pkgs.some((x) => sameEntry(x, e))) {
				// 已存在：若来自 pi install 在本次切换中的写入（preInstall 快照里没有）→ 纳管
				const inPre = (preInstallPackages ?? oldPkgs).some((x) => sameEntry(x, e));
				if (!inPre) newManagedPkgs.push(e);
				else result.borrowedPackages.push(e);
			} else {
				pkgs.push(e);
				newManagedPkgs.push(e);
				result.addedPackages.push(e);
			}
		}
		const newManagedSkills: string[] = [];
		for (const s of target.skills) {
			if (skills.includes(s)) {
				result.borrowedSkills.push(s);
			} else {
				skills.push(s);
				newManagedSkills.push(s);
				result.addedSkills.push(s);
			}
		}

		// 3) 落盘：备份 → 原子写
		if (fs.existsSync(paths.settingsFile)) {
			fs.copyFileSync(paths.settingsFile, `${paths.settingsFile}.scenes-bak`);
		}
		settings.packages = pkgs;
		settings.skills = skills;
		writeJson(paths.settingsFile, settings);

		saveState({ active, managed: { packages: newManagedPkgs, skills: newManagedSkills } });
		return result;
	}

	/** 生成模板 scenes.json + 场景 skill 目录骨架 */
	function scaffold(): string[] {
		const created: string[] = [];
		const template: ScenesFile = {
			common: {
				description: "通用层：所有场景恒加载",
				packages: ["npm:pi-scenes"],
				skills: ["~/.pi/agent/scenes/common/skills"],
			},
			scenes: {
				coding: {
					description: "写代码：开发向扩展与 skill",
					packages: [],
					skills: ["~/.pi/agent/scenes/coding/skills"],
				},
				office: {
					description: "办公：文档处理与日常事务",
					packages: [],
					skills: ["~/.pi/agent/scenes/office/skills"],
				},
			},
		};
		if (!fs.existsSync(paths.scenesFile)) {
			writeJson(paths.scenesFile, template);
			created.push(paths.scenesFile);
		}
		for (const s of ["common", "coding", "office"]) {
			const dir = path.join(paths.scenesRoot, s, "skills");
			if (!fs.existsSync(dir)) {
				fs.mkdirSync(dir, { recursive: true });
				created.push(dir);
			}
		}
		return created;
	}

	return {
		paths,
		loadScenes,
		saveScenes,
		loadState,
		saveState,
		resolveScene,
		computeTarget,
		isPackageInstalled,
		applyToSettings,
		scaffold,
	};
}

// ── 扩展入口 ────────────────────────────────────────────────

const PICKER_OFF = "∅  仅通用层（关闭场景）";
const PICKER_CANCEL = "—— 取消";

function specOf(e: PackageEntry): string {
	return typeof e === "string" ? e : e.source;
}

export default function (pi: ExtensionAPI) {
	const baseDir = process.env.PI_SCENES_DIR || path.join(os.homedir(), ".pi", "agent");
	const core = makeCore(baseDir);

	/** 执行切换（name=null 表示仅通用层） */
	async function doSwitch(ctx: any, name: string | null): Promise<void> {
		const cfg = core.loadScenes();
		if (name && !cfg.scenes?.[name]) {
			ctx.ui.notify(`场景不存在：${name}（可用：${Object.keys(cfg.scenes ?? {}).join(", ") || "无"}）`, "error");
			return;
		}
		const label = name ? `「${name}」${cfg.scenes?.[name]?.description ? ` — ${cfg.scenes[name].description}` : ""}` : "仅通用层";

		const target = core.computeTarget(name, cfg);

		// 缺失包：确认后逐个 pi install（全局 scope pi 不自动装，必须显式装）
		const missing = target.packages.filter((e) => !core.isPackageInstalled(e));
		let preInstallPackages: PackageEntry[] | undefined;
		if (missing.length > 0) {
			const ok = await ctx.ui.confirm(
				"场景包未安装",
				`以下 ${missing.length} 个包尚未安装，现在安装吗？\n${missing.map((m) => `  · ${specOf(m)}`).join("\n")}`,
			);
			if (!ok) {
				ctx.ui.notify("已取消切换（未做任何修改）", "info");
				return;
			}
			preInstallPackages = readJson<Record<string, unknown>>(core.paths.settingsFile, {}).packages as PackageEntry[] | undefined ?? [];
			for (const m of missing) {
				const r = spawnSync("pi", ["install", specOf(m)], { stdio: "inherit" });
				if (r.status !== 0) {
					ctx.ui.notify(`安装失败：${specOf(m)}（exit ${r.status}），已中止切换`, "error");
					return;
				}
			}
			const still = target.packages.filter((e) => !core.isPackageInstalled(e));
			if (still.length > 0) {
				ctx.ui.notify(`仍有包未安装：${still.map(specOf).join(", ")}，已中止切换`, "error");
				return;
			}
		}

		const r = core.applyToSettings(target, name, preInstallPackages);
		ctx.ui.notify(
			`已切换到 ${label}\n  +${r.addedPackages.length} 包 +${r.addedSkills.length} skill · -${r.removedPackages.length} 包 -${r.removedSkills.length} skill\n  正在热重载…`,
			"info",
		);
		await ctx.reload();
		return;
	}

	pi.registerCommand("scene", {
		title: "场景切换",
		description: "通用层+场景 一键切换 extension/skill（/scene、/scene <name>、/scene off、/scene status、/scene init）",
		handler: async (args: string, ctx: any) => {
			const arg = (args ?? "").trim();

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
				const st = core.loadState();
				const target = core.computeTarget(st.active, cfg);
				const lines = [
					`当前场景：${st.active ? st.active : "（无，仅通用层）"}`,
					`生效 packages（${target.packages.length}）：${target.packages.map(specOf).join(", ") || "—"}`,
					`生效 skills（${target.skills.length}）：${target.skills.join(", ") || "—"}`,
					`可用场景：${Object.keys(cfg.scenes ?? {}).join(", ") || "—"}`,
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (arg === "off" || arg === "none") {
				await doSwitch(ctx, null);
				return;
			}

			if (arg) {
				await doSwitch(ctx, arg);
				return;
			}

			// 无参数：选择器
			const cfg = core.loadScenes();
			const st = core.loadState();
			const names = Object.keys(cfg.scenes ?? {});
			if (names.length === 0) {
				ctx.ui.notify(`scenes.json 里还没有定义场景，编辑 ${core.paths.scenesFile}`, "info");
				return;
			}
			const items: string[] = names.map((n) => {
				const d = cfg.scenes![n]?.description ?? "";
				const cur = st.active === n ? "●" : "○";
				return `${cur} ${n}${d ? ` · ${d}` : ""}${st.active === n ? "  [当前]" : ""}`;
			});
			const extra = [PICKER_OFF + (st.active === null ? "  [当前]" : ""), PICKER_CANCEL];
			const choice = await ctx.ui.select(`切换场景（通用层恒生效）`, [...items, ...extra]);
			if (!choice || choice === PICKER_CANCEL) return;
			if (choice.startsWith(PICKER_OFF)) {
				if (st.active === null) {
					ctx.ui.notify("当前已是仅通用层", "info");
					return;
				}
				await doSwitch(ctx, null);
				return;
			}
			// "● name · desc" → name
			const name = choice.slice(2).split(" ·")[0].split("  [")[0].trim();
			if (st.active === name) {
				ctx.ui.notify(`当前已在场景「${name}」`, "info");
				return;
			}
			await doSwitch(ctx, name);
		},
	});
}
