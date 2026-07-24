/**
 * Usage Monitor Extension
 *
 * Shows provider-specific usage / balance info as a widget below the prompt line.
 * Each provider gets its own handler implementing ProviderUsageHandler — add
 * new handlers to the `handlers` map to extend support.
 *
 * Supported providers:
 * - openrouter
 * - openai-codex
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { codexHandler, consumeResetCredit, fetchResetCreditDetails } from "./providers/codex.ts";
import { openRouterHandler } from "./providers/openrouter.ts";
import type { ProviderUsageHandler, UsageInfo } from "./providers/types.ts";

export default function usageMonitor(pi: ExtensionAPI) {
  // ── Handler registry ──────────────────────────────────────────────
  const handlers = new Map<string, ProviderUsageHandler>();
  handlers.set(codexHandler.provider, codexHandler);
  handlers.set(openRouterHandler.provider, openRouterHandler);

  // ── Throttle state ────────────────────────────────────────────────
  const FETCH_COOLDOWN_MS = 60_000; // at most one API call per minute
  let lastFetch = 0;
  let lastUsage: UsageInfo | null = null;
  let activeProvider: string | null = null;

  // ── Internal helpers ──────────────────────────────────────────────

  async function getApiKey(
    provider: string,
    ctx: ExtensionContext,
  ): Promise<string | undefined> {
    const auth = await ctx.modelRegistry.getProviderAuth(provider);
    return auth?.auth.apiKey;
  }

  function showWidget(
    usage: UsageInfo | null,
    provider: string | null,
    ctx: ExtensionContext,
  ) {
    if (!ctx.hasUI) return;

    if (!usage || !provider) {
      ctx.ui.setWidget("usage-monitor", undefined);
      return;
    }

    const handler = handlers.get(provider);
    if (!handler) {
      ctx.ui.setWidget("usage-monitor", undefined);
      return;
    }

    ctx.ui.setWidget("usage-monitor", handler.formatWidget(usage, ctx), {
      placement: "belowEditor",
    });
  }

  async function refresh(
    provider: string,
    ctx: ExtensionContext,
    force = false,
  ) {
    if (!ctx.hasUI) return;

    // Always switch widgets on provider change
    if (activeProvider !== provider) {
      activeProvider = provider;
      lastUsage = null;
    }

    // Throttle unless forced (e.g. startup, model switch)
    if (
      !force &&
      lastUsage &&
      activeProvider === provider &&
      Date.now() - lastFetch < FETCH_COOLDOWN_MS
    ) {
      showWidget(lastUsage, provider, ctx);
      return;
    }

    const apiKey = await getApiKey(provider, ctx);
    if (!apiKey) {
      ctx.ui.setWidget("usage-monitor", undefined);
      return;
    }

    try {
      const usage = await handlers.get(provider)!.fetchUsage(apiKey, ctx.signal);
      lastUsage = usage;
      lastFetch = Date.now();
      showWidget(usage, provider, ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[usage-monitor] ${provider}:`, msg);
      // Show nothing on error — next refresh will retry
      ctx.ui.setWidget("usage-monitor", undefined);
    }
  }

  // ── Events ────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const provider = ctx.model?.provider;
    if (provider && handlers.has(provider)) {
      await refresh(provider, ctx, true);
    }
  });

  pi.on("model_select", async (event, ctx) => {
    const provider = event.model.provider;
    if (handlers.has(provider)) {
      await refresh(provider, ctx, true);
    } else {
      // Switched to unsupported provider — clear
      activeProvider = null;
      lastUsage = null;
      showWidget(null, null, ctx);
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (activeProvider && handlers.has(activeProvider)) {
      await refresh(activeProvider, ctx);
    }
  });

  // ── Commands ──────────────────────────────────────────────────────

  pi.registerCommand("reset-credit", {
    description: "Consume a Codex rate-limit reset credit",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      if (activeProvider !== "openai-codex") {
        ctx.ui.notify("Reset credits are only available for the Codex provider.", "warning");
        return;
      }

      const token = await getApiKey("openai-codex", ctx);
      if (!token) {
        ctx.ui.notify("No Codex credentials found.", "error");
        return;
      }

      // Fetch available credits
      let credits;
      try {
        credits = await fetchResetCreditDetails(token, ctx.signal);
      } catch (err) {
        ctx.ui.notify(
          `Failed to fetch reset credits: ${err instanceof Error ? err.message : err}`,
          "error",
        );
        return;
      }

      if (credits.length === 0) {
        ctx.ui.notify("No reset credits available.", "info");
        return;
      }

      // Let the user pick one
      const choice = await ctx.ui.select(
        `Reset credits available (${credits.length})`,
        credits.map((c) => {
          const expiry = c.expiresAt
            ? `redeem by ${new Date(c.expiresAt).toLocaleDateString()}`
            : "no expiry";
          return `${c.title} — ${expiry}`;
        }),
      );

      if (!choice) return; // cancelled

      const credit = credits.find(
        (c) => choice.startsWith(c.title),
      );
      if (!credit) return;

      // Confirm
      const ok = await ctx.ui.confirm(
        "Consume reset credit?",
        `${credit.title}\n${credit.description}\n\nThis will zero out both your current and weekly rate-limit windows.`,
      );
      if (!ok) return;

      // Consume
      try {
        const result = await consumeResetCredit(token, credit.id, ctx.signal);
        ctx.ui.notify(result, "success");
        // Refresh usage widget
        await refresh("openai-codex", ctx, true);
      } catch (err) {
        ctx.ui.notify(
          `Failed: ${err instanceof Error ? err.message : err}`,
          "error",
        );
      }
    },
  });
}
