import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const PLUGIN_ROOT = join(import.meta.dir, "..");
const CACHE_TS = join(PLUGIN_ROOT, "src", "cache.ts");

function makeHome(files: Record<string, unknown> = {}): string {
  const home = mkdtempSync(join(tmpdir(), "honcho-cache-"));
  mkdirSync(join(home, ".honcho"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(home, ".honcho", name), JSON.stringify(body));
  }
  return home;
}

function runSync(home: string, script: string, extraEnv: Record<string, string> = {}): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("HONCHO_"))
  ) as Record<string, string>;
  const proc = Bun.spawnSync(["bun", "-e", script], {
    env: { ...env, ...extraEnv, HOME: home },
    cwd: PLUGIN_ROOT,
  });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
}

describe("cache.json survives concurrent writers", () => {
  // Regression for backlog #40(b). Before the lock, N concurrent SessionStarts
  // each loaded the same snapshot and the last write won: measured 2026-08-26
  // at 1 of 12 entries surviving, and 2 writers losing 5 of 12 across six runs.
  test("every concurrent writer's cwd entry survives", async () => {
    const home = makeHome({ "cache.json": {} });
    const N = 8;
    try {
      // All children busy-wait to a shared wall-clock instant so they enter the
      // read-modify-write window together — a staggered start proves nothing.
      const startAt = Date.now() + 1200;
      const script = `
        import { setCachedSessionId } from ${JSON.stringify(CACHE_TS)};
        while (Date.now() < Number(process.env.START_AT)) {}
        const i = process.env.W;
        setCachedSessionId("/cwd/" + i, "n" + i, "id" + i, "inst" + i);
      `;
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !k.startsWith("HONCHO_"))
      ) as Record<string, string>;
      const kids = Array.from({ length: N }, (_, i) =>
        Bun.spawn(["bun", "-e", script], {
          env: { ...env, HOME: home, W: String(i), START_AT: String(startAt) },
          cwd: PLUGIN_ROOT,
          stdout: "ignore",
          stderr: "pipe",
        })
      );
      await Promise.all(kids.map((k) => k.exited));

      const cache = JSON.parse(readFileSync(join(home, ".honcho", "cache.json"), "utf-8"));
      const sessions = cache.sessions ?? {};
      expect(Object.keys(sessions).length).toBe(N);
      for (let i = 0; i < N; i++) {
        expect(sessions[`/cwd/${i}`]?.instanceId).toBe(`inst${i}`);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30000);

  test("a stale lock left by a dead process does not wedge writers", () => {
    const home = makeHome({ "cache.json": {} });
    try {
      // A lock directory with no owner: mkdir it, then backdate it past the
      // stale threshold so the next writer is entitled to steal it.
      const lock = join(home, ".honcho", "cache.json.lock");
      mkdirSync(lock);
      const backdated = Date.now() / 1000 - 60; // seconds, well past LOCK_STALE_MS
      utimesSync(lock, backdated, backdated);

      const out = runSync(
        home,
        `import { setCachedSessionId, getCachedSessionId } from ${JSON.stringify(CACHE_TS)};
         setCachedSessionId("/x", "n", "id-x");
         console.log(getCachedSessionId("/x"));`
      );
      expect(out).toBe("id-x");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15000);
});

describe("messageCount is scoped per cwd", () => {
  // Regression for backlog #40(a). One machine-wide integer meant a second
  // window's SessionStart reset the first window's counter, and the first
  // window's prompt consumed the second window's "first prompt" slot.
  test("two sessions each see their own first prompt", () => {
    const home = makeHome({ "context-cache.json": {} });
    try {
      const out = runSync(
        home,
        `import { resetMessageCount, incrementMessageCount, getMessageCount } from ${JSON.stringify(CACHE_TS)};
         resetMessageCount("/A");            // A's SessionStart
         resetMessageCount("/B");            // B's SessionStart, right after
         const aFirst = getMessageCount("/A"); incrementMessageCount("/A");
         const bFirst = getMessageCount("/B"); incrementMessageCount("/B");
         resetMessageCount("/C");            // a third window opens
         const aThird = getMessageCount("/A"); // A must NOT be back at zero
         console.log(JSON.stringify({ aFirst, bFirst, aThird }));`
      );
      const r = JSON.parse(out);
      expect(r.aFirst).toBe(0); // A's first prompt shows the hint
      expect(r.bFirst).toBe(0); // and so does B's — not suppressed by A
      expect(r.aThird).toBe(1); // C opening does not replay A's hint
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15000);

  test("a legacy machine-global messageCount is stripped on load", () => {
    const home = makeHome({ "context-cache.json": { messageCount: 7 } });
    try {
      const out = runSync(
        home,
        `import { getMessageCount } from ${JSON.stringify(CACHE_TS)};
         console.log(getMessageCount("/anything"));`
      );
      expect(out).toBe("0");
      const after = JSON.parse(readFileSync(join(home, ".honcho", "context-cache.json"), "utf-8"));
      expect(after.messageCount).toBeUndefined();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 15000);
});
