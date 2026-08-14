import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * A single quota window (e.g. rolling 5-hour, weekly, monthly).
 */
export interface UsageWindow {
  /** Short window label (e.g. "5h", "wk", "mo") */
  label: string;
  /** Usage percentage within this window (0-100; may exceed 100 on overage) */
  percent: number;
  /** Unix timestamp (ms) when the window resets */
  resetsAt?: number;
  /** Raw status string from the provider API, if any */
  status?: string;
}

/**
 * Normalized usage/balance info returned by a provider handler's fetch.
 * Each provider fills what it can; formatWidget decides what to display.
 */
export interface UsageInfo {
  /** Display label (e.g. "OpenRouter") */
  label: string;
  /** Remaining balance (USD) — credits left / limit_remaining */
  balance?: number;
  /** Total purchased credits (USD) — from /credits endpoint */
  totalCredits?: number;
  /** Spending limit if one is set on the key (USD) */
  limit?: number;
  /** Total usage ever (USD) */
  totalUsage?: number;
  /** Usage this week (USD) */
  weeklyUsage?: number;
  /** Usage this month (USD) */
  monthlyUsage?: number;
  /** Usage today (USD) */
  dailyUsage?: number;
  /** Plan / subscription tier (e.g. "plus", "pro") */
  planType?: string;
  /** Usage percentage within the current quota window (0-100) */
  usagePercent?: number;
  /** Unix timestamp (ms) when the quota window resets */
  resetsAt?: number;
  /** Number of available rate-limit reset credits (Codex extra credits) */
  extraCredits?: number;
  /** Whether a rate / spend / credit limit has been reached */
  limitReached?: boolean;
  /** Per-window quota breakdown for providers with multiple windows */
  windows?: UsageWindow[];
}

export interface ProviderUsageHandler {
  /** Provider id matching ctx.model.provider (e.g. "openrouter") */
  provider: string;
  /** Fetch the current usage info from the provider API */
  fetchUsage(apiKey: string, signal?: AbortSignal): Promise<UsageInfo>;
  /** Resolve an API key when pi auth has none (e.g. from a tool's own auth file) */
  resolveApiKey?(ctx: ExtensionContext): Promise<string | undefined>;
  /** Render usage info into lines for ctx.ui.setWidget */
  formatWidget(usage: UsageInfo, ctx: ExtensionContext): string[];
}
