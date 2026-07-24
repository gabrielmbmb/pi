import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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
}

export interface ProviderUsageHandler {
  /** Provider id matching ctx.model.provider (e.g. "openrouter") */
  provider: string;
  /** Fetch the current usage info from the provider API */
  fetchUsage(apiKey: string, signal?: AbortSignal): Promise<UsageInfo>;
  /** Render usage info into lines for ctx.ui.setWidget */
  formatWidget(usage: UsageInfo, ctx: ExtensionContext): string[];
}
