import assert from "node:assert/strict";
import test from "node:test";

import {
  formatClaudePlan,
  mapClaudeUsage,
  parseClaudeCredentials,
} from "../extensions/usage-monitor/providers/claude-code.ts";
import {
  formatCodexPlanType,
  formatCodexWindowLabel,
} from "../extensions/usage-monitor/providers/codex.ts";

test("formats Codex plan types with human-readable labels", () => {
  assert.equal(formatCodexPlanType("self_serve_business_prolite"), "Business Premium");
  assert.equal(formatCodexPlanType("prolite"), "Pro Lite");
  assert.equal(formatCodexPlanType("self_serve_business_usage_based"), "Business");
});

test("keeps unknown Codex plan types readable", () => {
  assert.equal(formatCodexPlanType("new_workspace_plan"), "New Workspace Plan");
});

test("labels Codex rate-limit windows by their server-provided duration", () => {
  assert.equal(formatCodexWindowLabel(5 * 60 * 60, "Usage"), "5h");
  assert.equal(formatCodexWindowLabel(7 * 24 * 60 * 60, "Usage"), "Weekly");
  assert.equal(formatCodexWindowLabel(60 * 60, "Usage"), "1h");
  assert.equal(formatCodexWindowLabel(undefined, "Usage"), "Usage");
});

test("formats Claude subscription plans for display", () => {
  assert.equal(formatClaudePlan("team"), "Team");
  assert.equal(formatClaudePlan("max", "default_claude_max_5x"), "Max 5x");
  assert.equal(formatClaudePlan("max", "default_claude_max_20x"), "Max 20x");
  assert.equal(formatClaudePlan("enterprise"), "Enterprise");
  assert.equal(formatClaudePlan("new_subscription_tier"), "New Subscription Tier");
  assert.equal(formatClaudePlan(undefined), undefined);
});

test("parses Claude Code OAuth credentials", () => {
  const credentials = parseClaudeCredentials(
    JSON.stringify({
      claudeAiOauth: {
        accessToken: " sk-ant-oat-test ",
        subscriptionType: "team",
        rateLimitTier: "default_claude_max_5x",
      },
    }),
  );

  assert.deepEqual(credentials, {
    accessToken: "sk-ant-oat-test",
    subscriptionType: "team",
    rateLimitTier: "default_claude_max_5x",
  });
  assert.equal(
    parseClaudeCredentials({ claudeAiOauth: { accessToken: "raw-token" } })
      ?.accessToken,
    "raw-token",
  );
  assert.equal(parseClaudeCredentials("{}"), undefined);
  assert.equal(parseClaudeCredentials("not json"), undefined);
});

test("maps Claude usage limits, scoped allowances, and usage credits", () => {
  const resetsAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const usage = mapClaudeUsage(
    {
      five_hour: { utilization: 12, resets_at: resetsAt },
      seven_day: { utilization: 100, resets_at: resetsAt },
      limits: [
        { kind: "session", percent: 12, resets_at: resetsAt, severity: "normal" },
        { kind: "weekly_all", percent: 100, resets_at: resetsAt, severity: "critical" },
        {
          kind: "weekly_scoped",
          percent: 39,
          resets_at: resetsAt,
          scope: { model: { display_name: "Fable" } },
        },
      ],
      extra_usage: {
        is_enabled: true,
        monthly_limit: 100_000,
        used_credits: 40_248,
        utilization: 40.248,
        currency: "USD",
        decimal_places: 2,
        spend_limit_reached: false,
      },
    },
    { subscriptionType: "team", rateLimitTier: "default_claude_max_5x" },
  );

  assert.equal(usage.label, "Claude");
  assert.equal(usage.planType, "Team");
  assert.equal(usage.usagePercent, 12);
  assert.equal(usage.resetsAt, Date.parse(resetsAt));
  assert.deepEqual(
    usage.windows.map((window) => [window.label, window.percent]),
    [
      ["5h", 12],
      ["Weekly", 100],
      ["Fable wk", 39],
      ["Credits", 40.248],
    ],
  );
  assert.equal(usage.limitReached, true);
  assert.equal(usage.limit, 1_000);
  assert.equal(usage.monthlyUsage, 402.48);
  assert.equal(usage.balance, 597.52);
});

test("falls back to legacy Claude usage windows", () => {
  const usage = mapClaudeUsage({
    five_hour: { utilization: 5, resets_at: null },
    seven_day: { utilization: 20, resets_at: null },
    seven_day_opus: { utilization: 10 },
  });

  assert.deepEqual(
    usage.windows.map((window) => window.label),
    ["5h", "Weekly", "Opus"],
  );
  assert.equal(usage.limitReached, false);
});
