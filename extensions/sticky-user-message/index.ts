/**
 * Sticky User Message
 *
 * Pins the user message that owns the top of the fullscreen transcript, so the
 * instruction you are currently reading under stays visible after its block
 * scrolls out of the viewport.
 *
 * The pinned message is the last rendered user message whose first visible line
 * is above the transcript's top edge. If no user message is above that edge,
 * the row disappears. This is deliberately not "the last user message": when
 * you have not scrolled to the newest instruction yet, the previous one stays
 * pinned.
 *
 * Fullscreen only. Regular mode leaves scrolling to the terminal, so Pi cannot
 * observe the viewport there.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import {
  Container,
  ScrollView,
  VStack,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Theme,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

const WIDGET_KEY = "sticky-user-message";
const COMMAND_NAME = "sticky";
const STICKY_PREFIX = "↑ ";

interface RecordedUserMessage {
  component: Component;
  /** Line offset of the message's first non-empty rendered line. */
  top: number;
}

interface StackEntryLike {
  component: Component;
  [key: string]: unknown;
}

interface LayoutRootLike extends VStack {
  children: Component[];
  entries: StackEntryLike[];
}

/** Collapse a user message to a single safe, readable line. */
export function flattenMessageText(text: string): string {
  return stripTerminalSequences(text)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Index of the last message whose first line is above `scrollTop`, or -1 when
 * no message has scrolled past the top edge yet.
 */
export function pickStickyMessage(
  messages: readonly { top: number }[],
  scrollTop: number,
): number {
  let index = -1;
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    if (messages[messageIndex].top < scrollTop) index = messageIndex;
  }
  return index;
}

function isUserMessageComponent(component: Component): boolean {
  return (
    component instanceof UserMessageComponent ||
    component.constructor?.name === "UserMessageComponent"
  );
}

/**
 * A container whose effective render is Container.render can be walked
 * recursively without changing its output. Subclasses that override render
 * (UserMessageComponent, Box, Markdown, ...) must render themselves.
 */
function isPlainContainer(component: Component): component is Container {
  return (
    Array.isArray((component as { children?: unknown }).children) &&
    (component.render === Container.prototype.render ||
      component.constructor?.name === "Container")
  );
}

function userMessageText(component: Component): string | undefined {
  // UserMessageComponent keeps its source text in a private field. It is the
  // only way to get the message content without re-rendering the component,
  // and the field name has been stable.
  const text = (component as { text?: unknown }).text;
  return typeof text === "string" ? text : undefined;
}

function firstContentLine(lines: readonly string[]): number {
  for (let index = 0; index < lines.length; index++) {
    if (stripTerminalSequences(lines[index]).trim().length > 0) return index;
  }
  return 0;
}

/**
 * Measures user message offsets while the transcript document renders, instead
 * of rendering the whole chat a second time. Offsets are in document content
 * lines, the same coordinate space as ScrollView.scrollTop.
 */
export class TranscriptOffsets {
  width = -1;
  messages: RecordedUserMessage[] = [];
  private readonly document: Container;
  private readonly onChange: () => void;
  private installed = false;
  private readonly hadOwnRender: boolean;
  private readonly previousRender: Component["render"];
  private lastMeasured: { component: Component; top: number }[] = [];
  private patchedRender: Component["render"] | undefined;

  constructor(document: Container, onChange: () => void) {
    this.document = document;
    this.onChange = onChange;
    this.hadOwnRender = Object.prototype.hasOwnProperty.call(document, "render");
    this.previousRender = document.render;
  }

  install(): void {
    if (this.installed) return;
    this.installed = true;
    this.patchedRender = (width: number) => this.renderDocument(width);
    this.document.render = this.patchedRender;
  }

  dispose(): void {
    if (!this.installed) return;
    this.installed = false;
    if (this.patchedRender && this.document.render !== this.patchedRender) return;
    if (this.hadOwnRender) this.document.render = this.previousRender;
    else delete (this.document as { render?: Component["render"] }).render;
  }

  /** Rebuild offsets at a width the transcript has not rendered at yet. */
  measure(width: number): void {
    this.document.render(Math.max(1, width));
  }

  private renderDocument(width: number): string[] {
    const messages: RecordedUserMessage[] = [];
    const safeWidth = Math.max(1, width);
    const lines = this.renderContainer(this.document, safeWidth, 0, messages);

    this.width = safeWidth;
    this.messages = messages;

    const changed =
      messages.length !== this.lastMeasured.length ||
      messages.some(
        (message, index) =>
          message.component !== this.lastMeasured[index]?.component ||
          message.top !== this.lastMeasured[index]?.top,
      );
    this.lastMeasured = messages.map(({ component, top }) => ({ component, top }));
    if (changed) this.onChange();

    return lines;
  }

  private renderContainer(
    container: Container,
    width: number,
    base: number,
    messages: RecordedUserMessage[],
  ): string[] {
    const lines: string[] = [];
    let y = base;

    for (const child of container.children) {
      const childLines = isPlainContainer(child)
        ? this.renderContainer(child, width, y, messages)
        : child.render(width);

      if (isUserMessageComponent(child))
        messages.push({ component: child, top: y + firstContentLine(childLines) });

      lines.push(...childLines);
      y += childLines.length;
    }

    return lines;
  }
}

export class StickyUserMessageRow implements Component {
  enabled = true;
  private readonly transcript: ScrollView;
  private readonly offsets: TranscriptOffsets;
  private readonly getTheme: () => Theme;
  private cachedComponent: Component | undefined;
  private cachedWidth = -1;
  private cachedLine: string | undefined;

  constructor(
    transcript: ScrollView,
    offsets: TranscriptOffsets,
    getTheme: () => Theme,
  ) {
    this.transcript = transcript;
    this.offsets = offsets;
    this.getTheme = getTheme;
  }

  render(width: number): string[] {
    if (!this.enabled) return [];

    const contentWidth = this.transcript.getContentWidth(width);
    if (this.offsets.width !== contentWidth) this.offsets.measure(contentWidth);

    const index = pickStickyMessage(this.offsets.messages, this.transcript.scrollTop);
    if (index < 0) return [];

    const component = this.offsets.messages[index].component;
    if (component === this.cachedComponent && width === this.cachedWidth) {
      return this.cachedLine === undefined ? [] : [this.cachedLine];
    }

    const text = userMessageText(component);
    const body = flattenMessageText(text ?? "") || "(no text)";
    const theme = this.getTheme();

    const prefix = theme.fg("muted", STICKY_PREFIX);
    const available = Math.max(0, width - visibleWidth(STICKY_PREFIX));
    const truncated = truncateToWidth(body, available, "…");

    let line = prefix + theme.fg("userMessageText", truncated);
    const padding = width - visibleWidth(line);
    if (padding > 0) line += " ".repeat(padding);

    this.cachedComponent = component;
    this.cachedWidth = width;
    this.cachedLine = theme.bg("userMessageBg", line);
    return [this.cachedLine];
  }

  invalidate(): void {
    this.cachedComponent = undefined;
    this.cachedWidth = -1;
    this.cachedLine = undefined;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "wheel" || !event.wheelDelta) return undefined;
    this.transcript.scrollBy(event.wheelDelta);
    return { handled: true };
  }
}

interface StickyInstance {
  readonly enabled: boolean;
  toggle(): void;
  dispose(): void;
}

const EMPTY_WIDGET: Component = {
  render: () => [],
  invalidate: () => {},
};

function asLayoutRoot(value: unknown): LayoutRootLike | undefined {
  if (!value || typeof value !== "object") return undefined;
  const root = value as Partial<LayoutRootLike>;
  if (!Array.isArray(root.children) || !Array.isArray(root.entries)) return undefined;
  if (typeof root.render !== "function" || typeof root.invalidate !== "function")
    return undefined;
  return value as LayoutRootLike;
}

function asTranscript(value: unknown): ScrollView | undefined {
  if (!(value instanceof ScrollView)) return undefined;
  return value;
}

function install(ctx: ExtensionContext): StickyInstance | undefined {
  let tui: TUI | undefined;
  ctx.ui.setWidget(WIDGET_KEY, (value) => {
    tui = value;
    return EMPTY_WIDGET;
  });

  let installed = false;
  try {
    if (!tui || tui.mode !== "fullscreen") return undefined;

    // In fullscreen, Pi mounts a VStack of [transcript ScrollView, input dock]
    // as the layout root. We wrap the transcript so the sticky row sits above
    // the scroll viewport instead of covering transcript content.
    const root = asLayoutRoot((tui as unknown as { layoutRoot?: unknown }).layoutRoot);
    if (!root) return undefined;

    const transcriptEntry = root.entries.find((entry) =>
      asTranscript(entry.component),
    );
    const transcript = asTranscript(transcriptEntry?.component);
    if (!transcriptEntry || !transcript) return undefined;

    // ScrollView keeps its child in a private field; the document container is
    // where user messages live.
    const document = (transcript as unknown as { child?: unknown }).child;
    if (!(document instanceof Container)) return undefined;

    const requestRender = () => {
      const callback = (
        transcript as unknown as { requestRenderCallback?: () => void }
      ).requestRenderCallback;
      if (typeof callback === "function") callback();
      else tui?.requestRender();
    };

    const offsets = new TranscriptOffsets(document, () => requestRender());
    const row = new StickyUserMessageRow(transcript, offsets, () => ctx.ui.theme);

    const wrapper = new VStack([
      { component: row, basis: "auto", grow: 0, shrink: 0, minSize: 0 },
      { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    ]);

    const transcriptIndex = root.children.indexOf(transcript);
    if (transcriptIndex < 0) return undefined;

    const restoreLayout = () => {
      if (transcriptEntry.component !== wrapper) return;
      transcriptEntry.component = transcript;
      const wrapperIndex = root.children.indexOf(wrapper);
      if (wrapperIndex >= 0) root.children[wrapperIndex] = transcript;
    };

    try {
      offsets.install();
      root.children[transcriptIndex] = wrapper;
      transcriptEntry.component = wrapper;
      root.invalidate();
      requestRender();
      installed = true;
    } catch (error) {
      restoreLayout();
      offsets.dispose();
      throw error;
    }

    return {
      get enabled() {
        return row.enabled;
      },
      toggle() {
        row.enabled = !row.enabled;
        requestRender();
      },
      dispose() {
        offsets.dispose();
        if (transcriptEntry.component === wrapper) {
          restoreLayout();
          root.invalidate();
          requestRender();
        }
        try {
          ctx.ui.setWidget(WIDGET_KEY, undefined);
        } catch {
          // The UI may already be torn down during session shutdown.
        }
      },
    };
  } finally {
    if (!installed) {
      try {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
      } catch {
        // Ignore teardown races.
      }
    }
  }
}

export default function stickyUserMessageExtension(pi: ExtensionAPI) {
  let instance: StickyInstance | undefined;

  pi.on("session_start", (_event, ctx) => {
    instance?.dispose();
    instance = undefined;
    if (ctx.mode !== "tui") return;
    instance = install(ctx);
  });

  pi.on("session_shutdown", () => {
    instance?.dispose();
    instance = undefined;
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Toggle the sticky user message row",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return;
      if (!instance) {
        ctx.ui.notify(
          "Sticky user message is only available in fullscreen TUI mode",
          "warning",
        );
        return;
      }
      instance.toggle();
      ctx.ui.notify(
        instance.enabled ? "Sticky user message enabled" : "Sticky user message disabled",
        "info",
      );
    },
  });
}
