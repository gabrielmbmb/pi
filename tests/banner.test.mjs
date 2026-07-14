import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import bannerExtension, { getLoadedContextFiles, getLoadedExtensionNames } from "../extensions/banner.ts";

function stripAnsi(text) {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

test("lists extension resources represented by commands and tools", () => {
	const extensions = getLoadedExtensionNames(
		[
			{ source: "extension", sourceInfo: { path: "/extensions/worktree.ts" } },
			{ source: "skill", sourceInfo: { path: "/skills/review/SKILL.md" } },
		],
		[
			{ sourceInfo: { path: "<builtin:read>", source: "builtin" } },
			{ sourceInfo: { path: "/extensions/review/index.ts", source: "local" } },
			{ sourceInfo: { path: "<sdk:tool>", source: "sdk" } },
		],
	);

	assert.deepEqual(extensions, ["banner", "review", "worktree"]);
});

test("lists the context files loaded by Pi", async (context) => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-banner-agent-"));
	const projectDir = await mkdtemp(join(tmpdir(), "pi-banner-project-"));
	context.after(() => Promise.all([rm(agentDir, { force: true, recursive: true }), rm(projectDir, { force: true, recursive: true })]));

	await mkdir(join(projectDir, "nested"));
	await writeFile(join(agentDir, "AGENTS.md"), "# Global instructions");
	await writeFile(join(projectDir, "AGENTS.md"), "# Project instructions");
	await writeFile(join(projectDir, "nested", "CLAUDE.md"), "# Nested instructions");

	assert.deepEqual(getLoadedContextFiles(join(projectDir, "nested"), agentDir), [
		join(agentDir, "AGENTS.md"),
		join(projectDir, "AGENTS.md"),
		"CLAUDE.md",
	]);
});

test("replaces the startup header with a rainbow Pi banner", async () => {
	let sessionStartHandler;
	bannerExtension({
		getAllTools() {
			return [{ sourceInfo: { path: "/extensions/worktree.ts", source: "local" } }];
		},
		getCommands() {
			return [];
		},
		on(event, handler) {
			if (event === "session_start") sessionStartHandler = handler;
		},
	});
	assert.ok(sessionStartHandler);

	let headerFactory;
	await sessionStartHandler(
		{},
		{
			cwd: process.cwd(),
			mode: "tui",
			ui: {
				setHeader(factory) {
					headerFactory = factory;
				},
			},
		},
	);
	assert.ok(headerFactory);

	const header = headerFactory(
		{ requestRender() {} },
		{ fg(_color, text) { return text; } },
	);
	const lines = header.render(80);
	const rendered = lines.map(stripAnsi);

	assert.ok(lines.some((line) => line.includes("\x1b[38;2;")));
	assert.deepEqual(header.render(18).map(stripAnsi).slice(1, 9), [
		"   ▄███████▄  ▄█  ",
		"  ███    ███ ███  ",
		"  ███    ███ ███▌ ",
		"  ███    ███ ███▌ ",
		"▀█████████▀  ███▌ ",
		"  ███        ███  ",
		"  ███        ███  ",
		" ▄████▀      █▀   ",
	]);
	assert.ok(rendered.every((line) => line.length <= 80));
	assert.ok(header.render(10).map(stripAnsi).every((line) => line.length <= 10));
	assert.ok(rendered.some((line) => line.trim() === "extensions loaded: banner, worktree"));
	assert.ok(rendered.some((line) => line.trim().startsWith("context files: ")));
	header.dispose();
});
