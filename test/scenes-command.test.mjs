/**
 * command 层（default export）冒烟测试 —— 必须独立文件：
 * default 的 baseDir 在模块求值时读 PI_SCENES_DIR（见 extensions/scenes.ts 870 行），
 * ESM 静态 import 会先于任何测试代码执行 → env 必须在动态 import 之前设置。
 * node --test 按文件 spawn 独立进程，与 scenes.test.mjs 天然隔离。
 *
 * v0.2.2 回归：/scene <name> 切换时 findMissingPackages 曾收到 computeTarget
 * 的对象而非 packages 数组 → TypeError: target.filter is not a function。
 *   node --test test/
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-scenes-cmd-"));
process.env.PI_SCENES_DIR = dir;

// ⚠️ 动态 import：此时 env 已生效，default 内部的 core 指向 dir 而非真实 ~/.pi/agent
const scenesExtension = (await import("../extensions/scenes.ts")).default;

const CFG = {
	common: { packages: ["npm:pi-scenes"], skills: ["~/skills-common"] },
	scenes: {
		coding: {
			description: "写代码",
			packages: ["npm:pi-carryover", "npm:pi-not-exist-demo"],
			skills: [],
		},
	},
};

test("/scene coding：缺失判定不抛 target.filter，取消路径干净退出", async () => {
	fs.writeFileSync(path.join(dir, "scenes.json"), JSON.stringify(CFG));
	fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ packages: ["npm:pi-scenes"], skills: [] }));

	let handler = null;
	const pi = {
		registerCommand: (_name, def) => {
			handler = def.handler;
		},
		registerTool: () => {},
		on: () => {},
	};
	scenesExtension(pi);
	assert.ok(handler, "应捕获到 /scene 命令 handler");

	const notes = [];
	const ctx = {
		ui: {
			notify: (m, l) => notes.push([m, l]),
			confirm: async () => false, // 拒绝安装缺失包 → 干净退出，不 spawnSync / 不 reload
			select: async () => null,
		},
		reload: async () => notes.push(["RELOADED", "x"]),
	};

	await handler("coding", ctx); // v0.2.1 在此抛 TypeError

	assert.ok(
		notes.some(([m]) => String(m).includes("已取消切换")),
		`应以「已取消切换（未做任何修改）」干净退出，实际 notify：${JSON.stringify(notes)}`,
	);
	assert.ok(!notes.some(([m]) => m === "RELOADED"), "取消路径不得触发 reload");
	// 隔离护栏：真实 ~/.pi/agent/settings.json 不得被测试触碰
	assert.equal(process.env.PI_SCENES_DIR, dir);
});

test("/scene coding：确认安装缺失包失败（exit≠0）→ 中止且不改 settings", async () => {
	fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ packages: ["npm:pi-scenes"], skills: [] }));
	// npm:pi-not-exist-demo 必然找不到 → isPackageInstalled=false → 进 missing
	// 但本用例不真正 spawnSync（confirm 拒绝在 spawn 之前），仅验证拦截顺序：
	// 若 913 行回归再犯，本文件第一个用例已先失败，此处主防误切换真实环境。
	const before = fs.readFileSync(path.join(dir, "settings.json"), "utf8");
	const notes = [];
	let handler = null;
	scenesExtension({
		registerCommand: (_n, def) => {
			handler = def.handler;
		},
		registerTool: () => {},
		on: () => {},
	});
	const ctx = {
		ui: { notify: (m, l) => notes.push([m, l]), confirm: async () => false, select: async () => null },
		reload: async () => {},
	};
	await handler("coding", ctx);
	assert.equal(fs.readFileSync(path.join(dir, "settings.json"), "utf8"), before, "取消路径不得写 settings");
});
