// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  reviewBrowserCrashDatabase,
  reviewBrowserCrashpad,
  reviewBrowserDesktopEntry,
  reviewBrowserProcess,
  reviewBrowserProfileArgument,
  createReviewBrowserProfileProof,
  reviewBrowserOwnershipScope,
  reviewBrowserSignalIdentity,
  reviewBrowserTargets,
  reviewBrowserUid,
  settleReviewBrowserCleanup,
} from "./owned-review-browser"

// Only inert /proc strings, fake HTTP and timer-only subprocesses. No native browser, process
// signaling, credential store or device is started by these regressions.
const status = "Name:\tchrome\nUid:\t1001\t1001\t1001\t1001\n"
const identity = { pid: 400, state: "S", group: 400, session: 400, birth: "123456" }

test("Linux fixture rejects Exec paths that require quoting before launching a browser", () => {
  expect(reviewBrowserDesktopEntry("/owned/review-012_fixture/browser")).toContain(
    "\nExec=/owned/review-012_fixture/browser %u\n",
  )
  for (const path of [
    "relative/browser",
    "/owned/review browser",
    "/owned/review\tbrowser",
    "/owned/review\nbrowser",
    "/owned/$(inert)/browser",
    "/owned/`inert`/browser",
    '/owned/"browser"',
    "/owned/'browser'",
    "/owned/%u/browser",
    "/owned/browser;inert",
    "/owned/browser:other",
    "/owned/\\browser",
    "/owned/../browser",
    "/owned/./browser",
    "/owned//browser",
    "/owned/browser\0",
  ])
    expect(() => reviewBrowserDesktopEntry(path)).toThrow("PROVIDER_REVIEW_BROWSER_UNCONFIRMED")
})

test.skipIf(process.platform === "win32")(
  "Noble generic xdg-open parser dispatches the safe fixture path and preserves its argument",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "xdg-exec-fixture-"))
    const launcher = join(root, "browser")
    const output = join(root, "argument.txt")
    let cleanupConfirmed = true
    const url = 'http://127.0.0.1:12345/inert?literal=$(never-run)&quoted="value"&space=one two'
    // Minimal relevant parser from Ubuntu xdg-utils 1.1.3-4.1ubuntu3's xdg-open,
    // first_word (lines 129-133) and search_desktop_file (759-760, 811).
    // The entire xdg-open script is never executed: only an inert owned writer.
    const parser = `
    first_word() { read first rest; echo "$first"; }
    command="$(printf '%s\\n' "$INERT_EXEC" | first_word)"
    command_exec=\`which $command 2>/dev/null\`
    "$command_exec" "$INERT_URL"
  `
    try {
      await writeFile(launcher, '#!/bin/sh\nprintf "%s" "$1" > "$INERT_OUTPUT"\n', { mode: 0o700, flag: "wx" })
      const corrected = reviewBrowserDesktopEntry(launcher)
        .split("\n")
        .find((line) => line.startsWith("Exec="))!
        .slice(5)
      for (const entry of [`"${launcher}" %u`, corrected]) {
        const child = spawn("/bin/sh", ["-c", parser], {
          env: { PATH: "/usr/bin:/bin", INERT_EXEC: entry, INERT_URL: url, INERT_OUTPUT: output },
          stdio: "ignore",
        })
        cleanupConfirmed = false
        const exit = await new Promise<number | null>((resolve, reject) => {
          let expired = false
          let stopTimer: ReturnType<typeof setTimeout> | undefined
          const timer = setTimeout(() => {
            expired = true
            // This child is only the test's inert parser/writer, never a native
            // browser. Wait for its exit before removing its temporary files.
            try {
              child.kill("SIGKILL")
            } catch {}
            stopTimer = setTimeout(() => {
              child.unref()
              reject(Error("INERT_PARSER_CLEANUP_UNCONFIRMED"))
            }, 1000)
          }, 3000)
          child.once("exit", (code) => {
            clearTimeout(timer)
            clearTimeout(stopTimer)
            cleanupConfirmed = true
            if (expired) reject(Error("INERT_PARSER_TIMEOUT"))
            else resolve(code)
          })
          child.once("error", () => {
            clearTimeout(timer)
            clearTimeout(stopTimer)
            cleanupConfirmed = child.pid === undefined
            child.unref()
            reject(Error("INERT_PARSER_FAILED"))
          })
        })
        if (entry === corrected) {
          expect(exit).toBe(0)
          expect(await readFile(output, "utf8")).toBe(url)
        } else {
          expect(exit).not.toBe(0)
          await expect(readFile(output, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
        }
      }
    } finally {
      if (cleanupConfirmed) await rm(root, { recursive: true, force: true })
    }
  },
)

test("Chrome Crashpad uses exact branded Linux config path, executable and NUL-delimited argument", () => {
  const database = reviewBrowserCrashDatabase("/owned/review browser")
  expect(database).toBe("/owned/review browser/config/google-chrome/Crash Reports")
  const executable = "/opt/google/chrome/chrome_crashpad_handler"
  expect(
    reviewBrowserCrashpad({ executable, database, command: `${executable}\0--database=${database}\0--monitor-self\0` }),
  ).toBe(true)
  for (const command of [
    `${executable}\0--database=/owned/review browser/profile/Crashpad\0`,
    `${executable}\0--database=${database}-unowned\0`,
    `${executable}\0--note=--database=${database}\0`,
    `${executable} --database=${database}`,
  ])
    expect(reviewBrowserCrashpad({ executable, database, command })).toBe(false)
  expect(
    reviewBrowserCrashpad({
      executable: "/other/chrome_crashpad_handler",
      database,
      command: `--database=${database}\0`,
    }),
  ).toBe(false)
})

test("main Chrome rewritten title proves one exact profile token without changing real argv boundaries", () => {
  const executable = "/opt/google/chrome/chrome"
  const profile = "/owned/review/profile"
  const title = `${executable} --user-data-dir=${profile} --no-first-run --remote-debugging-port=0 about:blank\0\0`
  // The previous lookup deterministically rejects Chromium's joined title.
  expect(title.split("\0").includes(`--user-data-dir=${profile}`)).toBe(false)
  for (const command of [
    title,
    title.replaceAll("\0", ""),
    `${executable}\0--user-data-dir=${profile}\0--no-first-run\0`,
  ])
    expect(reviewBrowserProfileArgument(command, profile)).toBe(true)
  expect(
    reviewBrowserProfileArgument(`${executable}\0--user-data-dir=/owned/review profile\0`, "/owned/review profile"),
  ).toBe(true)
  for (const command of [
    "",
    "\0\0",
    `${executable}\0`,
    `${executable}\0--user-data-dir=${profile}-foreign\0`,
    `${executable}\0--note=--user-data-dir=${profile}\0`,
    `${executable}\0--note=ignored --user-data-dir=${profile}\0`,
    `${executable}\0--user-data-dir\0${profile}\0`,
    `${executable} --user-data-dir=${profile}-foreign\0`,
    `${executable} --note=--user-data-dir=${profile}\0`,
    `${title.replaceAll("\0", "")} --user-data-dir=/foreign\0`,
    `${executable}\0--user-data-dir=${profile}\0--user-data-dir=${profile}\0`,
  ])
    expect(reviewBrowserProfileArgument(command, profile)).toBe(false)
  for (const profile of ["/owned/review profile", "/owned/review\tprofile", "/owned/review\nprofile"])
    expect(reviewBrowserProfileArgument(`${executable} --user-data-dir=${profile} --no-first-run\0`, profile)).toBe(
      false,
    )
})

test("ownership rejects changed PID/birth/session/group and every changed native UID before signaling", () => {
  reviewBrowserSignalIdentity(identity, { ...identity }, status, 1001)
  for (const changed of [{ pid: 401 }, { birth: "123457" }, { session: 401 }, { group: 401 }])
    expect(() => reviewBrowserSignalIdentity(identity, { ...identity, ...changed }, status, 1001)).toThrow(
      "PROVIDER_REVIEW_BROWSER_UNCONFIRMED",
    )
  for (let index = 0; index < 4; index++) {
    const uids = [1001, 1001, 1001, 1001]
    uids[index] = 0
    expect(() => reviewBrowserUid(`Uid:\t${uids.join("\t")}\n`, 1001)).toThrow("PROVIDER_REVIEW_BROWSER_UNCONFIRMED")
  }
  expect(() => reviewBrowserUid(status + status, 1001)).toThrow()
  expect(() => reviewBrowserUid(status, 0)).toThrow()
  const fields = ["399", "400", "400", ...Array(15).fill("0"), "123456", "0"]
  expect(reviewBrowserProcess(`400 (Chrome (renderer)) S ${fields.join(" ")}`)).toEqual(identity)
})

test("unrelated mixed-UID processes are excluded before strict validation of genuinely owned processes", () => {
  const database = reviewBrowserCrashDatabase("/owned/browser")
  const mixed = "Uid:\t1001\t0\t0\t0\n"
  const decide = (sameSession: boolean, command: string, value = mixed) => {
    const scope = reviewBrowserOwnershipScope({ sameSession, command, database })
    if (scope !== "unrelated") reviewBrowserUid(value, 1001)
    return scope
  }
  // Prior ordering rejected this same-real-UID process despite its unrelated argv.
  expect(() => reviewBrowserUid(mixed, 1001)).toThrow("BROWSER_UNCONFIRMED")
  for (const command of [
    "/usr/bin/unrelated\0",
    "--database=/other\0",
    `--note=--database=${database}\0`,
    `--database=${database}-other\0`,
  ])
    expect(decide(false, command)).toBe("unrelated")
  expect(() => decide(true, "")).toThrow("BROWSER_UNCONFIRMED")
  expect(() => decide(false, `--database=${database}\0`)).toThrow("BROWSER_UNCONFIRMED")
  expect(decide(true, "", status)).toBe("session")
  expect(decide(false, `--database=${database}\0`, status)).toBe("database")
})

test("empty argv retries require one immutable live identity; exit, reuse and nonempty mismatch never bind", () => {
  const profile = "/owned/profile"
  const command = `/opt/google/chrome/chrome --user-data-dir=${profile}\0`
  const proof = createReviewBrowserProfileProof(profile)
  const first = { ...identity }
  expect(proof(first, { ...first }, "\0\0")).toBe(false)
  first.birth = "999999"
  expect(proof({ ...identity, state: "R" }, { ...identity }, command)).toBe(true)
  for (const change of [
    { birth: "123457" },
    { pid: 401 },
    { group: 401 },
    { session: 401 },
    { state: "Z" },
    { state: "X" },
    { state: "x" },
  ]) {
    const pending = createReviewBrowserProfileProof(profile)
    expect(pending(identity, identity, "")).toBe(false)
    expect(() => pending({ ...identity, ...change }, { ...identity, ...change }, command)).toThrow(
      "BROWSER_UNCONFIRMED",
    )
    expect(() => createReviewBrowserProfileProof(profile)(identity, { ...identity, ...change }, "")).toThrow(
      "BROWSER_UNCONFIRMED",
    )
  }
  expect(() =>
    createReviewBrowserProfileProof(profile)(
      identity,
      identity,
      "/opt/google/chrome/chrome --user-data-dir=/foreign\0",
    ),
  ).toThrow("BROWSER_UNCONFIRMED")
})

test("read-only discovery tolerates refused, 503 and truncated responses before a valid target", async () => {
  const responses = [
    () => {
      throw new Error("PRIVATE-TRANSPORT")
    },
    () => new Response("PRIVATE-ERROR", { status: 503 }),
    () => new Response(""),
    () => new Response('[{"type":"page",'),
    () => new Response(JSON.stringify([{ type: "page", url: "about:blank", privateExtra: "PRIVATE" }])),
  ]
  for (let index = 0; index < responses.length; index++) {
    const result = await reviewBrowserTargets("http://127.0.0.1:12345", {
      fetcher: async (_url, options) => {
        expect(options?.redirect).toBe("error")
        expect(options?.signal).toBeDefined()
        return responses[index]!()
      },
    })
    expect(result).toEqual(index === 4 ? [{ type: "page", url: "about:blank" }] : undefined)
    expect(JSON.stringify(result) ?? "").not.toContain("PRIVATE")
  }
})

test("discovery caps stream bytes before consuming an oversized body and bounds stalled transports", async () => {
  let pulls = 0
  let cancelled = false
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        pulls++
        controller.enqueue(new Uint8Array(128 * 1024))
      },
      cancel() {
        cancelled = true
      },
    }),
  )
  expect(await reviewBrowserTargets("http://127.0.0.1:12345", { fetcher: async () => response })).toBeUndefined()
  expect(pulls).toBeLessThanOrEqual(4)
  expect(cancelled).toBe(true)
  for (const fetcher of [
    () => new Promise<Response>(() => {}),
    async () =>
      new Response(
        new ReadableStream({
          pull() {
            return new Promise(() => {})
          },
        }),
      ),
  ]) {
    const start = Date.now()
    expect(await reviewBrowserTargets("http://127.0.0.1:12345", { fetcher, timeoutMs: 10 })).toBeUndefined()
    expect(Date.now() - start).toBeLessThan(500)
  }
})

test("discovery rejects unowned endpoints and malformed or excessive target metadata", async () => {
  for (const origin of [
    "https://127.0.0.1:1234",
    "http://localhost:1234",
    "http://127.0.0.1:65536",
    "http://127.0.0.1:1234/private",
  ])
    await expect(reviewBrowserTargets(origin)).rejects.toThrow("PROVIDER_REVIEW_BROWSER_UNCONFIRMED")
  for (const value of [{}, [null], [{ type: "page" }], Array(129).fill({ type: "page", url: "about:blank" })])
    expect(
      await reviewBrowserTargets("http://127.0.0.1:12345", {
        fetcher: async () => new Response(JSON.stringify(value)),
      }),
    ).toBeUndefined()
})

test("cleanup releases only its controller handle while preserving the original failure", async () => {
  let unrefs = 0
  let pipeClosed = 0
  const child = {
    stderr: {
      destroy() {
        pipeClosed++
        return this
      },
    } as any,
    unref() {
      unrefs++
    },
  }
  const original = Error("PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED")
  await expect(
    settleReviewBrowserCleanup(child, async () => {
      throw original
    }),
  ).rejects.toBe(original)
  expect(unrefs).toBe(1)
  expect(pipeClosed).toBe(1)
  expect(await settleReviewBrowserCleanup(child, async () => "stopped")).toBe("stopped")
  expect(unrefs).toBe(2)
})

test("failed controller writes its receipt and exits while the inert retained child/profile remain", async () => {
  const helper = new URL("./owned-review-browser.ts", import.meta.url).href
  for (const corrected of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), "retained-review-fixture-"))
    const receipt = join(root, "receipt.json")
    const retained = join(root, "profile.txt")
    const finished = join(root, "inert-child-finished")
    const childCode = `import { writeFileSync } from 'node:fs'; setTimeout(() => writeFileSync(${JSON.stringify(finished)}, 'finished'), 1200);`
    const script = `
      import { spawn } from 'node:child_process';
      import { writeFile } from 'node:fs/promises';
      import { settleReviewBrowserCleanup } from ${JSON.stringify(helper)};
      await writeFile(${JSON.stringify(retained)}, 'retained inert profile');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { detached:true, stdio:'ignore' });
      await new Promise((resolve,reject) => { child.once('spawn',resolve); child.once('error',reject); });
      const cleanup = async () => { throw Error('PROVIDER_REVIEW_BROWSER_CLEANUP_UNCONFIRMED'); };
      try { ${corrected ? "await settleReviewBrowserCleanup(child, cleanup)" : "await cleanup()"}; }
      catch { await writeFile(${JSON.stringify(receipt)}, JSON.stringify({ result:'FAIL', cleanup:'UNCONFIRMED', retained:true })); process.exitCode=1; }
    `
    const controller = spawn(process.execPath, ["-e", script], { stdio: "ignore" })
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("INERT_CONTROLLER_TIMEOUT")), 5000)
        controller.once("exit", (code) => {
          clearTimeout(timer)
          resolve(code)
        })
        controller.once("error", () => {
          clearTimeout(timer)
          reject(Error("INERT_CONTROLLER_START_FAILED"))
        })
      })
      expect(code).toBe(1)
      expect(JSON.parse(await readFile(receipt, "utf8"))).toEqual({
        result: "FAIL",
        cleanup: "UNCONFIRMED",
        retained: true,
      })
      expect(await readFile(retained, "utf8")).toBe("retained inert profile")
      // The old referenced controller cannot exit until the child self-finishes.
      // The corrected controller finishes with no process signal or file removal.
      expect(
        await readFile(finished).then(
          () => true,
          () => false,
        ),
      ).toBe(!corrected)
      const until = Date.now() + 2500
      while (
        !(await readFile(finished).then(
          () => true,
          () => false,
        )) &&
        Date.now() < until
      )
        await new Promise((resolve) => setTimeout(resolve, 20))
      expect(await readFile(finished, "utf8")).toBe("finished")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}, 10000)
