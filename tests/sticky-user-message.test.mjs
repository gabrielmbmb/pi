import assert from "node:assert/strict";
import test from "node:test";

import { Container, ScrollView, Text, VStack } from "@earendil-works/pi-tui";
import { getScrollViewBox, renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";

import {
  StickyUserMessageRow,
  TranscriptOffsets,
  flattenMessageText,
  pickStickyMessage,
} from "../extensions/sticky-user-message/index.ts";

const theme = {
  bg: (_color, text) => text,
  fg: (_color, text) => text,
};

// Mirrors the parts of Pi's UserMessageComponent this extension relies on:
// the class name, the private `text` field, and a render override.
class UserMessageComponent extends Container {
  constructor(text, lines = 1) {
    super();
    this.text = text;
    for (let line = 0; line < lines; line++) this.addChild(new Text(text));
  }

  render(width) {
    return super.render(width);
  }
}

function createFixture() {
  const document = new Container();
  const chat = new Container();
  document.addChild(new Text("HEADER"));
  document.addChild(chat);

  const first = new UserMessageComponent("first instruction");
  chat.addChild(first);
  for (let index = 0; index < 12; index++) chat.addChild(new Text(`assistant ${index}`));

  const second = new UserMessageComponent("second instruction");
  chat.addChild(second);
  for (let index = 0; index < 30; index++) chat.addChild(new Text(`later ${index}`));

  const transcript = new ScrollView(document, { follow: "none", primary: true });
  const dock = new VStack([{ component: new Text("EDITOR"), basis: "auto" }]);
  const root = new VStack([
    { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
    { component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
  ]);

  const offsets = new TranscriptOffsets(document, () => {});
  const row = new StickyUserMessageRow(transcript, offsets, () => theme);
  const wrapper = new VStack([
    { component: row, basis: "auto", grow: 0, shrink: 0, minSize: 0 },
    { component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
  ]);
  root.children[0] = wrapper;
  root.entries[0].component = wrapper;

  offsets.install();

  return { document, offsets, root, row, second, transcript, wrapper, first };
}

function render(root) {
  return renderLayoutFrame(root, 40, 10, () => {});
}

test("flattens message text to one line", () => {
  assert.equal(flattenMessageText("  first\n\nsecond\tthird  "), "first second third");
  assert.equal(flattenMessageText("\x1b[31mred\x1b[39m\u0007 text"), "red text");
});

test("picks the last message above the scroll top", () => {
  const messages = [{ top: 2 }, { top: 20 }, { top: 40 }];
  assert.equal(pickStickyMessage(messages, 0), -1);
  assert.equal(pickStickyMessage(messages, 2), -1);
  assert.equal(pickStickyMessage(messages, 3), 0);
  assert.equal(pickStickyMessage(messages, 20), 0);
  assert.equal(pickStickyMessage(messages, 21), 1);
  assert.equal(pickStickyMessage(messages, 100), 2);
});

test("records user message offsets from the document render", () => {
  const { offsets, root } = createFixture();
  render(root);

  assert.equal(offsets.width, 40);
  assert.deepEqual(
    offsets.messages.map((message) => message.component.text),
    ["first instruction", "second instruction"],
  );
  assert.ok(offsets.messages[0].top < offsets.messages[1].top);
});

test("pins the message that owns the top of the viewport", () => {
  const { first, offsets, root, second, transcript } = createFixture();

  render(root);
  render(root);
  assert.ok(!render(root).lines[0].includes("first instruction"));

  transcript.scrollTo(offsets.messages[0].top + 1);
  let frame = render(root);
  assert.match(frame.lines[0], /first instruction/);
  assert.equal(getScrollViewBox(frame, transcript)?.rect.y, 1);

  transcript.scrollTo(offsets.messages[1].top + 1);
  frame = render(root);
  assert.match(frame.lines[0], /second instruction/);

  transcript.scrollTo(0);
  frame = render(root);
  assert.ok(!frame.lines[0].includes("instruction"));
  assert.equal(getScrollViewBox(frame, transcript)?.rect.y, 0);

  assert.equal(first.text, "first instruction");
  assert.equal(second.text, "second instruction");
});

test("sticky row disappears when disabled", () => {
  const { offsets, root, row, transcript } = createFixture();
  render(root);
  transcript.scrollTo(offsets.messages[0].top + 1);
  render(root);
  assert.match(render(root).lines[0], /first instruction/);

  row.enabled = false;
  assert.ok(!render(root).lines[0].includes("first instruction"));
});

test("restores the document render method on dispose", () => {
  const { document, offsets, root } = createFixture();
  const patched = document.render;
  assert.notEqual(patched, Container.prototype.render);

  offsets.dispose();
  assert.equal(document.render, Container.prototype.render);

  // Rendering still works after restoring the original implementation.
  assert.ok(render(root).lines.length > 0);
});
