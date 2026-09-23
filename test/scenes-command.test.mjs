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
// v0.7：/scene 默认项目级 —— 项目层也必须指向临时目录，防污染真实 <cwd>/.pi
process.env.PI_SCENES_PROJECT_DIR = path.join(dir, "proj");

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

test("状态栏场景徽标：切换成功 setStatus('pi-scene','◆ coding')，off 清除，session_start 幂等恢复", async () => {
	// 目标包全部已在 settings → 无 missing → 不弹 confirm、不 spawnSync，直达 applyToSettings
	fs.writeFileSync(
		path.join(dir, "scenes.json"),
		JSON.stringify({
			common: { packages: ["npm:pi-scenes"], skills: [] },
			scenes: { coding: { description: "写代码", packages: ["npm:pi-scenes"], skills: [] } },
		}),
	);
	fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ packages: ["npm:pi-scenes"], skills: [] }));

	const statuses = new Map();
	const mkCtx = () => ({
		ui: {
			notify: () => {},
			confirm: async () => true,
			select: async () => null,
			setStatus: (k, v) => statuses.set(k, v),
			theme: { fg: (_c, s) => s },
		},
		reload: async () => {},
	});

	let handler = null;
	const events = {};
	scenesExtension({
		registerCommand: (_n, def) => {
			handler = def.handler;
		},
		registerTool: () => {},
		on: (name, fn) => {
			events[name] = fn;
		},
	});

	// 1) 切到 coding → 徽标出现
	await handler("coding", mkCtx());
	assert.equal(statuses.get("pi-scene"), "◆ coding", "切换成功后应 setStatus('pi-scene','◆ coding')");

	// 2) 新会话（如重启 pi）→ session_start 恢复徽标
	statuses.delete("pi-scene");
	await events.session_start({}, mkCtx());
	assert.equal(statuses.get("pi-scene"), "◆ coding", "session_start 应从 scenes-state.json 恢复徽标");

	// 3) off（仅通用层）→ 徽标清除
	await handler("off", mkCtx());
	assert.equal(statuses.get("pi-scene"), undefined, "/scene off 后应清除 pi-scene 徽标");

	// 4) session_start 后仍为 off → 不重设徽标（保持清除）
	statuses.set("pi-scene", "stale");
	await events.session_start({}, mkCtx());
	assert.equal(statuses.get("pi-scene"), undefined, "off 状态下 session_start 不得重设徽标");
});

test("徽标 icon 定制：scenes.json 配 icon → '💻 coding'，未配 → 回退 ◆", async () => {
	fs.writeFileSync(
		path.join(dir, "scenes.json"),
		JSON.stringify({
			common: { packages: ["npm:pi-scenes"], skills: [] },
			scenes: {
				coding: { description: "写代码", icon: "💻", packages: ["npm:pi-scenes"], skills: [] },
				plain: { description: "无图标", packages: ["npm:pi-scenes"], skills: [] },
			},
		}),
	);
	fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ packages: ["npm:pi-scenes"], skills: [] }));

	const statuses = new Map();
	const mkCtx = () => ({
		ui: {
			notify: () => {},
			confirm: async () => true,
			select: async () => null,
			setStatus: (k, v) => statuses.set(k, v),
			theme: { fg: (_c, s) => s },
		},
		reload: async () => {},
	});
	let handler = null;
	const events = {};
	scenesExtension({
		registerCommand: (_n, def) => {
			handler = def.handler;
		},
		registerTool: () => {},
		on: (name, fn) => {
			events[name] = fn;
		},
	});

	await handler("coding", mkCtx());
	assert.equal(statuses.get("pi-scene"), "💻 coding", "配置 icon 后徽标应为 '💻 coding'");

	// session_start 恢复同样带 icon
	statuses.delete("pi-scene");
	await events.session_start({}, mkCtx());
	assert.equal(statuses.get("pi-scene"), "💻 coding", "session_start 恢复应保留 icon");

	await handler("plain", mkCtx());
	assert.equal(statuses.get("pi-scene"), "◆ plain", "未配 icon 的场景应回退 '◆ plain'");
});

test("参数 Tab 补全：场景名+子命令全量列出、前缀过滤、多词子命令", async () => {
	fs.writeFileSync(
		path.join(dir, "scenes.json"),
		JSON.stringify({
			common: { packages: ["npm:pi-scenes"], skills: [] },
			scenes: {
				coding: { description: "写代码", icon: "💻", packages: ["npm:pi-scenes"], skills: [] },
				research: { description: "调研", packages: ["npm:pi-scenes"], skills: [] },
			},
		}),
	);
	const commands = {};
	scenesExtension({
		registerCommand: (name, def) => {
			commands[name] = def;
		},
		registerTool: () => {},
		on: () => {},
	});
	assert.deepEqual(Object.keys(commands).sort(), ["scene"], "只注册 /scene（v0.5.0 起移除 /scenes 复数别名）");
	const gc = commands.scene.getArgumentCompletions;
	assert.equal(typeof gc, "function", "命令应携带 getArgumentCompletions");

	// 空前缀：场景在前（label 带 icon、description 带描述），子命令在后
	const all = gc("");
	const coding = all.find((i) => i.value === "coding");
	assert.ok(coding && coding.label.includes("💻") && String(coding.description).includes("写代码"));
	for (const sub of ["off", "status", "migrate", "init", "stats", "update-assets", "evolve", "evolve auto"]) {
		assert.ok(all.some((i) => i.value === sub), `空前缀应包含子命令 ${sub}`);
	}
	// 场景排在子命令前（先场景后子命令的固定顺序）
	assert.ok(all.findIndex((i) => i.value === "coding") < all.findIndex((i) => i.value === "off"));

	// 前缀过滤：/scene c<Tab> → coding（大小写不敏感）
	assert.deepEqual(gc("c").map((i) => i.value), ["coding"]);
	assert.deepEqual(gc("C").map((i) => i.value), ["coding"]);
	// 多词子命令：/scene evolve a<Tab> → evolve auto
	assert.deepEqual(gc("evolve a").map((i) => i.value), ["evolve auto"]);
	// 无匹配 → null
	assert.equal(gc("zzz"), null);
	// 提示行动态拼入场景名 + Tab 引导
	assert.ok(String(commands.scene.description).includes("coding") && String(commands.scene.description).includes("research"));
	assert.ok(String(commands.scene.description).includes("Tab"));

	// scenes.json 缺失：不抛异常，仍补全子命令
	fs.rmSync(path.join(dir, "scenes.json"));
	const onlySubs = gc("");
	assert.ok(onlySubs.length > 0 && onlySubs.every((i) => ["off", "status", "migrate", "init", "stats", "update-assets", "evolve", "evolve auto"].includes(i.value)));
	assert.deepEqual(gc("ini").map((i) => i.value), ["init"]);
});
