import { describe, expect, test } from "bun:test";
import { willUploadToolUse } from "../src/hooks/post-tool-use";
import { visCapture } from "../src/visual";

/**
 * Regression for the 2026-09-01 audit finding: visCapture() printed "captured:"
 * before logToHonchoAsync() applied its gate, so the line announced an upload
 * that saveMessages/saveToolUse had already suppressed. The two sides now share
 * willUploadToolUse(); these assertions exist so they cannot drift apart again.
 */
describe("willUploadToolUse", () => {
  test("uploads only when saveToolUse is opted in AND saveMessages is not off", () => {
    expect(willUploadToolUse({ saveMessages: true, saveToolUse: true })).toBe(true);
    // saveMessages undefined means "not disabled" — the gate is `!== false`
    expect(willUploadToolUse({ saveToolUse: true })).toBe(true);
  });

  test("saveMessages:false suppresses upload even with saveToolUse on", () => {
    expect(willUploadToolUse({ saveMessages: false, saveToolUse: true })).toBe(false);
  });

  test("saveToolUse must be explicitly true — absent or false suppresses", () => {
    // This is the live config shape: saveToolUse has been false since 2026-08-21,
    // so tool calls were never uploaded regardless of saveMessages.
    expect(willUploadToolUse({ saveMessages: true, saveToolUse: false })).toBe(false);
    expect(willUploadToolUse({ saveMessages: true })).toBe(false);
    expect(willUploadToolUse({ saveMessages: true, saveToolUse: "true" })).toBe(false);
  });
});

describe("visCapture label", () => {
  function captureLine(fn: () => void): string {
    const original = console.log;
    let out = "";
    console.log = (line?: unknown) => { out += String(line); };
    try { fn(); } finally { console.log = original; }
    return out;
  }

  test("says plain 'captured' when the tool call will be uploaded", () => {
    const line = captureLine(() => visCapture("Ran: ls", true));
    expect(line).toContain("captured: Ran: ls");
    expect(line).not.toContain("upload disabled");
  });

  test("says 'upload disabled' when it will not — the bug this file guards", () => {
    const line = captureLine(() => visCapture("Ran: ls", false));
    expect(line).toContain("captured (upload disabled): Ran: ls");
  });

  test("label tracks the gate for the live config shape (saveToolUse:false)", () => {
    const config = { saveMessages: true, saveToolUse: false };
    const line = captureLine(() => visCapture("Ran: ls", willUploadToolUse(config)));
    expect(line).toContain("upload disabled");
  });
});
