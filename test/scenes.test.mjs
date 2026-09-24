/**
 * 核心逻辑冒烟测试（不依赖 TUI / 真实 ~/.pi）：
 *   node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { makeCore, computeProposals, applyProposals } from "../extensions/scenes.ts";

function tmpBase() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scenes-test-"));
	// v0.7：项目层也指向临时目录（否则默认 <cwd>/.pi 会污染仓库）
	return { dir, core: makeCore(dir, path.join(dir, "proj")) };
}

function writeSettings(core, obj) {
	fs.writeFileSync(core.paths.settingsFile, JSON.stringify(obj, null, 2));
}

function readSettings(core) {
	return JSON.parse(fs.readFileSync(core.paths.settingsFile, "utf8"));
}

const CFG = {
	common: {
		packages: ["npm:pi-scenes"],
		skills: ["~/skills-common"],
	},
	scenes: {
		coding: {
			description: "写代码",
			packages: ["npm:pi-carryover", { source: "npm:pi-docparser", skills: ["doc"] }],
			skills: ["~/.pi/agent/scenes/coding/skills"],
		},
		office: {
			description: "办公",
			packages: ["npm:pi-docparser"],
			skills: [],
		},
		// 前向兼容：子场景 extends 主场景
		"coding-debug": {
			extends: "coding",
			description: "调试 = coding 超集",
			packages: ["npm:pi-ask"],
			skills: ["~/skills-debug"],
		},
	},
};

test("scaffold 生成模板与目录（含 7 个预设场景）", () => {
	const { core } = tmpBase();
	const created = core.scaffold();
	assert.ok(created.some((c) => c.endsWith("scenes.json")));
	for (const s of ["common", "coding", "office", "pm", "research", "writing", "data", "learning"]) {
		assert.ok(fs.existsSync(path.join(core.paths.scenesRoot, s, "skills")), s);
	}
	// 预设包均为真实 spec
	const cfg = core.loadScenes();
	assert.deepEqual(cfg.common.packages, ["npm:pi-scenes", "npm:pi-carryover"]);
	assert.ok(cfg.scenes.pm.packages.includes("npm:@juicesharp/rpiv-todo"));
	assert.ok(cfg.scenes.research.packages.includes("npm:pi-subagents"));
	assert.ok(cfg.scenes.coding.packages.includes("npm:pi-lens"));
	assert.ok(cfg.scenes.office.packages.includes("npm:pi-docparser"));
	assert.ok(cfg.scenes.writing.packages.includes("npm:pi-web-access"));
	assert.ok(cfg.scenes.data.packages.includes("npm:pi-mcp-adapter"));
	// 二次 scaffold 不覆盖
	assert.equal(core.scaffold().length, 0);
});

test("computeTarget：通用层 ∪ 场景，~ 展开，去重", () => {
	const { core } = tmpBase();
	const t = core.computeTarget("coding", CFG);
	assert.deepEqual(t.packages, ["npm:pi-scenes", "npm:pi-carryover", { source: "npm:pi-docparser", skills: ["doc"] }]);
	assert.deepEqual(t.skills, [path.join(os.homedir(), "skills-common"), expand("~/"), ].slice(0, 1).concat([path.join(os.homedir(), ".pi/agent/scenes/coding/skills")]));
	// off → 仅通用层
	const t2 = core.computeTarget(null, CFG);
	assert.deepEqual(t2.packages, ["npm:pi-scenes"]);
});

function expand(p) {
	return p.replace(/^~(?=\/|$)/, os.homedir());
}

test("resolveScene：extends 链 union + 环检测", () => {
	const { core } = tmpBase();
	const m = core.resolveScene("coding-debug", CFG);
	// 沿链合并：子场景自身在前，父场景在后（union 顺序无功能影响）
	assert.deepEqual(m.packages, ["npm:pi-ask", "npm:pi-carryover", { source: "npm:pi-docparser", skills: ["doc"] }]);
	const cyclic = { scenes: { a: { extends: "b" }, b: { extends: "a" } } };
	assert.throws(() => core.resolveScene("a", cyclic), /环/);
	assert.throws(() => core.resolveScene("nope", CFG), /不存在/);
});

test("切换：注入 managed、保留用户条目、切走精确摘除", () => {
	const { core } = tmpBase();
	writeSettings(core, {
		theme: "dark",
		packages: ["npm:pi-anywhere"], // 用户手工配置
	});

	// → coding
	let r = core.applyToSettings(core.computeTarget("coding", CFG), "coding", undefined);
	let s = readSettings(core);
	assert.equal(s.theme, "dark"); // 其他键不动
	assert.deepEqual(s.packages, ["npm:pi-anywhere", "npm:pi-scenes", "npm:pi-carryover", { source: "npm:pi-docparser", skills: ["doc"] }]);
	assert.deepEqual(s.skills, [path.join(os.homedir(), "skills-common"), path.join(os.homedir(), ".pi/agent/scenes/coding/skills")]);
	assert.equal(r.addedPackages.length, 3);
	assert.equal(core.loadState().active, "coding");
	assert.equal(core.loadState().managed.packages.length, 3);

	// → office：摘掉 coding 独有，保留通用与用户条目
	r = core.applyToSettings(core.computeTarget("office", CFG), "office", undefined);
	s = readSettings(core);
	assert.deepEqual(s.packages, ["npm:pi-anywhere", "npm:pi-scenes", "npm:pi-docparser"]);
	// coding 的 skill 目录被摘除
	assert.ok(!s.skills.includes(path.join(os.homedir(), ".pi/agent/scenes/coding/skills")));
	// removed 计 3：carryover、object-form docparser，外加通用层 pi-scenes（摘了又加回，报告忠实）
	assert.equal(r.removedPackages.length, 3);
	assert.equal(r.addedPackages.length, 2); // pi-scenes 重加 + pi-docparser 新入

	// → off：仅通用层
	core.applyToSettings(core.computeTarget(null, CFG), null, undefined);
	s = readSettings(core);
	assert.deepEqual(s.packages, ["npm:pi-anywhere", "npm:pi-scenes"]);
	assert.equal(core.loadState().active, null);
});

test("borrowed：目标条目用户已手配 → 不纳管，切走保留", () => {
	const { core } = tmpBase();
	writeSettings(core, { packages: ["npm:pi-docparser"] }); // office 场景也用它

	const r = core.applyToSettings(core.computeTarget("office", CFG), "office", undefined);
	assert.deepEqual(r.borrowedPackages, ["npm:pi-docparser"]);
	assert.ok(!core.loadState().managed.packages.some((p) => p === "npm:pi-docparser"));

	// 切到 coding（不含裸 pi-docparser）→ 用户的手配保留
	core.applyToSettings(core.computeTarget("coding", CFG), "coding", undefined);
	const s = readSettings(core);
	assert.ok(s.packages.includes("npm:pi-docparser"));
});

test("preInstall 快照：pi install 期间写入的条目归 managed", () => {
	const { core } = tmpBase();
	writeSettings(core, { packages: [] });

	// 模拟：切换前快照为空，但 pi install 已把 npm:pi-scenes 写进 settings
	writeSettings(core, { packages: ["npm:pi-scenes"] });
	const r = core.applyToSettings(core.computeTarget("coding", CFG), "coding", []);
	assert.ok(r.borrowedPackages.length === 0);
	assert.ok(core.loadState().managed.packages.includes("npm:pi-scenes"));

	// 切走后 carryover 等被摘除；pi-scenes 在通用层目标里，被保留
	core.applyToSettings(core.computeTarget(null, CFG), null, undefined);
	assert.deepEqual(readSettings(core).packages, ["npm:pi-scenes"]);
});

test("isPackageInstalled：npm/git/本地 三类探测", () => {
	const { dir, core } = tmpBase();
	// npm
	const nm = path.join(core.paths.npmDir, "node_modules", "pi-docparser");
	fs.mkdirSync(nm, { recursive: true });
	fs.writeFileSync(path.join(nm, "package.json"), "{}");
	assert.ok(core.isPackageInstalled("npm:pi-docparser"));
	assert.ok(!core.isPackageInstalled("npm:pi-other"));
	// git
	const gd = path.join(core.paths.gitRoot, "github.com", "Feng-H", "pi-carryover");
	fs.mkdirSync(gd, { recursive: true });
	assert.ok(core.isPackageInstalled("git:github.com/Feng-H/pi-carryover@v1.0.3"));
	// 本地
	const local = path.join(dir, "my-ext");
	fs.mkdirSync(local);
	assert.ok(core.isPackageInstalled(local));
});

test("settings 备份文件生成", () => {
	const { core } = tmpBase();
	writeSettings(core, { packages: ["npm:pi-anywhere"] });
	core.applyToSettings(core.computeTarget("coding", CFG), "coding", undefined);
	assert.ok(fs.existsSync(`${core.paths.settingsFile}.scenes-bak`));
});

// ── v0.2：用量记账 / 归因 / 进化 ───────────────────────

function writeScenes(core, cfg) {
	fs.writeFileSync(core.paths.scenesFile, JSON.stringify(cfg, null, 2));
}

test("buildToolMap：扫描 npm 安装目录归因工具与命令", () => {
	const { core } = tmpBase();
	const pkgDir = path.join(core.paths.npmDir, "node_modules", "pi-fake", "extensions");
	fs.mkdirSync(pkgDir, { recursive: true });
	fs.writeFileSync(
		path.join(pkgDir, "index.ts"),
		`pi.registerTool({ name: "fake_tool", async execute() {} });
pi.registerCommand("fake-cmd", { handler() {} });
`,
	);
	const { tools, commands } = core.buildToolMap();
	assert.equal(tools.get("fake_tool"), "pi-fake");
	assert.equal(commands.get("fake-cmd"), "pi-fake");
	// 子目录递归 + 无关目录跳过
	const sub = path.join(core.paths.npmDir, "node_modules", "pi-deep", "src", "nested");
	fs.mkdirSync(sub, { recursive: true });
	fs.writeFileSync(path.join(sub, "deep.ts"), `pi.registerTool({
	name: "deep_tool",
});`);
	assert.equal(core.buildToolMap().tools.get("deep_tool"), "pi-deep");
});

test("session 记账：begin/record/end 与 unmanaged 观察、streak 结算", () => {
	const { core } = tmpBase();
	writeScenes(core, CFG);
	core.applyToSettings(core.computeTarget("coding", CFG), "coding", undefined);

	// 手工条目 npm:pi-anywhere 在 settings 但不在任何场景定义 → unmanaged
	core.beginSession("s1.json", ["npm:pi-anywhere"]);
	let usage = core.loadUsage();
	assert.equal(usage.perScene["coding"].sessions, 1);
	assert.equal(usage.unmanagedSeen[JSON.stringify("npm:pi-anywhere")].count, 1);

	// 工具调用归因：some_tool 属于 pi-carryover，在 coding target 中
	const key = JSON.stringify("npm:pi-carryover");
	assert.ok(core.recordToolUse("some_tool", new Map([["some_tool", "pi-carryover"]]))) ;
	usage = core.loadUsage();
	assert.equal(usage.perResource[key].toolCalls, 1);
	assert.ok(usage._current.seen.includes(key));

	core.endSession("new"); // 非 reload → 结算：seen 重置 streak
	usage = core.loadUsage();
	assert.equal(usage.perResource[key].absentStreak, 0);
	assert.equal(usage.perResource[key].sessionsSeen, 1);

	// 第二个会话不使用 → streak 1；同文件重复 begin 不计数
	core.beginSession("s2.json", []);
	core.beginSession("s2.json", []); // 幂等
	core.endSession("quit");
	usage = core.loadUsage();
	assert.equal(usage.perScene["coding"].sessions, 2);
	assert.equal(usage.perResource[key].absentStreak, 1);
	assert.equal(usage._current, undefined);
});

test("反思记账：skill 子项有用 → 父目录条目 seen 重置 streak", () => {
	const { core } = tmpBase();
	writeScenes(core, CFG);
	core.applyToSettings(core.computeTarget("coding", CFG), "coding", undefined);
	core.beginSession("s1.json", []);
	core.endSession("quit"); // coding skills 条目 streak 1
	let usage = core.loadUsage();
	const parent = path.join(os.homedir(), ".pi/agent/scenes/coding/skills");
	assert.equal(usage.perResource[parent].absentStreak, 1);

	core.beginSession("s2.json", []);
	core.recordReflection([path.join(parent, "wecom")], [path.join(parent, "dead")]);
	core.endSession("quit");
	usage = core.loadUsage();
	assert.equal(usage.perResource[parent].absentStreak, 0); // 反思「用到」重置
	assert.equal(usage.perResource[path.join(parent, "wecom")].reflections.useful, 1);
	assert.equal(usage.perResource[path.join(parent, "dead")].reflections.unused, 1);
});

test("computeProposals：吸收 / 淘汰 / 保护规则", () => {
	const cfg = {
		common: { packages: ["npm:pi-anywhere"] },
		scenes: {
			coding: { packages: ["npm:pi-hot", "npm:pi-cold", "npm:pi-quiet"], skills: ["~/skills-dead"] },
		},
	};
	const usage = {
		perScene: {},
		perResource: {
			[JSON.stringify("npm:pi-hot")]: { toolCalls: 50, absentStreak: 0 },
			[JSON.stringify("npm:pi-cold")]: { toolCalls: 9, absentStreak: 20 },
			[JSON.stringify("npm:pi-quiet")]: { absentStreak: 25 },
			[JSON.stringify("npm:pi-anywhere")]: { absentStreak: 99 },
			[expand("~/skills-dead")]: { reflections: { useful: 0, unused: 6 } },
		},
		unmanagedSeen: {
			[JSON.stringify("npm:pi-foo")]: { count: 3, lastSeen: "x", scenes: ["coding"] },
		},
	};
	const hasTools = new Set([JSON.stringify("npm:pi-hot"), JSON.stringify("npm:pi-cold")]);
	const ps = computeProposals(cfg, usage, { hasTools });
	assert.ok(ps.some((p) => p.kind === "absorb" && p.scene === "coding" && p.entry === "npm:pi-foo"));
	assert.ok(ps.some((p) => p.kind === "retire" && p.label === "npm:pi-cold")); // 有信号且连续 20 未用
	assert.ok(!ps.some((p) => p.label === "npm:pi-quiet")); // 无工具信号 → 保护（command-only）
	assert.ok(!ps.some((p) => p.label === "npm:pi-anywhere")); // common 层永不淘汰
	assert.ok(!ps.some((p) => p.label === "npm:pi-hot")); // 在用不淘汰
	assert.ok(ps.some((p) => p.kind === "retire" && p.skillPath === "~/skills-dead")); // skill 反思淘汰
	// patience 配置覆盖：30 → pi-cold(20) 不再触发
	const ps2 = computeProposals({ ...cfg, evolve: { patience: 30 } }, usage, { hasTools });
	assert.ok(!ps2.some((p) => p.label === "npm:pi-cold"));
	// 未达吸收阈值（count 1 < 2）不提案
	const ps3 = computeProposals(cfg, { ...usage, unmanagedSeen: { [JSON.stringify("npm:pi-bar")]: { count: 1, lastSeen: "x", scenes: ["coding"] } } }, { hasTools });
	assert.ok(!ps3.some((p) => p.entry === "npm:pi-bar"));
});

test("同包异写法：identity 去重 + borrowed 防重复注入 + 冲突检测", () => {
	const { core } = tmpBase();
	writeSettings(core, { packages: [] });

	// 1) common 写 @版本、场景写裸名 → target 只保留首个（common 优先）
	const cfg = {
		common: { packages: ["npm:pi-carryover@1.0.3"] },
		scenes: { coding: { packages: ["npm:pi-carryover", "npm:pi-lens"] } },
	};
	const t = core.computeTarget("coding", cfg);
	assert.equal(t.packages.filter((p) => String(p).includes("carryover")).length, 1);
	assert.equal(t.packages[0], "npm:pi-carryover@1.0.3"); // keep-first：common 优先

	// 2) 用户手动 pin 了版本、common 预设裸名 → 裸名按 borrowed 处理，不重复注入
	const cfg2 = { common: { packages: ["npm:pi-carryover"] }, scenes: { coding: { packages: [] } } };
	writeSettings(core, { packages: ["npm:pi-carryover@1.0.3"] }); // 用户手动 pin
	const r = core.applyToSettings(core.computeTarget("coding", cfg2), "coding", undefined);
	assert.deepEqual(r.borrowedPackages, ["npm:pi-carryover"]);
	const s = readSettings(core);
	assert.equal(s.packages.filter((p) => String(p).includes("carryover")).length, 1); // 仍只有用户的 @1.0.3

	// 3) 冲突检测：异写法报、同写法跨层不报
	const col = core.findSpecCollisions(cfg);
	assert.equal(col.length, 1);
	assert.equal(col[0].id, "pi-carryover");
	assert.ok(col[0].entries.some((e) => e.where === "common" && e.spec === "npm:pi-carryover@1.0.3"));
	assert.equal(core.findSpecCollisions({ common: { packages: ["npm:pi-x"] }, scenes: { c: { packages: ["npm:pi-x"] } } }).length, 0);
});

test("切换缺失判定：settings 已手配本地路径写法 → 同包 npm 写法不算缺失（防 pi install 重复写入致启动冲突）", () => {
	const { core } = tmpBase();
	const local = "/Users/dev/pidev/pi-carryover"; // 本地路径写法，无需真实存在
	writeSettings(core, { packages: [local] });
	// npm 目录未装 pi-carryover，但 settings 已有同身份本地写法 → 不应触发 pi install（切换时会按 borrowed 借用）
	const missing = core.findMissingPackages(["npm:pi-carryover", "npm:pi-notexist"], [local]);
	assert.deepEqual(missing, ["npm:pi-notexist"]);
});

test("settings 异写法并存检测：双写法（会导致 pi 启动工具冲突退出）必须被检出", () => {
	const { core } = tmpBase();
	const local = "/Users/dev/pidev/pi-carryover";
	const d = core.findSettingsDuplicates([local, "npm:pi-carryover", "npm:pi-lens"]);
	assert.equal(d.length, 1);
	assert.equal(d[0].id, "pi-carryover");
	assert.ok(d[0].entries.includes(local) && d[0].entries.includes("npm:pi-carryover"));
	assert.equal(core.findSettingsDuplicates([local, "npm:pi-lens"]).length, 0);
	// git 写法与 npm 写法同身份也能检出
	assert.equal(core.findSettingsDuplicates(["git:github.com/Feng-H/pi-carryover", "npm:pi-carryover"]).length, 1);
});

test("applyProposals：生成新配置且不动原对象", () => {
	const cfg = { scenes: { coding: { packages: ["npm:pi-cold"], skills: ["~/skills-dead"] } } };
	const next = applyProposals(cfg, [
		{ kind: "absorb", scene: "coding", entry: "npm:pi-foo", reason: "" },
		{ kind: "retire", scene: "coding", key: JSON.stringify("npm:pi-cold"), label: "npm:pi-cold", reason: "" },
		{ kind: "retire", scene: "coding", key: "x", label: "~/skills-dead", skillPath: "~/skills-dead", reason: "" },
	]);
	assert.deepEqual(next.scenes.coding.packages, ["npm:pi-foo"]);
	assert.deepEqual(next.scenes.coding.skills, []);
	assert.deepEqual(cfg.scenes.coding.packages, ["npm:pi-cold"]); // 原 cfg 未被改
	assert.deepEqual(cfg.scenes.coding.skills, ["~/skills-dead"]);
});

test("v0.6.0 对象形态条目：pi install 写入裸 spec 后，场景声明对象形态替换之（skills 过滤不丢）", () => {
	const { core } = tmpBase();
	const OBJ = {
		source: "git:github.com/anthropics/skills",
		skills: ["skills/docx", "skills/pptx", "skills/xlsx", "skills/pdf"],
	};
	const cfg = {
		common: { packages: [], skills: [] },
		scenes: {
			office: { packages: [OBJ], skills: [] },
		},
	};
	// 模拟：pi install git:github.com/anthropics/skills 已把裸字符串写进 settings
	writeSettings(core, { packages: ["git:github.com/anthropics/skills"] });
	const r = core.applyToSettings(core.computeTarget("office", cfg), "office", []);

	// 对象形态替换裸 spec：settings 里只剩对象条目，且被纳管
	const pkgs = readSettings(core).packages;
	assert.equal(pkgs.length, 1);
	assert.deepEqual(pkgs[0], OBJ);
	assert.ok(r.addedPackages.some((p) => typeof p === "object" && p.source === OBJ.source));
	assert.equal(r.borrowedPackages.length, 0);
	assert.ok(core.loadState().managed.packages.some((p) => typeof p === "object"));

	// 切走后对象条目被精确摘除
	core.applyToSettings(core.computeTarget(null, cfg), null, undefined);
	assert.deepEqual(readSettings(core).packages, []);
});

test("v0.6.0 对象形态条目：裸 spec 为 pi install 本次产物时替换，重复切换同场景幂等", () => {
	const { core } = tmpBase();
	const OBJ = { source: "git:github.com/anthropics/skills", skills: ["skills/docx"] };
	const cfg = {
		common: { packages: [], skills: [] },
		scenes: { coding: { packages: [OBJ], skills: [] } },
	};
	writeSettings(core, { packages: ["git:github.com/anthropics/skills"] });
	core.applyToSettings(core.computeTarget("coding", cfg), "coding", []);
	core.applyToSettings(core.computeTarget("coding", cfg), "coding", undefined); // 再切一次同场景：幂等
	assert.deepEqual(readSettings(core).packages, [OBJ]);
});

test("v0.6.0 scaffold：预置技能从 assets/scene-skills 复制到 research/writing 场景目录", () => {
	const { core } = tmpBase();
	const created = core.scaffold();
	// research / writing 各预置 2/1 个技能；coding 等场景目录存在但无预置
	assert.ok(
		fs.existsSync(path.join(core.paths.scenesRoot, "research", "skills", "arxiv-research", "SKILL.md")),
		"arxiv-research 预置",
	);
	assert.ok(
		fs.existsSync(path.join(core.paths.scenesRoot, "research", "skills", "openalex-paper-search", "SKILL.md")),
		"openalex-paper-search 预置",
	);
	assert.ok(
		fs.existsSync(path.join(core.paths.scenesRoot, "writing", "skills", "humanizer", "SKILL.md")),
		"humanizer 预置",
	);
	assert.ok(created.some((c) => c.includes("arxiv-research")));
	// 幂等：重复 scaffold 不重复复制、不覆盖
	fs.rmSync(path.join(core.paths.scenesRoot, "research", "skills", "arxiv-research", "SKILL.md"));
	core.scaffold();
	assert.ok(!fs.existsSync(path.join(core.paths.scenesRoot, "research", "skills", "arxiv-research", "SKILL.md")));
});

test("v0.6.0 模板预设：coding 含 pi-simplify + anthropics/skills 对象形态；office/pm 各有新增", () => {
	const { core } = tmpBase();
	core.scaffold();
	const cfg = core.loadScenes();
	const codingSpecs = cfg.scenes.coding.packages.map((p) => (typeof p === "string" ? p : p.source));
	assert.ok(codingSpecs.includes("npm:pi-simplify"));
	assert.ok(codingSpecs.includes("git:github.com/anthropics/skills"));
	assert.ok(!codingSpecs.includes("git:github.com/openclaw/agent-skills"), "v0.8.1 移除 openclaw（项目专用库，非通用）");
	// 对象形态带 skills 过滤子集
	const anth = cfg.scenes.coding.packages.find(
		(p) => typeof p === "object" && p.source === "git:github.com/anthropics/skills",
	);
	assert.ok(Array.isArray(anth.skills) && anth.skills.length === 3);
	const officeSpecs = cfg.scenes.office.packages.map((p) => (typeof p === "string" ? p : p.source));
	assert.ok(officeSpecs.includes("git:github.com/anthropics/skills"));
	assert.ok(cfg.scenes.pm.packages.includes("npm:@juicesharp/rpiv-ask-user-question"));
});

// ── v0.7 双层模型：资产层（user）与激活层（project）分离 ──────────

function tmpDual() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scenes-dual-"));
	const projDir = path.join(dir, "proj-pi");
	return { dir, projDir, core: makeCore(dir, projDir) };
}

const DUAL_CFG = {
	common: {
		packages: ["npm:pi-scenes"],
		skills: ["~/skills-common"],
	},
	scenes: {
		coding: {
			description: "写代码",
			packages: ["npm:pi-carryover", { source: "git:github.com/anthropics/skills", skills: ["skills/docx"] }],
			// 场景 skills 指向全局 scenesRoot 下（与真实模板同构），测试用 makeCore 的 baseDir
		skills: ["<ROOT>/scenes/coding/skills"],
		},
		office: {
			description: "办公",
			packages: [{ source: "git:github.com/anthropics/skills", skills: ["skills/pptx"] }],
		skills: ["<ROOT>/scenes/office/skills"],
		},
	},
};

// 把 <ROOT> 占位符替换为各测试自己的 baseDir（scenesRoot 依赖 baseDir）
function dualCfg(dir) {
	return JSON.parse(JSON.stringify(DUAL_CFG).replaceAll("<ROOT>", dir));
}

test("v0.9 项目级切换：场景包(含裸 npm)→项目 delta + 全局零暴露锚点；common 留全局", () => {
	const { core, dir, projDir } = tmpDual();
	const CFG = dualCfg(dir);
	// 预置全局 scaffold 目录（vendor 源）
	fs.mkdirSync(path.join(dir, "scenes", "coding", "skills", "my-skill"), { recursive: true });
	fs.writeFileSync(path.join(dir, "scenes", "coding", "skills", "my-skill", "SKILL.md"), "name: my-skill\ndescription: t\n");

	const r = core.applyToSettings(core.computeTarget("coding", CFG), "coding", undefined, "project");

	const user = JSON.parse(fs.readFileSync(core.paths.settingsFile, "utf8"));
	const proj = JSON.parse(fs.readFileSync(core.paths.projectSettingsFile, "utf8"));

	// 全局层：common npm 在；场景裸 npm 不在（空间隔离）；两个零暴露锚点
	assert.ok(user.packages.includes("npm:pi-scenes"), "common npm 在全局层");
	assert.ok(!user.packages.includes("npm:pi-carryover"), "场景裸 npm 不落全局层（v0.9 空间隔离）");
	const anchors = user.packages.filter((p) => typeof p === "object" && p.autoload === false);
	assert.equal(anchors.length, 2, "全局层有 2 个零暴露锚点（carryover + anthropics）");
	assert.ok(anchors.every((a) => Array.isArray(a.skills) && a.skills.length === 0), "锚点零暴露");
	assert.ok(!user.packages.some((p) => typeof p === "object" && Array.isArray(p.skills) && p.skills.length > 0), "全局层无白名单条目");

	// 项目层：裸 npm → 通用 delta（** 通配全启用 + autoload:false）；git → 白名单 delta
	const npmDelta = proj.packages.find((p) => typeof p === "object" && p.source === "npm:pi-carryover");
	assert.ok(npmDelta && npmDelta.autoload === false, "npm 落项目层 delta");
	assert.deepEqual(npmDelta.skills, ["**"], "通用 delta ** 通配");
	assert.deepEqual(npmDelta.extensions, ["**"], "extensions 也启用（扩展工具可用）");
	const gitDelta = proj.packages.find((p) => typeof p === "object" && p.source === "git:github.com/anthropics/skills");
	assert.ok(gitDelta && gitDelta.autoload === false && gitDelta.skills.includes("skills/docx"), "git delta 白名单保留");

	// skills：common 留全局；场景目录映射为项目相对路径 + vendor 复制
	assert.ok(user.skills.includes("/Users/xxx-not-real") === false, "sanity");
	assert.ok(user.skills.some((s) => s.endsWith("skills-common")), "common skills 在全局层");
	assert.ok(proj.skills.includes("scenes/coding/skills"), "场景 skills 映射为项目相对路径");
	assert.ok(fs.existsSync(path.join(projDir, "scenes", "coding", "skills", "my-skill", "SKILL.md")), "vendor 复制到项目目录");

	// 状态双轨
	assert.equal(core.loadProjectState().active, "coding");
	assert.equal(core.loadUserState().active, null);
	assert.equal(core.loadUserState().anchors.length, 2);
	assert.ok(r.addedPackages.length >= 3);
});

test("v0.7 两层互斥：project 切换摘净 --global 遗留；--global 切换替换锚点", () => {
	const { core, dir } = tmpDual();
	const CFG = dualCfg(dir);

	// 先 --global 切 coding（白名单条目直接进全局层）
	core.applyToSettings(core.computeTarget("coding", CFG), "coding", undefined, "user");
	let user = JSON.parse(fs.readFileSync(core.paths.settingsFile, "utf8"));
	assert.ok(user.packages.some((p) => typeof p === "object" && p.source === "git:github.com/anthropics/skills" && !("autoload" in p)), "全局模式写白名单条目（无 autoload）");

	// 再 project 切 office：全局层旧 managed 摘净、锚点重建，项目层换 delta
	core.applyToSettings(core.computeTarget("office", CFG), "office", undefined, "project");
	user = JSON.parse(fs.readFileSync(core.paths.settingsFile, "utf8"));
	const proj = JSON.parse(fs.readFileSync(core.paths.projectSettingsFile, "utf8"));
	assert.ok(!user.packages.some((p) => typeof p === "object" && p.source === "git:github.com/anthropics/skills" && Array.isArray(p.skills) && p.skills.length > 0), "全局层白名单被摘");
	assert.ok(user.packages.some((p) => typeof p === "object" && p.source === "git:github.com/anthropics/skills" && p.autoload === false), "全局层留零暴露锚点");
	assert.ok(user.packages.includes("npm:pi-carryover") === false, "旧场景 npm 随 managed 摘除");
	const delta = proj.packages.find((p) => typeof p === "object" && p.source === "git:github.com/anthropics/skills");
	assert.ok(delta && delta.skills.includes("skills/pptx"), "项目层 delta 换为 office 白名单");

	// 再 --global 切 coding：锚点被白名单条目替换（用户层不双条目）
	core.applyToSettings(core.computeTarget("coding", CFG), "coding", undefined, "user");
	user = JSON.parse(fs.readFileSync(core.paths.settingsFile, "utf8"));
	const anthEntries = user.packages.filter((p) => typeof p === "object" && p.source === "git:github.com/anthropics/skills");
	assert.equal(anthEntries.length, 1, "全局层同包只有一条");
	assert.ok(anthEntries[0].skills.includes("skills/docx") && !("autoload" in anthEntries[0]), "锚点被白名单替换");
	assert.equal(core.loadUserState().anchors.length, 0, "锚点清单同步清空");
});

test("v0.7 off：摘两层 managed，锚点保留（下次切换秒切）", () => {
	const { core, dir } = tmpDual();
	const CFG = dualCfg(dir);
	core.applyToSettings(core.computeTarget("coding", CFG), "coding", undefined, "project");
	core.applyToSettings(core.computeTarget(null, CFG), null, undefined, "project");

	let user = JSON.parse(fs.readFileSync(core.paths.settingsFile, "utf8"));
	const proj = JSON.parse(fs.readFileSync(core.paths.projectSettingsFile, "utf8"));
	assert.ok(!user.packages.includes("npm:pi-carryover"), "场景 npm 摘除");
	assert.ok(user.packages.some((p) => typeof p === "object" && p.autoload === false), "锚点保留");
	assert.deepEqual(proj.packages.filter((p) => typeof p === "object"), [], "项目层 delta 摘净");
	assert.equal(core.loadProjectState().active, null);
	assert.equal(core.loadUserState().active, null);

	// 再切同场景：锚点已在不重复写
	core.applyToSettings(core.computeTarget("coding", CFG), "coding", undefined, "project");
	user = JSON.parse(fs.readFileSync(core.paths.settingsFile, "utf8"));
	assert.equal(user.packages.filter((p) => typeof p === "object" && p.source === "git:github.com/anthropics/skills").length, 1, "锚点不重复");
	assert.equal(user.packages.filter((p) => typeof p === "object" && p.source === "npm:pi-carryover").length, 1, "npm 锚点不重复");
	assert.equal(core.loadUserState().anchors.length, 2);
});

// ── v0.9：场景包空间隔离（裸 npm 也落项目层 delta）────────────

test("v0.9 迁移自愈：v0.7 遗留的全局 managed 裸串 → 项目重激活后摘除并转项目 delta", () => {
	const { core, dir } = tmpDual();
	const CFG = dualCfg(dir);
	// 模拟 v0.7 状态：场景裸 npm 在全局层且属 managed
	writeSettings(core, { packages: ["npm:pi-scenes", "npm:pi-carryover"] });
	fs.writeFileSync(
		core.paths.stateFile,
		JSON.stringify({ active: null, managed: { packages: ["npm:pi-carryover"], skills: [] }, anchors: [], version: 2 }),
	);

	core.applyToSettings(core.computeTarget("coding", CFG), "coding", undefined, "project");
	const user = JSON.parse(fs.readFileSync(core.paths.settingsFile, "utf8"));
	const proj = JSON.parse(fs.readFileSync(core.paths.projectSettingsFile, "utf8"));
	assert.ok(!user.packages.includes("npm:pi-carryover"), "全局层裸串被摘（managed 摘旧）");
	assert.ok(user.packages.some((p) => typeof p === "object" && p.source === "npm:pi-carryover" && p.autoload === false), "零暴露锚点就位");
	assert.ok(proj.packages.some((p) => typeof p === "object" && p.source === "npm:pi-carryover" && p.skills.includes("**")), "项目 delta 就位");
});

test("v0.9 borrowed：用户手配的全局同包 → 借用，不落项目 delta、不加锚点", () => {
	const { core, dir } = tmpDual();
	const CFG = dualCfg(dir);
	writeSettings(core, { packages: ["npm:pi-scenes", "npm:pi-carryover"] }); // 用户自己手配（非 managed）

	const r = core.applyToSettings(core.computeTarget("coding", CFG), "coding", undefined, "project");
	const user = JSON.parse(fs.readFileSync(core.paths.settingsFile, "utf8"));
	const proj = JSON.parse(fs.readFileSync(core.paths.projectSettingsFile, "utf8"));
	assert.ok(r.borrowedPackages.includes("npm:pi-carryover"), "借用而非纳管");
	assert.ok(user.packages.includes("npm:pi-carryover"), "用户手配保留全局");
	assert.ok(!proj.packages.some((p) => typeof p === "object" && p.source === "npm:pi-carryover"), "不落项目 delta");
	assert.ok(!core.loadUserState().anchors.some((a) => a.source === "npm:pi-carryover"), "不加锚点");
	assert.ok(core.loadUserState().anchors.some((a) => a.source === "git:github.com/anthropics/skills"), "anthropics 仍正常锚点");
});

test("v0.9 preInstall：pi install 刚写入的裸串 → 摘为锚点 + 项目 delta（不泄漏全局）", () => {
	const { core, dir } = tmpDual();
	const CFG = dualCfg(dir);
	writeSettings(core, { packages: ["npm:pi-scenes", "npm:pi-carryover"] }); // 模拟 pi install 已写入

	const r = core.applyToSettings(core.computeTarget("coding", CFG), "coding", ["npm:pi-scenes"], "project");
	const user = JSON.parse(fs.readFileSync(core.paths.settingsFile, "utf8"));
	const proj = JSON.parse(fs.readFileSync(core.paths.projectSettingsFile, "utf8"));
	assert.ok(!user.packages.includes("npm:pi-carryover"), "刚写入的裸串被摘");
	assert.ok(user.packages.some((p) => typeof p === "object" && p.source === "npm:pi-carryover" && p.autoload === false), "换为零暴露锚点");
	assert.ok(proj.packages.some((p) => typeof p === "object" && p.source === "npm:pi-carryover" && p.skills.includes("**")), "项目层 delta");
	assert.ok(!r.borrowedPackages.includes("npm:pi-carryover"), "非借用");
});

// ── v0.8：场景化 prompt 模板 ──────────────────────────────

test("v0.8 computeTarget：prompts 通用层 ∪ 场景，~ 展开，去重", () => {
	const { core } = tmpBase();
	const cfg = {
		common: { packages: [], skills: [], prompts: ["~/prompts-common", "/abs/tpl.md"] },
		scenes: {
			coding: { prompts: ["~/prompts-common", "~/.pi/agent/scenes/coding/prompts"] },
			"coding-debug": { extends: "coding", prompts: ["~/prompts-debug"] },
		},
	};
	const t = core.computeTarget("coding", cfg);
	assert.deepEqual(t.prompts, [
		`${os.homedir()}/prompts-common`,
		"/abs/tpl.md",
		`${os.homedir()}/.pi/agent/scenes/coding/prompts`,
	]);
	// extends 链 union：子场景含父场景 prompts
	const t2 = core.computeTarget("coding-debug", cfg);
	assert.ok(t2.prompts.includes(`${os.homedir()}/prompts-debug`));
	assert.ok(t2.prompts.includes(`${os.homedir()}/.pi/agent/scenes/coding/prompts`));
	// 仅通用层
	const t0 = core.computeTarget(null, cfg);
	assert.deepEqual(t0.prompts, [`${os.homedir()}/prompts-common`, "/abs/tpl.md"]);
});

test("v0.8 resolveScene：prompts 沿 extends 链 union", () => {
	const { core } = tmpBase();
	const cfg = {
		scenes: {
			base: { prompts: ["~/a"] },
			child: { extends: "base", prompts: ["~/b"] },
		},
	};
	// 既有语义：从子场景沿 extends 向上合并，子场景条目在前
	assert.deepEqual(core.resolveScene("child", cfg).prompts, ["~/b", "~/a"]);
});

test("v0.8 scaffold：模板 scenes.json 含 prompts 字段 + prompts 目录骨架 + 预置模板复制", () => {
	const { core } = tmpBase();
	const created = core.scaffold();
	// 1) scenes.json 每个场景（含 common）声明 prompts 目录
	const cfg = core.loadScenes();
	const all = ["common", ...Object.keys(cfg.scenes)];
	for (const s of all) {
		const def = s === "common" ? cfg.common : cfg.scenes[s];
		assert.ok(Array.isArray(def.prompts) && def.prompts.length > 0, `${s} prompts`);
	}
	// 2) prompts 目录骨架
	for (const s of ["common", "coding", "office", "pm", "research", "writing", "data", "learning"]) {
		assert.ok(fs.existsSync(path.join(core.paths.scenesRoot, s, "prompts")), `${s}/prompts`);
	}
	// 3) 预置模板从包内 assets/scene-prompts 复制（幂等，不覆盖已有）
	assert.ok(fs.existsSync(path.join(core.paths.scenesRoot, "coding", "prompts", "pre-commit.md")));
	assert.ok(fs.existsSync(path.join(core.paths.scenesRoot, "research", "prompts", "deep-dive.md")));
	assert.ok(fs.existsSync(path.join(core.paths.scenesRoot, "learning", "prompts", "feynman.md")));
	assert.ok(fs.existsSync(path.join(core.paths.scenesRoot, "learning", "skills", "eli5", "SKILL.md")), "eli5 预置技能");
	assert.ok(fs.existsSync(path.join(core.paths.scenesRoot, "learning", "prompts", "socratic.md")));
	assert.ok(fs.existsSync(path.join(core.paths.scenesRoot, "learning", "prompts", "flashcards.md")));
	// 幂等：用户改过的文件不被 scaffold 覆盖
	const mine = path.join(core.paths.scenesRoot, "coding", "prompts", "pre-commit.md");
	fs.writeFileSync(mine, "用户自定义内容");
	core.scaffold();
	assert.equal(fs.readFileSync(mine, "utf8"), "用户自定义内容");
});

test("v0.8 resources_discover 语义：prompts 不写 settings，切走零残留", () => {
	const { core } = tmpBase();
	const cfg = core.loadScenes() || {};
	cfg.scenes = { coding: { packages: ["npm:pi-lens"], prompts: ["~/my-templates"] } };
	core.saveScenes(cfg);
	// 模拟切换到 coding：settings 只会写 packages/skills
	core.applyToSettings(core.computeTarget("coding", cfg), "coding", undefined, "project");
	const proj = JSON.parse(fs.readFileSync(core.paths.projectSettingsFile, "utf8"));
	const user = JSON.parse(fs.readFileSync(core.paths.settingsFile, "utf8"));
	assert.equal(proj.prompts, undefined, "prompts 绝不写入项目 settings");
	assert.equal(user.prompts, undefined, "prompts 绝不写入全局 settings");
	assert.ok(Array.isArray(user.packages) && user.packages.some((e) => e === "npm:pi-lens" || e?.source === "npm:pi-lens"), "包条目正常落 settings（仅 prompts 走动态注入）");
	// 动态注入源 = computeTarget(active).prompts（切走后 effectiveActive 变化 → 路径自动消失）
	const active = core.computeTarget(core.effectiveActive(), core.loadScenes());
	assert.deepEqual(active.prompts, [`${os.homedir()}/my-templates`]);
});

// ── v0.10：vendored 资产指纹与安全更新 ─────────────────────

function makeFakeAssets(root, version) {
	// 构造包内 assets：skills/<scene>/<skill>/SKILL.md + prompts/<scene>/tpl.md
	const skills = path.join(root, "scene-skills", "learning", "eli5");
	fs.mkdirSync(skills, { recursive: true });
	fs.writeFileSync(path.join(skills, "SKILL.md"), `# eli5 v${version}\nanalogy-first\n`);
	const prompts = path.join(root, "scene-prompts", "coding");
	fs.mkdirSync(prompts, { recursive: true });
	fs.writeFileSync(path.join(prompts, "pre-commit.md"), `---\ndescription: v${version}\n---\nstep list v${version}\n`);
	return { skills: path.join(root, "scene-skills"), prompts: path.join(root, "scene-prompts") };
}

test("v0.10 syncVendoredAssets：首次全 added + manifest 基线", () => {
	const { core } = tmpBase();
	const roots = makeFakeAssets(path.join(core.paths.baseDir, "fake-pkg"), "1");
	const r = core.syncVendoredAssets(roots);
	assert.deepEqual(r.added.sort(), ["coding/prompts/pre-commit.md", "learning/skills/eli5"]);
	assert.equal(r.updated.length, 0);
	const m = JSON.parse(fs.readFileSync(core.paths.assetsManifest, "utf8"));
	assert.ok(m.files["learning/skills/eli5"], "manifest 记录 skill 目录指纹");
});

test("v0.10 用户未改 + 包升级 → updated 覆盖跟随新版", () => {
	const { core } = tmpBase();
	const pkgDir = path.join(core.paths.baseDir, "fake-pkg");
	makeFakeAssets(pkgDir, "1");
	core.syncVendoredAssets({ skills: path.join(pkgDir, "scene-skills"), prompts: path.join(pkgDir, "scene-prompts") });
	// 包升级到 v2
	const roots = makeFakeAssets(pkgDir, "2");
	const r = core.syncVendoredAssets(roots);
	assert.deepEqual(r.updated.sort(), ["coding/prompts/pre-commit.md", "learning/skills/eli5"]);
	assert.ok(fs.readFileSync(path.join(core.paths.scenesRoot, "coding", "prompts", "pre-commit.md"), "utf8").includes("v2"), "落盘已是新版");
});

test("v0.10 用户改过 → conflict 保留用户版，再跑稳定不重复报告", () => {
	const { core } = tmpBase();
	const pkgDir = path.join(core.paths.baseDir, "fake-pkg");
	const roots = makeFakeAssets(pkgDir, "1");
	core.syncVendoredAssets(roots);
	const mine = path.join(core.paths.scenesRoot, "coding", "prompts", "pre-commit.md");
	fs.writeFileSync(mine, "用户自定义流程");
	const r2 = core.syncVendoredAssets(roots);
	assert.deepEqual(r2.conflicts, ["coding/prompts/pre-commit.md"]);
	assert.equal(fs.readFileSync(mine, "utf8"), "用户自定义流程", "用户版保留");
	// 稳定性：再跑一次仍是同一 conflict（不覆盖、不误报 updated）
	const r3 = core.syncVendoredAssets(roots);
	assert.deepEqual(r3.conflicts, ["coding/prompts/pre-commit.md"]);
	assert.equal(r3.updated.length, 0);
});

test("v0.10 用户改过 + 包也升级 → 仍保留用户版（改动态优先）", () => {
	const { core } = tmpBase();
	const pkgDir = path.join(core.paths.baseDir, "fake-pkg");
	makeFakeAssets(pkgDir, "1");
	core.syncVendoredAssets({ skills: path.join(pkgDir, "scene-skills"), prompts: path.join(pkgDir, "scene-prompts") });
	fs.writeFileSync(path.join(core.paths.scenesRoot, "coding", "prompts", "pre-commit.md"), "用户自定义流程");
	const roots2 = makeFakeAssets(pkgDir, "2"); // 包升级
	const r = core.syncVendoredAssets(roots2);
	assert.deepEqual(r.conflicts, ["coding/prompts/pre-commit.md"]);
	assert.ok(r.updated.includes("learning/skills/eli5"), "未改的 skill 正常更新");
});

test("v0.10 包内删除预设 → removed 仅提示，本地保留", () => {
	const { core } = tmpBase();
	const pkgDir = path.join(core.paths.baseDir, "fake-pkg");
	makeFakeAssets(pkgDir, "1");
	core.syncVendoredAssets({ skills: path.join(pkgDir, "scene-skills"), prompts: path.join(pkgDir, "scene-prompts") });
	// 模拟包 v2 删掉了 eli5
	fs.rmSync(path.join(pkgDir, "scene-skills"), { recursive: true });
	const r = core.syncVendoredAssets({ skills: path.join(pkgDir, "scene-skills"), prompts: path.join(pkgDir, "scene-prompts") });
	assert.deepEqual(r.removed, ["learning/skills/eli5"]);
	assert.ok(fs.existsSync(path.join(core.paths.scenesRoot, "learning", "skills", "eli5", "SKILL.md")), "本地未删");
});

test("v0.10 无 manifest 首跑（存量落盘）→ 一致补录基线，不一致保守冲突", () => {
	const { core } = tmpBase();
	const pkgDir = path.join(core.paths.baseDir, "fake-pkg");
	const roots = makeFakeAssets(pkgDir, "1");
	// 模拟 v0.9 时代落盘：无 manifest，pre-commit 被用户改过，eli5 原样
	fs.mkdirSync(path.join(core.paths.scenesRoot, "learning", "skills", "eli5"), { recursive: true });
	fs.writeFileSync(path.join(core.paths.scenesRoot, "learning", "skills", "eli5", "SKILL.md"), "# eli5 v1\nanalogy-first\n");
	fs.mkdirSync(path.join(core.paths.scenesRoot, "coding", "prompts"), { recursive: true });
	fs.writeFileSync(path.join(core.paths.scenesRoot, "coding", "prompts", "pre-commit.md"), "用户旧版流程");
	const r = core.syncVendoredAssets(roots);
	assert.deepEqual(r.baselineRepaired, ["learning/skills/eli5"]);
	assert.deepEqual(r.conflicts, ["coding/prompts/pre-commit.md"]);
	assert.equal(fs.readFileSync(path.join(core.paths.scenesRoot, "coding", "prompts", "pre-commit.md"), "utf8"), "用户旧版流程");
});

test("v0.10 scaffold 内建同步：产出 manifest 且预置落盘", () => {
	const { core } = tmpBase();
	core.scaffold();
	assert.ok(fs.existsSync(core.paths.assetsManifest), "manifest 生成");
	const m = JSON.parse(fs.readFileSync(core.paths.assetsManifest, "utf8"));
	assert.ok(m.files["coding/prompts/pre-commit.md"]);
	assert.ok(m.files["learning/skills/eli5"]);
});
