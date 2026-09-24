import { physicalSystemsEnglish } from "../../../src/physicalsystems/i18n"

export const useLanguage = () => ({
  t: (key: string, params: Record<string, unknown> = {}) =>
    Object.entries(params).reduce(
      (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
      physicalSystemsEnglish[key as keyof typeof physicalSystemsEnglish] ?? key,
    ),
})
export const Persist = { window: (key: string) => key }
export const persisted = <T extends unknown[]>(_key: string, store: T) => store
