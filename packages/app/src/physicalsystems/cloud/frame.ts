// SPDX-License-Identifier: Apache-2.0
import { mountCloudConversation } from "./mount"
// Same-origin host injection only. No URL credentials, endpoint selection, or
// postMessage command surface; the parent supplies the already scoped transport.
Object.defineProperty(window, "physicalSystemsCloudConversation", {
  value: Object.freeze({ mount: mountCloudConversation }),
  writable: false,
  configurable: false,
})
