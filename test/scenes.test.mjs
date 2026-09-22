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
	return { dir, core: makeCore(dir) };
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
	for (const s of ["common", "coding", "office", "pm", "research", "writing", "data"]) {
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

