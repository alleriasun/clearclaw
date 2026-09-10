import assert from "node:assert/strict";
import test from "node:test";
import { GrammyError } from "grammy";
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

test("createProjectChat rejects a Telegram group without Topics", async () => {
  const { channel, calls } = channelWithApi({ type: "supergroup", is_forum: false });

  await assert.rejects(
    channel.createProjectChat("ClearClaw", "tg:-1001", "peer"),
    /requires a forum supergroup\. Enable Topics manually in Telegram/,
  );
  assert.deepEqual(calls.getChat, [-1001]);
  assert.deepEqual(calls.createForumTopic, []);
});

test("createProjectChat validates before creating a Telegram topic", async () => {
  const { channel, calls } = channelWithApi({ type: "supergroup", is_forum: true });

  const chatId = await channel.createProjectChat("ClearClaw", "tg:-1001", "peer");

  assert.equal(chatId, "tg:-1001:42");
  assert.deepEqual(calls.getChat, [-1001]);
  assert.deepEqual(calls.createForumTopic, [{ chatId: -1001, title: "peer" }]);
});

test("createProjectChat requires Threaded Mode for a Telegram private chat", async () => {
  const { channel, calls } = channelWithApi({ type: "private" });

  await assert.rejects(
    channel.createProjectChat("default", "tg:123", "peer"),
    /requires Threaded Mode for this bot\. Enable it in BotFather/,
  );
  assert.equal(calls.getMe, 1);
  assert.deepEqual(calls.createForumTopic, []);
});

test("createProjectChat supports a Telegram private chat with Threaded Mode", async () => {
  const { channel, calls } = channelWithApi({ type: "private" }, true);

  const chatId = await channel.createProjectChat("default", "tg:123", "peer");

  assert.equal(chatId, "tg:123:42");
  assert.equal(calls.getMe, 1);
  assert.deepEqual(calls.createForumTopic, [{ chatId: 123, title: "peer" }]);
});

test("creating a project from an existing topic returns a sibling topic ID", async () => {
  const { channel, calls } = channelWithApi({ type: "private" }, true);
  const chatId = await channel.createProjectChat("new-project", "tg:123:40", "main");
  assert.match(chatId, /^tg:123:\d+$/);
  assert.equal(calls.createForumTopic[0].chatId, 123);
});

test("closeProjectChat deletes a Telegram private-chat topic", async () => {
  const { channel, calls } = channelWithApi({ type: "private" }, true);

  await channel.closeProjectChat("tg:123:42");

  assert.deepEqual(calls.deleteForumTopic, [{ chatId: 123, threadId: 42 }]);
  assert.deepEqual(calls.closeForumTopic, []);
});

test("closeProjectChat closes a Telegram supergroup topic", async () => {
  const { channel, calls } = channelWithApi({ type: "supergroup", is_forum: true });

  await channel.closeProjectChat("tg:-1001:42");

  assert.deepEqual(calls.closeForumTopic, [{ chatId: -1001, threadId: 42 }]);
  assert.deepEqual(calls.deleteForumTopic, []);
});

test("createProjectChat rejects an invalid Telegram anchor", async () => {
  const { channel, calls } = channelWithApi({ type: "supergroup", is_forum: true });

  await assert.rejects(
    channel.createProjectChat("ClearClaw", "tg:invalid", "peer"),
    /must use a valid chat ID/,
  );
  assert.deepEqual(calls.getChat, []);
});

test("closeProjectChat rejects whole Telegram chats without changing them", async () => {
  const { channel, calls } = channelWithApi({ type: "supergroup", is_forum: true });

  for (const chatId of ["tg:-1001", "tg:123"]) {
    await assert.rejects(channel.closeProjectChat(chatId), /cannot close a whole chat; only topics/);
  }

  assert.deepEqual(calls.closeForumTopic, []);
  assert.deepEqual(calls.deleteForumTopic, []);
});

test("closeProjectChat accepts an already-closed topic but propagates other API errors", async () => {
  const { channel } = channelWithApi({ type: "supergroup", is_forum: true });
  const bot = (channel as unknown as { bot: { api: { closeForumTopic: () => Promise<never> } } }).bot;
  const apiError = (description: string) => new GrammyError("close failed", {
    ok: false, error_code: 400, description,
  }, "closeForumTopic", { chat_id: -1001, message_thread_id: 42 });
  bot.api.closeForumTopic = async () => { throw apiError("Bad Request: TOPIC_NOT_MODIFIED"); };
  await channel.closeProjectChat("tg:-1001:42");
  const forbidden = apiError("Bad Request: CHAT_ADMIN_REQUIRED");
  bot.api.closeForumTopic = async () => { throw forbidden; };
  await assert.rejects(channel.closeProjectChat("tg:-1001:42"), (err) => err === forbidden);
});
