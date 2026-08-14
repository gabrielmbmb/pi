import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ProviderUsageHandler, UsageInfo, UsageWindow } from "./types.ts";

// ── Response shapes ─────────────────────────────────────────────────

interface GoWindow {
  status?: string;
  percent?: number;
  resetsAt?: string; // ISO timestamp
}

interface GoUsageResponse {
  usage?: {
    rolling?: GoWindow;
    weekly?: GoWindow;
    monthly?: GoWindow;
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

const GO_USAGE_ENDPOINT = "https://opencode.ai/zen/go/v1/usage";

function toWindow(
  label: string,
  w: GoWindow | undefined,
): UsageWindow | undefined {
  if (!w || typeof w.percent !== "number") return undefined;
  return {
    label,
    percent: w.percent,
    status: w.status,
    resetsAt: w.resetsAt ? Date.parse(w.resetsAt) : undefined,
  };
}

/**
 * OpenCode Go keys configured via opencode's own `/connect` live in
 * `~/.local/share/opencode/auth.json` under the `opencode-go` entry —
 * fall back to that when pi auth has no key for the provider.
 */
async function readOpencodeAuthKey(): Promise<string | undefined> {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return undefined;
  try {
    const raw = await readFile(
      join(home, ".local", "share", "opencode", "auth.json"),
      "utf8",
    );
    const json = JSON.parse(raw) as Record<
      string,
      { key?: string } | undefined
    >;
    return json["opencode-go"]?.key;
  } catch {
    return undefined;
  }
}

// ── Handler ─────────────────────────────────────────────────────────

export const opencodeGoHandler: ProviderUsageHandler = {
  provider: "opencode-go",

  async resolveApiKey(): Promise<string | undefined> {
    // pi's own auth (env var / ~/.pi/agent/auth.json) is tried first by
    // index.ts; this covers opencode's own auth.json via /connect.
    return readOpencodeAuthKey();
  },

  async fetchUsage(apiKey: string, signal?: AbortSignal): Promise<UsageInfo> {
    const resp = await fetch(GO_USAGE_ENDPOINT, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    });

    if (!resp.ok) throw new Error(`OpenCode Go API: ${resp.status} ${resp.statusText}`);

    const json = (await resp.json()) as GoUsageResponse;
    const usage = json.usage;

    const windows = [
      toWindow("5h", usage?.rolling),
      toWindow("wk", usage?.weekly),
      toWindow("mo", usage?.monthly),
    ].filter((w): w is UsageWindow => w !== undefined);

    if (windows.length === 0) throw new Error("OpenCode Go API: no quota windows in response");

    // Primary window is the rolling 5-hour one — mirrors codex.ts semantics
    // (usagePercent / resetsAt describe the shortest-lived window).
    const primary = windows[0];

    return {
      label: "OpenCode Go",
      usagePercent: primary.percent,
      resetsAt: primary.resetsAt,
      windows,
    };
  },

  formatWidget(usage: UsageInfo, ctx: ExtensionContext): string[] {
    const theme = ctx.ui.theme;
    const parts: string[] = [theme.fg("accent", usage.label)];

    const windows = usage.windows ?? [];
    for (const w of windows) {
      const remaining = Math.max(0, 100 - w.percent);
      const color = w.percent >= 100 ? "warning" : "text";
      parts.push(theme.fg(color, `${w.label} ${remaining.toFixed(0)}% left`));

      // Reset countdown for the primary (rolling 5h) window
      if (w === windows[0] && w.resetsAt) {
        const mins = Math.max(0, Math.round((w.resetsAt - Date.now()) / 60000));
        if (mins > 0) {
          const hr = Math.floor(mins / 60);
          const min = mins % 60;
          const when = hr > 0 ? `${hr}h ${min}m` : `${min}m`;
          parts.push(theme.fg("dim", `resets ${when}`));
        }
      }
    }

    return [parts.join("  ")];
  },
};
