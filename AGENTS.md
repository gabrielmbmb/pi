# Repository Guidelines

This repository is a pnpm workspace of independently installable Pi packages. Put each extension in `packages/<name>/` with its own `package.json`, Pi manifest, README, source, and tests. Within a package, follow Pi's conventional resource directories (`extensions/`, `skills/`, `prompts/`, and `themes/`).

## Package Management

Use pnpm for all Node.js package management. If a Node.js project needs to be initialized, use `pnpm init`. Use `pnpm add`, `pnpm install`, and `pnpm run` instead of npm, Yarn, or Bun equivalents.

## Code Style

Prefer omitting curly braces when an `if` condition contains only one statement:

```typescript
if (typeof branch !== "string") return;
```

## Extension Documentation

When adding, removing, or renaming an extension package, update the Packages table in the root `README.md` and the package's own README in the same change.
