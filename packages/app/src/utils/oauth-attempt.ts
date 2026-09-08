/** Responses belong to one selected sign-in method. Leaving that method must
 * not open an old URL, close a newer dialog or retain a pending server attempt. */
export function createOAuthAttempt<T extends { attemptID: string }>(cancel: (attempt: T) => Promise<unknown>) {
  let revision = 0
  let authorization: T | undefined
  const discard = (value: T) => {
    void Promise.resolve()
      .then(() => cancel(value))
      .catch(() => {})
  }
  const current = (ticket: number, attemptID?: string) =>
    ticket === revision && (attemptID === undefined || authorization?.attemptID === attemptID)
  return {
    begin(cancelPending = true) {
      revision++
      if (authorization && cancelPending) discard(authorization)
      authorization = undefined
      return revision
    },
    accept(ticket: number, value: T) {
      if (!current(ticket)) {
        discard(value)
        return false
      }
      authorization = value
      return true
    },
    current,
    authorization: () => authorization,
    ticket: () => revision,
  }
}

export function oauthBrowserURL(value: string) {
  if (typeof value !== "string" || value.length > 8192 || !URL.canParse(value)) return
  const url = new URL(value)
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return
  return url.href
}
