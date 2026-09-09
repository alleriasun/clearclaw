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
    create?: () => Promise<{ channel: { id: string } }>;
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
        if (overrides.create) return overrides.create();
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

test("createProjectChat creates a private channel and invites authorized Slack users", async () => {
  const { channel, calls } = channelWithClient([
    "slack:UONE",
    "tg:123",
    "slack:UTWO",
    "slack:UONE",
  ]);

  const chatId = await channel.createProjectChat("ClearClaw", "slack:CMAIN", "Résumé Review!");

  assert.equal(chatId, "slack:CPEER");
  assert.deepEqual(calls.create, [{ name: "resume-review", is_private: true }]);
  assert.deepEqual(calls.invite, [{ channel: "CPEER", users: "UONE,UTWO" }]);
});

test("createProjectChat archives the new channel when inviting users fails", async () => {
  const inviteError = new Error("invite failed");
  const { channel, calls } = channelWithClient(
    ["slack:UONE"],
    { invite: async () => { throw inviteError; } },
  );

  await assert.rejects(
    channel.createProjectChat("ClearClaw", "slack:CMAIN", "peer"),
    (err) => err === inviteError,
  );
  assert.deepEqual(calls.archive, [{ channel: "CPEER" }]);
});

for (const code of ["already_archived", "channel_not_found"]) {
  test(`closeProjectChat removes section membership when Slack reports ${code}`, async () => {
    const { channel, calls } = channelWithClient(["slack:UONE"], {
      archive: async () => { throw { data: { error: code } }; },
      apiCall: async (method) => method === "usergroups.list" ? {
        usergroups: [{
          id: "SSECTION", description: projectMarker("ClearClaw"),
          prefs: { channels: ["CMAIN", "CPEER"] },
        }],
      } : {},
    });

    await channel.closeProjectChat("slack:CPEER", "ClearClaw");

    assert.deepEqual(calls.archive, [{ channel: "CPEER" }]);
    assert.deepEqual(calls.api.at(-1), {
      method: "usergroups.update", args: { usergroup: "SSECTION", channels: "CMAIN" },
    });
  });
}

test("closeProjectChat keeps section membership when channel archival fails", async () => {
  const error = new Error("missing permission");
  const { channel, calls } = channelWithClient(["slack:UONE"], {
    archive: async () => { throw error; },
  });

  await assert.rejects(channel.closeProjectChat("slack:CMAIN", "ClearClaw"), (err) => err === error);

  assert.deepEqual(calls.api, []);
});

test("project creation initializes a shared section and its authorized users once", async () => {
  const { channel, calls } = channelWithClient(["slack:UONE", "tg:123", "slack:UTWO", "slack:UONE"]);

  await channel.setupProject("Résumé Review!", "slack:CMAIN");

  assert.deepEqual(calls.api, [
    { method: "usergroups.list", args: { include_disabled: true } },
    {
      method: "usergroups.create",
      args: {
        name: "Résumé Review!", handle: "cc-resume-review", description: projectMarker("Résumé Review!"),
        channels: "CMAIN", enable_section: true,
      },
    },
    { method: "usergroups.users.update", args: { usergroup: "SSECTION", users: "UONE,UTWO" } },
  ]);
});

test("project creation skips a Slack DM without Slack I/O", async () => {
  const { channel, calls } = channelWithClient(["slack:UONE"]);
  await channel.setupProject("default", "slack:DHOME");
  assert.deepEqual(calls.api, []);
});

test("lifecycle changes preserve live manual section edits and update only the affected channel", async () => {
  const group = {
    id: "SEXISTING", name: "My custom name", handle: "my-custom-handle",
    description: projectMarker("ClearClaw"), users: ["UHUMAN"], date_delete: 0,
    prefs: { channels: ["CMANUAL"], groups: ["GMANUAL"] },
  };
  const { channel, calls } = channelWithClient(["slack:UONE"], {
    apiCall: async (method, args) => {
      if (method === "usergroups.list") return { usergroups: [structuredClone(group)] };
      if (method === "usergroups.update") {
        group.prefs = { channels: String(args.channels).split(",").filter(Boolean), groups: [] };
      }
      return {};
    },
  });

  await channel.setupProject("ClearClaw", "slack:CMAIN");
  await channel.createProjectChat("ClearClaw", "slack:CMAIN", "peer");
  // A human removes the main, adds another channel, and changes the group after spawning.
  group.prefs.channels = ["CMANUAL", "GMANUAL", "CPEER", "CNEW"];
  group.name = "Renamed again";
  group.handle = "renamed-again";
  group.users = ["UOTHER"];
  await channel.closeProjectChat("slack:CPEER", "ClearClaw");

  assert.deepEqual(calls.api.filter((call) => call.method !== "usergroups.list"), [
    { method: "usergroups.update", args: { usergroup: "SEXISTING", channels: "CMANUAL,GMANUAL,CMAIN" } },
    { method: "usergroups.update", args: { usergroup: "SEXISTING", channels: "CMANUAL,GMANUAL,CMAIN,CPEER" } },
    { method: "usergroups.update", args: { usergroup: "SEXISTING", channels: "CMANUAL,GMANUAL,CNEW" } },
  ]);
  assert.equal(calls.api.filter((call) => call.method === "usergroups.list").length, 3);
  assert.deepEqual(group.users, ["UOTHER"]);
  assert.equal(group.name, "Renamed again");
});

test("closing an existing main channel archives it and clears the section without disabling it", async () => {
  const { channel, calls } = channelWithClient(["slack:UONE"], {
    apiCall: async (method) => method === "usergroups.list" ? {
      usergroups: [{ id: "SEXISTING", description: projectMarker("ClearClaw"), prefs: { channels: ["CMAIN"] } }],
    } : {},
  });
  await channel.closeProjectChat("slack:CMAIN", "ClearClaw");
  assert.deepEqual(calls.create, []);
  assert.deepEqual(calls.archive, [{ channel: "CMAIN" }]);
  assert.deepEqual(calls.api, [
    { method: "usergroups.list", args: { include_disabled: true } },
    { method: "usergroups.update", args: { usergroup: "SEXISTING", channels: "" } },
  ]);
});

test("disabled sections stay disabled during initialization, spawn, and archive", async () => {
  const { channel, calls } = channelWithClient(["slack:UONE"], {
    apiCall: async (method) => method === "usergroups.list" ? {
      usergroups: [{ id: "SEXISTING", description: projectMarker("ClearClaw"), date_delete: 123 }],
    } : {},
  });
  await channel.setupProject("ClearClaw", "slack:CMAIN");
  await channel.createProjectChat("ClearClaw", "slack:CMAIN", "peer");
  await channel.closeProjectChat("slack:CPEER", "ClearClaw");
  assert.deepEqual(calls.api.map((call) => call.method), ["usergroups.list", "usergroups.list", "usergroups.list"]);
});

test("spawn and archive leave missing or human-owned sections alone", async () => {
  for (const usergroups of [[], [{ id: "SHUMAN", handle: "cc-clearclaw", description: "Human managed" }]]) {
    const { channel, calls } = channelWithClient(["slack:UONE"], {
      apiCall: async () => ({ usergroups }),
    });
    await channel.createProjectChat("ClearClaw", "slack:CMAIN", "peer");
    await channel.closeProjectChat("slack:CPEER", "ClearClaw");
    assert.deepEqual(calls.api.map((call) => call.method), ["usergroups.list", "usergroups.list"]);
  }
});

test("project initialization leaves human-owned handles alone and uses a stable fallback", async () => {
  const { channel, calls } = channelWithClient(["slack:UONE"], {
    apiCall: async (method) => {
      if (method === "usergroups.list") return {
        usergroups: [{ id: "SHUMAN", handle: "cc-clearclaw", description: "Human managed" }],
      };
      if (method === "usergroups.create") return { usergroup: { id: "SSECTION" } };
      return {};
    },
  });
  await channel.setupProject("ClearClaw", "slack:CMAIN");
  assert.deepEqual(calls.api.find((call) => call.method === "usergroups.create")?.args, {
    name: "ClearClaw", handle: collisionHandle("ClearClaw"), description: projectMarker("ClearClaw"),
    channels: "CMAIN", enable_section: true,
  });
});

test("section API failures leave chat creation and closure successful", async () => {
  const { channel, calls } = channelWithClient(["slack:UONE"], {
    apiCall: async () => { throw new Error("Slack section unavailable"); },
  });
  assert.equal(await channel.createProjectChat("ClearClaw", "slack:CMAIN", "peer"), "slack:CPEER");
  await channel.setupProject("ClearClaw", "slack:CMAIN");
  await channel.closeProjectChat("slack:CPEER", "ClearClaw");
  assert.deepEqual(calls.archive, [{ channel: "CPEER" }]);
  assert.equal(calls.api.length, 3);
});
