import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piVim from "pi-vim/index.ts";

import { addVisualSelectionHighlight } from "./visual-highlight.ts";

const HELP = [
	"INSERT: type normally; Esc enters NORMAL (or closes autocomplete first).",
	"NORMAL: hjkl, w/b/e, 0/^/$, gg/G, i/a/I/A, o/O, d/c/y, x, u/C-r, p/P, and counts.",
	"VISUAL: v selects characters; V selects lines; move, then d/x, y, or c. Esc cancels.",
	"EX: :tree, :model …, and :!command bridge to Pi while preserving the draft.",
	"More: https://github.com/lajarre/pi-vim",
].join("\n");

/**
 * Loads the maintained pi-vim editor as part of this Pi resource package.
 * Keeping the integration thin lets us inherit its Vim-parity test suite,
 * clipboard support, mode UI, and future compatibility fixes.
 */
export default function viModeExtension(pi: ExtensionAPI): void {
	piVim(pi);

	// pi-vim intentionally leaves Visual selections unpainted. Decorate the
	// editor in place so its app callbacks, history, and cursor behavior remain intact.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		const editorFactory = ctx.ui.getEditorComponent();
		if (!editorFactory) return;
		ctx.ui.setEditorComponent((tui, theme, keybindings) =>
			addVisualSelectionHighlight(editorFactory(tui, theme, keybindings), tui, ctx.ui.theme),
		);
	});

	pi.registerCommand("vi-help", {
		description: "Show the Vi prompt editor's essential shortcuts",
		handler: async (_args, ctx) => {
			ctx.ui.notify(HELP, "info");
		},
	});
}
