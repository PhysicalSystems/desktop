// SPDX-License-Identifier: Apache-2.0
const password = process.env.OPENCODE_SERVER_PASSWORD
if (!password) process.exit(1)
const response = await fetch(`http://127.0.0.1:${process.env.PORT ?? "4096"}/api/health`, {
  headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
  signal: AbortSignal.timeout(5000),
  redirect: "error",
}).catch(() => undefined)
process.exit(response?.ok ? 0 : 1)
