This fixture renders the production `UpdaterButton` and `useUpdaterAction` with the real platform/language providers and an inert native backend. It never opens Desktop, a Node connection, an installer, or an external download.

From `packages/app`, run the DOM regression test with:

```sh
bun test --conditions=browser --preload ./happydom.ts test-browser/preview-update-button.test.ts
```

The optional screenshot uses the installed `/snap/bin/geckodriver` and Firefox in an isolated headless session, plus a temporary loopback server. It closes those owned processes after capture. Pass an absolute output path:

```sh
bun test-browser/fixtures/preview-update-button/capture.ts "$(pwd)/../desktop/docs/preview-update-button.png"
```

The image shows actual shared button styles and representative states, rather than a running application or a completed native installation.
