// SPDX-License-Identifier: Apache-2.0
import { createEffect, createMemo, For, onCleanup, Show, type JSX, type ParentProps } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { useLanguage } from "../context/language"
import { usePlatform } from "../context/platform"
import { showToast } from "../utils/toast"
import { useModelAccount } from "./model-account"
import type { CompanyModelRelease, ModelDevice } from "../../../physicalsystems/src/model-account-types"

function ModelMenu(props: ParentProps<{ label: string; trigger: JSX.Element; action: string; compact?: boolean }>) {
  const [state, setState] = createStore({ open: false, left: 0, offset: 0, above: true, height: 520 })
  let trigger: HTMLButtonElement | undefined
  let panel: HTMLDivElement | undefined
  const close = () => setState("open", false)
  createEffect(() => {
    if (!state.open) return
    const outside = (event: PointerEvent) => {
      if (!panel?.contains(event.target as Node) && !trigger?.contains(event.target as Node)) close()
    }
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close()
        trigger?.focus()
      }
    }
    const scrolled = (event: Event) => {
      if (!panel?.contains(event.target as Node)) close()
    }
    document.addEventListener("pointerdown", outside)
    document.addEventListener("keydown", keyboard)
    window.addEventListener("resize", close)
    window.addEventListener("scroll", scrolled, true)
    queueMicrotask(() => panel?.querySelector<HTMLElement>("button, select, a")?.focus({ preventScroll: true }))
    onCleanup(() => {
      document.removeEventListener("pointerdown", outside)
      document.removeEventListener("keydown", keyboard)
      window.removeEventListener("resize", close)
      window.removeEventListener("scroll", scrolled, true)
    })
  })
  return (
    <>
      <button
        ref={trigger}
        type="button"
        class={props.compact ? "ps-robot-model-trigger" : "ps-settings-button ps-account-trigger"}
        data-action={props.action}
        aria-label={props.label}
        title={props.label}
        aria-haspopup="dialog"
        aria-expanded={state.open}
        onClick={() => {
          const rect = trigger!.getBoundingClientRect()
          const above = rect.top >= 300 || rect.top > window.innerHeight - rect.bottom
          setState({
            open: !state.open,
            left: Math.max(8, Math.min(rect.left, window.innerWidth - 348)),
            above,
            offset: above ? window.innerHeight - rect.top + 8 : rect.bottom + 8,
            height: Math.max(
              60,
              Math.min(520, window.innerHeight * 0.65, above ? rect.top - 16 : window.innerHeight - rect.bottom - 16),
            ),
          })
        }}
      >
        {props.trigger}
      </button>
      <Show when={state.open}>
        <Portal>
          <div
            ref={panel}
            class="ps-model-menu"
            role="dialog"
            aria-label={props.label}
            style={{
              left: `${state.left}px`,
              bottom: state.above ? `${state.offset}px` : undefined,
              top: state.above ? undefined : `${state.offset}px`,
              "max-height": `${state.height}px`,
            }}
          >
            {props.children}
          </div>
        </Portal>
      </Show>
    </>
  )
}

function AccountError() {
  const account = useModelAccount()!
  const language = useLanguage()
  return (
    <Show when={account.state.failed || account.state.snapshot?.error}>
      <p role="alert" class="ps-model-error">
        {language.t(
          `physicalsystems.account.error.${account.state.failed ? "UNAVAILABLE" : account.state.snapshot!.error!}`,
        )}
      </p>
    </Show>
  )
}

function CompanyChoice() {
  const account = useModelAccount()!
  const language = useLanguage()
  return (
    <Show when={account.state.snapshot?.status === "signed_in"}>
      <Show
        when={account.state.snapshot!.companies.length}
        fallback={<p>{language.t("physicalsystems.account.noCompanies")}</p>}
      >
        <label>
          {language.t("physicalsystems.account.company")}
          <select
            data-model-company
            value={account.state.snapshot!.companyId ?? ""}
            disabled={account.state.pending}
            onChange={(event) => void account.company(event.currentTarget.value)}
          >
            <For each={account.state.snapshot!.companies}>
              {(company) => <option value={company.id}>{company.name}</option>}
            </For>
          </select>
        </label>
      </Show>
    </Show>
  )
}

export function ModelAccountMenu(props: { expanded: boolean }) {
  const account = useModelAccount()
  const language = useLanguage()
  const platform = usePlatform()
  const identity = () => account?.state.snapshot?.account
  const openPortal = async () => {
    const url = "https://physicalsystems.ai/model-delivery"
    const opened = await Promise.resolve()
      .then(async () => await platform.openExternal(url))
      .catch(() => false)
    if (opened === false)
      showToast({
        title: language.t("physicalsystems.portal.failed"),
        description: language.t("physicalsystems.portal.openManually", { url }),
      })
  }
  return (
    <Show when={account?.enabled}>
      <ModelMenu
        action="physicalsystems-account"
        label={language.t("physicalsystems.account.title")}
        trigger={
          <>
            <span class="ps-account-avatar" aria-hidden="true">
              {identity()?.name.slice(0, 1).toUpperCase() ?? "P"}
            </span>
            <Show when={props.expanded}>
              <span class="ps-account-name">{identity()?.name ?? language.t("physicalsystems.account.signIn")}</span>
            </Show>
          </>
        }
      >
        <strong>{identity()?.name ?? language.t("physicalsystems.account.title")}</strong>
        <Show when={identity()}>
          <p class="ps-model-muted">{identity()!.email}</p>
        </Show>
        <AccountError />
        <Show when={account!.state.snapshot?.pending}>
          {(pending) => (
            <>
              <p>{language.t("physicalsystems.account.completeSignIn")}</p>
              <code class="ps-model-code">{pending().userCode}</code>
              <p class="ps-model-muted">{pending().verificationUrl}</p>
              <button disabled={account!.state.pending} onClick={() => void account!.cancel()}>
                {language.t("physicalsystems.account.cancel")}
              </button>
            </>
          )}
        </Show>
        <Show when={!account!.state.snapshot?.pending && account!.state.snapshot?.status !== "signed_in"}>
          <button data-model-sign-in disabled={account!.state.pending} onClick={() => void account!.signIn()}>
            {language.t("physicalsystems.account.google")}
          </button>
        </Show>
        <CompanyChoice />
        <button data-ps-company-models onClick={() => void openPortal()}>
          <Icon name="outline-square-arrow" />
          {language.t("physicalsystems.portal.label")}
        </button>
        <button disabled={account!.state.pending} onClick={() => void account!.refresh()}>
          {language.t("physicalsystems.account.refresh")}
        </button>
        <Show when={identity() || account!.state.snapshot?.status === "unavailable"}>
          <button data-model-sign-out disabled={account!.state.pending} onClick={() => void account!.signOut()}>
            {language.t("physicalsystems.account.signOut")}
          </button>
        </Show>
      </ModelMenu>
    </Show>
  )
}

export function RobotModelPicker() {
  const account = useModelAccount()
  const language = useLanguage()
  const selected = createMemo(() => {
    const value = account?.state.snapshot?.selection
    if (value?.kind === "company") {
      const release = account?.state.snapshot?.releases.find((item) => item.releaseId === value.releaseId)
      return release ? `${release.modelId} · ${release.version}` : undefined
    }
    if (value?.kind === "generic") return account?.state.snapshot?.generic.find((item) => item.id === value.id)?.name
  })
  return (
    <Show when={account?.enabled}>
      <ModelMenu
        compact
        action="prompt-robot-model"
        label={language.t("physicalsystems.models.choose")}
        trigger={
          <>
            <span>{selected() ?? language.t("physicalsystems.models.label")}</span>
            <Icon name="chevron-down" />
          </>
        }
      >
        <strong>{language.t("physicalsystems.models.choose")}</strong>
        <p class="ps-model-muted">{language.t("physicalsystems.models.referenceOnly")}</p>
        <AccountError />
        <CompanyChoice />
        <h3>{language.t("physicalsystems.models.company")}</h3>
        <Show
          when={account!.state.snapshot?.status === "signed_in"}
          fallback={<p>{language.t("physicalsystems.models.signInHelp")}</p>}
        >
          <Show
            when={account!.state.snapshot!.releases.length}
            fallback={<p>{language.t("physicalsystems.models.noReleases")}</p>}
          >
            <For each={account!.state.snapshot!.releases}>
              {(release) => (
                <div class="ps-model-option">
                  <button
                    disabled={account!.state.pending}
                    aria-pressed={
                      account!.state.snapshot?.selection?.kind === "company" &&
                      (account!.state.snapshot.selection as { releaseId: string }).releaseId === release.releaseId
                    }
                    onClick={() =>
                      void account!.select({
                        kind: "company",
                        companyId: account!.state.snapshot!.companyId!,
                        releaseId: release.releaseId,
                        manifestSha256: release.manifestSha256,
                      })
                    }
                  >
                    {release.modelId} · {release.version}
                  </button>
                  <p class="ps-model-muted">
                    {language.t("physicalsystems.models.signature")} ·{" "}
                    {language.t(
                      release.evaluation.kind === "supervised"
                        ? "physicalsystems.models.supervised"
                        : "physicalsystems.models.offline",
                    )}
                  </p>
                  <p class="ps-model-muted">
                    {release.compatibility.runtime} · {release.compatibility.robotType} ·{" "}
                    {release.compatibility.platform}
                  </p>
                  <ModelReadiness release={release} devices={account!.state.snapshot!.devices} />
                </div>
              )}
            </For>
          </Show>
        </Show>
        <h3>{language.t("physicalsystems.models.generic")}</h3>
        <Show
          when={account!.state.snapshot?.generic.length}
          fallback={<p>{language.t("physicalsystems.models.catalogUnavailable")}</p>}
        >
          <For each={account!.state.snapshot!.generic}>
            {(model) => (
              <div class="ps-model-option">
                <button
                  disabled={account!.state.pending}
                  aria-pressed={
                    account!.state.snapshot?.selection?.kind === "generic" &&
                    (account!.state.snapshot.selection as { id: string }).id === model.id
                  }
                  onClick={() =>
                    void account!.select({ kind: "generic", id: model.id, revision: model.source.revision })
                  }
                >
                  {model.name}
                </button>
                <p class="ps-model-muted">{language.t("physicalsystems.models.trainingBase")}</p>
                <code>
                  {model.source.repoId} · {model.source.revision.slice(0, 12)}
                </code>
              </div>
            )}
          </For>
        </Show>
        <div class="ps-model-actions">
          <button disabled={account!.state.pending} onClick={() => void account!.refresh()}>
            {language.t("physicalsystems.account.refresh")}
          </button>
          <button
            disabled={account!.state.pending || !account!.state.snapshot?.selection}
            onClick={() => void account!.select(null)}
          >
            {language.t("physicalsystems.models.clear")}
          </button>
        </div>
      </ModelMenu>
    </Show>
  )
}

function ModelReadiness(props: { release: CompanyModelRelease; devices: ModelDevice[] }) {
  const language = useLanguage()
  const compatible = createMemo(() =>
    props.devices.filter(
      (device) =>
        !device.revoked &&
        Date.parse(device.expiresAt) > Date.now() &&
        (["runtime", "platform", "robotType", "configurationSha256"] as const).every(
          (key) => device.compatibility[key] === props.release.compatibility[key],
        ),
    ),
  )
  return (
    <Show
      when={compatible().length}
      fallback={<p class="ps-model-muted">{language.t("physicalsystems.models.noCompatibleDevice")}</p>}
    >
      <For each={compatible()}>
        {(device) => {
          const reported = () =>
            device.lastReport &&
            Date.now() - Date.parse(device.lastReport.createdAt) < 300_000 &&
            Date.parse(device.lastReport.createdAt) <= Date.now()
          const staged = () =>
            device.staged?.releaseId === props.release.releaseId &&
            device.staged.manifestSha256 === props.release.manifestSha256
          return (
            <p class="ps-model-muted">
              {language.t("physicalsystems.models.deviceStatus", {
                name: device.name,
                status: language.t(
                  !reported()
                    ? "physicalsystems.models.statusUnknown"
                    : device.lastReport?.status === "failed"
                      ? "physicalsystems.models.statusFailed"
                      : staged()
                        ? "physicalsystems.models.statusStaged"
                        : "physicalsystems.models.statusNotStaged",
                ),
              })}
            </p>
          )
        }}
      </For>
    </Show>
  )
}
