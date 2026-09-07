// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { commitLegacyImport, listLegacyImports, previewLegacyImport, readLegacyImport } from "./migration"

const roots: string[] = []
const sessionFile = "harness/harness-sessions/fixture.jsonl"
function catalog() {
  return {
    schemaVersion: 1, revision: 7,
    projects: [{ id: "project-one", name: "Robot experiments", connectionId: "connection-one", cwd: "/fixture/project", lastConversationId: "chat-one" }],
    connections: [{ id: "connection-one", type: "ssh", label: "Fixture laptop", host: "fixture.invalid", credentialRef: "legacy-secret-reference", keyPath: "/fixture/private-key", autoConnect: true }],
    conversations: [{ id: "chat-one", projectId: "project-one", title: "Compare alignment", draft: "Try the next offset", sessionId: "legacy-session", sessionFile }],
    selection: { projectId: "project-one", conversationId: "chat-one" }, preferences: { devicesOpen: true, theme: "system" },
  }
}
function entries() {
  return [
    { type: "session", version: 3, id: "legacy-session", timestamp: "2026-09-07T00:00:00Z", cwd: "/fixture/project" },
    { type: "message", id: "user-one", parentId: null, message: { role: "user", content: "Find an approach" } },
    { type: "message", id: "assistant-one", parentId: "user-one", message: { role: "assistant", content: [{ type: "text", text: "**Simulation** proposed" }, { type: "thinking", thinking: "private-thinking-fixture" }, { type: "toolCall", name: "propose_local_experiment", arguments: { approved: true, apiKey: "secret-tool-argument" } }] } },
    { type: "message", id: "result-one", parentId: "assistant-one", message: { role: "toolResult", toolName: "propose_local_experiment", content: [{ type: "text", text: "secret-tool-result" }, { type: "image", data: "camera-image-fixture" }], details: { approval: { active: true } } } },
    { type: "custom", id: "approval-one", parentId: "result-one", customType: "approval", data: { approved: true, pendingTurn: "do-not-replay" } },
    { type: "message", id: "assistant-two", parentId: "result-one", message: { role: "assistant", content: "Trial 1: 3 mm error. Historical branch." } },
  ]
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "physical-migration-test-"))
  roots.push(root)
  const source = join(root, "source")
  const target = join(root, "destination")
  await mkdir(join(source, "harness/harness-sessions"), { recursive: true })
  await writeFile(join(source, "catalog.json"), JSON.stringify(catalog()))
  await writeFile(join(source, sessionFile), entries().map((entry) => JSON.stringify(entry)).join("\n") + "\n")
  await writeFile(join(source, "credentials.json"), "credential-file-fixture-not-to-read")
  await writeFile(join(source, "executor.json"), "executor-file-fixture-not-to-read")
  return { root, source, target }
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe("explicit legacy history import", () => {
  test("copies titles/drafts/prose as inert history without original mutation, credentials, images or approval authority", async () => {
    const value = await fixture()
    const before = await readFile(join(value.source, "catalog.json"))
    const sessionBefore = await readFile(join(value.source, sessionFile))
    const preview = await previewLegacyImport(value.source)
    expect(await readdir(value.root)).toEqual(["source"])
    expect(preview.summary).toMatchObject({ projectCount: 1, conversationCount: 1, messageCount: 5 })
    const project = preview.archive.projects[0]
    expect(project.connection).toEqual({ kind: "ssh", label: "Fixture laptop", status: "offline" })
    expect(project.conversations[0]).toMatchObject({ title: "Compare alignment", draft: "Try the next offset" })
    expect(project.conversations[0].messages[1].text).toContain("**Simulation** proposed")
    expect(project.conversations[0].messages[1].text).toContain("Historical tools: propose_local_experiment")
    expect(project.conversations[0].messages[4].parentId).toBe("result-one")
    const summary = await commitLegacyImport(preview, value.target)
    expect(await listLegacyImports(value.target)).toEqual([summary])
    const saved = await readLegacyImport(value.target, summary.id)
    expect(saved).toMatchObject({ authority: "none", readOnly: true })
    for (const excluded of ["secret-tool-argument", "secret-tool-result", "camera-image-fixture", "private-thinking-fixture", "legacy-secret-reference", "/fixture/private-key", "credential-file-fixture-not-to-read", "executor-file-fixture-not-to-read", "do-not-replay", "autoConnect"]) expect(JSON.stringify(saved)).not.toContain(excluded)
    expect(await readFile(join(value.source, "catalog.json"))).toEqual(before)
    expect(await readFile(join(value.source, sessionFile))).toEqual(sessionBefore)
    expect((await stat(join(value.target, `${summary.id}.json`))).mode & 0o777).toBe(0o600)
  })

  test("idempotent retries and concurrent commits produce one complete archive", async () => {
    const value = await fixture()
    const preview = await previewLegacyImport(value.source)
    const again = await previewLegacyImport(value.source)
    expect(again.archive.id).toBe(preview.archive.id)
    const [one, two] = await Promise.all([commitLegacyImport(preview, value.target), commitLegacyImport(again, value.target)])
    expect(one).toEqual(two)
    expect(await commitLegacyImport(preview, value.target)).toEqual(one)
    expect(await readdir(value.target)).toEqual([`${one.id}.json`])
  })

  test("interrupted temporary copies are ignored and a new import recovers without replay", async () => {
    const value = await fixture()
    const preview = await previewLegacyImport(value.source)
    await mkdir(value.target)
    await writeFile(join(value.target, ".interrupted.tmp"), "{ incomplete")
    expect(await listLegacyImports(value.target)).toEqual([])
    await commitLegacyImport(preview, value.target)
    expect((await listLegacyImports(value.target)).length).toBe(1)
    expect(await readFile(join(value.target, ".interrupted.tmp"), "utf8")).toBe("{ incomplete")
  })

  test("missing transcript preserves its title/draft with an explicit recovery warning", async () => {
    const value = await fixture()
    await rm(join(value.source, sessionFile))
    const preview = await previewLegacyImport(value.source)
    expect(preview.archive.projects[0].conversations[0]).toMatchObject({ title: "Compare alignment", draft: "Try the next offset", messages: [] })
    expect(preview.summary.warnings.join(" ")).toContain("Transcript missing")
  })

  test("unknown schema, credential fields and malformed JSON preserve source and create no destination", async () => {
    const value = await fixture()
    for (const invalid of [{ ...catalog(), schemaVersion: 99 }, { ...catalog(), credentials: "should-not-copy" }, "{ incomplete"]) {
      const bytes = typeof invalid === "string" ? invalid : JSON.stringify(invalid)
      await writeFile(join(value.source, "catalog.json"), bytes)
      await expect(previewLegacyImport(value.source)).rejects.toThrow("Original files are unchanged")
      expect(await readFile(join(value.source, "catalog.json"), "utf8")).toBe(bytes)
    }
    expect(await readdir(value.root)).toEqual(["source"])
  })

  test("unknown transcript versions and truncated entries reject rather than silently lose history", async () => {
    const value = await fixture()
    for (const bytes of [JSON.stringify({ type: "session", version: 999, id: "future" }) + "\n", entries().map((entry) => JSON.stringify(entry)).join("\n") + "\n{ partial"]) {
      await writeFile(join(value.source, sessionFile), bytes)
      await expect(previewLegacyImport(value.source)).rejects.toThrow("Original files are unchanged")
    }
  })

  test("traversal and symbolic link references cannot read arbitrary files", async () => {
    const value = await fixture()
    const invalid = catalog()
    invalid.conversations[0].sessionFile = "harness/harness-sessions/../../credentials.json"
    await writeFile(join(value.source, "catalog.json"), JSON.stringify(invalid))
    await expect(previewLegacyImport(value.source)).rejects.toThrow("escapes")
    await writeFile(join(value.source, "catalog.json"), JSON.stringify(catalog()))
    await rm(join(value.source, sessionFile))
    await symlink(join(value.source, "credentials.json"), join(value.source, sessionFile))
    await expect(previewLegacyImport(value.source)).rejects.toThrow("symbolic links")
    await symlink(value.source, join(value.root, "source-link"))
    await expect(previewLegacyImport(join(value.root, "source-link"))).rejects.toThrow("symbolic link")
  })

  test("failed destination and tampering leave the old app data and previous import usable", async () => {
    const value = await fixture()
    const preview = await previewLegacyImport(value.source)
    await expect(commitLegacyImport(preview, value.source)).rejects.toThrow("separate")
    await expect(commitLegacyImport(preview, join(value.source, "imports"))).rejects.toThrow("separate")
    await symlink(value.source, join(value.root, "source-alias"))
    await expect(commitLegacyImport(preview, join(value.root, "source-alias", "imports"))).rejects.toThrow("separate")
    expect(await readdir(value.source)).not.toContain("imports")
    await writeFile(value.target, "destination unavailable")
    await expect(commitLegacyImport(preview, value.target)).rejects.toThrow()
    expect((await previewLegacyImport(value.source)).archive.id).toBe(preview.archive.id)
    await rm(value.target)
    const summary = await commitLegacyImport(preview, value.target)
    const path = join(value.target, `${summary.id}.json`)
    const good = await readFile(path, "utf8")
    await writeFile(path, good.replace("Try the next offset", "tampered draft"))
    await expect(readLegacyImport(value.target, summary.id)).rejects.toThrow("digest")
    await expect(commitLegacyImport(preview, value.target)).rejects.toThrow("differs")
    expect((await previewLegacyImport(value.source)).archive.id).toBe(summary.id)
  })

  test("recognizable secret and embedded image text is redacted without importing credential storage", async () => {
    const value = await fixture()
    const input = catalog()
    input.conversations[0].draft = "API key=fixture-secret password: fixture-password sk-abcdefghijklmnopqrstuv data:image/jpeg;base64,fixture-image"
    await writeFile(join(value.source, "catalog.json"), JSON.stringify(input))
    const preview = await previewLegacyImport(value.source)
    expect(preview.archive.projects[0].conversations[0].draft).toContain("[credential excluded]")
    expect(preview.archive.projects[0].conversations[0].draft).not.toContain("fixture-secret")
    expect(preview.archive.projects[0].conversations[0].draft).not.toContain("fixture-image")
  })
})
