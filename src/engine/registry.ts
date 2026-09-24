import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { ClaudeCodeEngine } from "./claude-code.js";
import { AcpEngine } from "./acp.js";
import type { Engine, RunTurnOpts } from "../types.js";

export interface AcpEngineDefinition {
  command: [string, ...string[]];
  env?: Record<string, string> | ((opts: RunTurnOpts) => Record<string, string> | undefined);
}

interface AcpEngineConfig {
  cliCommand: string;
  command: AcpEngineDefinition["command"] | ((cliPath: string) => AcpEngineDefinition["command"]);
  bundled?: boolean;
  env?: (opts: RunTurnOpts, executablePath?: string) => Record<string, string> | undefined;
}

/** Known ACP engines: CLI for setup, optional adapter for launch. */
const require = createRequire(import.meta.url);
const KNOWN_ACP_ENGINES: Record<string, AcpEngineConfig> = {
  kiro: { cliCommand: "kiro-cli", command: (cliPath) => [cliPath, "acp"] },
  codex: {
    cliCommand: "codex",
    bundled: true,
    // Resolve only when starting Codex, and always use our pinned, patched dependency.
    get command(): AcpEngineDefinition["command"] { return [process.execPath, require.resolve("@agentclientprotocol/codex-acp")]; },
    env: codexEnv,
  },
};

/**
 * ACP has no system-prompt channel, so ClearClaw's assembled framework prompt
 * reaches Codex through its config: codex-acp parses CODEX_CONFIG as a JSON
 * config object and forwards it to codex core, which honors
 * `developer_instructions`. Merges over an inherited CODEX_CONFIG rather than
 * clobbering it.
 * CODEX_PATH selects the underlying CLI while the pinned adapter stays fixed.
 */

function codexEnv(opts: RunTurnOpts, executablePath?: string): Record<string, string> | undefined {
  const developerInstructions = opts.appendSystemPrompt?.trim();
  if (!developerInstructions && !executablePath) return undefined;

  return {
    ...(executablePath ? { CODEX_PATH: executablePath } : {}),
    ...(developerInstructions ? {
      CODEX_CONFIG: JSON.stringify({
        ...readCodexConfigEnv(),
        developer_instructions: developerInstructions,
      }),
    } : {}),
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
export const ENGINE_NAMES = ["claude-code", ...Object.keys(KNOWN_ACP_ENGINES)] as const;

/** Return the CLI command an engine needs on PATH. */
export function engineCommand(name: string): string | undefined {
  return name === "claude-code" ? "claude" : KNOWN_ACP_ENGINES[name]?.cliCommand;
}

/** Prefer an installed CLI; bundled engines can omit the override. */
export function resolveEnginePath(name: string): string | undefined {
  const command = engineCommand(name);
  if (!command) throw new Error(`Unknown engine: ${name}`);
  try {
    return execFileSync("which", [command], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    if (KNOWN_ACP_ENGINES[name]?.bundled) return undefined;
    throw new Error(`"${command}" not found on PATH. Install it first or choose another engine.`);
  }
}

/**
 * Build the engine map: claude-code (Agent SDK) + known ACP engines.
 * Engines are lightweight — they store config, not running processes.
 *
 * @param enginePaths - resolved executable paths from config (e.g. { "claude-code": "/usr/local/bin/claude" })
 */
export function createEngineMap(enginePaths: Record<string, string | undefined> = {}): Map<string, Engine> {
  const engines = new Map<string, Engine>();
  engines.set("claude-code", new ClaudeCodeEngine(enginePaths["claude-code"]));
  for (const [name, config] of Object.entries(KNOWN_ACP_ENGINES)) {
    engines.set(name, new AcpEngine(name, {
      get command() {
        const command = config.command;
        return typeof command === "function" ? command(enginePaths[name] ?? config.cliCommand) : command;
      },
      env: (opts) => config.env?.(opts, enginePaths[name]),
    }));
  }
  return engines;
}
