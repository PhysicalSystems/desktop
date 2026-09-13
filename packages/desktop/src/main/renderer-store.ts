/** Renderer persistence names are flat logical names, never filesystem paths.
 * Main-owned update records live in a separate directory outside this namespace.
 */
export function rendererStoreName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value) ||
    value.endsWith(".") ||
    value.toLowerCase() === "physicalsystems.preview-updater"
  ) {
    throw new Error("INVALID_RENDERER_STORE")
  }
  return value
}
