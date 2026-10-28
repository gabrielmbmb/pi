import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";

import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

import { addVisualSelectionHighlight } from "../extensions/vi-mode/visual-highlight.ts";

function stripAnsi(text) {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

test("loads the Vi editor integration and its help command", async (context) => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-vi-mode-agent-"));
	context.after(() => rm(agentDir, { force: true, recursive: true }));

	const extensionPath = resolve("extensions/vi-mode/index.ts");
	const result = await discoverAndLoadExtensions([extensionPath], process.cwd(), agentDir);

	assert.deepEqual(result.errors, []);
	const extension = result.extensions.find((candidate) => candidate.resolvedPath === extensionPath);
	assert.ok(extension);
	assert.equal(extension.handlers.get("session_start")?.length, 2);
	assert.equal(extension.handlers.get("session_shutdown")?.length, 1);

	const help = extension.commands.get("vi-help");
	assert.ok(help);
	let notification;
	await help.handler("", {
		ui: {
			notify(message, type) {
				notification = { message, type };
			},
		},
	});
	assert.equal(notification.type, "info");
	assert.match(notification.message, /INSERT/);
	assert.match(notification.message, /VISUAL/);
});

test("loads without installed host peers when Pi has import-only exports", async (context) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-vi-mode-esm-"));
	context.after(() => rm(directory, { force: true, recursive: true }));

	const extensionPath = join(directory, "extensions/vi-mode/index.ts");
	await cp(resolve("extensions/vi-mode"), join(directory, "extensions/vi-mode"), { recursive: true });
	await cp(await realpath("node_modules/pi-vim"), join(directory, "node_modules/pi-vim"), {
		recursive: true,
		filter: (source) => basename(source) !== "node_modules",
	});
	const hostDirectory = join(directory, "node_modules/@earendil-works/pi-coding-agent");
	await mkdir(hostDirectory, { recursive: true });
	// Ordinary imports use Pi's host mapping, but pi-vim's clipboard helper
	// also resolves the package itself. It must tolerate import-only exports.
	await writeFile(join(hostDirectory, "package.json"), JSON.stringify({
		name: "@earendil-works/pi-coding-agent",
		type: "module",
		exports: { ".": { import: "./index.js" } },
	}));

	const result = await discoverAndLoadExtensions([extensionPath], directory, join(directory, "agent"));
	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions.length, 1);
	assert.ok(result.extensions[0].commands.has("vi-help"));
});

test("highlights the inclusive character-wise Visual selection", () => {
	const editor = {
		focused: false,
		visualAnchor: { line: 0, col: 0 },
		scrollOffset: 0,
		getCursor: () => ({ line: 0, col: 6 }),
		getLines: () => ["one two three"],
		getMode: () => "visual",
		getPaddingX: () => 0,
		getText: () => "one two three",
		setText() {},
		handleInput() {},
		invalidate() {},
		layoutText: () => [{ text: "one two three", hasCursor: true, cursorPos: 6 }],
		render: (width) => ["─".repeat(width), "one two three".padEnd(width), " VISUAL ".padStart(width, "─")],
	};
	const tui = {
		terminal: { rows: 24 },
		getShowHardwareCursor: () => true,
	};
	const theme = {
		bg: (_color, text) => `\x1b[41m${text}\x1b[49m`,
		fg: (_color, text) => text,
	};

	addVisualSelectionHighlight(editor, tui, theme);
	const rendered = editor.render(20);

	assert.equal((rendered[1].match(/\x1b\[41m/g) ?? []).length, 7);
	assert.equal(stripAnsi(rendered[1]), "one two three       ");
	assert.ok(rendered[2].endsWith(" VISUAL "));
});
