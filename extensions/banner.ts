import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

import {
	getAgentDir,
	loadProjectContextFiles,
	type ExtensionAPI,
	type Theme,
} from "@earendil-works/pi-coding-agent";

const RAINBOW_COLORS = [
	[255, 95, 95],
	[255, 159, 67],
	[255, 230, 109],
	[125, 255, 158],
	[94, 230, 255],
	[95, 168, 255],
	[178, 141, 255],
] as const;
const RESET = "\x1b[0m";
const BANNER_WIDTH = 18;
const PI_PIXELS = [
	"   ▄███████▄  ▄█  ",
	"  ███    ███ ███  ",
	"  ███    ███ ███▌ ",
	"  ███    ███ ███▌ ",
	"▀█████████▀  ███▌ ",
	"  ███        ███  ",
	"  ███        ███  ",
	" ▄████▀      █▀   ",
].map((line) => line.padEnd(BANNER_WIDTH));

interface ExtensionCommand {
	source: string;
	sourceInfo: {
		path: string;
	};
}

interface Tool {
	sourceInfo: {
		path: string;
		source: string;
	};
}

function extensionName(path: string): string {
	const filename = basename(path, extname(path));
	return filename === "index" ? basename(dirname(path)) : filename;
}

function truncate(text: string, width: number): string {
	if (width <= 0) return "";
	if (text.length <= width) return text;
	if (width === 1) return "…";
	return `${text.slice(0, width - 1)}…`;
}

export function getLoadedExtensionNames(
	commands: readonly ExtensionCommand[],
	tools: readonly Tool[],
): string[] {
	const paths = new Set<string>();

	for (const command of commands) {
		if (command.source === "extension") paths.add(command.sourceInfo.path);
	}

	for (const tool of tools) {
		if (tool.sourceInfo.source === "builtin" || tool.sourceInfo.source === "sdk") continue;
		paths.add(tool.sourceInfo.path);
	}

	// This extension has no command or tool, so it is not otherwise observable through Pi's public API.
	paths.add("banner.ts");

	return [...paths].map(extensionName).sort((first, second) => first.localeCompare(second));
}

function formatContextPath(filePath: string, cwd: string): string {
	const absolutePath = resolve(filePath);
	const relativePath = relative(resolve(cwd), absolutePath);
	const isInsideCwd =
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
	if (isInsideCwd) return relativePath || ".";

	const home = homedir();
	return absolutePath.startsWith(home) ? `~${absolutePath.slice(home.length)}` : absolutePath;
}

export function getLoadedContextFiles(cwd: string, agentDir = getAgentDir()): string[] {
	return loadProjectContextFiles({ cwd, agentDir }).map((file) => formatContextPath(file.path, cwd));
}

class PiBanner {
	private readonly tui: { requestRender(): void };
	private readonly theme: Theme;
	private readonly extensions: readonly string[];
	private readonly contextFiles: readonly string[];
	private animationTimer: ReturnType<typeof setInterval>;
	private frame = 0;

	constructor(
		tui: { requestRender(): void },
		theme: Theme,
		extensions: readonly string[],
		contextFiles: readonly string[],
	) {
		this.tui = tui;
		this.theme = theme;
		this.extensions = extensions;
		this.contextFiles = contextFiles;
		this.animationTimer = setInterval(() => {
			this.frame++;
			this.tui.requestRender();
		}, 80);
	}

	dispose(): void {
		clearInterval(this.animationTimer);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const extensions = this.extensions.length > 0 ? this.extensions.join(", ") : "none";
		const contextFiles = this.contextFiles.length > 0 ? this.contextFiles.join(", ") : "none";
		return [
			"",
			...PI_PIXELS.map((line, row) => this.renderBannerLine(line, row, width)),
			"",
			this.renderDetail(`extensions loaded: ${extensions}`, width),
			this.renderDetail(`context files: ${contextFiles}`, width),
			"",
		];
	}

	private renderBannerLine(line: string, row: number, width: number): string {
		if (width <= 0) return "";

		const pixels = [...line].slice(0, width);
		const padding = " ".repeat(Math.max(0, Math.floor((width - pixels.length) / 2)));
		return padding + pixels.map((pixel, column) => this.colorize(pixel, column, row)).join("");
	}

	private renderDetail(text: string, width: number): string {
		const detail = truncate(text, width);
		const padding = " ".repeat(Math.max(0, Math.floor((width - detail.length) / 2)));
		return padding + this.theme.fg("muted", detail);
	}

	private colorize(pixel: string, column: number, row: number): string {
		if (pixel === " ") return pixel;
		const color = RAINBOW_COLORS[(column + row + this.frame) % RAINBOW_COLORS.length]!;
		return `\x1b[38;2;${color[0]};${color[1]};${color[2]}m${pixel}${RESET}`;
	}
}

export default function bannerExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const extensions = getLoadedExtensionNames(pi.getCommands(), pi.getAllTools());
		const contextFiles = getLoadedContextFiles(ctx.cwd);
		ctx.ui.setHeader((tui, theme) => new PiBanner(tui, theme, extensions, contextFiles));
	});
}
