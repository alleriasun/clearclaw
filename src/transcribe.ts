import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Attachment } from "./types.js";

const RATE = 16000;
const FRAME_BYTES = RATE * 2 / 10; // 100 ms of s16le mono
const STREAM_URL = "wss://api.anthropic.com/api/ws/speech_to_text/voice_stream?" + new URLSearchParams({
  encoding: "linear16", sample_rate: String(RATE), channels: "1", endpointing_ms: "300", utterance_end_ms: "1000",
  language: "en", use_conversation_engine: "true", stt_provider: "deepgram-nova3",
});

export function isAudio(att: Attachment): boolean {
  return att.mimeType.startsWith("audio/");
}

/** Interim/Text frames replace the current segment; Endpoint finalizes it. */
export function reduceTranscriptFrames(frames: Array<{ type: string; data?: string }>): string {
  const finals: string[] = [];
  let current = "";
  for (const f of frames) {
    if (f.type === "TranscriptInterim" || f.type === "TranscriptText") current = f.data ?? "";
    else if (f.type === "TranscriptEndpoint") {
      if (current) finals.push(current);
      current = "";
    }
  }
  return [...finals, current].filter(Boolean).join(" ").trim();
}

/** The service's last word on a stream is an Endpoint; anything else means text may still be coming. */
export function isComplete(frames: Array<{ type: string }>): boolean {
  return frames.at(-1)?.type === "TranscriptEndpoint";
}

/** Speech-to-text via the stream Claude Code's /voice uses, authenticated with the Claude.ai OAuth token. */
export async function transcribeAudio(att: Attachment): Promise<string> {
  const token = readClaudeToken();
  if (!token) throw new Error("no Claude.ai credentials");
  const pcm = await decodeToPcm16k(att.buffer);
  const text = await voiceStream(pcm, token);
  if (!text) throw new Error("empty transcript");
  return text;
}

function readClaudeToken(): string | null {
  try {
    const raw = process.platform === "darwin"
      ? execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 })
      : fs.readFileSync(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8");
    const oauth = JSON.parse(raw).claudeAiOauth;
    if (!oauth?.accessToken || !(oauth.expiresAt > Date.now())) return null;
    return oauth.accessToken;
  } catch {
    return null;
  }
}

// The service requires an explicit PCM encoding; it does not accept OGG/Opus.
function decodeToPcm16k(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-loglevel", "error", "-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", String(RATE), "pipe:1"], { timeout: 30_000 });
    const out: Buffer[] = [];
    let stderr = "";
    ff.stdout.on("data", (c: Buffer) => out.push(c));
    ff.stderr.on("data", (c: Buffer) => (stderr += c));
    ff.on("error", (e) => reject(new Error(`ffmpeg failed: ${e.message}`)));
    ff.on("close", (code) => {
      const pcm = Buffer.concat(out);
      if (code === 0 && pcm.length > 0) resolve(pcm);
      else reject(new Error(`ffmpeg failed: ${stderr.trim().split("\n").pop() || `exit ${code}`}`));
    });
    ff.stdin.on("error", () => {}); // ffmpeg can exit before reading all input; "close" reports why
    ff.stdin.end(input);
  });
}

function voiceStream(pcm: Buffer, token: string): Promise<string> {
  // The service trims ~0.5 s at each end; pad with silence so the first and last words survive.
  const pad = Buffer.alloc(RATE); // 0.5 s
  const audio = Buffer.concat([pad, pcm, pad]);
  const durationMs = (pcm.length / 2 / RATE) * 1000;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(STREAM_URL, { headers: {
      Authorization: `Bearer ${token}`, "User-Agent": "claude-cli/2.1.284 (external, cli)",
      "x-app": "cli", "anthropic-client-platform": "claude_code_cli",
    } } as unknown as string[]); // Node (undici) accepts { headers }; the DOM typings do not
    ws.binaryType = "arraybuffer";
    const frames: Array<{ type: string; data?: string }> = [];
    let closing = false;
    let done = false;
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let safety: ReturnType<typeof setTimeout> | undefined;

    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      clearInterval(keepalive); clearTimeout(idle); clearTimeout(safety);
      try { ws.close(); } catch { /* already closed */ }
      if (err) reject(err);
      else resolve(reduceTranscriptFrames(frames));
    };
    // Finish on idle rather than on the first Endpoint after CloseStream: with unpaced
    // sending, that endpoint can arrive before the tail of the audio is transcribed.
    // A partial transcript is never a success: an incomplete stream waits for the safety timeout.
    const bump = () => {
      if (!closing) return;
      clearTimeout(idle);
      idle = setTimeout(() => { if (isComplete(frames)) finish(); }, 1500);
    };
    safety = setTimeout(() => finish(new Error("timed out")), 15_000 + durationMs);

    ws.onopen = () => {
      const keepAlive = () => ws.send(JSON.stringify({ type: "KeepAlive" }));
      keepAlive();
      keepalive = setInterval(keepAlive, 8000);
      for (let off = 0; off < audio.length; off += FRAME_BYTES) ws.send(audio.subarray(off, off + FRAME_BYTES));
      closing = true;
      ws.send(JSON.stringify({ type: "CloseStream" }));
      bump();
    };
    ws.onmessage = (ev) => {
      let msg: { type?: string; data?: unknown };
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString());
      } catch {
        return;
      }
      bump();
      if (msg.type === "TranscriptError" || msg.type === "error") {
        finish(new Error(`voice stream error: ${JSON.stringify(msg.data ?? msg).slice(0, 200)}`));
      } else if (msg.type) {
        frames.push({ type: msg.type, data: typeof msg.data === "string" ? msg.data : undefined });
      }
    };
    ws.onerror = () => finish(new Error("voice stream error: connection failed"));
    ws.onclose = (ev) => {
      if (closing && isComplete(frames)) finish();
      else finish(new Error(`voice stream error: closed ${ev.code} ${ev.reason}`.trim()));
    };
  });
}
