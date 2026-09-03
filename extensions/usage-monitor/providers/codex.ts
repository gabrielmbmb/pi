import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderUsageHandler, UsageInfo, UsageWindow } from "./types.ts";

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
  primary_window?: WhamWindow | null;
  secondary_window?: WhamWindow | null;
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

const CODEX_PLAN_LABELS: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  prolite: "Pro Lite",
  team: "Business",
  self_serve_business_prolite: "Business Premium",
  self_serve_business_usage_based: "Business",
  business: "Business",
  ent26: "Enterprise",
  enterprise_cbp_automation: "Enterprise (Automation)",
  enterprise_cbp_usage_based: "Enterprise",
  enterprise: "Enterprise",
  edu: "Edu",
  education: "Edu",
  edu_plus: "Edu Plus",
  edu_pro: "Edu Pro",
};

/** Convert Codex's backend plan enum into the label users should see. */
export function formatCodexPlanType(planType: string): string {
  const normalized = planType.trim().toLowerCase();
  const knownLabel = CODEX_PLAN_LABELS[normalized];
  if (typeof knownLabel === "string") return knownLabel;

  // Keep newly introduced backend values readable until they are added above.
  return normalized
    .split("_")
    .map((word) => word ? word[0].toUpperCase() + word.slice(1) : word)
    .join(" ");
}

function isApproximately(value: number, target: number): boolean {
  return Math.abs(value - target) <= target * 0.05;
}

/** Format the server-provided rate-limit duration instead of calling it a session. */
export function formatCodexWindowLabel(
  limitWindowSeconds: number | undefined,
  fallback: string,
): string {
  if (
    typeof limitWindowSeconds !== "number" ||
    !Number.isFinite(limitWindowSeconds) ||
    limitWindowSeconds <= 0
  )
    return fallback;

  const seconds = Math.round(limitWindowSeconds);
  if (isApproximately(seconds, 5 * 60 * 60)) return "5h";
  if (isApproximately(seconds, 24 * 60 * 60)) return "Daily";
  if (isApproximately(seconds, 7 * 24 * 60 * 60)) return "Weekly";
  if (isApproximately(seconds, 30 * 24 * 60 * 60)) return "Monthly";
  if (isApproximately(seconds, 365 * 24 * 60 * 60)) return "Annual";

  if (seconds >= 60 * 60 && seconds % (60 * 60) === 0)
    return `${seconds / (60 * 60)}h`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
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

function toUsageWindow(
  label: string,
  window: WhamWindow | null | undefined,
): UsageWindow | undefined {
  if (typeof window?.used_percent !== "number") return undefined;
  return {
    label,
    percent: window.used_percent,
    resetsAt: window.reset_at ? window.reset_at * 1000 : undefined,
  };
}

function mapWhamToUsage(wham: WhamUsageResponse): UsageInfo {
  const primary = wham.rate_limit?.primary_window;
  const credits = wham.credits;
  const resetCredits = wham.rate_limit_reset_credits;
  const spend = wham.spend_control;
  const secondary = wham.rate_limit?.secondary_window;
  const windows = [
    toUsageWindow(formatCodexWindowLabel(primary?.limit_window_seconds, "Usage"), primary),
    toUsageWindow(
      formatCodexWindowLabel(secondary?.limit_window_seconds, "Secondary usage"),
      secondary,
    ),
  ].filter((window): window is UsageWindow => window !== undefined);

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
    windows,
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
    const usageParts: string[] = [theme.fg("accent", "Codex")];
    const detailParts: string[] = [];

    // Plan tier
    if (usage.planType) {
      usageParts.push(theme.fg("text", `Plan: ${formatCodexPlanType(usage.planType)}`));
    }

    const windows = usage.windows?.length
      ? usage.windows
      : typeof usage.usagePercent === "number"
        ? [{ label: "Usage", percent: usage.usagePercent, resetsAt: usage.resetsAt }]
        : [];

    // Keep both percentages together on the first line so neither is pushed
    // out of view by reset details on narrower terminals.
    for (const window of windows) {
      const pct = window.percent.toFixed(0);
      const color = window.percent > 90 ? "warning" : "text";
      usageParts.push(theme.fg(color, `${window.label} ${pct}% used`));
    }

    for (const window of windows) {
      if (!window.resetsAt) continue;

      const mins = Math.max(0, Math.round((window.resetsAt - Date.now()) / 60000));
      if (mins <= 0) continue;

      const days = Math.floor(mins / 1440);
      const hours = Math.floor((mins % 1440) / 60);
      const min = mins % 60;
      const when = days > 0
        ? `${days}d ${hours}h`
        : hours > 0
          ? `${hours}h ${min}m`
          : `${min}m`;
      detailParts.push(theme.fg("dim", `${window.label} resets in ${when}`));
    }

    // Extra credits
    if (typeof usage.extraCredits === "number" && usage.extraCredits > 0) {
      detailParts.push(theme.fg("muted", "✦") + theme.fg("dim", `${usage.extraCredits} reset credit${usage.extraCredits !== 1 ? "s" : ""}`));
    }

    // Limit reached indicator
    if (usage.limitReached) {
      detailParts.push(theme.fg("warning", "● limit reached"));
    }

    return [
      usageParts.join("  "),
      ...(detailParts.length > 0 ? [detailParts.join("  ")] : []),
    ];
  },
};
