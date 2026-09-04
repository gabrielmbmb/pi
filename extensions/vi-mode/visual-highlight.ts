import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	type EditorComponent,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

type Position = { line: number; col: number };
type VisualMode = "visual" | "visual-line";
type LayoutLine = { text: string; hasCursor: boolean; cursorPos?: number };
type MappedLayoutLine = LayoutLine & {
	absoluteStart: number;
	absoluteEnd: number;
	logicalLine: number;
	isLastChunk: boolean;
};

type VisualEditor = EditorComponent & {
	focused?: boolean;
	getCursor(): Position;
	getLines(): string[];
	getMode(): string;
	getPaddingX?(): number;
};

type VisualEditorInternals = {
	layoutText?: (contentWidth: number) => LayoutLine[];
	paddingX?: number;
	scrollOffset?: number;
	visualAnchor?: Position | null;
};

const DECORATED = Symbol("vi-mode-visual-highlight");
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.max(minimum, Math.min(maximum, value));
}

function lineOffsets(lines: readonly string[]): number[] {
	const offsets: number[] = [];
	let offset = 0;
	for (const line of lines) {
		offsets.push(offset);
		offset += line.length + 1;
	}
	return offsets;
}

function clampPosition(lines: readonly string[], position: Position): Position {
	const line = clamp(position.line, 0, Math.max(0, lines.length - 1));
	return { line, col: clamp(position.col, 0, (lines[line] ?? "").length) };
}

function positionToOffset(lines: readonly string[], offsets: readonly number[], position: Position): number {
	const bounded = clampPosition(lines, position);
	return (offsets[bounded.line] ?? 0) + bounded.col;
}

function inclusiveGraphemeEnd(line: string, column: number): number {
	if (column >= line.length) return line.length;
	for (const segment of graphemeSegmenter.segment(line)) {
		const end = segment.index + segment.segment.length;
		if (column < end) return end;
	}
	return line.length;
}

function getSelection(
	lines: readonly string[],
	anchor: Position,
	cursor: Position,
	mode: VisualMode,
): { start: number; end: number; startLine: number; endLine: number } {
	const offsets = lineOffsets(lines);
	const boundedAnchor = clampPosition(lines, anchor);
	const boundedCursor = clampPosition(lines, cursor);
	const startLine = Math.min(boundedAnchor.line, boundedCursor.line);
	const endLine = Math.max(boundedAnchor.line, boundedCursor.line);

	if (mode === "visual-line") {
		const start = offsets[startLine] ?? 0;
		const end = endLine < lines.length - 1
			? offsets[endLine + 1] ?? start
			: (offsets[endLine] ?? 0) + (lines[endLine] ?? "").length;
		return { start, end, startLine, endLine };
	}

	const anchorOffset = positionToOffset(lines, offsets, boundedAnchor);
	const cursorOffset = positionToOffset(lines, offsets, boundedCursor);
	const earlier = anchorOffset <= cursorOffset ? boundedAnchor : boundedCursor;
	const later = anchorOffset <= cursorOffset ? boundedCursor : boundedAnchor;
	const start = positionToOffset(lines, offsets, earlier);
	const end = (offsets[later.line] ?? 0) + inclusiveGraphemeEnd(lines[later.line] ?? "", later.col);
	return { start, end, startLine, endLine };
}

function mapLayoutLines(layout: readonly LayoutLine[], lines: readonly string[]): MappedLayoutLine[] {
	const offsets = lineOffsets(lines);
	let logicalLine = 0;
	let logicalColumn = 0;
	const mapped: MappedLayoutLine[] = [];

	for (const layoutLine of layout) {
		const sourceLine = lines[logicalLine] ?? "";
		const absoluteStart = (offsets[logicalLine] ?? 0) + logicalColumn;
		const absoluteEnd = absoluteStart + layoutLine.text.length;
		logicalColumn += layoutLine.text.length;
		const isLastChunk = logicalColumn >= sourceLine.length;
		mapped.push({ ...layoutLine, absoluteStart, absoluteEnd, logicalLine, isLastChunk });

		if (!isLastChunk) continue;
		logicalLine = Math.min(logicalLine + 1, Math.max(0, lines.length - 1));
		logicalColumn = 0;
	}

	return mapped;
}

function renderCursor(text: string, focused: boolean, hardwareCursor: boolean): string {
	const marker = focused ? CURSOR_MARKER : "";
	if (hardwareCursor) return marker + text;
	return `${marker}\x1b[7m${text}\x1b[27m`;
}

function renderSelectedLine(
	line: MappedLayoutLine,
	selection: ReturnType<typeof getSelection>,
	mode: VisualMode,
	contentWidth: number,
	paddingX: number,
	focused: boolean,
	hardwareCursor: boolean,
	select: (text: string) => string,
): string {
	let displayText = "";
	let cursorRendered = false;
	const linewise = mode === "visual-line" &&
		line.logicalLine >= selection.startLine && line.logicalLine <= selection.endLine;

	for (const segment of graphemeSegmenter.segment(line.text)) {
		const segmentStart = line.absoluteStart + segment.index;
		const segmentEnd = segmentStart + segment.segment.length;
		const selected = linewise || (segmentStart < selection.end && segmentEnd > selection.start);
		const isCursor = line.hasCursor && line.cursorPos !== undefined &&
			segment.index <= line.cursorPos && line.cursorPos < segment.index + segment.segment.length;
		let rendered = selected ? select(segment.segment) : segment.segment;
		if (isCursor) {
			rendered = renderCursor(rendered, focused, hardwareCursor);
			cursorRendered = true;
		}
		displayText += rendered;
	}

	let lineWidth = visibleWidth(line.text);
	if (line.hasCursor && !cursorRendered && line.cursorPos !== undefined && line.cursorPos >= line.text.length) {
		const cursorCellSelected = linewise ||
			(line.isLastChunk && line.absoluteEnd >= selection.start && line.absoluteEnd < selection.end);
		const cursorCell = cursorCellSelected ? select(" ") : " ";
		displayText += renderCursor(cursorCell, focused, hardwareCursor);
		lineWidth++;
	}

	let remaining = Math.max(0, contentWidth - lineWidth);
	if (linewise && remaining > 0) {
		displayText += select(" ".repeat(remaining));
		remaining = 0;
	} else if (
		mode === "visual" &&
		line.isLastChunk &&
		line.absoluteEnd >= selection.start &&
		line.absoluteEnd < selection.end &&
		remaining > 0
	) {
		displayText += select(" ");
		remaining--;
	}

	const leftPadding = " ".repeat(paddingX);
	let rightPadding = leftPadding;
	if (lineWidth > contentWidth && paddingX > 0) rightPadding = rightPadding.slice(1);
	return `${leftPadding}${displayText}${" ".repeat(remaining)}${rightPadding}`;
}

/** Add visible selection highlighting to pi-vim without replacing its editor instance. */
export function addVisualSelectionHighlight(
	component: EditorComponent,
	tui: TUI,
	theme: Theme,
): EditorComponent {
	const candidate = component as Partial<VisualEditor>;
	if (
		typeof candidate.getMode !== "function" ||
		typeof candidate.getLines !== "function" ||
		typeof candidate.getCursor !== "function"
	) return component;
	const editor = candidate as VisualEditor;
	const internals = editor as unknown as VisualEditorInternals & { [DECORATED]?: boolean };
	if (internals[DECORATED]) return editor;
	internals[DECORATED] = true;

	const originalRender = editor.render.bind(editor);
	editor.render = (width: number): string[] => {
		const rendered = originalRender(width);
		const mode = editor.getMode();
		if (mode !== "visual" && mode !== "visual-line") return rendered;

		const anchor = internals.visualAnchor;
		const lines = editor.getLines();
		if (!anchor || lines.length === 0 || !internals.layoutText) return rendered;

		const paddingX = Math.min(
			editor.getPaddingX?.() ?? internals.paddingX ?? 0,
			Math.max(0, Math.floor((width - 1) / 2)),
		);
		const contentWidth = Math.max(1, width - paddingX * 2);
		const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));
		const layout = mapLayoutLines(internals.layoutText(layoutWidth), lines);
		const scrollOffset = clamp(internals.scrollOffset ?? 0, 0, Math.max(0, layout.length - 1));
		const visibleCount = Math.min(
			layout.length - scrollOffset,
			Math.max(5, Math.floor(tui.terminal.rows * 0.3)),
		);
		const selection = getSelection(lines, anchor, editor.getCursor(), mode);
		const select = (text: string) => theme.bg("selectedBg", theme.fg("searchMatchText", text));
		const hardwareCursor = tui.getShowHardwareCursor();

		for (let index = 0; index < visibleCount; index++) {
			const line = layout[scrollOffset + index];
			if (!line || rendered[index + 1] === undefined) continue;
			rendered[index + 1] = truncateToWidth(
				renderSelectedLine(
					line,
					selection,
					mode,
					contentWidth,
					paddingX,
					editor.focused ?? false,
					hardwareCursor,
					select,
				),
				width,
				"",
			);
		}

		return rendered;
	};

	return editor;
}
