import assert from "node:assert/strict";
import test from "node:test";
import { SlackChannel } from "../src/channel/slack.js";

interface SlackCalls {
  create: Array<{ name: string; is_private?: boolean }>;
  invite: Array<{ channel: string; users: string }>;
  archive: Array<{ channel: string }>;
}

function channelWithClient(
  userIds: string[],
  overrides: {
    invite?: () => Promise<never>;
    archive?: () => Promise<unknown>;
  } = {},
): { channel: SlackChannel; calls: SlackCalls } {
  const channel = new SlackChannel("xoxb-test", "xapp-test", () => true, undefined, () => userIds);
  const calls: SlackCalls = { create: [], invite: [], archive: [] };
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
  };
  (channel as unknown as { app: { client: typeof client } }).app = { client };
  return { channel, calls };
}

test("createChat creates a private channel and invites authorized Slack users", async () => {
  const { channel, calls } = channelWithClient([
    "slack:UONE",
    "tg:123",
    "slack:UTWO",
    "slack:UONE",
  ]);

  const chatId = await channel.createChat("slack:CMAIN", "Résumé Review!");

  assert.equal(chatId, "slack:CPEER");
  assert.deepEqual(calls.create, [{ name: "resume-review", is_private: true }]);
  assert.deepEqual(calls.invite, [{ channel: "CPEER", users: "UONE,UTWO" }]);
});

test("createChat archives the new channel when inviting users fails", async () => {
  const inviteError = new Error("invite failed");
  const { channel, calls } = channelWithClient(
    ["slack:UONE"],
    { invite: async () => { throw inviteError; } },
  );

  await assert.rejects(
    channel.createChat("slack:CMAIN", "peer"),
    (err) => err === inviteError,
  );
  assert.deepEqual(calls.archive, [{ channel: "CPEER" }]);
});

test("closeChat treats an already archived channel as closed", async () => {
  const { channel, calls } = channelWithClient(
    ["slack:UONE"],
    { archive: async () => { throw { data: { error: "already_archived" } }; } },
  );

  await channel.closeChat("slack:CPEER");

  assert.deepEqual(calls.archive, [{ channel: "CPEER" }]);
});
