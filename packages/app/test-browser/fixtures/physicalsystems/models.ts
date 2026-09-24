import type {
  ModelAccountBridge,
  ModelAccountState,
  RobotModelSelection,
} from "../../../../physicalsystems/src/model-account-types"

const compatibility = {
  runtime: "lerobot-act-v1",
  platform: "linux-aarch64",
  robotType: "so101_follower",
  configurationSha256: "a".repeat(64),
}
const listeners = new Set<(value: ModelAccountState) => void>()
const initial: ModelAccountState = {
  revision: 1,
  status: "signed_out",
  account: null,
  companies: [],
  companyId: null,
  releases: [],
  devices: [],
  selection: null,
  pending: null,
  checkedAt: null,
  error: null,
  generic: [
    {
      id: "lerobot/smolvla_base",
      name: "SmolVLA base",
      source: { repoId: "lerobot/smolvla_base", revision: "d9f33c94a60fb382c90dea2164c96845bd955e28" },
      kind: "training_base",
      status: "runtime_setup_required",
      architecture: "smolvla",
      robotCompatibility: "unverified",
      canRun: false,
      description: "Training base",
    },
  ],
}
export const models = {
  state: structuredClone(initial),
  calls: [] as string[],
  emit() {
    models.state.revision++
    for (const listener of listeners) listener(structuredClone(models.state))
    return structuredClone(models.state)
  },
  approve() {
    Object.assign(models.state, {
      status: "signed_in",
      pending: null,
      account: { id: "fixture-account", name: "Lienert Fixture", email: "fixture@example.invalid" },
      companies: [
        { id: "company-a", name: "Robot lab", role: "viewer" },
        { id: "company-b", name: "Other company", role: "owner" },
      ],
      companyId: "company-a",
      checkedAt: new Date().toISOString(),
      releases: [
        {
          releaseId: "release-a",
          modelId: "Collars to tray",
          version: "v1",
          manifestSha256: "b".repeat(64),
          createdAt: new Date().toISOString(),
          compatibility,
          evaluation: { kind: "offline", reportPath: "evaluation/report.json" },
          keyId: "fixture",
          signatureVerified: true,
        },
      ],
      devices: [
        {
          id: "device-a",
          name: "Thor fixture",
          compatibility,
          revoked: false,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          desired: null,
          staged: { releaseId: "release-a", manifestSha256: "b".repeat(64) },
          selected: null,
          lastReport: { status: "staged", createdAt: new Date().toISOString() },
        },
      ],
    })
    return models.emit()
  },
}
export const modelBridge: ModelAccountBridge = {
  snapshot: async () => structuredClone(models.state),
  refresh: async () => models.emit(),
  subscribe: (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  signIn: async () => {
    models.calls.push("signIn")
    models.state.status = "signing_in"
    models.state.pending = {
      userCode: "1234567890ABCDEF",
      verificationUrl: "https://physicalsystems.ai/model-delivery/connect?code=1234567890ABCDEF",
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      browserOpened: true,
    }
    return models.emit()
  },
  cancelSignIn: async () => {
    models.calls.push("cancel")
    models.state.pending = null
    models.state.status = "signed_out"
    return models.emit()
  },
  signOut: async () => {
    models.calls.push("signOut")
    const revision = models.state.revision
    models.state = { ...structuredClone(initial), revision }
    return models.emit()
  },
  company: async (id) => {
    models.calls.push(`company:${id}`)
    models.state.companyId = id
    models.state.selection = null
    models.state.releases = []
    models.state.devices = []
    return models.emit()
  },
  select: async (selection: RobotModelSelection | null) => {
    models.calls.push("select")
    models.state.selection = selection
    return models.emit()
  },
}
