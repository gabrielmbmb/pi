import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderUsageHandler, UsageInfo } from "./types.ts";

// ── Response shapes ─────────────────────────────────────────────────

interface WhamWindow {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_after_seconds?: number;
  reset_at?: number; // unix seconds
}

interface WhamRateLimit {
  allowed?: boolean;
  limit_reached?: boolean;
  primary_window?: WhamWindow;
  secondary_window?: WhamWindow;
}

interface WhamCredits {
  has_credits?: boolean;
  unlimited?: boolean;
  balance?: string | number;
  overage_limit_reached?: boolean;
}

interface WhamResetCredits {
  available_count?: number;
}

interface WhamSpendControl {
  reached?: boolean;
  individual_limit?: number;
}

interface WhamUsageResponse {
  plan_type?: string;
  rate_limit?: WhamRateLimit | null;
  credits?: WhamCredits | null;
  rate_limit_reset_credits?: WhamResetCredits | null;
  spend_control?: WhamSpendControl | null;
}

// ── JWT helpers ─────────────────────────────────────────────────────

const JWT_CLAIM_PATH = "https://api.openai.com/auth";

function extractAccountId(token: string): string | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    return payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
  } catch {
    return undefined;
  }
}

// ── Reset credit types ──────────────────────────────────────────────

export interface ResetCredit {
  id: string;
  title: string;
  description: string;
  status: string;
  grantedAt: string;
  expiresAt?: string;
}

interface WhamResetCreditsDetails {
  available_count: number;
  credits: Array<{
    id: string;
    reset_type: string;
    status: string;
    granted_at: string;
    expires_at?: string;
    title: string;
    description: string;
  }>;
}

// ── Helpers ─────────────────────────────────────────────────────────

function codexHeaders(token: string): Record<string, string> {
  const accountId = extractAccountId(token);
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (accountId) headers["chatgpt-account-id"] = accountId;
  return headers;
}

async function fetchWhamUsage(
  token: string,
  signal?: AbortSignal,
): Promise<WhamUsageResponse | null> {
  const resp = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers: codexHeaders(token),
    signal,
  });

  if (resp.status === 401) return null; // expired token
  if (!resp.ok) {
    throw new Error(`Codex API: ${resp.status} ${resp.statusText}`);
  }

  try {
    return (await resp.json()) as WhamUsageResponse;
  } catch {
    return null;
  }
}

function mapWhamToUsage(wham: WhamUsageResponse): UsageInfo {
  const primary = wham.rate_limit?.primary_window;
  const credits = wham.credits;
  const resetCredits = wham.rate_limit_reset_credits;
  const spend = wham.spend_control;

  // Determine if any limit has been reached
  const rateReached = wham.rate_limit?.limit_reached;
  const overageReached = credits?.overage_limit_reached;
  const spendReached = spend?.reached;
  const limitReached =
    rateReached != null || overageReached != null || spendReached != null
      ? (rateReached ?? false) || (overageReached ?? false) || (spendReached ?? false)
      : undefined;

  return {
    label: "Codex",
    planType: wham.plan_type,
    usagePercent: primary?.used_percent,
    resetsAt: primary?.reset_at ? primary.reset_at * 1000 : undefined,
    extraCredits: resetCredits?.available_count,
    balance: credits?.balance != null ? Number(credits.balance) : undefined,
    limitReached,
  };
}

// ── Reset credit operations ─────────────────────────────────────────

const WHAM_BASE = "https://chatgpt.com/backend-api/wham";

/** Fetch detailed reset credit info including IDs, titles, and expiry. */
export async function fetchResetCreditDetails(
  token: string,
  signal?: AbortSignal,
): Promise<ResetCredit[]> {
  const resp = await fetch(`${WHAM_BASE}/rate-limit-reset-credits`, {
    headers: codexHeaders(token),
    signal,
  });

  if (resp.status === 401) throw new Error("Codex token expired");
  if (!resp.ok) throw new Error(`Codex API: ${resp.status} ${resp.statusText}`);

  const json = (await resp.json()) as WhamResetCreditsDetails;

  return json.credits
    .filter((c) => c.status === "available")
    .map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description,
      status: c.status,
      grantedAt: c.granted_at,
      expiresAt: c.expires_at,
    }));
}

/** Consume one reset credit. Returns the outcome from the backend. */
export async function consumeResetCredit(
  token: string,
  creditId: string,
  signal?: AbortSignal,
): Promise<string> {
  const resp = await fetch(`${WHAM_BASE}/rate-limit-reset-credits/consume`, {
    method: "POST",
    headers: {
      ...codexHeaders(token),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      credit_id: creditId,
      redeem_request_id: crypto.randomUUID(),
    }),
    signal,
  });

  if (resp.status === 401) throw new Error("Codex token expired");
  if (!resp.ok) throw new Error(`Codex API: ${resp.status} ${resp.statusText}`);

  return "Credit applied! Both rate-limit windows reset.";
}

// ── Handler ─────────────────────────────────────────────────────────

export const codexHandler: ProviderUsageHandler = {
  provider: "openai-codex",

  async fetchUsage(apiKey: string, signal?: AbortSignal): Promise<UsageInfo> {
    const wham = await fetchWhamUsage(apiKey, signal);
    if (!wham) throw new Error("Codex: unable to fetch usage (token may be expired)");
    return mapWhamToUsage(wham);
  },

  formatWidget(usage: UsageInfo, ctx: ExtensionContext): string[] {
    const theme = ctx.ui.theme;
    const parts: string[] = [theme.fg("accent", "Codex")];

    // Plan tier
    if (usage.planType) {
      parts.push(theme.fg("text", `Plan: ${usage.planType}`));
    }

    // Usage percentage + reset time
    if (typeof usage.usagePercent === "number") {
      const pct = usage.usagePercent.toFixed(0);
      const color = usage.usagePercent > 90 ? "warning" : "text";
      parts.push(theme.fg(color, `${pct}% used`));

      if (usage.resetsAt) {
        const mins = Math.max(0, Math.round((usage.resetsAt - Date.now()) / 60000));
        if (mins > 0) {
          const hr = Math.floor(mins / 60);
          const min = mins % 60;
          const when = hr > 0 ? `${hr}h ${min}m` : `${min}m`;
          parts.push(theme.fg("dim", `resets in ${when}`));
        }
      }
    }

    // Extra credits
    if (typeof usage.extraCredits === "number" && usage.extraCredits > 0) {
      parts.push(theme.fg("muted", "✦") + theme.fg("dim", `${usage.extraCredits} reset credit${usage.extraCredits !== 1 ? "s" : ""}`));
    }

    // Limit reached indicator
    if (usage.limitReached) {
      parts.push(theme.fg("warning", "● limit reached"));
    }

    return [parts.join("  ")];
  },
};
