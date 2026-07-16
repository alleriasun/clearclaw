import { ClaudeCodeEngine } from "./claude-code.js";
import { AcpEngine } from "./acp.js";
import type { Engine, RunTurnOpts } from "../types.js";

export interface SpawnConfig {
  command: string;
  args: string[];
  env?: Record<string, string> | ((opts: RunTurnOpts) => Record<string, string> | undefined);
}

/** Known ACP agent spawn configurations. */
const KNOWN_ACP_AGENTS: Record<string, SpawnConfig> = {
  kiro: { command: "kiro-cli", args: ["acp"] },
  codex: {
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp"],
    env: codexEnv,
  },
};

function codexEnv(opts: RunTurnOpts): Record<string, string> | undefined {
  const developerInstructions = opts.appendSystemPrompt?.trim();
  if (!developerInstructions) return undefined;

  return {
    CODEX_CONFIG: JSON.stringify({
      ...readCodexConfigEnv(),
      developer_instructions: developerInstructions,
    }),
  };
}

function readCodexConfigEnv(): Record<string, unknown> {
  const raw = process.env.CODEX_CONFIG?.trim();
  if (!raw) return {};

  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CODEX_CONFIG must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** All known engine names (for validation / setup prompts). */
export const ENGINE_NAMES = ["claude-code", ...Object.keys(KNOWN_ACP_AGENTS)] as const;

/** CLI binary each engine needs on PATH. */
const ENGINE_COMMANDS: Record<string, string> = {
  "claude-code": "claude",
  ...Object.fromEntries(Object.entries(KNOWN_ACP_AGENTS).map(([name, cfg]) => [name, cfg.command])),
};

/** Return the CLI command an engine needs on PATH. */
export function engineCommand(name: string): string | undefined {
  return ENGINE_COMMANDS[name];
}

/**
 * Build the engine map: claude-code (Agent SDK) + known ACP agents.
 * Engines are lightweight — they store config, not running processes.
 *
 * @param enginePaths - resolved executable paths from config (e.g. { "claude-code": "/usr/local/bin/claude" })
 */
export function createEngineMap(enginePaths: Record<string, string> = {}): Map<string, Engine> {
  const engines = new Map<string, Engine>();
  engines.set("claude-code", new ClaudeCodeEngine(enginePaths["claude-code"]));
  for (const [name, config] of Object.entries(KNOWN_ACP_AGENTS)) {
    engines.set(name, new AcpEngine(name, config));
  }
  return engines;
}
