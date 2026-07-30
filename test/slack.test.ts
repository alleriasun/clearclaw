import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { SlackChannel } from "../src/channel/slack.js";

interface SlackCalls {
  create: Array<{ name: string; is_private?: boolean }>;
  invite: Array<{ channel: string; users: string }>;
  archive: Array<{ channel: string }>;
  api: Array<{ method: string; args: Record<string, unknown> }>;
}

function channelWithClient(
  userIds: string[],
  overrides: {
    invite?: () => Promise<never>;
    archive?: () => Promise<unknown>;
    apiCall?: (method: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  } = {},
): { channel: SlackChannel; calls: SlackCalls } {
  const channel = new SlackChannel("xoxb-test", "xapp-test", () => true, undefined, () => userIds);
  const calls: SlackCalls = { create: [], invite: [], archive: [], api: [] };
  const client = {
    conversations: {
      create: async (args: { name: string; is_private?: boolean }) => {
        calls.create.push(args);
        return { channel: { id: "CPEER" } };
      },
      invite: async (args: { channel: string; users: string }) => {
        calls.invite.push(args);
        if (overrides.invite) return overrides.invite();
        return {};
      },
      archive: async (args: { channel: string }) => {
        calls.archive.push(args);
        if (overrides.archive) return overrides.archive();
        return {};
      },
    },
    apiCall: async (method: string, args: Record<string, unknown>) => {
      calls.api.push({ method, args });
      if (overrides.apiCall) return overrides.apiCall(method, args);
      if (method === "usergroups.list") return { usergroups: [] };
      if (method === "usergroups.create") {
        return { usergroup: { id: "SSECTION", handle: args.handle } };
      }
      return {};
    },
  };
  (channel as unknown as { app: { client: typeof client } }).app = { client };
  return { channel, calls };
}

function projectMarker(projectName: string): string {
  const hash = createHash("sha256").update(projectName).digest("hex").slice(0, 16);
  return `Managed by ClearClaw (${hash})`;
}

function collisionHandle(projectName: string): string {
  const hash = createHash("sha256").update(projectName).digest("hex").slice(0, 6);
  return `cc-${projectName.toLowerCase()}-${hash}`;
}

test("constructing a Slack channel does not start Slack I/O", () => {
  const channel = new SlackChannel("xoxb-test", "xapp-test", () => true);

  assert.equal((channel as unknown as { app?: unknown }).app, undefined);
});

test("projectChats.create creates a private channel and invites authorized Slack users", async () => {
  const { channel, calls } = channelWithClient([
    "slack:UONE",
    "tg:123",
    "slack:UTWO",
    "slack:UONE",
  ]);

  const chatId = await channel.projectChats.create("ClearClaw", "slack:CMAIN", "Résumé Review!");

  assert.equal(chatId, "slack:CPEER");
  assert.deepEqual(calls.create, [{ name: "resume-review", is_private: true }]);
  assert.deepEqual(calls.invite, [{ channel: "CPEER", users: "UONE,UTWO" }]);
});

test("projectChats.create archives the new channel when inviting users fails", async () => {
  const inviteError = new Error("invite failed");
  const { channel, calls } = channelWithClient(
    ["slack:UONE"],
    { invite: async () => { throw inviteError; } },
  );

  await assert.rejects(
    channel.projectChats.create("ClearClaw", "slack:CMAIN", "peer"),
    (err) => err === inviteError,
  );
  assert.deepEqual(calls.archive, [{ channel: "CPEER" }]);
});

test("projectChats.close treats an already archived channel as closed", async () => {
  const { channel, calls } = channelWithClient(
    ["slack:UONE"],
    { archive: async () => { throw { data: { error: "already_archived" } }; } },
  );

  await channel.projectChats.close("slack:CPEER");

  assert.deepEqual(calls.archive, [{ channel: "CPEER" }]);
});

test("projectChats.reconcile creates a shared section with Project chats and authorized users", async () => {
  const { channel, calls } = channelWithClient([
    "slack:UONE",
    "tg:123",
    "slack:UTWO",
    "slack:UONE",
  ]);

  await channel.projectChats.reconcile("Résumé Review!", [
    "slack:DHOME",
    "slack:CMAIN",
    "slack:CPEER",
    "slack:CPEER",
  ]);

  assert.deepEqual(calls.api, [
    {
      method: "usergroups.list",
      args: { include_disabled: true },
    },
    {
      method: "usergroups.create",
      args: {
        name: "Résumé Review!",
        handle: "cc-resume-review",
        description: projectMarker("Résumé Review!"),
        channels: "CMAIN,CPEER",
        enable_section: true,
      },
    },
    {
      method: "usergroups.users.update",
      args: { usergroup: "SSECTION", users: "UONE,UTWO" },
    },
  ]);
});

test("projectChats.reconcile treats a Project containing only a Slack DM as empty", async () => {
  const { channel, calls } = channelWithClient(["slack:UONE"]);

  await channel.projectChats.reconcile("default", ["slack:DHOME"]);

  assert.deepEqual(calls.api, [{
    method: "usergroups.list",
    args: { include_disabled: true },
  }]);
});

test("projectChats.reconcile re-enables and updates its existing User Group", async () => {
  const { channel, calls } = channelWithClient(
    ["slack:UONE"],
    {
      apiCall: async (method) => method === "usergroups.list"
        ? {
            usergroups: [{
              id: "SEXISTING",
              handle: "cc-clearclaw",
              description: projectMarker("ClearClaw"),
              date_delete: 123,
            }],
          }
        : {},
    },
  );

  await channel.projectChats.reconcile("ClearClaw", ["slack:CMAIN", "slack:CPEER"]);

  assert.deepEqual(calls.api, [
    {
      method: "usergroups.list",
      args: { include_disabled: true },
    },
    {
      method: "usergroups.enable",
      args: { usergroup: "SEXISTING" },
    },
    {
      method: "usergroups.update",
      args: {
        usergroup: "SEXISTING",
        name: "ClearClaw",
        handle: "cc-clearclaw",
        description: projectMarker("ClearClaw"),
        channels: "CMAIN,CPEER",
        enable_section: true,
      },
    },
    {
      method: "usergroups.users.update",
      args: { usergroup: "SEXISTING", users: "UONE" },
    },
  ]);
});

test("projectChats.reconcile disables its User Group for an empty chat set", async () => {
  const { channel, calls } = channelWithClient(
    ["slack:UONE"],
    {
      apiCall: async (method) => method === "usergroups.list"
        ? {
            usergroups: [{
              id: "SEXISTING",
              handle: "cc-clearclaw",
              description: projectMarker("ClearClaw"),
              date_delete: 0,
            }],
          }
        : {},
    },
  );

  await channel.projectChats.reconcile("ClearClaw", []);

  assert.deepEqual(calls.api, [
    {
      method: "usergroups.list",
      args: { include_disabled: true },
    },
    {
      method: "usergroups.disable",
      args: { usergroup: "SEXISTING" },
    },
  ]);
});

test("projectChats.reconcile leaves a human-owned handle alone and uses a stable fallback", async () => {
  const { channel, calls } = channelWithClient(
    ["slack:UONE"],
    {
      apiCall: async (method, args) => {
        if (method === "usergroups.list") {
          return {
            usergroups: [{
              id: "SHUMAN",
              handle: "cc-clearclaw",
              description: "Human-managed group",
            }],
          };
        }
        if (method === "usergroups.create") {
          return { usergroup: { id: "SSECTION", handle: args.handle } };
        }
        return {};
      },
    },
  );

  await channel.projectChats.reconcile("ClearClaw", ["slack:CMAIN"]);

  assert.deepEqual(calls.api, [
    {
      method: "usergroups.list",
      args: { include_disabled: true },
    },
    {
      method: "usergroups.create",
      args: {
        name: "ClearClaw",
        handle: collisionHandle("ClearClaw"),
        description: projectMarker("ClearClaw"),
        channels: "CMAIN",
        enable_section: true,
      },
    },
    {
      method: "usergroups.users.update",
      args: { usergroup: "SSECTION", users: "UONE" },
    },
  ]);
});

test("projectChats.reconcile never disables a human-owned User Group", async () => {
  const { channel, calls } = channelWithClient(
    ["slack:UONE"],
    {
      apiCall: async (method) => method === "usergroups.list"
        ? {
            usergroups: [{
              id: "SHUMAN",
              handle: "cc-clearclaw",
              description: "Human-managed group",
            }],
          }
        : {},
    },
  );

  await channel.projectChats.reconcile("ClearClaw", []);

  assert.deepEqual(calls.api, [{
    method: "usergroups.list",
    args: { include_disabled: true },
  }]);
});
