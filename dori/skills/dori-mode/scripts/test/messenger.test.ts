import { expect, test } from "bun:test";

import { transcribe, TranscriptionError } from "../src/messenger/voice.ts";

test("a voice note becomes text through the configured hook, and a failing or empty transcription is an error", async () => {
  const calls: string[][] = [];
  const run = async (argv: readonly string[]) => { calls.push([...argv]); return { code: 0, out: "  ship it  ", err: "" }; };
  expect(await transcribe(run, ["stt", "--file", "{file}"], "/tmp/v 1.ogg")).toBe("ship it");
  expect(calls[0]).toEqual(["stt", "--file", "/tmp/v 1.ogg"]);
  await expect(transcribe(async () => ({ code: 0, out: "", err: "" }), ["stt", "{file}"], "/a.ogg")).rejects.toBeInstanceOf(TranscriptionError);
  await expect(transcribe(run, undefined, "/a.ogg")).rejects.toBeInstanceOf(TranscriptionError);
});
