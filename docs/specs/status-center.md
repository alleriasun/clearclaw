# Subscription usage in the status bar

## Status

Accepted: passive subscription usage alongside context usage in the existing Telegram pinned status message and Slack channel topic. No new `/status` command, provider polling, history storage, threshold alerts, or engine routing.

## Context

Parallel workspaces share an engine's account allowance. Context tokens measure one conversation; they do not measure the account's five-hour or weekly quota. A turn failing after allowance is exhausted arrives too late to plan around it.

Claude SDK `rate_limit_event` fields are optional. Older bundled CLIs report only a selected warning window and normally omit utilization while allowed. The configured Claude Code 2.1.251 executable also emits `unifiedWindows` for `five_hour`, `seven_day`, and `seven_day_overage_included` (the Fable weekly limit), including while allowed. These runtime fields pass through the SDK unchanged even though its older type declarations omit them. Utilization is a fraction and can exceed 1; reset timestamps are Unix seconds. Missing values cannot be interpreted as zero or a fresh prior value.

Codex's adapter already receives and stores account quota snapshots, but npm version 1.11.0 only displays them through its text `/status` command. Upstream [PR #334](https://github.com/agentclientprotocol/codex-acp/pull/334) attaches them to ACP `usage_update._meta["_codex/rateLimits"]`, following Claude ACP's metadata pattern. Standard ACP `used` and `size` remain context tokens.

## Decision

Use that metadata patch and display the context percentage beside the model name and account windows as `5h•11% 7d•58%`. The bar omits the `ctx` and `used` labels and hides the permission mode when it matches the configured default; an overridden mode stays visible. Window labels follow provider durations, including five-hour, seven-day, model-specific Claude, and additional Codex buckets when reported. Reset times remain optional data; the compact bar omits reset dates. A question mark means unknown. Claude rejection without utilization displays `limited`, never an invented 100%. Extra usage, when reported by Claude, is distinct from subscription allowance. Fable's weekly window is displayed separately as `Fable 7d`; [Anthropic describes it](https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan) as a limit within the overall weekly allowance, not an additional allowance. Missing Fable and overall weekly readings remain independently unknown.

The common formatter renders only normalized values, with no engine-name branches. Engines provide known unknown-window seeds where available: Claude supplies five-hour, overall weekly, and Fable weekly windows. Codex displays only reported windows; before any report it shows `quota•?`, since primary/secondary positions do not imply particular durations. Engine-normalized model labels are separate from raw model IDs.

ACP engines retain the selected model ID from session configuration responses and updates, including resumed sessions and confirmed model overrides. The existing end-of-turn status displays that ID beside context usage. This is the adapter's selected session model, not proof of per-request backend routing. The engine name introduces the plan usage section after a separator, for example `🤖 gpt-5.4 25% | codex 5h•47% 7d•18%`. If the model is unknown, the context section omits its name; the engine remains visible beside plan usage.

The daemon retains the latest observation of each window in memory, indexed by engine. This follows the current single-account-per-engine setup. Workspaces using the same engine see the shared snapshot; no per-workspace attribution is inferred. Provider logins changed outside ClearClaw are not identity-tracked. Daemon restart starts with unknown usage until new events arrive.

Engine-specific normalization converts provider window identifiers, durations, percentages, and rejection status into one shared `plan_usage` event. Windows have a display label and optional percentage, reset time, and `limited` flag; extra usage is optional on the event. Claude raw SDK extensions remain inside the engine layer. All quota events update state silently; actual turn errors remain visible through the normal error event. A new typed window observation replaces its old percentage even if the new percentage is absent. Untyped allowed events without unified windows leave the latest readings unchanged. ACP history replay does not become a new account observation. When present, each valid `unifiedWindows` entry updates its own observation and takes precedence over the selected top-level window's percentage. Unknown future window identifiers retain a bounded readable label.

Quota usage follows the existing context status lifecycle. Events retain the latest reported values in memory; each workspace displays the shared account snapshot when its own turn completes, through the existing status update path. Existing engine and permission changes also retain their normal status refresh. There is no quota-triggered fanout, periodic clock, observation timestamp, staleness threshold, or expiry transition. Provider reset times are retained as data and never schedule work. Values remain visible until replaced by a later observation, even after a reset; they describe the latest reported usage rather than a live account view. This supersedes the earlier proposal to expire readings after 15 minutes and refresh all same-engine workspaces in the background. Slack's topic length budget is respected, with an explicit count when additional quota readings cannot fit.

Pin Codex ACP to 1.11.0 and backport only PR #334's metadata emission onto its existing snapshot merge. The installation hook applies a checked-in patch with original and resulting bundle hashes. Unexpected versions or bundles fail the patch explicitly. See [patch provenance and removal](../../patches/README.md).

## Consequences and alternatives

No second provider connection, quota scraper, persistent database, or custom ACP request is needed. Codex metadata emission still requires known context usage, as in the upstream patch. Claude may show unknown percentages even when turns are allowed; that is an upstream data limitation rather than unused quota.

Polling or a fresh on-demand account read could fill gaps, but is outside the accepted scope. A new standalone dashboard would duplicate the existing status surface. A generic quota protocol may eventually replace the provider metadata; today the existing upstream patch minimizes divergence.
