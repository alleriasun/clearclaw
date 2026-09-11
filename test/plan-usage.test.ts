import assert from "node:assert/strict";
import test from "node:test";
import { formatPlanUsage, recordPlanUsage } from "../src/plan-usage.js";
import { CLAUDE_PLAN_WINDOWS, claudePlanUsage } from "../src/engine/claude-code.js";
import { codexPlanUsage } from "../src/engine/acp.js";
import type { PlanUsageState } from "../src/types.js";

const recordClaudeUsage = (usage: PlanUsageState, info: Parameters<typeof claudePlanUsage>[0]) => recordPlanUsage(usage, claudePlanUsage(info));

const now = new Date("2026-09-10T17:00:00Z").getTime();
const state = (): PlanUsageState => ({ windows: new Map(CLAUDE_PLAN_WINDOWS.map(window => [window.id, window])) });

test("Claude unified windows preserve the separate Fable allowance while allowed", () => {
  const usage = state();
  const resetsAt = now / 1000 + 3600;
  recordClaudeUsage(usage, { status: "allowed", rateLimitType: "five_hour",
    unifiedWindows: {
      five_hour: { utilization: 0, resetsAt },
      seven_day: { utilization: .25, resetsAt },
      seven_day_overage_included: { utilization: .5, resetsAt },
    } });
  assert.equal(usage.windows.size, 3);
  const text = formatPlanUsage(usage);
  assert.match(text, /5h•0%/);
  assert.match(text, / 7d•25%/);
  assert.match(text, /Fable 7d•50%/);
});

test("Fable-only observations do not imply the overall weekly usage; future windows are safe", () => {
  const usage = state();
  recordClaudeUsage(usage, { status: "rejected",
    rateLimitType: "seven_day_overage_included" });
  assert.match(formatPlanUsage(usage), /7d•\?.*Fable 7d•limited/);
  recordClaudeUsage(usage, { status: "allowed",
    unifiedWindows: {
      seven_day_overage_included: { utilization: 1.05, resetsAt: now / 1000 + 3600 },
      future_window: { utilization: .2, resetsAt: now / 1000 + 3600 },
      invalid: { utilization: NaN, resetsAt: now / 1000 + 3600 },
    } });
  assert.match(formatPlanUsage(usage), /Fable 7d•105%/);
  assert.match(formatPlanUsage(usage), /future window•20%/);
  assert.equal(usage.windows.has("invalid"), false);
});

test("Claude windows stay independent; allowed without a percentage does not invent a new percentage", () => {
  const usage = state();
  recordClaudeUsage(usage, { status: "allowed_warning", rateLimitType: "five_hour", utilization: .9 });
  recordClaudeUsage(usage, { status: "allowed_warning", rateLimitType: "seven_day", utilization: .5 });
  recordClaudeUsage(usage, { status: "allowed" });
  assert.equal(usage.windows.get("five_hour")?.usedPercent, 90);
  assert.equal(usage.windows.get("seven_day")?.usedPercent, 50);
  recordClaudeUsage(usage, { status: "allowed", rateLimitType: "five_hour" });
  assert.equal(usage.windows.get("five_hour")?.usedPercent, undefined);
  assert.match(formatPlanUsage(usage), /5h•\?/);
  assert.match(formatPlanUsage(usage), /7d•50%/);
});

test("Codex metadata preserves zero, separate buckets and real window durations", () => {
  const windows = codexPlanUsage({ "_codex/rateLimits": [
    { limitId: "codex", primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: now / 1000 + 3600 },
      secondary: { usedPercent: 48, windowDurationMins: 10080 } },
    { limitId: "fast", primary: { usedPercent: 80, windowDurationMins: 60 } },
  ] });
  assert.deepEqual(windows.map(({ id, label, usedPercent }) => ({ id, label, usedPercent })), [
    { id: "codex/primary", label: "5h", usedPercent: 0 },
    { id: "codex/secondary", label: "7d", usedPercent: 48 },
    { id: "fast/primary", label: "fast 1h", usedPercent: 80 },
  ]);
  const usage = state();
  recordPlanUsage(usage, { type: "plan_usage", windows });
  assert.match(formatPlanUsage(usage), /5h•0%/);
});

test("missing and malformed metadata never invents quota from context tokens", () => {
  for (const meta of [undefined, null, [], { quota: { token_count: 50 } },
    { "_codex/rateLimits": "bad" }, { "_codex/rateLimits": [null, {}, { limitId: "codex", primary: { usedPercent: "50", windowDurationMins: "300" } }] }]) {
    assert.deepEqual(codexPlanUsage(meta), []);
  }
  assert.equal(formatPlanUsage(), "quota•?");
});

test("a bounded status preserves whole readings and explicitly counts omitted parts", () => {
  const usage = state();
  recordPlanUsage(usage, { type: "plan_usage", windows: Array.from({ length: 10 }, (_, i) => ({
    id: `bucket${i}/primary`, label: `bucket${i} 5h`, usedPercent: 50, resetsAt: now / 1000 + 3600,
  })) });
  const text = formatPlanUsage(usage, 150);
  assert.ok(text.length <= 150);
  assert.match(text, /bucket0 5h•50%/);
  assert.match(text, /\+\d+ more$/);
});

test("reported usage stays visible after its reset until a new observation replaces it", () => {
  const usage = state();
  recordClaudeUsage(usage, { status: "allowed_warning", rateLimitType: "five_hour",
    utilization: .9, resetsAt: 1 });
  assert.match(formatPlanUsage(usage), /5h•90%/);
  recordClaudeUsage(usage, { status: "allowed", rateLimitType: "five_hour", utilization: .1 });
  assert.match(formatPlanUsage(usage), /5h•10%/);
});

test("Claude rejected status and extra usage remain distinct from a known percentage", () => {
  const usage = state();
  recordClaudeUsage(usage, { status: "rejected", rateLimitType: "five_hour", isUsingOverage: true });
  assert.match(formatPlanUsage(usage), /5h•limited/);
  assert.match(formatPlanUsage(usage), /extra•on/);
  assert.doesNotMatch(formatPlanUsage(usage), /100%/);
});
