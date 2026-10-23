interface ImportMetaEnv {
  readonly PHYSICALSYSTEMS_BUILD_IDENTITY: "candidate" | "public"
  readonly OPENCODE_CHANNEL: string
  readonly OPENCODE_VERSION?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
