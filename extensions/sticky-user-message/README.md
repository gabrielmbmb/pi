# Sticky user message

Pins the user message that owns the top of the transcript, so the instruction you are reading under stays visible after its block scrolls out of the viewport.

The pinned row is **not** always the newest user message. It is the last rendered user message whose first visible line is above the top of the viewport. With this transcript:

```text
user message 1
assistant
assistant
user message 2   <- still below the viewport
assistant
```

`user message 1` is pinned. Once `user message 2` reaches the top edge, the row switches to it. Scrolling back above a message removes it from the row.

The row shows a one-line, ellipsized preview with a `↑` marker. Wheel scrolling over the row scrolls the transcript.

## Commands

| Command | Description |
| --- | --- |
| `/sticky` | Toggle the pinned row on or off |

## Limitations

- Fullscreen TUI only. In regular mode the terminal owns scrollback, so Pi cannot observe the viewport position.
- Uses fullscreen layout internals (the root `VStack` and `ScrollView` child) because the extension API does not expose the transcript viewport. If those internals change, the extension silently disables itself.
- The preview comes from `UserMessageComponent`'s private `text` field. If that changes, the row shows `(no text)` instead.
