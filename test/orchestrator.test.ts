import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Config, PendingSpinOut, Project } from "../src/config.js";
import { Orchestrator } from "../src/orchestrator.js";
import type { Channel, Workspace } from "../src/types.js";
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
    closeChat: string[];
    createChat: Array<{ anchor: string; title: string }>;
    messages: string[];
  };
  config: Config;
  orchestrator: Orchestrator;
  pendingSpinOuts: PendingSpinOut[];
  tools: TestTool[];
  workspaces: Workspace[];
}

function makeHarness(options: {
  workspaces: Workspace[];
  projects?: Project[];
  createChat?: boolean;
  interactiveResponse?: string;
}): Harness {
  const workspaces = [...options.workspaces];
  const projects = [...(options.projects ?? [])];
  const pendingSpinOuts: PendingSpinOut[] = [];
  const channelCalls = {
    closeChat: [] as string[],
    createChat: [] as Array<{ anchor: string; title: string }>,
    messages: [] as string[],
  };
  const channel = {
    name: "test",
    sendInteractive: async () => ({ value: options.interactiveResponse ?? "spawn" }),
    sendMessage: async (_chatId: string, text: string) => {
      channelCalls.messages.push(text);
      return ["message-id"];
    },
    closeChat: async (chatId: string) => {
      channelCalls.closeChat.push(chatId);
    },
    ...(options.createChat === false
      ? {}
      : {
          createChat: async (anchor: string, title: string) => {
            channelCalls.createChat.push({ anchor, title });
            return "test:peer";
          },
        }),
  } as unknown as Channel;
  const config = {
    homeWorkspacePath: "/tmp/clearclaw-home",
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
    projectByName: (name: string) => projects.find((project) => project.name === name),
    removeProject: (name: string) => {
      const index = projects.findIndex((project) => project.name === name);
      return index >= 0 ? projects.splice(index, 1)[0] : undefined;
    },
    addSpinOut: (entry: PendingSpinOut) => pendingSpinOuts.push(entry),
  } as unknown as Config;
  const orchestrator = new Orchestrator({ channel, engines: new Map(), config });
  orchestrator.deliverToWorkspace = () => true;
  const tools = (orchestrator as unknown as {
    buildMcpTools(
      chatId: string,
      behavior: "assistant" | "relay",
      turnState: { staySilent: boolean; replyToMessageId: string | null },
    ): TestTool[];
  }).buildMcpTools("test:self", "relay", { staySilent: false, replyToMessageId: null });
  return { channelCalls, config, orchestrator, pendingSpinOuts, tools, workspaces };
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
  assert.match(spinOut.description, /channel supports createChat/);
  assert.match(spinOut.description, /path must already exist/);
  assert.match(spinOut.description, /never create or remove it/);
  assert.doesNotMatch(spinOut.description, /forum/);
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
    assert.deepEqual(harness.channelCalls.createChat, []);
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
    assert.deepEqual(harness.channelCalls.createChat, []);
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
    assert.deepEqual(harness.channelCalls.closeChat, ["test:peer"]);
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
  const createChat = (harness.orchestrator as unknown as { channel: Channel }).channel.createChat;
  (harness.orchestrator as unknown as { channel: Channel }).channel.createChat = async () => {
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
    (harness.orchestrator as unknown as { channel: Channel }).channel.createChat = createChat;
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
    assert.deepEqual(harness.channelCalls.closeChat, ["test:peer"]);
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
      name: "channel lacks createChat",
      harness: makeHarness({
        workspaces: [
          workspace({ project: "project" }),
          workspace({ name: "main", chat_id: "test:main", project: "project" }),
        ],
        projects: [{ name: "project", description: "test", main_workspace: "main" }],
        createChat: false,
      }),
      reason: 'channel "test" lacks createChat capability',
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
