export const fixture: {
  api: Record<string, unknown>
  layout: boolean
  toasts: unknown[]
  refreshes: number
} = { api: {}, layout: true, toasts: [], refreshes: 0 }
const providers = new Map([["fixture", { id: "fixture", name: "Fixture provider" }]])
export const popularProviders: string[] = []
export const useProviders = () => ({ all: () => providers })
export const useServerSDK = () => () => ({ api: fixture.api })
export const useServerSync = () => () => ({
  data: { provider: { all: providers } },
  async refreshProviders() {
    fixture.refreshes++
  },
})
export const useSettings = () => ({ general: { newLayoutDesigns: () => fixture.layout } })
export const showToast = (value: unknown) => {
  fixture.toasts.push(value)
}
