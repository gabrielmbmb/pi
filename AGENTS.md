# Repository Guidelines

This repository contains shared Pi extensions, skills, prompts, and themes. Follow Pi's conventional resource directories (`extensions/`, `skills/`, `prompts/`, and `themes/`).

## Package Management

Use pnpm for all Node.js package management. If a Node.js project needs to be initialized, use `pnpm init`. Use `pnpm add`, `pnpm install`, and `pnpm run` instead of npm, Yarn, or Bun equivalents.

## Code Style

Prefer omitting curly braces when an `if` condition contains only one statement:

```typescript
if (typeof branch !== "string") return;
```

## Extension Documentation

When adding, removing, or renaming an extension, update the Extensions table in `README.md` in the same change.
