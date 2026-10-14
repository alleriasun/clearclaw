import assert from "node:assert/strict";
import test from "node:test";
import { isAudio, isComplete, reduceTranscriptFrames } from "../src/transcribe.js";

test("a later transcript frame replaces the current segment", () => {
  assert.equal(reduceTranscriptFrames([
    { type: "TranscriptText", data: "Hey" },
    { type: "TranscriptText", data: "Hey Clear" },
    { type: "TranscriptEndpoint" },
  ]), "Hey Clear");
});

test("finalized segments join with a trailing partial", () => {
  assert.equal(reduceTranscriptFrames([
    { type: "TranscriptText", data: "a b" },
    { type: "TranscriptEndpoint" },
    { type: "TranscriptInterim", data: "c" },
    { type: "TranscriptEndpoint" },
    { type: "TranscriptText", data: "d" },
  ]), "a b c d");
});

test("isAudio matches audio MIME types only", () => {
  assert.equal(isAudio({ buffer: Buffer.alloc(0), mimeType: "audio/ogg" }), true);
  assert.equal(isAudio({ buffer: Buffer.alloc(0), mimeType: "image/jpeg" }), false);
});

test("a stream is complete only when its last frame is an Endpoint", () => {
  assert.equal(isComplete([{ type: "TranscriptText" }, { type: "TranscriptEndpoint" }]), true);
  assert.equal(isComplete([{ type: "TranscriptEndpoint" }, { type: "TranscriptText" }]), false);
  assert.equal(isComplete([]), false);
});
