import type { EngineEvent, PlanUsageState } from "./types.js";

/** Latest normalized readings shared by workspaces on the same engine/account. */
export function recordPlanUsage(state: PlanUsageState, event: Extract<EngineEvent, { type: "plan_usage" }>): void {
  for (const window of event.windows) state.windows.set(window.id, window);
  if (event.isUsingOverage !== undefined) state.isUsingOverage = event.isUsingOverage;
}

export function formatPlanUsage(state?: PlanUsageState, maxLength = 4096): string {
  const windows = [...(state?.windows.values() ?? [])];
  const parts = windows.map((window) => {
    const value = window.usedPercent !== undefined ? `${Math.round(window.usedPercent)}%`
      : window.limited ? "limited" : "?";
    return `${window.label} ${value}`;
  });
  if (!parts.length) parts.push("?");
  if (state?.isUsingOverage) parts.push("extra usage active");
  const heading = "used: ";
  const kept: string[] = [];
  for (const part of parts) {
    const remaining = parts.length - kept.length - 1;
    const candidate = heading + [...kept, part].join(" · ") + (remaining ? ` · +${remaining} more` : "");
    if (candidate.length > maxLength) break;
    kept.push(part);
  }
  const omitted = parts.length - kept.length;
  return heading + kept.join(" · ") + (omitted ? `${kept.length ? " · " : ""}+${omitted} more` : "");
}
