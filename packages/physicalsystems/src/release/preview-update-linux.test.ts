// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  clickPreviewUpdateLinuxConfirmation,
  startPreviewUpdatePolkitAgent,
  PreviewUpdateLinuxError,
} from "./preview-update-linux"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const temporary = await mkdtemp(join(tmpdir(), "preview-update-native-"))
  roots.push(temporary)
  const root = join(temporary, "owned")
  await mkdir(root, { mode: 0o700 })
  await writeFile(
    join(root, "preview-update-runner.json"),
    JSON.stringify({ kind: "disposable-preview-update", runId: "123" }),
    { mode: 0o600 },
  )
  return {
    env: {
      CI: "true",
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "github-hosted",
      RUNNER_OS: "Linux",
      GITHUB_RUN_ID: "123",
      RUNNER_TEMP: temporary,
      DISPLAY: ":98",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/inert-session-bus",
      PHYSICALSYSTEMS_UPDATER_TEST: "1",
      GITHUB_REPOSITORY: "PhysicalSystems/desktop",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      RUNNER_ARCH: "X64",
      LD_PRELOAD: "must-be-removed",
      PYTHONPATH: "must-be-removed",
      UNRELATED_SECRET: "must-be-removed",
    },
    root,
    applicationPid: 42,
    version: "0.1.0-beta.7",
    authUser: "ps-update-auth" as const,
    authPassword: "x".repeat(48),
  }
}

const native = test.skipIf(process.platform !== "linux" || !process.getuid?.())

native("native helpers refuse local runners and bad ownership markers before spawning", async () => {
  const f = await fixture()
  let called = false
  const dependencies = {
    spawn: (() => {
      called = true
      throw new Error("unexpected process")
    }) as typeof spawn,
  }
  await expect(
    startPreviewUpdatePolkitAgent({ ...f, env: { ...f.env, GITHUB_ACTIONS: "false" } }, dependencies),
  ).rejects.toThrow("DISPOSABLE_RUNNER")
  await chmod(join(f.root, "preview-update-runner.json"), 0o644)
  await expect(clickPreviewUpdateLinuxConfirmation({ ...f, choice: "install" }, dependencies)).rejects.toThrow(
    "MARKER_INVALID",
  )
  await rm(join(f.root, "preview-update-runner.json"))
  await writeFile(join(f.root, "other"), JSON.stringify({ kind: "disposable-preview-update", runId: "123" }), {
    mode: 0o600,
  })
  await symlink(join(f.root, "other"), join(f.root, "preview-update-runner.json"))
  await expect(startPreviewUpdatePolkitAgent(f, dependencies)).rejects.toThrow("MARKER_INVALID")
  expect(called).toBe(false)
})

native("native authentication rejects weak secrets, wrong identity and invalid application/version", async () => {
  const f = await fixture()
  for (const patch of [
    { authPassword: "short" },
    { authPassword: "x".repeat(47) + "\n" },
    { applicationPid: 1 },
    { version: "0.1.0" },
  ]) {
    await expect(startPreviewUpdatePolkitAgent({ ...f, ...patch })).rejects.toThrow("INVALID")
  }
  await expect(
    startPreviewUpdatePolkitAgent(f, {
      spawn: (() => {
        throw new Error("private native path")
      }) as typeof spawn,
    }),
  ).rejects.toThrow("PREVIEW_UPDATE_NATIVE_HELPER_LAUNCH_FAILED")
})

native(
  "private helper pipe keeps password out of argv/env and waits for real auth event before owned cleanup",
  async () => {
    const f = await fixture()
    const calls: { executable: string; args: readonly string[]; env: NodeJS.ProcessEnv | undefined }[] = []
    const dependencies = {
      spawn(executable: string, args: readonly string[], options: Parameters<typeof spawn>[2]) {
        calls.push({ executable, args, env: options?.env })
        // Inert child exercises the real pipe/event/cleanup boundary only. It never
        // imports the native helper or calls pkexec, dpkg, AT-SPI, or Electron.
        return spawn(
          process.execPath,
          [
            "-e",
            `
        let buffer = '';
        process.stdin.on('data', chunk => {
          buffer += chunk;
          while (buffer.includes('\\n')) {
            const end = buffer.indexOf('\\n');
            const input = JSON.parse(buffer.slice(0,end)); buffer = buffer.slice(end+1);
            if (input.command === 'stop') { process.exit(0); }
            if (input.authUser !== 'ps-update-auth' || input.authPassword.length !== 48 || 'env' in input) process.exit(5);
            process.stdout.write('{"event":"ready"}\\n');
            setTimeout(() => process.stdout.write('{"event":"authenticated"}\\n'), 30);
          }
        });
      `,
          ],
          options,
        )
      },
    }
    const agent = await startPreviewUpdatePolkitAgent(f, { spawn: dependencies.spawn as typeof spawn })
    try {
      await agent.ready
      await agent.authenticated
    } finally {
      await agent.stop()
    }
    await agent.stop()
    expect(calls).toHaveLength(1)
    expect(calls[0].executable).toBe("/usr/bin/python3")
    expect(calls[0].args.slice(0, 3)).toEqual(["-I", "-B", "-u"])
    expect(calls[0].args.at(-1)).toBe("polkit")
    expect(JSON.stringify(calls)).not.toContain(f.authPassword)
    expect(calls[0].env).not.toHaveProperty("LD_PRELOAD")
    expect(calls[0].env).not.toHaveProperty("PYTHONPATH")
    expect(calls[0].env).not.toHaveProperty("UNRELATED_SECRET")
    expect(calls[0].env?.DISPLAY).toBe(":98")
  },
)

native("confirmation requires matching native action plus successful helper exit", async () => {
  const f = await fixture()
  const inert = (event: object, code = 0) => ({
    spawn: ((_: string, _args: string[], options: Parameters<typeof spawn>[2]) =>
      spawn(
        process.execPath,
        [
          "-e",
          `process.stdin.resume(); process.stdin.once('end',()=>{ process.stdout.write(${JSON.stringify(JSON.stringify(event) + "\n")}); process.exitCode=${code} })`,
        ],
        options,
      )) as typeof spawn,
  })
  for (const choice of ["later", "install"] as const) {
    for (const method of ["at-spi", "x11-ocr"] as const) {
      await expect(
        clickPreviewUpdateLinuxConfirmation({ ...f, choice }, inert({ event: "clicked", action: choice, method })),
      ).resolves.toEqual({ action: choice, method })
    }
  }
  await expect(
    clickPreviewUpdateLinuxConfirmation(
      { ...f, choice: "install" },
      inert({ event: "clicked", action: "install", method: "global-keyboard" }),
    ),
  ).rejects.toThrow("OUTPUT_INVALID")
  await expect(
    clickPreviewUpdateLinuxConfirmation(
      { ...f, choice: "install" },
      inert({ event: "clicked", action: "later", method: "at-spi" }),
    ),
  ).rejects.toThrow("OUTPUT_INVALID")
  await expect(
    clickPreviewUpdateLinuxConfirmation(
      { ...f, choice: "install" },
      inert({ event: "clicked", action: "install", method: "at-spi" }, 1),
    ),
  ).rejects.toThrow("HELPER_EXITED")
})

native(
  "only authored diagnostics escape; missing registration and timeout cannot become authentication success",
  async () => {
    const f = await fixture()
    for (const [event, expected] of [
      [{ event: "failed", code: "AUTHENTICATION_IDENTITY_MISMATCH" }, "IDENTITY_MISMATCH"],
      [{ event: "failed", code: "PRIVATE_PASSWORD_AND_PATH" }, "OUTPUT_INVALID"],
      [{ event: "authenticated" }, "OUTPUT_INVALID"],
    ] as const) {
      const agent = await startPreviewUpdatePolkitAgent(f, {
        spawn: ((_: string, _args: string[], options: Parameters<typeof spawn>[2]) =>
          spawn(
            process.execPath,
            [
              "-e",
              `process.stdin.resume(); process.stdin.once('data',()=>{process.stdout.write(${JSON.stringify(JSON.stringify(event) + "\n")});process.stderr.write('private native diagnostic');process.exitCode=1;process.stdin.destroy()})`,
            ],
            options,
          )) as typeof spawn,
      })
      await expect(agent.ready).rejects.toThrow(expected)
      await expect(agent.authenticated).rejects.toThrow(expected)
      await expect(agent.stop()).rejects.toThrow(expected)
    }
    const agent = await startPreviewUpdatePolkitAgent(f, {
      timeoutMs: 20,
      spawn: ((_: string, _args: string[], options: Parameters<typeof spawn>[2]) =>
        spawn(process.execPath, ["-e", "process.stdin.resume()"], options)) as typeof spawn,
    })
    await expect(agent.ready).rejects.toThrow("HELPER_TIMEOUT")
    await expect(agent.authenticated).rejects.toThrow("HELPER_TIMEOUT")
    await expect(agent.stop()).rejects.toThrow("HELPER_TIMEOUT")
  },
)

native("Python entrypoint independently refuses local execution before touching app or native APIs", async () => {
  const child = spawn(
    "/usr/bin/python3",
    ["-I", fileURLToPath(new URL("./preview-update-linux.py", import.meta.url)), "polkit"],
    {
      env: { CI: "false", PATH: "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  )
  let output = ""
  let diagnostics = ""
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostics += chunk.toString()
  })
  child.stdin.end(JSON.stringify({ root: "/private/path", applicationPid: 1, authPassword: "private-secret" }) + "\n")
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("close", resolve)
    child.once("error", reject)
  })
  expect(code).toBe(1)
  expect(JSON.parse(output)).toEqual({ event: "failed", code: "DISPOSABLE_RUNNER_REQUIRED" })
  expect(diagnostics).toBe("")
  expect(output).not.toContain("private")
})

native("native dialog failure retains only schema-checked count/category diagnostics", async () => {
  const f = await fixture()
  const diagnostic = {
    applications: 2,
    ownedApplications: 1,
    windows: [{ role: "frame" as const, name: "other" as const, message: false, install: 0, later: 0 }],
  }
  const recognition = {
    reason: "text",
    expectedWords: 42,
    actualWords: 42,
    minimumConfidence: 83,
    rangesValid: true,
    width: 627,
    height: 173,
    mismatches: [{ index: 41, expected: "later-button", difference: "punctuation" }],
  }
  const withRecognition = { ...diagnostic, recognition, diagnosticImage: "saved" }
  for (const data of [
    diagnostic,
    withRecognition,
    { ...diagnostic, privateTitle: "must-never-be-retained" },
    { ...diagnostic, windows: [{ ...diagnostic.windows[0], name: "private title" }] },
    { ...withRecognition, recognition: { ...recognition, rawText: "private text" } },
    { ...withRecognition, recognition: { ...recognition, actualWords: 257 } },
    { ...withRecognition, recognition: { ...recognition, minimumConfidence: -2 } },
    { ...withRecognition, recognition: { ...recognition, mismatches: Array(13).fill(recognition.mismatches[0]) } },
    {
      ...withRecognition,
      recognition: { ...recognition, mismatches: [{ index: 0, expected: "private", difference: "word" }] },
    },
    { ...diagnostic, recognition },
  ]) {
    const events = [
      { event: "diagnostic", data },
      { event: "failed", code: "NATIVE_DIALOG_NOT_FOUND" },
    ]
      .map((event) => JSON.stringify(event) + "\n")
      .join("")
    const error = await clickPreviewUpdateLinuxConfirmation(
      { ...f, choice: "later" },
      {
        spawn: ((_: string, _args: string[], options: Parameters<typeof spawn>[2]) =>
          spawn(
            process.execPath,
            [
              "-e",
              `process.stdin.resume(); process.stdin.once('end',()=>{process.stdout.write(${JSON.stringify(events)});process.exitCode=1})`,
            ],
            options,
          )) as typeof spawn,
      },
    ).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(PreviewUpdateLinuxError)
    if (!(error instanceof PreviewUpdateLinuxError)) throw new Error("unexpected helper error")
    if (data === diagnostic || data === withRecognition) {
      expect(error.message).toBe("PREVIEW_UPDATE_NATIVE_DIALOG_NOT_FOUND")
      expect(error.nativeDialog as unknown).toEqual(data)
    } else {
      expect(error.message).toBe("PREVIEW_UPDATE_NATIVE_HELPER_OUTPUT_INVALID")
      expect(error.nativeDialog).toBeUndefined()
    }
    expect(JSON.stringify(error)).not.toContain("private")
  }
})

test.skipIf(process.platform !== "linux")(
  "Python prompt and accessible-dialog boundaries run without any native side effects",
  async () => {
    const child = spawn(
      "/usr/bin/python3",
      ["-I", fileURLToPath(new URL("./preview-update-linux.test.py", import.meta.url))],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
    let output = ""
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString()
    })
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve)
      child.once("error", reject)
    })
    expect(output).toContain("Ran 21 tests")
    expect(code).toBe(0)
  },
)
