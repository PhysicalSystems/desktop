// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"

const root = dirname(fileURLToPath(import.meta.url))
const packages = ["ui", "session-ui"].map((name) => ({
  root: resolve(root, "packages", name),
  ...JSON.parse(readFileSync(resolve(root, "packages", name, "package.json"), "utf8")),
}))
export default defineConfig({
  root: resolve(root, "packages/app"),
  base: "./",
  publicDir: false,
  plugins: [
    {
      name: "canonical-source-exports",
      enforce: "pre",
      resolveId(id) {
        if (id.startsWith("@opencode-ai/core/util/")) {
          const name = id.slice("@opencode-ai/core/util/".length)
          if (!["path", "encode", "binary"].includes(name)) throw new Error("Unexported core dependency")
          return resolve(root, `packages/core/src/util/${name}.ts`)
        }
        const pkg = packages.find((pkg) => id.startsWith(`${pkg.name}/`))
        if (!pkg) return
        const subpath = `.${id.slice(pkg.name.length)}`
        const exact = pkg.exports[subpath]
        if (exact) return resolve(pkg.root, exact)
        const patterns = Object.entries(pkg.exports)
          .filter(([key]) => key.includes("*"))
          .sort(([a], [b]) => b.replace("*", "").length - a.replace("*", "").length)
        for (const [key, target] of patterns) {
          const [before, after] = key.split("*")
          if (subpath.startsWith(before) && subpath.endsWith(after))
            return resolve(
              pkg.root,
              target.replace("*", subpath.slice(before.length, after ? -after.length : undefined)),
            )
        }
        throw new Error(`Unexported UI dependency: ${id}`)
      },
    },
    tailwindcss(),
    solid(),
  ],
  resolve: { alias: { "@": resolve(root, "packages/app/src") }, dedupe: ["solid-js"] },
  worker: { format: "es" },
  build: {
    target: "es2022",
    sourcemap: false,
    outDir: resolve(root, "dist"),
    rollupOptions: { input: resolve(root, "packages/app/index.html") },
  },
})
