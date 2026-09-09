import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Config, PendingSpinOut, Project } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { Channel, Engine, Workspace } from "../src/types.js";
import { createWorktree, removeWorktree } from "../src/worktree.js";

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}

interface TestTool {
  name: string;
  description: string;
  handler(args: Record<string, unknown>): Promise<ToolResult>;
}

interface Harness {
  channelCalls: {
    closeProjectChat: Array<{ chatId: string; projectName?: string }>;
    createProjectChat: Array<{ projectName: string; anchor: string; title: string }>;
    messages: string[];
    setupProject: Array<{ projectName: string; chatId: string }>;
  };
  config: Config;
  orchestrator: Orchestrator;
  pendingSpinOuts: PendingSpinOut[];
  projects: Project[];
  tools: TestTool[];
  workspaces: Workspace[];
}

function makeHarness(options: {
  workspaces: Workspace[];
  projects?: Project[];
  peerChats?: boolean;
  interactiveResponse?: string;
  lifecycleError?: Error;
  closeError?: Error;
}): Harness {
  const workspaces = [...options.workspaces];
  const projects = [...(options.projects ?? [])];
  const pendingSpinOuts: PendingSpinOut[] = [];
  const channelCalls = {
    closeProjectChat: [] as Array<{ chatId: string; projectName?: string }>,
    createProjectChat: [] as Array<{ projectName: string; anchor: string; title: string }>,
    messages: [] as string[],
    setupProject: [] as Array<{ projectName: string; chatId: string }>,
  };
  const channel = {
    name: "test",
    connect: async () => {},
    disconnect: async () => {},
    on: () => {},
    ownsId: (chatId: string) => chatId.startsWith("test:"),
    sendInteractive: async () => ({ value: options.interactiveResponse ?? "spawn" }),
    sendMessage: async (_chatId: string, text: string) => {
      channelCalls.messages.push(text);
      return ["message-id"];
    },
    ...(options.peerChats === false
      ? {}
      : {
          createProjectChat: async (projectName: string, anchor: string, title: string) => {
            channelCalls.createProjectChat.push({ projectName, anchor, title });
            return "test:peer";
          },
          closeProjectChat: async (chatId: string, projectName?: string) => {
            channelCalls.closeProjectChat.push({ chatId, projectName });
            if (options.closeError) throw options.closeError;
          },
          setupProject: async (projectName: string, chatId: string) => {
            channelCalls.setupProject.push({ projectName, chatId });
            if (options.lifecycleError) throw options.lifecycleError;
          },
        }),
  } as unknown as Channel;
  const config = {
    homeWorkspacePath: "/tmp/clearclaw-home",
    defaultEngine: "claude-code",
    workspaceByChat: (chatId: string) => workspaces.find((workspace) => workspace.chat_id === chatId),
    workspaceByName: (name: string) => workspaces.find((workspace) => workspace.name === name),
    listWorkspaces: () => workspaces,
    upsertWorkspace: (workspace: Workspace) => {
      const index = workspaces.findIndex((candidate) => candidate.name === workspace.name);
      if (index >= 0) workspaces[index] = workspace;
      else workspaces.push(workspace);
    },
    removeWorkspace: (name: string) => {
      const index = workspaces.findIndex((workspace) => workspace.name === name);
      return index >= 0 ? workspaces.splice(index, 1)[0] : undefined;
    },
    listProjects: () => projects,
    listSchedules: () => [],
    projectByName: (name: string) => projects.find((project) => project.name === name),
    addProject: (project: Project) => {
      const index = projects.findIndex((candidate) => candidate.name === project.name);
      if (index >= 0) projects[index] = project;
      else projects.push(project);
    },
    removeProject: (name: string) => {
      const index = projects.findIndex((project) => project.name === name);
      return index >= 0 ? projects.splice(index, 1)[0] : undefined;
    },
    addSpinOut: (entry: PendingSpinOut) => pendingSpinOuts.push(entry),
    listSpinOuts: () => pendingSpinOuts,
    removeSpinOut: (id: string) => {
      const index = pendingSpinOuts.findIndex((entry) => entry.id === id);
      if (index < 0) return false;
      pendingSpinOuts.splice(index, 1);
      return true;
    },
  } as unknown as Config;
  const engines = new Map([
    ["claude-code", { name: "claude-code" }],
    ["codex", { name: "codex" }],
    ["kiro", { name: "kiro" }],
  ]) as Map<string, Engine>;
  const orchestrator = new Orchestrator({ channel, engines, config });
  orchestrator.deliverToWorkspace = () => true;
  const tools = (orchestrator as unknown as {
    buildMcpTools(
      chatId: string,
      behavior: "assistant" | "relay",
      turnState: { staySilent: boolean; replyToMessageId: string | null },
    ): TestTool[];
  }).buildMcpTools("test:self", "relay", { staySilent: false, replyToMessageId: null });
  return { channelCalls, config, orchestrator, pendingSpinOuts, projects, tools, workspaces };
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    name: "self",
    cwd: "/tmp/self",
    chat_id: "test:self",
    current_session_id: null,
    ...overrides,
  };
}

function tool(harness: Harness, name: string): TestTool {
  const found = harness.tools.find((candidate) => candidate.name === name);
  assert.ok(found, `tool ${name} should exist`);
  return found;
}

function taskTools(harness: Harness, chatId = "test:new"): TestTool[] {
  (harness.orchestrator as unknown as {
    tasks: Map<string, { sessionId: string | null; cwd: string; prompt: string }>;
  }).tasks.set(chatId, {
    sessionId: null,
    cwd: "/tmp/clearclaw-home",
    prompt: "onboarding",
  });
  return (harness.orchestrator as unknown as {
    buildMcpTools(
      chatId: string,
      behavior: "assistant" | "relay",
      turnState: { staySilent: boolean; replyToMessageId: string | null },
    ): TestTool[];
  }).buildMcpTools(chatId, "assistant", { staySilent: false, replyToMessageId: null });
}

function initRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "clearclaw-spin-out-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "ClearClaw Test"]);
  fs.writeFileSync(path.join(repo, "README.md"), "test\n");
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "initial"]);
  return repo;
}

test("spin_out documents strict external cwd ownership", () => {
  const harness = makeHarness({ workspaces: [workspace()] });
  const spinOut = tool(harness, "spin_out");

  assert.match(spinOut.description, /target project resolves/);
  assert.match(spinOut.description, /channel supports Project chat lifecycle/);
  assert.match(spinOut.description, /path must already exist/);
  assert.match(spinOut.description, /never create or remove it/);
  assert.doesNotMatch(spinOut.description, /forum/);
});

test("spin_out can override the peer engine without inheriting another engine's model", async () => {
  const externalCwd = fs.mkdtempSync(path.join(os.tmpdir(), "clearclaw-engine-spawn-"));
  const main = workspace({
    cwd: externalCwd,
    project: "ClearClaw",
    engine: "claude-code",
    model: "claude-opus-4-6",
  });
  const harness = makeHarness({
    workspaces: [main],
    projects: [{ name: "ClearClaw", description: "test", main_workspace: "self" }],
  });

  try {
    await tool(harness, "spin_out").handler({
      name: "peer",
      brief: "test brief",
      cwd: externalCwd,
      engine: "codex",
    });

    const peer = harness.workspaces.find((candidate) => candidate.name === "peer");
    assert.equal(peer?.engine, "codex");
    assert.equal(peer?.model, undefined);
  } finally {
    fs.rmSync(externalCwd, { recursive: true, force: true });
  }
});

test("spin_out can override the peer model and otherwise inherits runtime settings", async () => {
  const externalCwd = fs.mkdtempSync(path.join(os.tmpdir(), "clearclaw-model-spawn-"));
  const main = workspace({
    cwd: externalCwd,
    project: "ClearClaw",
    behavior: "assistant",
    engine: "claude-code",
    model: "claude-sonnet-4-6",
  });
  const harness = makeHarness({
    workspaces: [main],
    projects: [{ name: "ClearClaw", description: "test", main_workspace: "self" }],
  });

  try {
    await tool(harness, "spin_out").handler({
      name: "peer",
      brief: "test brief",
      cwd: externalCwd,
      model: "claude-opus-4-6",
    });

    const peer = harness.workspaces.find((candidate) => candidate.name === "peer");
    assert.equal(peer?.behavior, "assistant");
    assert.equal(peer?.engine, "claude-code");
    assert.equal(peer?.model, "claude-opus-4-6");
  } finally {
    fs.rmSync(externalCwd, { recursive: true, force: true });
  }
});

test("spin_out inherits the Project main's model by default", async () => {
  const externalCwd = fs.mkdtempSync(path.join(os.tmpdir(), "clearclaw-inherit-model-"));
  const main = workspace({
    cwd: externalCwd,
    project: "ClearClaw",
    engine: "claude-code",
    model: "claude-sonnet-4-6",
  });
  const harness = makeHarness({
    workspaces: [main],
    projects: [{ name: "ClearClaw", description: "test", main_workspace: "self" }],
  });

  try {
    await tool(harness, "spin_out").handler({
      name: "peer",
      brief: "test brief",
      cwd: externalCwd,
    });

    const peer = harness.workspaces.find((candidate) => candidate.name === "peer");
    assert.equal(peer?.engine, "claude-code");
    assert.equal(peer?.model, "claude-sonnet-4-6");
  } finally {
    fs.rmSync(externalCwd, { recursive: true, force: true });
  }
});

test("ACP spin-outs preserve inherited and explicit models through direct creation and pending claims", async (t) => {
  for (const engine of ["codex", "kiro"]) {
    for (const peerChats of [true, false]) {
      for (const explicitModel of [undefined, "selected-model"]) {
        await t.test(`${engine}, ${peerChats ? "direct" : "pending"}, ${explicitModel ? "override" : "inherited"}`, async () => {
          const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clearclaw-acp-peer-"));
          const harness = makeHarness({
            workspaces: [workspace({ cwd, project: "ClearClaw", engine, model: "inherited-model" })],
            projects: [{ name: "ClearClaw", description: "test", main_workspace: "self" }],
            peerChats,
          });
          try {
            await tool(harness, "spin_out").handler({
              name: "peer", brief: "test brief", cwd, model: explicitModel,
            });
            if (!peerChats) {
              const pending = harness.pendingSpinOuts[0];
              assert.equal(pending?.engine, engine);
              assert.equal(pending?.model, explicitModel ?? "inherited-model");
              const create = taskTools(harness).find((candidate) => candidate.name === "workspace_create");
              assert.ok(create);
              await create.handler({ name: "peer", cwd, description: "test", spin_out_id: pending!.id });
            }
            const peer = harness.workspaces.find((candidate) => candidate.name === "peer");
            assert.equal(peer?.engine, engine);
            assert.equal(peer?.model, explicitModel ?? "inherited-model");
          } finally {
            fs.rmSync(cwd, { recursive: true, force: true });
          }
        });
      }
    }
  }
});

test("workspace_create accepts a registered ACP engine's model and rejects an unknown engine", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clearclaw-create-model-"));
  const harness = makeHarness({ workspaces: [workspace()] });
  const create = taskTools(harness).find((candidate) => candidate.name === "workspace_create");
  assert.ok(create);
  try {
    await assert.rejects(
      create.handler({ name: "peer", cwd, description: "test", engine: "unknown", model: "selected-model" }),
      /Unknown engine "unknown"/,
    );
    await create.handler({ name: "peer", cwd, description: "test", engine: "kiro", model: "selected-model" });
    const peer = harness.workspaces.find((candidate) => candidate.name === "peer");
    assert.equal(peer?.engine, "kiro");
    assert.equal(peer?.model, "selected-model");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("spin_out rejects a model override for an unknown engine", async () => {
  const main = workspace({ project: "ClearClaw", engine: "kiro" });
  const harness = makeHarness({
    workspaces: [main],
    projects: [{ name: "ClearClaw", description: "test", main_workspace: "self" }],
  });

  const result = await tool(harness, "spin_out").handler({
    name: "peer",
    brief: "test brief",
    engine: "unknown",
    model: "selected-model",
  });

  assert.match(result.content[0]!.text, /Unknown engine "unknown"/);
  assert.deepEqual(harness.channelCalls.createProjectChat, []);
});

test("pending spin_out preserves its chosen engine and model", async () => {
  const self = workspace({ project: "ClearClaw" });
  const harness = makeHarness({
    workspaces: [self],
    projects: [{ name: "ClearClaw", description: "test", main_workspace: "self" }],
    peerChats: false,
  });

  await tool(harness, "spin_out").handler({
    name: "peer",
    brief: "test brief",
    engine: "claude-code",
    model: "claude-opus-4-6",
  });

  assert.equal(harness.pendingSpinOuts[0]?.engine, "claude-code");
  assert.equal(harness.pendingSpinOuts[0]?.model, "claude-opus-4-6");
});

test("spin_out rejects a missing explicit cwd without creating a chat or directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clearclaw-missing-cwd-"));
  const missingCwd = path.join(root, "mistyped");
  const main = workspace({ name: "main", cwd: root, chat_id: "test:main", project: "project" });
  const self = workspace({ project: "project" });
  const harness = makeHarness({
    workspaces: [self, main],
    projects: [{ name: "project", description: "test", main_workspace: "main" }],
  });

  try {
    const result = await tool(harness, "spin_out").handler({
      name: "peer",
      brief: "test brief",
      cwd: missingCwd,
    });

    assert.match(result.content[0]!.text, /must be an existing directory/);
    assert.equal(fs.existsSync(missingCwd), false);
    assert.deepEqual(harness.channelCalls.createProjectChat, []);
    assert.equal(harness.workspaces.some((candidate) => candidate.name === "peer"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("spin_out treats an explicitly empty cwd as invalid, not omitted", async () => {
  const repo = initRepo();
  const main = workspace({ name: "main", cwd: repo, chat_id: "test:main", project: "project" });
  const self = workspace({ cwd: repo, project: "project" });
  const harness = makeHarness({
    workspaces: [self, main],
    projects: [{ name: "project", description: "test", main_workspace: "main" }],
  });

  try {
    const result = await tool(harness, "spin_out").handler({
      name: "peer",
      brief: "test brief",
      cwd: "",
    });

    assert.match(result.content[0]!.text, /must be an existing directory/);
    assert.equal(fs.existsSync(path.join(repo, ".worktrees", "peer")), false);
    assert.deepEqual(harness.channelCalls.createProjectChat, []);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("spin_out persists external cwd as unowned", async () => {
  const externalCwd = fs.mkdtempSync(path.join(os.tmpdir(), "clearclaw-external-cwd-"));
  const main = workspace({ name: "main", cwd: externalCwd, chat_id: "test:main", project: "project" });
  const self = workspace({ project: "project" });
  const harness = makeHarness({
    workspaces: [self, main],
    projects: [{ name: "project", description: "test", main_workspace: "main" }],
  });

  try {
    await tool(harness, "spin_out").handler({
      name: "peer",
      brief: "test brief",
      cwd: externalCwd,
    });

    const peer = harness.workspaces.find((candidate) => candidate.name === "peer");
    assert.equal(peer?.cwd, externalCwd);
    assert.equal(peer?.owns_worktree, false);
  } finally {
    fs.rmSync(externalCwd, { recursive: true, force: true });
  }
});

test("spin_out delegates creation without reinitializing the Project section", async () => {
  const externalCwd = fs.mkdtempSync(path.join(os.tmpdir(), "clearclaw-section-spawn-"));
  const self = workspace({ cwd: externalCwd, project: "ClearClaw" });
  const harness = makeHarness({
    workspaces: [self],
    projects: [{ name: "ClearClaw", description: "test", main_workspace: "self" }],
  });

  try {
    await tool(harness, "spin_out").handler({
      name: "peer",
      brief: "test brief",
      cwd: externalCwd,
    });

    assert.deepEqual(harness.channelCalls.createProjectChat, [{
      projectName: "ClearClaw", anchor: "test:self", title: "peer",
    }]);
    assert.deepEqual(harness.channelCalls.setupProject, []);
  } finally {
    fs.rmSync(externalCwd, { recursive: true, force: true });
  }
});

test("project_create succeeds when optional section initialization fails", async () => {
  const harness = makeHarness({
    workspaces: [workspace()],
    lifecycleError: new Error("Project chat grouping unavailable"),
  });
  const result = await tool(harness, "project_create").handler({
    name: "ClearClaw", description: "test",
  });
  assert.match(result.content[0]!.text, /Project "ClearClaw" created/);
  assert.equal(harness.workspaces[0]?.project, "ClearClaw");
  assert.deepEqual(harness.channelCalls.closeProjectChat, []);
});

test("spin_out rollback never removes an explicit external cwd", async () => {
  const externalCwd = fs.mkdtempSync(path.join(os.tmpdir(), "clearclaw-external-rollback-"));
  const main = workspace({ name: "main", cwd: externalCwd, chat_id: "test:main", project: "project" });
  const self = workspace({ project: "project" });
  const harness = makeHarness({
    workspaces: [self, main],
    projects: [{ name: "project", description: "test", main_workspace: "main" }],
  });
  harness.config.upsertWorkspace = () => {
    throw new Error("persist failed");
  };

  try {
    const result = await tool(harness, "spin_out").handler({
      name: "peer",
      brief: "test brief",
      cwd: externalCwd,
    });

    assert.match(result.content[0]!.text, /persist failed/);
    assert.equal(fs.existsSync(externalCwd), true);
    assert.deepEqual(harness.channelCalls.closeProjectChat, [{ chatId: "test:peer", projectName: "project" }]);
  } finally {
    fs.rmSync(externalCwd, { recursive: true, force: true });
  }
});

test("spin_out owns its built-in worktree and removes it on rollback", async () => {
  const repo = initRepo();
  const worktree = path.join(repo, ".worktrees", "peer");
  const main = workspace({ name: "main", cwd: repo, chat_id: "test:main", project: "project" });
  const self = workspace({ cwd: repo, project: "project" });
  const harness = makeHarness({
    workspaces: [self, main],
    projects: [{ name: "project", description: "test", main_workspace: "main" }],
  });
  const channel = (harness.orchestrator as unknown as { channel: Channel }).channel;
  const createProjectChat = channel.createProjectChat;
  channel.createProjectChat = async () => {
    throw new Error("chat failed");
  };

  try {
    const result = await tool(harness, "spin_out").handler({
      name: "peer",
      brief: "test brief",
    });

    assert.match(result.content[0]!.text, /chat failed/);
    assert.equal(fs.existsSync(worktree), false);
    assert.equal(harness.workspaces.some((candidate) => candidate.name === "peer"), false);
  } finally {
    channel.createProjectChat = createProjectChat;
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("workspace_archive removes a ClearClaw-owned worktree", async () => {
  const repo = initRepo();
  const ownedCwd = createWorktree(repo, "peer");
  const self = workspace({ cwd: repo, project: "project" });
  const peer = workspace({
    name: "peer",
    cwd: ownedCwd,
    chat_id: "test:peer",
    project: "project",
    spawnedFrom: "self",
    owns_worktree: true,
  });
  const harness = makeHarness({
    workspaces: [self, peer],
    projects: [{ name: "project", description: "test", main_workspace: "self" }],
    interactiveResponse: "yes",
  });

  try {
    const result = await tool(harness, "workspace_archive").handler({ name: "peer" });

    assert.equal(fs.existsSync(ownedCwd), false);
    assert.doesNotMatch(result.content[0]!.text, /left in place/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("workspace_archive leaves an external worktree in place", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clearclaw-archive-external-"));
  const externalCwd = path.join(root, ".worktrees", "peer");
  fs.mkdirSync(externalCwd, { recursive: true });
  const self = workspace({ project: "project" });
  const peer = workspace({
    name: "peer",
    cwd: externalCwd,
    chat_id: "test:peer",
    project: "project",
    spawnedFrom: "self",
    owns_worktree: false,
  });
  const harness = makeHarness({
    workspaces: [self, peer],
    projects: [{ name: "project", description: "test", main_workspace: "self" }],
    interactiveResponse: "yes",
  });

  try {
    const result = await tool(harness, "workspace_archive").handler({ name: "peer" });

    assert.equal(fs.existsSync(externalCwd), true);
    assert.deepEqual(harness.channelCalls.closeProjectChat, [{ chatId: "test:peer", projectName: "project" }]);
    assert.equal(harness.workspaces.some((candidate) => candidate.name === "peer"), false);
    assert.match(result.content[0]!.text, /External worktree left in place; clean up with your own tooling\./);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace_archive leaves legacy unknown-ownership directories in place", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clearclaw-archive-legacy-"));
  const legacyCwd = path.join(root, ".worktrees", "peer");
  fs.mkdirSync(legacyCwd, { recursive: true });
  const self = workspace({ project: "project" });
  const peer = workspace({
    name: "peer",
    cwd: legacyCwd,
    chat_id: "test:peer",
    project: "project",
    spawnedFrom: "self",
  });
  const harness = makeHarness({
    workspaces: [self, peer],
    projects: [{ name: "project", description: "test", main_workspace: "self" }],
    interactiveResponse: "yes",
  });

  try {
    const result = await tool(harness, "workspace_archive").handler({ name: "peer" });

    assert.equal(fs.existsSync(legacyCwd), true);
    assert.match(result.content[0]!.text, /Workspace directory left in place because ClearClaw does not own it\./);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("workspace_archive closes only the archived peer with its Project context", async () => {
  const self = workspace({ project: "ClearClaw" });
  const peer = workspace({
    name: "peer",
    chat_id: "test:peer",
    project: "ClearClaw",
    spawnedFrom: "self",
    owns_worktree: false,
  });
  const harness = makeHarness({
    workspaces: [self, peer],
    projects: [{ name: "ClearClaw", description: "test", main_workspace: "self" }],
    interactiveResponse: "yes",
  });

  await tool(harness, "workspace_archive").handler({ name: "peer" });

  assert.deepEqual(harness.channelCalls.closeProjectChat, [{
    projectName: "ClearClaw", chatId: "test:peer",
  }]);
});

test("workspace_archive closes a pre-existing main chat when removing a Project", async () => {
  const main = workspace({ name: "main", project: "ClearClaw" });
  const harness = makeHarness({
    workspaces: [main],
    projects: [{ name: "ClearClaw", description: "test", main_workspace: "main" }],
    interactiveResponse: "yes",
  });

  await tool(harness, "workspace_archive").handler({ name: "main" });

  assert.deepEqual(harness.channelCalls.closeProjectChat, [{
    projectName: "ClearClaw", chatId: "test:self",
  }]);
});

test("workspace_archive closes an original main after another workspace becomes main", async () => {
  const harness = makeHarness({
    workspaces: [workspace({ project: "ClearClaw" }), workspace({ name: "peer", chat_id: "test:peer", project: "ClearClaw", spawnedFrom: "self" })],
    projects: [{ name: "ClearClaw", description: "test", main_workspace: "self" }],
    interactiveResponse: "yes",
  });
  await tool(harness, "project_update").handler({ name: "ClearClaw", main_workspace: "peer" });
  await tool(harness, "workspace_archive").handler({ name: "self" });
  assert.deepEqual(harness.channelCalls.closeProjectChat, [{ projectName: "ClearClaw", chatId: "test:self" }]);
  assert.equal(harness.projects[0]?.main_workspace, "peer");
});

test("workspace_archive refuses another channel's chat and leaves it bound", async () => {
  const harness = makeHarness({
    workspaces: [workspace({ name: "foreign", chat_id: "tg:123", project: "Foreign" })],
    projects: [{ name: "Foreign", description: "test", main_workspace: "foreign" }],
    interactiveResponse: "yes",
  });
  const result = await tool(harness, "workspace_archive").handler({ name: "foreign" });
  assert.match(result.content[0]!.text, /Cannot archive/);
  assert.equal(harness.workspaces.length, 1);
  assert.equal(harness.projects.length, 1);
  assert.deepEqual(harness.channelCalls.closeProjectChat, []);
});

test("workspace_archive preserves workspace and Project when chat closure fails", async () => {
  const harness = makeHarness({
    workspaces: [workspace({ name: "main", project: "ClearClaw" })],
    projects: [{ name: "ClearClaw", description: "test", main_workspace: "main" }],
    interactiveResponse: "yes",
    closeError: new Error("closure unavailable"),
  });
  const result = await tool(harness, "workspace_archive").handler({ name: "main" });
  assert.match(result.content[0]!.text, /closure unavailable.*Workspace remains bound/);
  assert.equal(harness.workspaces.length, 1);
  assert.equal(harness.projects.length, 1);
});

test("startup leaves existing Project grouping untouched", async () => {
  const harness = makeHarness({
    workspaces: [workspace({ project: "ClearClaw" })],
    projects: [{ name: "ClearClaw", description: "test", main_workspace: "self" }],
  });
  const signals = ["SIGINT", "SIGTERM"] as const;
  const before = signals.map((signal) => new Set(process.listeners(signal)));
  try {
    await harness.orchestrator.start();
    assert.deepEqual(harness.channelCalls.setupProject, []);
    assert.deepEqual(harness.channelCalls.closeProjectChat, []);
    assert.deepEqual(harness.channelCalls.createProjectChat, []);
  } finally {
    await harness.orchestrator.stop();
    signals.forEach((signal, i) => {
      for (const listener of process.listeners(signal)) {
        if (!before[i]!.has(listener)) process.removeListener(signal, listener);
      }
    });
  }
});

test("project_create adopts an unprojected workspace as Project main", async () => {
  const self = workspace();
  const harness = makeHarness({ workspaces: [self] });

  const result = await tool(harness, "project_create").handler({
    name: "ClearClaw",
    description: "ClearClaw development",
  });

  assert.match(result.content[0]!.text, /Project "ClearClaw" created with "self" as its main workspace/);
  assert.equal(harness.workspaces[0]?.project, "ClearClaw");
  assert.deepEqual(harness.projects, [{
    name: "ClearClaw",
    description: "ClearClaw development",
    main_workspace: "self",
  }]);
  assert.deepEqual(harness.channelCalls.setupProject, [{
    projectName: "ClearClaw", chatId: "test:self",
  }]);
});

test("spin_out sees a Project created earlier in the same turn", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clearclaw-create-then-spawn-"));
  const self = workspace({ cwd });
  const harness = makeHarness({ workspaces: [self] });

  try {
    await tool(harness, "project_create").handler({
      name: "ClearClaw",
      description: "ClearClaw development",
    });
    await tool(harness, "spin_out").handler({
      name: "peer",
      brief: "test brief",
      cwd,
    });

    const peer = harness.workspaces.find((candidate) => candidate.name === "peer");
    assert.equal(peer?.project, "ClearClaw");
    assert.equal(harness.pendingSpinOuts.length, 0);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("project_create refuses to silently reassign a workspace", async () => {
  const self = workspace({ project: "Existing" });
  const harness = makeHarness({
    workspaces: [self],
    projects: [{ name: "Existing", description: "existing", main_workspace: "self" }],
  });

  const result = await tool(harness, "project_create").handler({
    name: "Other",
    description: "other",
  });

  assert.match(result.content[0]!.text, /already belongs to project "Existing"/);
  assert.equal(harness.projects.some((project) => project.name === "Other"), false);
});

test("workspace_create inherits engine and model from a claimed pending spin-out", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clearclaw-pending-runtime-"));
  const harness = makeHarness({ workspaces: [workspace()] });
  harness.pendingSpinOuts.push({
    id: "pending1",
    fromWorkspace: "self",
    name: "peer",
    brief: "test brief",
    suggestedCwd: cwd,
    engine: "claude-code",
    model: "claude-opus-4-6",
    createdAt: Date.now(),
  });
  const workspaceCreate = taskTools(harness).find((candidate) => candidate.name === "workspace_create");
  assert.ok(workspaceCreate);

  try {
    await workspaceCreate.handler({
      name: "peer",
      cwd,
      description: "test brief",
      spin_out_id: "pending1",
    });

    const peer = harness.workspaces.find((candidate) => candidate.name === "peer");
    assert.equal(peer?.engine, "claude-code");
    assert.equal(peer?.model, "claude-opus-4-6");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("workspace_create drops a pending model when its engine is overridden", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "clearclaw-pending-engine-"));
  const harness = makeHarness({ workspaces: [workspace()] });
  harness.pendingSpinOuts.push({
    id: "pending1",
    fromWorkspace: "self",
    name: "peer",
    brief: "test brief",
    suggestedCwd: cwd,
    engine: "claude-code",
    model: "claude-opus-4-6",
    createdAt: Date.now(),
  });
  const workspaceCreate = taskTools(harness).find((candidate) => candidate.name === "workspace_create");
  assert.ok(workspaceCreate);

  try {
    await workspaceCreate.handler({
      name: "peer",
      cwd,
      description: "test brief",
      engine: "codex",
      spin_out_id: "pending1",
    });

    const peer = harness.workspaces.find((candidate) => candidate.name === "peer");
    assert.equal(peer?.engine, "codex");
    assert.equal(peer?.model, undefined);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("pending-brief fallback reports why one-tap spawning is unavailable", async () => {
  const cases = [
    {
      name: "no project",
      harness: makeHarness({ workspaces: [workspace()] }),
      reason: 'no project resolved for workspace "self"',
    },
    {
      name: "no main workspace",
      harness: makeHarness({
        workspaces: [workspace({ project: "project" })],
        projects: [{ name: "project", description: "test", main_workspace: "missing" }],
      }),
      reason: 'project "project" has no main workspace "missing"',
    },
    {
      name: "channel lacks Project chat lifecycle",
      harness: makeHarness({
        workspaces: [
          workspace({ project: "project" }),
          workspace({ name: "main", chat_id: "test:main", project: "project" }),
        ],
        projects: [{ name: "project", description: "test", main_workspace: "main" }],
        peerChats: false,
      }),
      reason: 'channel "test" lacks peer chat creation or closure',
    },
  ];

  for (const entry of cases) {
    const result = await tool(entry.harness, "spin_out").handler({
      name: `peer-${entry.name}`,
      brief: "test brief",
    });

    assert.equal(entry.harness.pendingSpinOuts.length, 1, entry.name);
    assert.match(entry.harness.channelCalls.messages.at(-1) ?? "", new RegExp(entry.reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.content[0]!.text, new RegExp(entry.reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("spin_out persists owned worktrees for successful built-in creation", async () => {
  const repo = initRepo();
  const main = workspace({ name: "main", cwd: repo, chat_id: "test:main", project: "project" });
  const self = workspace({ cwd: repo, project: "project" });
  const harness = makeHarness({
    workspaces: [self, main],
    projects: [{ name: "project", description: "test", main_workspace: "main" }],
  });

  try {
    await tool(harness, "spin_out").handler({
      name: "peer",
      brief: "test brief",
    });

    const peer = harness.workspaces.find((candidate) => candidate.name === "peer");
    assert.equal(peer?.owns_worktree, true);
    assert.equal(fs.existsSync(peer?.cwd ?? ""), true);
    removeWorktree(peer!.cwd);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
