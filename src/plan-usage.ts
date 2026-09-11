import type { EngineEvent, PlanUsageState } from "./types.js";

/** Latest normalized readings shared by workspaces on the same engine/account. */
export function recordPlanUsage(state: PlanUsageState, event: Extract<EngineEvent, { type: "plan_usage" }>): void {
  for (const window of event.windows) state.windows.set(window.id, window);
  if (event.isUsingOverage !== undefined) state.isUsingOverage = event.isUsingOverage;
}

export function formatPlanUsage(state?: PlanUsageState, maxLength = 4096): string {
  // A window with nothing to report is omitted: "5h ?" tells the reader less than
  // its absence does, and the seeded windows start out unreported.
  const parts: string[] = [];
  for (const window of state?.windows.values() ?? []) {
    if (window.usedPercent !== undefined) parts.push(`${window.label} ${Math.round(window.usedPercent)}%`);
    else if (window.limited) parts.push(`${window.label} limited`);
  }
  if (state?.isUsingOverage) parts.push("overage");
  const kept: string[] = [];
  for (const part of parts) {
    const remaining = parts.length - kept.length - 1;
    const candidate = [...kept, part].join(", ") + (remaining ? ` +${remaining} more` : "");
    if (candidate.length > maxLength) break;
    kept.push(part);
  }
  const omitted = parts.length - kept.length;
  return kept.join(", ") + (omitted ? `${kept.length ? " " : ""}+${omitted} more` : "");
}
