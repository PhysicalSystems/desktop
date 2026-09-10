export type DesktopUpdaterConfiguration = Readonly<{
  provider: "generic"
  url: string
  publisherName: string
  verifyUpdateCodeSignature: boolean
}>

// Populate only from reviewed source after the signed feed and installed-app
// upgrade path are qualified. Runtime environment variables grant no authority.
export const REVIEWED_UPDATER_CONFIGURATION: DesktopUpdaterConfiguration | undefined = undefined

/** These constraints do not prove signing or qualification. The main process
 * must establish the actual packaged publisher and active native verifier.
 */
export function desktopUpdaterPolicy(input: {
  packaged: boolean
  platform: string
  arch: string
  identity: { kind: string; appId: string; productName: string }
  configuration?: DesktopUpdaterConfiguration
  packagedConfiguration?: unknown
  nativeSignatureVerification: boolean
}) {
  if (input.packaged !== true || input.platform !== "win32" || input.arch !== "x64")
    return { enabled: false, reason: "unsupported-installation" } as const
  if (
    input.identity.kind !== "public" ||
    input.identity.appId !== "systems.physical.desktop" ||
    input.identity.productName !== "Physical Systems"
  )
    return { enabled: false, reason: "unsupported-identity" } as const

  const configuration = input.configuration
  if (!configuration) return { enabled: false, reason: "unqualified-release" } as const
  // A generic provider can read a specifically selected Desktop release despite
  // the component-prefixed tags and other products in the download repository.
  if (
    configuration.provider !== "generic" ||
    typeof configuration.url !== "string" ||
    configuration.url.length > 2048 ||
    configuration.url.trim() !== configuration.url ||
    !/^https:\/\/github\.com\/PhysicalSystems\/physicalsystems\/releases\/download\/desktop-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-beta\.[1-9]\d*)?\/$/.test(
      configuration.url,
    )
  )
    return { enabled: false, reason: "untrusted-feed" } as const
  if (
    typeof configuration.publisherName !== "string" ||
    configuration.publisherName.length < 1 ||
    configuration.publisherName.length > 200 ||
    configuration.publisherName.trim() !== configuration.publisherName ||
    /[\x00-\x1f\x7f]/.test(configuration.publisherName) ||
    configuration.verifyUpdateCodeSignature !== true
  )
    return { enabled: false, reason: "unverified-publisher" } as const

  const packaged = input.packagedConfiguration
  // electron-updater 6.8.9 silently skips Authenticode verification when its
  // packaged app-update.yml has no publisherName, even with a build-time flag.
  if (
    !packaged ||
    typeof packaged !== "object" ||
    Array.isArray(packaged) ||
    !("publisherName" in packaged) ||
    !("verifyUpdateCodeSignature" in packaged) ||
    packaged.verifyUpdateCodeSignature !== true ||
    (packaged.publisherName !== configuration.publisherName &&
      !(
        Array.isArray(packaged.publisherName) &&
        packaged.publisherName.length === 1 &&
        packaged.publisherName[0] === configuration.publisherName
      )) ||
    input.nativeSignatureVerification !== true
  )
    return { enabled: false, reason: "native-verification-unavailable" } as const

  return { enabled: true, configuration } as const
}
