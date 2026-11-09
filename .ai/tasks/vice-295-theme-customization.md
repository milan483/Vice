# Vice #295: better theme customization: implementation specification

Source: https://github.com/splitshotz/Vice/issues/295 (open; request for precise colors including pure black/white and optional Matugen colors)
Branch baseline: `splitshotz/Vice` main at `ad7758bf55e48b53db0b7e2dce11bedb465b90a3`.
This branch intentionally excludes three unrelated fork-only commits on `milan483/Vice:main` (GUI close and session tagging). Never reset the user's local changes.

## Findings (verified in current upstream code)

- `ui-src/components/AccentPicker.tsx` already accepts hex values and has HSV controls.
- `ui-src/theme/deriveAccent.ts` turns the hex into a Material 3 Expressive **hue-based** dark tonal scheme; the exact RGB is not the displayed accent. `rampFailures` explicitly forbids pure-black `bg` and `surfaceLowest`.
- `ui-src/theme/viceTheme.ts` maps `AccentRamp` to the Astryx theme and root variables; `ui-src/main.tsx` applies it.
- `ui-src/lib/accentChoice.ts` writes the selected mode/seed and prepaint colors to localStorage and syncs the **actual derived accent** to the Discord embed; `vice/ui/index.html` paints a pre-bundle cover.
- `vice/share.py` already provides `/api/app-state` at `~/.local/share/vice/ui_state.json`, useful if native-webview persistence is unreliable.
- Theme parity/static tests exist in `tests/test_ui_static.py` and `tools/verify-custom-accent.mjs`.

## PR 1: Exact manual themes and monochrome (implement on this branch)

### Product behavior
1. In Settings → Appearance keep all five presets and the **existing** generated custom accent unchanged.
2. Clearly distinguish **Generated Material 3** from **Manual exact** and **Monochrome / AMOLED dark** modes. The UI must never imply a generated tone is identical to the entered seed.
3. In manual mode, provide independent hex inputs for the *actual displayed primary accent* and *page background*, live preview, cancel/apply/reset, validation messages. Preserve exact values when applied; derive only the dependent surfaces, text/on-colors, hover/pressed and borders.
4. Support exact `#ffffff` as a bright accent on dark surfaces and `#000000` as the page background in AMOLED mode. A dark-on-dark accent (e.g. black accent over black background) is illegible: display the failure and prevent application rather than silently modifying user-provided hex. A general light-mode redesign is not requested.
5. Make the pure-black surface stack still distinguishable (cards, recessed controls, popovers), and disable/adapt the ambient wash for true black. Maintain readable buttons, focus states, outlines, disabled states and text. Preserve semantic error colors.
6. Keep the current `deriveAccent` and five generated presets consistent with `accents:verify`; separate the generated scheme's black prohibition from contrast checks for explicitly requested AMOLED backgrounds. Do not edit generated `accents.ts` manually.
7. Persist mode, colors, last custom seed and chosen palette safely across full native window restart, including a consistent **boot cover** before React loads. Migrate legacy `vice-theme` / `vice-custom-*` keys, provide sane fallback if missing/corrupt, preserve user choices when switching presets. When a theme is selected update `sharing.embed_color` using the actual primary accent.
8. Include localizations in `ui-src/locales/*.json` and keyboard-accessible form controls.

### Engineering approach (adapt if source reveals a better fit)
- Use an explicit discriminated theme selection model rather than overloading `AccentName` with increasingly ambiguous strings. Keep `AccentRamp` the rendering boundary.
- Add a pure function for constructing/validating exact dark palettes and separate contrast validation from the existing generated-palette `rampFailures` design restrictions.
- Preserve single theme resolution/caching; avoid deriving and repainting on every unrelated state change.
- Prefer existing store/hooks/Theme provider. Avoid global CSS overrides, a replacement styling framework, or new mandatory dependencies.
- Native `localStorage` is known unreliable on some builds, so consider `/api/app-state` as the durable source for new preferences, with a migration/read fallback. Never accept unchecked CSS strings or arbitrary file paths from an untrusted request.

### PR 1 acceptance
- [ ] Five existing swatches and generated custom schemes remain visually identical to baseline.
- [ ] `#ffffff` exact primary; `#000000` exact page; clearly layered AMOLED surfaces and readable text.
- [ ] Invalid hex, low-contrast pairs, grayscale seeds, black/white edge cases and cancellation are covered.
- [ ] All theme modes survive restart, mode switching and invalid/corrupt saved state.
- [ ] Boot screen has no stale theme flash; Discord share embed is correct.
- [ ] Keyboard focus, preview, modals, dropdowns, selection, and controls are usable.
- [ ] `npm run typecheck`, `npm run build`, `npm run accents:verify`, `npm run i18n:check`, `python -m unittest discover -s tests` pass or baseline differences are documented.
- [ ] Test on real KDE Plasma Wayland; post screenshots and a detailed implementation/test report **on the draft PR**. Never claim hardware testing without performing it.

## PR 2: Optional Matugen palette following (separate branch/PR after PR 1)

External research:
- Matugen documentation: https://github.com/InioX/matugen and https://github.com/InioX/matugen/wiki/Configuration
- Matugen 4.0 changed default JSON output: https://github.com/InioX/matugen/releases/tag/v4.0.0 . Do **not** assume the old `colors.dark` JSON shape applies to all versions.

Recommended integration contract:
1. Ship a **documented Matugen template** that exports a tiny versioned, Vice-specific JSON object with named Material dark/AMOLED roles (primary/on-primary, surfaces, text, containers, outlines, error colors). Users configure Matugen to write it to a fixed, user-owned file such as `~/.config/vice/matugen-theme.json`. Avoid relying on the changing default CLI `--json` format.
2. Offer opt-in Matugen mode in Settings. Read and validate the generated JSON with strict schema / hex validation / contrast checks and a size limit. Render roles directly through `AccentRamp`; **do not collapse the external scheme to one seed hue**.
3. Optional automatic synchronization follows changes to that fixed path with debouncing and atomic-write tolerance, updating the UI over existing daemon/WebSocket mechanisms; keep the last valid palette on partial/invalid files and display actionable errors. If no file exists, stay with a safe prior theme. Matugen must not be a Vice installation/runtime dependency.
4. Support an import-once fallback if access to the generated file is unavailable (e.g., sandboxed builds). Do not run arbitrary commands or trust supplied paths; document host/Flatpak constraints and whether follow mode requires the daemon.
5. Test missing/malformed/oversized JSON, file changes, disappear/reappear, disabled follow, rapid writes, startup, and no Matugen installed. No UI freezes or repeated warning toasts.

These two PRs should be small, independently reviewable changes. No full light-mode support, automatic KDE wallpaper extraction, or fork-specific capture/recording changes in scope.

## Handoff/PR requirements

Codex: read **this file** and issue #295 first; only inspect code necessary for PR 1. Preserve uncommitted work. Implement and run appropriate automated + local validation, then push this branch, keep PR **draft**, and post implementation summary, test results, screenshots if available, risk/limitations, and exact SHA on the PR. Do not merge or release. ChatGPT will review the resulting diff and CI before any upstream submission.
