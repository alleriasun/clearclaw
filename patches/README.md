# Codex ACP usage metadata backport

ClearClaw temporarily pins `@agentclientprotocol/codex-acp` to npm version `1.11.0` and backports the usage notification changes from [codex-acp PR #334](https://github.com/agentclientprotocol/codex-acp/pull/334), head [`b670a4e4914fbd5ffe2d008091e64921dc2684d4`](https://github.com/agentclientprotocol/codex-acp/commit/b670a4e4914fbd5ffe2d008091e64921dc2684d4). The upstream adapter and these adapted changes are Apache-2.0 licensed.

The npm release distributes a bundled `dist/index.js`, so the patch targets that bundle. It forwards account limit updates as ACP `usage_update` notifications and includes all cached quota buckets in `_meta["_codex/rateLimits"]` on context usage updates. Notifications retain the upstream requirement that context usage and a positive context window are known. This does not fetch quotas on demand.

Only the emission changes are backported. Version 1.11.0's existing `mergeRateLimitSnapshot` logic remains intact, including preservation of account-level fields on sparse updates.

`scripts/patch-codex-acp.mjs` runs after installation and uses ClearClaw's existing `diff` dependency. It resolves the installed adapter, checks its exact version and original SHA-256 hash, applies this patch, and verifies the resulting hash. An already patched bundle is accepted, making repeat installation idempotent. Unexpected source fails installation instead of silently dropping quota data.

The installer modifies the resolved dependency in place. In an installation where npm hoists and shares that exact adapter version, other consumers also receive these additive usage metadata notifications. Both the script and patch are included in ClearClaw's published package. Installations using `--ignore-scripts` must explicitly run `node scripts/patch-codex-acp.mjs` from the ClearClaw package directory before relying on Codex quota reporting.

Remove the installer and patch when an upstream release includes this metadata contract, then update the pinned dependency and verify usage notifications.
