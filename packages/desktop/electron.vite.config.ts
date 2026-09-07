import { defineConfig } from "electron-vite"
import appPlugin from "@opencode-ai/app/vite"
import { cp, mkdir, readdir, copyFile, readFile, writeFile } from "node:fs/promises"
import { compiledDesktopIdentity, compiledIdentityRecord } from "../physicalsystems/src/release/public-build"

const OPENCODE_SERVER_DIST = "../opencode/dist/node"
const physicalIdentity = compiledDesktopIdentity(process.env)

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.OPENCODE_CHANNEL === "latest") return "prod"
  return "dev"
})()

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`

export default defineConfig({
  main: {
    define: {
      "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
      "import.meta.env.PHYSICALSYSTEMS_BUILD_IDENTITY": JSON.stringify(physicalIdentity.kind),
    },
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts", sidecar: "src/main/sidecar.ts", "physical-worker": "src/main/physical-worker.ts" },
        // Keep this identical to electron-vite's Node 20.11+ shim. Its regex insertion can
        // corrupt bundled TypeScript, while a Rollup banner places the shim safely.
        output: {
          banner: `
// -- CommonJS Shims --
import __cjs_mod__ from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __cjs_mod__.createRequire(import.meta.url);
`,
        },
      },
      externalizeDeps: { include: [nodePtyPkg] },
    },
    plugins: [
      {
        name: "opencode:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "opencode:virtual-server-module",
        enforce: "pre",
        resolveId(id) {
          // Bun has already bundled the agent server. Keep that artifact separate
          // instead of parsing its entire dependency graph again in Rollup.
          if (id === "virtual:opencode-server") return { id: "./server/node.js", external: true }
          if (id === "virtual:physicalsystems-operator") return this.resolve("../physicalsystems/vendor/operator-service.mjs")
        },
      },
      {
        name: "opencode:copy-server-assets",
        async writeBundle() {
          await cp("../physicalsystems/vendor/skills", "./out/main/skills", { recursive: true })
          await mkdir("./out/legal", { recursive: true })
          await writeFile("./out/legal/physical-build-identity.json", JSON.stringify(
            compiledIdentityRecord(process.env, await readFile("./out/main/index.js")), null, 2,
          ) + "\n")
          await copyFile("../../LICENSE", "./out/legal/OpenCode-LICENSE")
          for (const name of ["LICENSE", "NOTICE", "manifest.json"]) {
            await copyFile(`../physicalsystems/vendor/${name}`, `./out/legal/PhysicalSystems-${name}`)
          }
          await mkdir("./out/main/server", { recursive: true })
          for (const l of await readdir(OPENCODE_SERVER_DIST)) {
            if (!l.endsWith(".wasm") && l !== "node.js") continue
            await copyFile(`${OPENCODE_SERVER_DIST}/${l}`, `./out/main/server/${l}`)
          }
        },
      },
    ],
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: process.env.PHYSICALSYSTEMS_BUILD_TARGET === "main" ? undefined : {
    plugins: [appPlugin],
    publicDir: "../../../app/public",
    root: "src/renderer",
    build: {
      sourcemap: true,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
        },
      },
    },
  },
})
