# Usage Monitor Extension Notes

- The Codex provider reads usage from `https://chatgpt.com/backend-api/wham/usage` in `providers/codex.ts`.
- The response's `plan_type` is a backend/programmatic enum. Keep the raw value in `UsageInfo`, but always use `formatCodexPlanType()` when displaying it.
- Plan-label mappings live in `providers/codex.ts`, especially the `self_serve_business_prolite` → `Business Premium` mapping.
- Rate-limit windows come from `rate_limit.primary_window` and `secondary_window`. Their labels must be derived from `limit_window_seconds` with `formatCodexWindowLabel()`; do not call the primary window `Session`, since it is backend quota usage rather than Pi session usage.
- If Codex plan names or usage fields change, search the upstream [`openai/codex`](https://github.com/openai/codex) repository for `PlanType`, `plan_type`, and `wham/usage`, then update the response types, mappings, and tests here.
- The upstream Codex implementation is a useful reference for plan classification and user-facing names: `codex-rs/protocol/src/account.rs` and `codex-rs/tui/src/status/helpers.rs`.

## Claude Code provider

- The Claude Code provider (`providers/claude-code.ts`) covers the `claude-code` provider registered by [`earendil-works/pi-claude-code`](https://github.com/earendil-works/pi-claude-code).
- Pi only exposes a placeholder key for that provider, so the handler sets `skipPiAuth` and reads Claude Code's own OAuth credentials. On macOS those live in the `Claude Code-credentials` keychain item; elsewhere they live in `<config dir>/.credentials.json`.
- `CLAUDE_CODE_OAUTH_TOKEN` takes precedence when it is set.
- The config directory comes from `PI_CLAUDE_CODE_CONFIG_DIR` or `CLAUDE_CONFIG_DIR`, resolved through the provider's auth result so Pi's provider-scoped settings apply.
- Usage comes from `https://api.anthropic.com/api/oauth/usage` with the `oauth-2025-04-20` beta header. Prefer the `limits` array (which includes scoped weekly allowances) and fall back to `five_hour` / `seven_day` / `seven_day_opus` / `seven_day_sonnet` for older responses.
- `extra_usage` amounts are minor units scaled by `decimal_places`; only show the credit line when `is_enabled` is true.
