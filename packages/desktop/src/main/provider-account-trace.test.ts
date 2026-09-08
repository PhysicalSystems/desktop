// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { providerAccountTrace } from "./provider-account-trace"

test("normal desktop usage and failed/operator/non-OAuth writes emit no account diagnostic", () => {
  const calls: string[] = []
  const write = (_fd: number, value: string) => {
    calls.push(value)
  }
  const input = {
    key: "physicalsystems.v2." + createHash("sha256").update("openai").digest("hex"),
    info: {
      kind: "physicalsystems-v2-credential",
      record: {
        id: "cred_fixture",
        integrationID: "openai",
        value: {
          type: "oauth",
          methodID: "chatgpt-headless",
          access: "private-token-canary",
          refresh: "private-refresh-canary",
          metadata: { accountID: "private-account-canary" },
        },
      },
    },
  }
  providerAccountTrace("set", input, { saved: true }, { env: {}, write })
  providerAccountTrace("set", input, { saved: true }, { env: { PHYSICALSYSTEMS_QUALIFICATION_TRACE: "1" }, write })
  const env = {
    PHYSICALSYSTEMS_PROVIDER_REVIEW: "openai-device",
    PHYSICALSYSTEMS_QUALIFICATION_TRACE: "1",
    PHYSICALSYSTEMS_PROVIDER_REVIEW_NONCE: "a".repeat(64),
  }
  providerAccountTrace("set", input, { saved: false }, { env, write })
  providerAccountTrace("remove", input, { saved: true }, { env, write })
  expect(calls).toEqual([])
  providerAccountTrace("set", input, { saved: true }, { env, write })
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatch(/^PHYSICALSYSTEMS_PROVIDER_ACCOUNT_WRITE [a-f0-9]{64} cred_fixture [a-f0-9]{64}\n$/)
  expect(calls[0]).not.toContain("private-")
  expect(calls[0]).not.toContain(env.PHYSICALSYSTEMS_PROVIDER_REVIEW_NONCE)
  expect(() =>
    providerAccountTrace(
      "set",
      input,
      { saved: true },
      {
        env,
        write: () => {
          throw new Error("write failed")
        },
      },
    ),
  ).not.toThrow()
})
