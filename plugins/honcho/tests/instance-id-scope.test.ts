import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// config.ts and cache.ts both resolve ~/.honcho via a module-level homedir()
// const, so these run in a child process with HOME pointed at a fixture.
function runInSandbox(home: string, script: string): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("HONCHO_"))
  ) as Record<string, string>;
  const proc = Bun.spawnSync(["bun", "-e", script], {
    env: { ...env, HOME: home },
    cwd: join(import.meta.dir, ".."),
  });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
}

function fixture(cache: Record<string, unknown>): { home: string; a: string; b: string; c: string } {
  const home = mkdtempSync(join(tmpdir(), "honcho-home-"));
  const a = join(home, "alpha");
  const b = join(home, "beta");
  const c = join(home, "gamma");
  for (const d of [a, b, c]) mkdirSync(d, { recursive: true });
  mkdirSync(join(home, ".honcho"), { recursive: true });
  writeFileSync(
    join(home, ".honcho", "config.json"),
    JSON.stringify({ apiKey: "k", peerName: "t", sessionStrategy: "chat-instance" })
  );
  const stamp = new Date().toISOString();
  writeFileSync(
    join(home, ".honcho", "cache.json"),
    JSON.stringify({
      ...cache,
      sessions: {
        [a]: { name: "n", id: "i", updatedAt: stamp, instanceId: "alpha-instance" },
        [b]: { name: "n", id: "i", updatedAt: stamp, instanceId: "beta-instance" },
      },
    })
  );
  return { home, a, b, c };
}

describe("chat-instance resolves per cwd, never machine-global", () => {
  test("each cwd keeps its own instance id", () => {
    const { home, a, b } = fixture({});
    try {
      const out = runInSandbox(
        home,
        `import { getSessionName } from "./src/config.ts";
         console.log(JSON.stringify({
           a: getSessionName(${JSON.stringify(a)}),
           b: getSessionName(${JSON.stringify(b)}),
         }));`
      );
      const r = JSON.parse(out);
      expect(r.a).toBe("t-chat-alpha-instance");
      expect(r.b).toBe("t-chat-beta-instance");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Regression for backlog #39: a legacy top-level `claudeInstanceId` in
  // cache.json used to be the last resort of the resolution chain, so an
  // unmapped cwd inherited whichever session wrote it last. It must be inert.
  test("a legacy global claudeInstanceId is ignored for an unmapped cwd", () => {
    const { home, c } = fixture({ claudeInstanceId: "stale-global-instance" });
    try {
      const out = runInSandbox(
        home,
        `import { getSessionName } from "./src/config.ts";
         console.log(getSessionName(${JSON.stringify(c)}));`
      );
      expect(out).not.toContain("stale-global-instance");
      expect(out).toBe("t-gamma");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // An explicit id from the caller's own hook input always wins.
  test("an explicit instance id beats the cached one", () => {
    const { home, a } = fixture({ claudeInstanceId: "stale-global-instance" });
    try {
      const out = runInSandbox(
        home,
        `import { getSessionName } from "./src/config.ts";
         console.log(getSessionName(${JSON.stringify(a)}, "explicit-instance"));`
      );
      expect(out).toBe("t-chat-explicit-instance");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("setInstanceIdForCwd", () => {
  test("records an id without a cached session, and preserves one that exists", () => {
    const { home, a, c } = fixture({});
    try {
      const out = runInSandbox(
        home,
        `import { setInstanceIdForCwd, getInstanceIdForCwd, getCachedSessionId } from "./src/cache.ts";
         setInstanceIdForCwd(${JSON.stringify(c)}, "fresh-instance");
         setInstanceIdForCwd(${JSON.stringify(a)}, "replaced-instance");
         console.log(JSON.stringify({
           freshId: getInstanceIdForCwd(${JSON.stringify(c)}),
           freshSession: getCachedSessionId(${JSON.stringify(c)}),
           replacedId: getInstanceIdForCwd(${JSON.stringify(a)}),
           keptSession: getCachedSessionId(${JSON.stringify(a)}),
         }));`
      );
      const r = JSON.parse(out);
      expect(r.freshId).toBe("fresh-instance");
      expect(r.freshSession).toBe(null); // no session id invented
      expect(r.replacedId).toBe("replaced-instance");
      expect(r.keptSession).toBe("i"); // existing session id survives
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
