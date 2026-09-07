// SPDX-License-Identifier: Apache-2.0
import { createEffect, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { useLanguage } from "../context/language"
import type {
  LegacyArchive,
  LegacyArchiveSummary,
  LegacyMigrationBridge,
  LegacyPreview,
} from "../../../physicalsystems/src/migration-types"
import "./migration.css"

/** Historical text never enters ToolRegistry, a model prompt, or an operator command. */
export function MigrationHistory(props: { bridge?: LegacyMigrationBridge }) {
  const language = useLanguage()
  const bridge = () => props.bridge ?? window.api?.physicalSystems?.migration
  const [state, setState] = createStore<{
    open: boolean
    pending: boolean
    preview?: LegacyPreview
    archives: LegacyArchiveSummary[]
    archive?: LegacyArchive
    error: string
    copied: string
  }>({ open: false, pending: false, archives: [], error: "", copied: "" })
  const controls: { trigger?: HTMLButtonElement; heading?: HTMLHeadingElement; generation: number } = { generation: 0 }
  createEffect(() => {
    if (state.open) controls.heading?.focus()
  })
  const close = () => {
    controls.generation++
    setState({ open: false, pending: false, preview: undefined, archive: undefined, copied: "", error: "" })
    controls.trigger?.focus()
  }
  const perform = async <T,>(work: () => Promise<T>, done: (result: T) => void) => {
    if (state.pending) return
    const generation = controls.generation
    setState({ pending: true, error: "" })
    await work()
      .then(
        (result) => {
          if (generation === controls.generation) done(result)
        },
        () => {
          if (generation === controls.generation) setState("error", language.t("physicalsystems.migration.failure"))
        },
      )
      .finally(() => {
        if (generation === controls.generation) setState("pending", false)
      })
  }
  const list = () => {
    const api = bridge()
    if (api)
      void perform(
        () => api.list(),
        (archives) => setState("archives", archives),
      )
  }
  const open = () => {
    setState("open", true)
    list()
  }
  const preview = () => {
    const api = bridge()
    if (api)
      void perform(
        () => api.preview(),
        (value) => setState("preview", value ?? undefined),
      )
  }
  const commit = () => {
    const api = bridge(),
      value = state.preview
    if (!api || !value) return
    void perform(
      async () => {
        const summary = await api.commit(value.token)
        return { archive: await api.read(summary.id), archives: await api.list() }
      },
      (result) => setState({ ...result, preview: undefined }),
    )
  }
  const read = (id: string) => {
    const api = bridge()
    if (api)
      void perform(
        () => api.read(id),
        (archive) => setState({ archive, preview: undefined, copied: "" }),
      )
  }
  const copy = async (id: string, draft: string) => {
    await navigator.clipboard.writeText(draft).then(
      () => setState("copied", id),
      () => setState("error", language.t("physicalsystems.migration.clipboardFailure")),
    )
  }
  return (
    <Show when={bridge()}>
      <button
        type="button"
        class="ps-migration-trigger"
        ref={(element) => (controls.trigger = element)}
        onClick={open}
        aria-label={language.t("physicalsystems.migration.open")}
        title={language.t("physicalsystems.migration.open")}
      >
        <span aria-hidden="true">◷</span>
        <span>{language.t("physicalsystems.migration.open")}</span>
      </button>
      <Show when={state.open}>
        <Portal>
          <section
            class="ps-migration ps-stack"
            role="dialog"
            aria-modal="false"
            aria-labelledby="ps-migration-title"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation()
                close()
              }
            }}
          >
            <div class="ps-heading">
              <h2 id="ps-migration-title" tabindex="-1" ref={(element) => (controls.heading = element)}>
                {language.t("physicalsystems.migration.title")}
              </h2>
              <button type="button" aria-label={language.t("physicalsystems.migration.close")} onClick={close}>
                ×
              </button>
            </div>
            <p class="ps-muted">{language.t("physicalsystems.migration.notice")}</p>
            <Show when={state.error}>
              <p class="ps-error" role="alert">
                {state.error}
              </p>
            </Show>
            <Show when={state.pending}>
              <p role="status">{language.t("physicalsystems.migration.pending")}</p>
            </Show>
            <Show when={state.preview}>
              {(preview) => (
                <section class="ps-card ps-stack" data-ps-import-preview>
                  <h3>{language.t("physicalsystems.migration.preview")}</h3>
                  <p>
                    {language.t("physicalsystems.migration.summary", {
                      projects: preview().projectCount,
                      conversations: preview().conversationCount,
                      messages: preview().messageCount,
                    })}
                  </p>
                  <For each={preview().projects}>
                    {(project) => (
                      <p>
                        {language.t("physicalsystems.migration.projectSummary", {
                          name: project.name,
                          conversations: project.conversationCount,
                          messages: project.messageCount,
                        })}
                      </p>
                    )}
                  </For>
                  <p class="ps-muted">{language.t("physicalsystems.migration.excluded")}</p>
                  <For each={preview().warnings}>{(warning) => <p class="ps-muted">{warning}</p>}</For>
                  <div class="ps-actions">
                    <button type="button" disabled={state.pending} onClick={() => setState("preview", undefined)}>
                      {language.t("physicalsystems.migration.cancel")}
                    </button>
                    <button type="button" class="ps-primary" disabled={state.pending} onClick={commit}>
                      {language.t("physicalsystems.migration.confirm")}
                    </button>
                  </div>
                </section>
              )}
            </Show>
            <Show
              when={state.archive}
              fallback={
                <>
                  <div class="ps-actions">
                    <button type="button" disabled={state.pending} onClick={preview}>
                      {language.t("physicalsystems.migration.choose")}
                    </button>
                    <button type="button" disabled={state.pending} onClick={list}>
                      {language.t("physicalsystems.migration.reload")}
                    </button>
                  </div>
                  <Show
                    when={state.archives.length}
                    fallback={<p class="ps-muted">{language.t("physicalsystems.migration.empty")}</p>}
                  >
                    <For each={state.archives}>
                      {(archive) => (
                        <button
                          type="button"
                          class="ps-card ps-migration-archive"
                          disabled={state.pending}
                          onClick={() => read(archive.id)}
                        >
                          <For each={archive.projects}>
                            {(project) => (
                              <span>
                                {language.t("physicalsystems.migration.projectSummary", {
                                  name: project.name,
                                  conversations: project.conversationCount,
                                  messages: project.messageCount,
                                })}
                              </span>
                            )}
                          </For>
                          <code>{archive.id.slice(0, 23)}</code>
                        </button>
                      )}
                    </For>
                  </Show>
                </>
              }
            >
              {(archive) => (
                <>
                  <button type="button" disabled={state.pending} onClick={() => setState("archive", undefined)}>
                    {language.t("physicalsystems.migration.back")}
                  </button>
                  <For each={archive().projects}>
                    {(project) => (
                      <section class="ps-stack">
                        <div>
                          <h3>{project.name}</h3>
                          <span class="ps-muted">{language.t("physicalsystems.migration.offline")}</span>
                        </div>
                        <For each={project.conversations}>
                          {(conversation) => {
                            const [history, setHistory] = createStore({ open: false, count: 100 })
                            return <details class="ps-card ps-stack" onToggle={(event) => setHistory("open", event.currentTarget.open)}>
                              <summary>{conversation.title}</summary>
                              <Show when={history.open}>
                              <Show when={conversation.draft}>
                                <label>
                                  {language.t("physicalsystems.migration.draft")}
                                  <textarea readonly value={conversation.draft} rows="3" />
                                </label>
                                <button type="button" onClick={() => void copy(conversation.id, conversation.draft)}>
                                  {language.t("physicalsystems.migration.copy")}
                                </button>
                                <Show when={state.copied === conversation.id}>
                                  <p role="status">{language.t("physicalsystems.migration.copied")}</p>
                                </Show>
                              </Show>
                              <Show
                                when={conversation.messages.length}
                                fallback={<p class="ps-muted">{language.t("physicalsystems.migration.noMessages")}</p>}
                              >
                                <For each={conversation.messages.slice(0, history.count)}>
                                  {(message) => (
                                    <article class="ps-migration-message">
                                      <strong>
                                        {language.t(
                                          message.role === "user"
                                            ? "physicalsystems.migration.role.user"
                                            : message.role === "assistant"
                                              ? "physicalsystems.migration.role.assistant"
                                              : "physicalsystems.migration.role.historical",
                                        )}
                                      </strong>
                                      <pre>{message.text}</pre>
                                      <p class="ps-muted">
                                        {language.t("physicalsystems.migration.branch", {
                                          id: message.id,
                                          parent: message.parentId ?? language.t("physicalsystems.migration.root"),
                                        })}
                                      </p>
                                    </article>
                                  )}
                                </For>
                                <Show when={conversation.messages.length > history.count}><button type="button" onClick={() => setHistory("count", (count) => count + 100)}>{language.t("physicalsystems.migration.more")}</button></Show>
                              </Show>
                              </Show>
                            </details>
                          }}
                        </For>
                      </section>
                    )}
                  </For>
                </>
              )}
            </Show>
          </section>
        </Portal>
      </Show>
    </Show>
  )
}
