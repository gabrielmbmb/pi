# Usage Monitor Extension Notes

- The Codex provider reads usage from `https://chatgpt.com/backend-api/wham/usage` in `providers/codex.ts`.
- The response's `plan_type` is a backend/programmatic enum. Keep the raw value in `UsageInfo`, but always use `formatCodexPlanType()` when displaying it.
- Plan-label mappings live in `providers/codex.ts`, especially the `self_serve_business_prolite` → `Business Premium` mapping.
- Rate-limit windows come from `rate_limit.primary_window` and `secondary_window`. Their labels must be derived from `limit_window_seconds` with `formatCodexWindowLabel()`; do not call the primary window `Session`, since it is backend quota usage rather than Pi session usage.
- If Codex plan names or usage fields change, search the upstream [`openai/codex`](https://github.com/openai/codex) repository for `PlanType`, `plan_type`, and `wham/usage`, then update the response types, mappings, and tests here.
- The upstream Codex implementation is a useful reference for plan classification and user-facing names: `codex-rs/protocol/src/account.rs` and `codex-rs/tui/src/status/helpers.rs`.
