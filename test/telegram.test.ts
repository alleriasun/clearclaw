import assert from "node:assert/strict";
import test from "node:test";
import { TelegramChannel } from "../src/channel/telegram.js";

interface TelegramCalls {
  getChat: number[];
  getMe: number;
  createForumTopic: Array<{ chatId: number; title: string }>;
  closeForumTopic: Array<{ chatId: number; threadId: number }>;
  deleteForumTopic: Array<{ chatId: number; threadId: number }>;
}

function channelWithApi(
  chat: { type: string; is_forum?: boolean },
  hasTopicsEnabled = false,
): {
  channel: TelegramChannel;
  calls: TelegramCalls;
} {
  const channel = new TelegramChannel("test-token", () => true);
  const calls: TelegramCalls = {
    getChat: [],
    getMe: 0,
    createForumTopic: [],
    closeForumTopic: [],
    deleteForumTopic: [],
  };
  const api = {
    getChat: async (chatId: number) => {
      calls.getChat.push(chatId);
      return chat;
    },
    getMe: async () => {
      calls.getMe += 1;
      return { id: 1, is_bot: true, first_name: "ClearClaw", has_topics_enabled: hasTopicsEnabled };
    },
    createForumTopic: async (chatId: number, title: string) => {
      calls.createForumTopic.push({ chatId, title });
      return { message_thread_id: 42 };
    },
    closeForumTopic: async (chatId: number, threadId: number) => {
      calls.closeForumTopic.push({ chatId, threadId });
      return true;
    },
    deleteForumTopic: async (chatId: number, threadId: number) => {
      calls.deleteForumTopic.push({ chatId, threadId });
      return true;
    },
  };
  (channel as unknown as { bot: { api: typeof api } }).bot = { api };
  return { channel, calls };
}

test("projectChats.reconcile validates a Telegram forum supergroup", async () => {
  const { channel, calls } = channelWithApi({ type: "supergroup", is_forum: true });

  await channel.projectChats.reconcile("ClearClaw", ["tg:-1001", "tg:-1001:42"]);

  assert.deepEqual(calls.getChat, [-1001]);
});

test("projectChats.reconcile rejects a Telegram group without Topics", async () => {
  const { channel, calls } = channelWithApi({ type: "supergroup", is_forum: false });

  await assert.rejects(
    channel.projectChats.reconcile("ClearClaw", ["tg:-1001"]),
    /requires a forum supergroup\. Enable Topics manually in Telegram/,
  );
  assert.deepEqual(calls.getChat, [-1001]);
  assert.deepEqual(calls.createForumTopic, []);
});

test("projectChats.create validates before creating a Telegram topic", async () => {
  const { channel, calls } = channelWithApi({ type: "supergroup", is_forum: true });

  const chatId = await channel.projectChats.create("ClearClaw", "tg:-1001", "peer");

  assert.equal(chatId, "tg:-1001:42");
  assert.deepEqual(calls.getChat, [-1001]);
  assert.deepEqual(calls.createForumTopic, [{ chatId: -1001, title: "peer" }]);
});

test("projectChats.create requires Threaded Mode for a Telegram private chat", async () => {
  const { channel, calls } = channelWithApi({ type: "private" });

  await assert.rejects(
    channel.projectChats.create("default", "tg:123", "peer"),
    /requires Threaded Mode for this bot\. Enable it in BotFather/,
  );
  assert.equal(calls.getMe, 1);
  assert.deepEqual(calls.createForumTopic, []);
});

test("projectChats.create supports a Telegram private chat with Threaded Mode", async () => {
  const { channel, calls } = channelWithApi({ type: "private" }, true);

  const chatId = await channel.projectChats.create("default", "tg:123", "peer");

  assert.equal(chatId, "tg:123:42");
  assert.equal(calls.getMe, 1);
  assert.deepEqual(calls.createForumTopic, [{ chatId: 123, title: "peer" }]);
});

test("projectChats.close deletes a Telegram private-chat topic", async () => {
  const { channel, calls } = channelWithApi({ type: "private" }, true);

  await channel.projectChats.close("tg:123:42");

  assert.deepEqual(calls.deleteForumTopic, [{ chatId: 123, threadId: 42 }]);
  assert.deepEqual(calls.closeForumTopic, []);
});

test("projectChats.close closes a Telegram supergroup topic", async () => {
  const { channel, calls } = channelWithApi({ type: "supergroup", is_forum: true });

  await channel.projectChats.close("tg:-1001:42");

  assert.deepEqual(calls.closeForumTopic, [{ chatId: -1001, threadId: 42 }]);
  assert.deepEqual(calls.deleteForumTopic, []);
});

test("projectChats.reconcile requires one Telegram parent chat", async () => {
  const { channel, calls } = channelWithApi({ type: "supergroup", is_forum: true });

  await assert.rejects(
    channel.projectChats.reconcile("ClearClaw", ["tg:-1001", "tg:-1002:42"]),
    /must use one forum chat/,
  );
  assert.deepEqual(calls.getChat, []);
});
