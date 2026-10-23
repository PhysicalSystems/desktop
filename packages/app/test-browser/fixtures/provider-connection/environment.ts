export const fixture: { api: Record<string, unknown>; layout: boolean; toasts: unknown[]; refreshes: number } = {
  api: {},
  layout: true,
  toasts: [],
  refreshes: 0,
}
const providers = new Map([["fixture", { id: "fixture", name: "Fixture provider" }]])
export const useProviders = () => ({ all: () => providers, anyConnection: () => true })
export const useIntegrations = () => ({ list: () => [] })
export const useServerSDK = () => ({ api: fixture.api })
const collection = {
  list: () => [],
  invalidate() {},
  async sync() {
    fixture.refreshes++
  },
}
export const useData = () => ({ location: { provider: collection, integration: collection, model: collection } })
export const useGlobal = () => ({ models: { show() {} } })
export const useTabs = () => ({})
export const showToast = (value: unknown) => {
  fixture.toasts.push(value)
}
