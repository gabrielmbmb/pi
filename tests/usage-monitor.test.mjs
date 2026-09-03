import assert from "node:assert/strict";
import test from "node:test";

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
