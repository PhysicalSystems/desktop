export const fixture = { toasts: [] as unknown[] }

export function showToast(value: unknown) {
  fixture.toasts.push(value)
}
