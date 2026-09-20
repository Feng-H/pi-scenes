/**
 * 核心逻辑冒烟测试（不依赖 TUI / 真实 ~/.pi）：
 *   node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { makeCore } from "../extensions/scenes.ts";

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

test("scaffold 生成模板与目录", () => {
	const { core } = tmpBase();
	const created = core.scaffold();
	assert.ok(created.some((c) => c.endsWith("scenes.json")));
	assert.ok(fs.existsSync(path.join(core.paths.scenesRoot, "coding", "skills")));
	assert.ok(!fs.existsSync(path.join(core.paths.scenesRoot, "office", "skills", "SKILL.md")));
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
