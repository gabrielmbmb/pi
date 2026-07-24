import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderUsageHandler, UsageInfo } from "./types.ts";

// ── Response shapes ─────────────────────────────────────────────────

interface OpenRouterCreditsResponse {
  data: {
    total_credits: number;
    total_usage: number;
  };
}

interface OpenRouterKeyResponse {
  data: {
    label?: string;
    limit?: number | null;
    limit_remaining?: number;
    usage?: number;
    usage_daily?: number;
    usage_weekly?: number;
    usage_monthly?: number;
    is_free_tier?: boolean;
    rate_limit?: { requests?: number; interval?: string };
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

async function fetchCredits(
  apiKey: string,
  signal?: AbortSignal,
): Promise<UsageInfo | null> {
  const resp = await fetch("https://openrouter.ai/api/v1/credits", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });

  if (!resp.ok) return null; // likely needs a management key — fall back

  const json = (await resp.json()) as OpenRouterCreditsResponse;
  const d = json.data;

  return {
    label: "OpenRouter",
    totalCredits: d.total_credits,
    balance: d.total_credits - d.total_usage,
    totalUsage: d.total_usage,
  };
}

async function fetchKey(
  apiKey: string,
  signal?: AbortSignal,
): Promise<UsageInfo> {
  const resp = await fetch("https://openrouter.ai/api/v1/key", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  });

  if (!resp.ok) {
    throw new Error(`OpenRouter API: ${resp.status} ${resp.statusText}`);
  }

  const json = (await resp.json()) as OpenRouterKeyResponse;
  const d = json.data;

  return {
    label: "OpenRouter",
    balance: d.limit_remaining,
    limit: d.limit ?? undefined,
    totalUsage: d.usage,
    weeklyUsage: d.usage_weekly,
    monthlyUsage: d.usage_monthly,
    dailyUsage: d.usage_daily,
  };
}

// ── Handler ─────────────────────────────────────────────────────────

export const openRouterHandler: ProviderUsageHandler = {
  provider: "openrouter",

  async fetchUsage(apiKey: string, signal?: AbortSignal): Promise<UsageInfo> {
    // Prefer /credits for account-level balance; fall back to /key
    const credits = await fetchCredits(apiKey, signal);
    if (credits) return credits;

    return fetchKey(apiKey, signal);
  },

  formatWidget(usage: UsageInfo, ctx: ExtensionContext): string[] {
    const theme = ctx.ui.theme;
    const parts: string[] = [theme.fg("accent", usage.label)];

    // Account-level balance from /credits
    if (typeof usage.totalCredits === "number") {
      const bal = usage.balance ?? usage.totalCredits - (usage.totalUsage ?? 0);
      const used = usage.totalUsage ?? 0;
      parts.push(theme.fg("text", `$${bal.toFixed(2)} balance`));
      parts.push(
        theme.fg("dim", `($${used.toFixed(2)} used of $${usage.totalCredits.toFixed(2)})`),
      );
    }
    // Key-level limit from /key fallback
    else if (typeof usage.limit === "number" && typeof usage.balance === "number") {
      const pct = ((usage.balance / usage.limit) * 100).toFixed(0);
      parts.push(
        theme.fg("text", `$${usage.balance.toFixed(2)}`) +
          " / " +
          theme.fg("muted", `$${usage.limit.toFixed(2)}`) +
          "  " +
          theme.fg("dim", `${pct}%`),
      );
    } else if (typeof usage.balance === "number") {
      parts.push(theme.fg("text", `$${usage.balance.toFixed(2)}`));
      if (typeof usage.totalUsage === "number") {
        parts.push(theme.fg("dim", `($${usage.totalUsage.toFixed(2)} used)`));
      }
    }

    // Weekly usage (only from /key)
    if (typeof usage.weeklyUsage === "number") {
      parts.push(theme.fg("muted", "▾") + theme.fg("dim", `$${usage.weeklyUsage.toFixed(2)}/wk`));
    }

    return [parts.join("  ")];
  },
};
