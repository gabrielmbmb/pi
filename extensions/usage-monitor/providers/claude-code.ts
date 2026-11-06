import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatResetDuration } from "./format.ts";
import type { ProviderUsageHandler, UsageInfo, UsageWindow } from "./types.ts";

const CLAUDE_USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";
const CREDENTIALS_CACHE_MS = 60_000;
const execFileAsync = promisify(execFile);

// ── Response shapes ─────────────────────────────────────────────────

interface ClaudeUsageWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

interface ClaudeUsageLimitScope {
  model?: { display_name?: string | null } | null;
  surface?: { display_name?: string | null } | null;
}

interface ClaudeUsageLimit {
  kind?: string;
  group?: string;
  percent?: number;
  resets_at?: string | null;
  severity?: string;
  scope?: ClaudeUsageLimitScope | null;
}

interface ClaudeExtraUsage {
  is_enabled?: boolean;
  monthly_limit?: number | null;
  used_credits?: number | null;
  utilization?: number | null;
  decimal_places?: number | null;
  spend_limit_reached?: boolean | null;
}

interface ClaudeUsageResponse {
  five_hour?: ClaudeUsageWindow | null;
  seven_day?: ClaudeUsageWindow | null;
  seven_day_opus?: ClaudeUsageWindow | null;
  seven_day_sonnet?: ClaudeUsageWindow | null;
  limits?: ClaudeUsageLimit[] | null;
  extra_usage?: ClaudeExtraUsage | null;
}

export interface ClaudeCodeCredentials {
  accessToken: string;
  subscriptionType?: string;
  rateLimitTier?: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

const CLAUDE_PLAN_LABELS: Record<string, string> = {
  free: "Free",
  pro: "Pro",
  max: "Max",
  team: "Team",
  enterprise: "Enterprise",
  edu: "Education",
  education: "Education",
};

function titleCase(value: string): string {
  return value
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/** Convert Claude's subscription tier into the label users should see. */
export function formatClaudePlan(
  subscriptionType: string | undefined,
  rateLimitTier?: string,
): string | undefined {
  if (!subscriptionType) return undefined;

  const normalized = subscriptionType.trim().toLowerCase();
  if (!normalized) return undefined;

  const label = CLAUDE_PLAN_LABELS[normalized] ?? titleCase(normalized);

  if (normalized === "max") {
    const tier = rateLimitTier?.match(/(?:^|_)max_(5x|20x)$/i);
    if (tier) return `${label} ${tier[1].toLowerCase()}`;
  }

  return label;
}

function parseTimestamp(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function toUsageWindow(
  label: string,
  window: ClaudeUsageWindow | null | undefined,
): UsageWindow | undefined {
  if (typeof window?.utilization !== "number") return undefined;
  return {
    label,
    percent: window.utilization,
    resetsAt: parseTimestamp(window.resets_at),
  };
}

function formatLimitLabel(limit: ClaudeUsageLimit): string {
  switch (limit.kind) {
    case "session":
      return "5h";
    case "weekly_all":
      return "Weekly";
    case "weekly_scoped": {
      const name =
        limit.scope?.model?.display_name ?? limit.scope?.surface?.display_name;
      return name ? `${name} wk` : "Scoped wk";
    }
    case "spend":
      return "Credits";
    default:
      return titleCase(limit.kind || limit.group || "Usage");
  }
}

type CountedUsageLimit = ClaudeUsageLimit & { percent: number };

function isCountedUsageLimit(limit: ClaudeUsageLimit): limit is CountedUsageLimit {
  return typeof limit.percent === "number";
}

function mapLimitWindow(limit: CountedUsageLimit): UsageWindow {
  return {
    label: formatLimitLabel(limit),
    percent: limit.percent,
    resetsAt: parseTimestamp(limit.resets_at),
    status: limit.severity,
  };
}

function extraUsageAmounts(extra: ClaudeExtraUsage | null | undefined) {
  if (
    extra?.is_enabled !== true ||
    typeof extra.monthly_limit !== "number" ||
    extra.monthly_limit <= 0 ||
    typeof extra.used_credits !== "number"
  )
    return undefined;

  const scale = 10 ** (extra.decimal_places ?? 2);
  return {
    used: extra.used_credits / scale,
    limit: extra.monthly_limit / scale,
    percent:
      typeof extra.utilization === "number"
        ? extra.utilization
        : (extra.used_credits / extra.monthly_limit) * 100,
  };
}

/** Map the `/api/oauth/usage` response into the shared usage model. */
export function mapClaudeUsage(
  response: ClaudeUsageResponse,
  credentials?: Pick<ClaudeCodeCredentials, "subscriptionType" | "rateLimitTier">,
): UsageInfo {
  const extra = extraUsageAmounts(response.extra_usage);
  const limitWindows = (response.limits ?? []).filter(isCountedUsageLimit);

  const legacyWindows = [
    toUsageWindow("5h", response.five_hour),
    toUsageWindow("Weekly", response.seven_day),
    toUsageWindow("Opus", response.seven_day_opus),
    toUsageWindow("Sonnet", response.seven_day_sonnet),
  ].filter((window): window is UsageWindow => window !== undefined);

  // `limits` is the newest shape and carries per-model allowances. Older
  // responses only populate the five_hour / seven_day fields.
  const quotaWindows = limitWindows
    .filter((limit) => limit.kind !== "spend")
    .map(mapLimitWindow);
  const windows = quotaWindows.length > 0 ? quotaWindows : legacyWindows;

  if (extra) {
    windows.push({
      label: "Credits",
      percent: extra.percent,
      status: response.extra_usage?.spend_limit_reached ? "reached" : undefined,
    });
  } else {
    // Gateway responses can report spend-only caps instead of extra_usage.
    const spendLimit = limitWindows.find((limit) => limit.kind === "spend");
    if (spendLimit) windows.push(mapLimitWindow(spendLimit));
  }

  if (windows.length === 0) throw new Error("Claude Code API: no usage windows in response");

  // `usagePercent` / `resetsAt` describe the shortest-lived window, like the
  // Codex handler. Fall back to the first window on plans without a 5h limit.
  const primary = windows.find((window) => window.label === "5h") ?? windows[0];

  return {
    label: "Claude",
    planType: formatClaudePlan(
      credentials?.subscriptionType,
      credentials?.rateLimitTier,
    ),
    usagePercent: primary.percent,
    resetsAt: primary.resetsAt,
    limitReached:
      windows.some((window) => window.percent >= 100) ||
      response.extra_usage?.spend_limit_reached === true,
    windows,
    limit: extra?.limit,
    monthlyUsage: extra?.used,
    balance: extra ? extra.limit - extra.used : undefined,
  };
}

// ── Credentials ─────────────────────────────────────────────────────

/** Parse the JSON Claude Code stores in its keychain item / .credentials.json. */
export function parseClaudeCredentials(
  raw: unknown,
): ClaudeCodeCredentials | undefined {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  const oauth = (parsed as { claudeAiOauth?: Record<string, unknown> } | null)
    ?.claudeAiOauth;
  if (!oauth) return undefined;

  const accessToken =
    typeof oauth.accessToken === "string" ? oauth.accessToken.trim() : "";
  if (!accessToken) return undefined;

  return {
    accessToken,
    subscriptionType:
      typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : undefined,
    rateLimitTier:
      typeof oauth.rateLimitTier === "string" ? oauth.rateLimitTier : undefined,
  };
}

async function readKeychainCredentials(): Promise<ClaudeCodeCredentials | undefined> {
  if (process.platform !== "darwin") return undefined;
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/security",
      ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"],
      { timeout: 5_000, maxBuffer: 1024 * 1024 },
    );
    return parseClaudeCredentials(String(stdout));
  } catch {
    return undefined;
  }
}

async function readFileCredentials(
  directory: string,
): Promise<ClaudeCodeCredentials | undefined> {
  try {
    const raw = await readFile(join(directory, ".credentials.json"), "utf8");
    return parseClaudeCredentials(raw);
  } catch {
    return undefined;
  }
}

let cachedCredentials:
  | { value: ClaudeCodeCredentials; fetchedAt: number }
  | undefined;

/**
 * The pi-claude-code provider does not expose Claude Code's token, and Pi only
 * sees a placeholder. Read the OAuth login Claude Code itself maintains instead.
 */
async function readClaudeCredentials(
  env: Record<string, string | undefined> = process.env,
): Promise<ClaudeCodeCredentials | undefined> {
  // An explicitly provided token wins over the stored Claude Code login.
  const envToken = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (envToken) {
    const credentials = { accessToken: envToken };
    cachedCredentials = { value: credentials, fetchedAt: Date.now() };
    return credentials;
  }

  if (
    cachedCredentials &&
    Date.now() - cachedCredentials.fetchedAt < CREDENTIALS_CACHE_MS
  )
    return cachedCredentials.value;

  const configDir = env.PI_CLAUDE_CODE_CONFIG_DIR || env.CLAUDE_CONFIG_DIR;
  const credentials = configDir
    ? // A custom config dir usually carries its own .credentials.json.
      (await readFileCredentials(configDir)) ?? (await readKeychainCredentials())
    : (await readKeychainCredentials()) ??
      (await readFileCredentials(join(homedir(), ".claude")));
  if (credentials) cachedCredentials = { value: credentials, fetchedAt: Date.now() };
  return credentials;
}

/** Resolve the provider-scoped environment the claude-code extension uses. */
async function claudeCodeEnvironment(
  ctx: ExtensionContext,
): Promise<Record<string, string | undefined>> {
  try {
    const auth = await ctx.modelRegistry.getProviderAuth("claude-code");
    return { ...process.env, ...auth?.env };
  } catch {
    return process.env;
  }
}

function formatUsd(amount: number): string {
  return `$${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function windowColor(window: UsageWindow): "warning" | "text" {
  if (
    window.status === "warning" ||
    window.status === "critical" ||
    window.status === "reached" ||
    window.percent >= 90
  )
    return "warning";
  return "text";
}

// ── Handler ─────────────────────────────────────────────────────────

export const claudeCodeHandler: ProviderUsageHandler = {
  provider: "claude-code",
  skipPiAuth: true,

  async resolveApiKey(ctx: ExtensionContext): Promise<string | undefined> {
    const env = await claudeCodeEnvironment(ctx);
    return (await readClaudeCredentials(env))?.accessToken;
  },

  async fetchUsage(apiKey: string, signal?: AbortSignal): Promise<UsageInfo> {
    const credentials = await readClaudeCredentials();

    const resp = await fetch(CLAUDE_USAGE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "anthropic-beta": CLAUDE_OAUTH_BETA,
      },
      signal,
    });

    if (!resp.ok) {
      throw new Error(`Claude Code API: ${resp.status} ${resp.statusText}`);
    }

    const json = (await resp.json()) as ClaudeUsageResponse;
    return mapClaudeUsage(json, credentials);
  },

  formatWidget(usage: UsageInfo, ctx: ExtensionContext): string[] {
    const theme = ctx.ui.theme;
    const summary: string[] = [theme.fg("accent", usage.label)];
    const details: string[] = [];

    if (usage.planType) {
      summary.push(theme.fg("text", `Plan: ${usage.planType}`));
    }

    const windows = usage.windows ?? [];

    // Keep every percentage together on the first line so none are pushed out
    // of view by reset details on narrower terminals.
    for (const window of windows) {
      summary.push(
        theme.fg(windowColor(window), `${window.label} ${window.percent.toFixed(0)}% used`),
      );
    }

    for (const window of windows) {
      if (!window.resetsAt) continue;
      const when = formatResetDuration(window.resetsAt);
      if (when) details.push(theme.fg("dim", `${window.label} resets in ${when}`));
    }

    if (typeof usage.limit === "number" && typeof usage.monthlyUsage === "number") {
      details.push(
        theme.fg("muted", "✦") +
          theme.fg(
            "dim",
            ` ${formatUsd(usage.monthlyUsage)} / ${formatUsd(usage.limit)} usage credits`,
          ),
      );
    }

    if (usage.limitReached) {
      details.push(theme.fg("warning", "● limit reached"));
    }

    return [
      summary.join("  "),
      ...(details.length > 0 ? [details.join("  ")] : []),
    ];
  },
};
