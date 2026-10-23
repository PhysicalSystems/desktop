import { expect, test } from "bun:test"
import { desktopChecks } from "../../../script/desktop-ci-scope.mjs"

const full = { source: true, release: true, appearance: true }
const source = { source: true, release: false, appearance: false }
const app = { source: true, release: false, appearance: true }
const docs = { source: false, release: false, appearance: false }

test.each([
  ["README.md", docs],
  ["release/public-publisher.md", docs],
  ["packages/physicalsystems/docs/model-runtime-ready.png", docs],
  ["packages/app/src/physicalsystems/model-runtime.tsx", app],
  ["packages/app/src/shell/layout.tsx", app],
  ["packages/app/test-browser/physicalsystems-ui.test.ts", app],
  ["packages/physicalsystems/src/renderer-authority.ts", source],
  ["packages/core/src/credential.ts", source],
  ["packages/server/test/session.test.ts", source],
  ["packages/tui/src/feature-plugins/physicalsystems.ts", source],
  ["packages/desktop/src/main/preview-update-install.ts", full],
  ["packages/app/src/components/updater-action.test.ts", full],
  ["packages/physicalsystems/src/release/inputs.ts", full],
  ["packages/physicalsystems/vendor/skills/robot/SKILL.md", full],
  ["packages/physicalsystems/vendor/manifest.json", full],
  ["packages/app/package.json", full],
  ["packages/app/playwright.config.ts", full],
  ["packages/ui/src/theme.ts", full],
  ["bun.lock", full],
  [".github/workflows/desktop-ci.yml", full],
  ["script/desktop-ci-scope.mjs", full],
  ["unknown/new-package.ts", full],
] as const)("selects appropriate checks for %s", (path, expected) => {
  expect(desktopChecks([path], "pull_request")).toEqual(expected)
})

test("combines all changed paths and retains checks for deleted or renamed sources", () => {
  expect(desktopChecks(["README.md", "packages/core/src/credential.ts"], "pull_request")).toEqual(source)
  // git diff --no-renames supplies both the old and new path for a moved file.
  expect(desktopChecks(["packages/desktop/src/main/old.ts", "docs/old.ts"], "pull_request")).toEqual(full)
  expect(desktopChecks(["README.md", "packages/app/src/settings.tsx", "bun.lock"], "pull_request")).toEqual(full)
})

test("manual, reusable release and empty-diff runs always require every check", () => {
  expect(desktopChecks(["README.md"], "workflow_dispatch")).toEqual(full)
  expect(desktopChecks(["README.md"], "workflow_call")).toEqual(full)
  expect(desktopChecks(["README.md"], "pull_request", "a".repeat(40))).toEqual(full)
  expect(desktopChecks([], "pull_request")).toEqual(full)
})

const workflow = Bun.YAML.parse(
  await Bun.file(new URL("../../../.github/workflows/desktop-ci.yml", import.meta.url)).text(),
) as {
  jobs: Record<string, { name: string; if?: string; needs?: string[] | string; steps: { run?: string }[] }>
}

test("required gate waits for every selected job while source and native tests run independently", () => {
  expect(workflow.jobs.source!.name).toBe("Source and authority checks")
  expect(workflow.jobs.source!.if).toContain("always()")
  expect(workflow.jobs.source!.needs).toEqual([
    "scope",
    "regression",
    "windows-installer-owner",
    "linux-updater-dialog",
  ])
  for (const job of ["regression", "windows-installer-owner", "linux-updater-dialog"]) {
    expect(workflow.jobs[job]!.needs).toBe("scope")
  }
  expect(workflow.jobs["preview-updater-test"]!.needs).toEqual(["source"])
})

test.each([
  ["true", "true", "success", "success", "success", "success", true],
  ["true", "false", "success", "success", "skipped", "skipped", true],
  ["false", "false", "success", "skipped", "skipped", "skipped", true],
  ["true", "true", "failure", "skipped", "skipped", "skipped", false],
  ["true", "false", "success", "failure", "skipped", "skipped", false],
  ["true", "true", "success", "success", "failure", "success", false],
  ["true", "true", "success", "success", "success", "cancelled", false],
  ["true", "true", "success", "skipped", "success", "success", false],
  ["true", "true", "success", "success", "skipped", "success", false],
  ["", "", "success", "skipped", "skipped", "skipped", false],
] as const)(
  "merge gate: source=%s release=%s scope=%s regression=%s windows=%s linux=%s",
  (sourceRequired, releaseRequired, scopeResult, sourceResult, windowsResult, linuxResult, passes) => {
    const result = Bun.spawnSync(["bash", "-e", "-c", workflow.jobs.source!.steps[0]!.run!], {
      env: {
        ...process.env,
        SCOPE_RESULT: scopeResult,
        SOURCE_REQUIRED: sourceRequired,
        RELEASE_REQUIRED: releaseRequired,
        SOURCE_RESULT: sourceResult,
        WINDOWS_RESULT: windowsResult,
        LINUX_RESULT: linuxResult,
      },
    })
    expect(result.exitCode === 0).toBe(passes)
  },
)
