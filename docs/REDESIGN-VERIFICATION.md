# EZClaw desktop redesign verification

Verified on 2026-11-10 in Chromium, using the real frontend and local API with the existing mock provider.

Correction after workflow audit: the original redesign incorrectly hid the Edit composer until a target image existed and grouped existing controls in a new accordion. Both changes have been reverted. Edit now shows an editable instruction field immediately, without a model or target. The new Chat/Image prompt suggestions and added Library actions have also been removed to keep the redesign visual only. The previous visual checks did not establish workflow parity; the additional source and interaction checks below cover that regression.

## Scope

The owner's final direction is a compact desktop-only application, including a future native desktop application. The frontend now has a permanent 208px rail, a 264px inline inspector, a 44px toolbar, and 30px primary controls. Minimum intended window: 1024 by 640 CSS pixels. Mobile layouts and touch targets are outside this delivery's scope, overriding antislop R-03 by explicit session instruction.

Native packaging was not part of this implementation. All changes remain in the existing React application.

QA used `.sandbox-redesign` for database, credentials, assets, and a test workspace, with the frontend at port 5175, API at 8790, and mock provider at 9911. Existing user data and provider keys were not used. Test conversations, images, and model overrides exist only in that sandbox.

## Build and automated checks

- `pnpm build`: web TypeScript checks, production Vite build, and server bundle completed.
- `pnpm typecheck`: all workspace packages passed; subsequent frontend builds checked the final frontend changes.
- `pnpm test`: 18 test files and 372 tests passed, comprising 95 core, 30 registry, and 247 server tests.
- `git diff --check`: clean.
- Final browser console after a fresh navigation: zero errors and zero warnings. Deliberate invalid-form and simulated API-failure checks produced expected HTTP 400 and 503 entries in earlier QA sessions.
- Route components load on demand. The desktop build's entry JavaScript is approximately 328.21 kB, or 99.13 kB gzip. These are build artifact sizes, not runtime performance measurements.
- Vite retains its large-chunk advisory for an existing syntax-highlighting language bundle. Code highlighting remains deferred until used.
- Field Core Web Vitals and Lighthouse scores: not measured.

## Desktop layout and visual review

The compact pass opened all 12 routes at 1024x640, 1440x900, and 1920x1080, totaling 36 checks. No horizontal overflow or missing page headings were found. Prompt fields stayed visible and editable. Each mode kept its inline inspector and permanent rail; no modal inspector appeared automatically.

Reviewed screenshots of the desktop welcome, a populated conversation in dark mode, Settings, and the image-editing flow. Controls use separate radii for tags, fields, panels, and the composer. Edit shows the target stage and full composer together. References, preservation options, and output controls are directly visible in their original order. Only the original compiled-prompt details remains collapsible.

## Workflow parity audit

The compact pass changes sizing, layout classes, typography, and initial textarea rows only. It adds no controls, conditional steps, handlers, or state logic. Textareas retain their existing automatic growth while typing. The updated source audit covers 784 bindings across 25 component/page files; the only differences from the original remain the four previously documented desktop modal-inspector callbacks. The 14 Edit control declarations still match the baseline order and native-details ancestry.

- Compared 460 event/state bindings across 19 changed component/page files to Git HEAD using TypeScript tokenization. The only removed bindings are the four old modal-inspector close callbacks, replaced by the explicit desktop inline layout. The remaining action handlers, values, disabled states, model/spec/target props, references, parameters, and send bindings match the baseline.
- Checked the complete Edit control order and native-details ancestry against the baseline; no new disclosure layer remains.
- All 14 Edit control declarations match the baseline order and native-details ancestry exactly.
- With no endpoints and no models, the Edit instruction field is visible and editable; the submit button retains its original blocked state.
- Typed a draft before selecting a model or image, selected preservation options, picked a model, then uploaded a target. Both the draft and preservation selections remained. The original submit rules then enabled Edit.
- Exercised the existing manual-prompt/reset controls and visible output controls, submitted an edit, and observed the actual v1 result.
- Source review confirmed the request-building, validation, draft initialization, image upload, model capability, and generation/edit functions were not changed by the visual redesign.
- Rechecked the prompt fields in all four modes at 1024x640, 1440x900, 1534x735, and 1920x1080: 16 checks, all fields visible and editable, no horizontal overflow. Re-ran all 24 desktop axe theme scans with zero reported violations.
- Rebuilt the production frontend and re-ran all 372 project tests successfully after the workflow restoration.

## Compact layout measurements

Measured in the running frontend at 1440x900 before and after the density pass:

| Surface | Before | Compact |
| --- | --- | --- |
| Sidebar width | 244px | 208px |
| Inspector width | 304px | 264px |
| Header height | 64px | 44px |
| Main work stage width | 878px | 960px |
| Chat composer including hint/gutters | 235px high | 168.4px high |
| Edit composer | 356.6px high | 294.6px high |
| Empty Edit upload stage | 196px high | 82px high |
| First Settings section | 165.3px high | 132.8px high |

The compact pass keeps UI text at 14px and prose at 15px, reduces padding and gaps, uses wider content containers, and makes welcome text a small aligned introduction instead of a large hero. No controls are hidden to achieve the density change.

Compact verification: the production frontend build and TypeScript checks passed. All 36 layout checks and all 24 light/dark axe scans passed. A multiline Chat draft grew the field from 44px to 129px, survived model selection, and sent successfully with Ctrl+Enter; the inspector and Ctrl+K search also remained functional. Read-only verification of the running application at `127.0.0.1:8787/edit` confirmed the 208px rail, 264px inspector, 44px header, 30px submit button, and visible/editable prompt. The browser console reported zero errors. The desktop antislop gate remains PASS with the original workflow preserved.

## Recorded browser interactions

| Control | Observed result |
| --- | --- |
| Chat, Agent, Image, Edit navigation | Clicked each link; opened its real route with its page heading. |
| Library and Settings navigation | Clicked each link; opened its real route. |
| Umum, Endpoint, Model, Harness, Memori, MCP, Skills | Clicked all seven Settings tabs; each opened its matching route. |
| New thread | Returned to an empty composer on the same mode route. |
| Inspector button | Hid and reopened the inline inspector; no navigation or modal substitution. |
| Theme: light, dark, system | Changed the rendered theme; system removed the explicit theme attribute. |
| Keyboard skip link | Enter moved focus to the main workspace. |
| Ctrl+K | Opened search immediately, without an entrance animation. |
| Search input and Enter | Found the sandbox thread by its new title and navigated to it. |
| Escape in dialogs | Closed model, request, search, comparison, and inspector-era QA dialogs through native dialog behavior. The final desktop inspector itself is inline. |
| Empty endpoint form | Returned visible validation feedback. |
| Add endpoint | Saved the local mock endpoint and loaded its models. |
| Test connection | Connected to the mock provider and refreshed the discovered models. |
| Model picker and search | Filtered to echo, slow, agent-read, and the test image model; selecting a result updated the composer. |
| Chat send | Created a thread, streamed an answer, and returned the send control to idle. |
| Stop | Stopped the slow mock stream and displayed the stopped state. |
| Pin | Updated the pin control and sidebar indicator. |
| Rename and save | Updated both the page heading and thread title. |
| Delete and cancel | Opened the confirmation dialog; cancel kept the thread. |
| Copy answer | Read back the expected answer from the clipboard after granting browser clipboard permission. |
| Request log | Opened the actual request details with sensitive headers redacted by the existing backend. |
| Agent workspace field and check | Verified the sandbox folder. |
| Agent send | Read `hello.txt` in the sandbox and displayed the file content in the completed response. |
| Image count and create | Selecting two outputs produced two stored mock images. |
| Enlarge image | Opened the image preview; Escape closed it. |
| Use as reference and remove reference | Added a reference thumbnail and removed it again. |
| Edit this image | Opened the actual generated asset as an editing target. |
| Edit before target/model | Instruction field and original controls were visible; typed a draft while submit remained blocked. |
| Upload target after writing | Uploaded a local QA screenshot; the existing composer and its typed draft remained. |
| Preservation controls | Updated selected state and recorded the chosen preservation option with the edit. |
| Manual prompt and reset | Marked the prompt as manual; reset restored the template. |
| Edit output count | Changed the number of requested edits through the existing parameter state. |
| Edit send | Created v1 and subsequently v2 in the real version lineage. |
| Compare side by side | Displayed the two selected versions. |
| Compare slider | Changing the slider to 70 updated the reveal position. |
| Library image | Opened prompt and model details for a stored image. |
| Favorite | Updated the favorite action and marker; the favorite filter limited results. |
| Search with no matches | Displayed the filter-specific empty state. |
| Delayed Library request | Displayed the named loading state. |
| Simulated Library failure | Displayed the returned cause using the existing error state. |
| Reduced motion | Inspector transition duration computed to `0s`; non-essential animation was disabled. |

Deep external integrations, real provider billing, OS-native folder dialogs, and unrelated Settings mutations were not exercised against live accounts. Their existing handlers and backend tests remain in place.

## Accessibility evidence

axe-core checked all 12 routes in both themes on the final desktop shell: 24 scans with zero reported violations under WCAG 2 A/AA, WCAG 2.1 AA, WCAG 2.2 AA, and best-practice tags.

The scanner marked gradient-backed and empty-input contrast for manual review. The actual theme tokens and composited glass colors were checked separately using the WCAG relative-luminance formula. All 32 tested text/background pairs per theme exceeded 4.5:1: minimum 5.24:1 in light mode and 4.69:1 in dark mode. Glass composites were tested over both endpoint colors of the workspace gradient. Empty-input placeholders use the checked secondary-text tokens.

## Antislop delivery gate

The following results apply to the final desktop scope. Design reasons and ENERGY 2 / RHYTHM 2 / MOTION 2 are recorded in `DESIGN.md`.

### Hard gate

- R-02 PASS: source search found no authored em dash in frontend UI text.
- R-03 PASS with owner override: mobile responsiveness is explicitly excluded; all 36 desktop layout checks passed.
- R-17 PASS: no new usage statistics were introduced; counts and run metadata come from API responses.
- R-18 PASS: no testimonials, invented people, or profile photographs were added.
- R-23 PASS: reused the existing text wordmark and icon family; no production visual assets or new navigation destinations were invented.
- R-24 PASS: all navigation destinations exist; the 13 sidebar/Settings link actions were clicked.
- R-25 PASS: 24 axe scans and the separate 64 text/background contrast calculations support both themes.
- R-26 PASS: modified controls retain real handlers; the browser action table records their observable effects.
- R-27 PASS: empty, loading, failure, and successful recovery states were observed using Library and the first-run mode screens.
- R-28 PASS: no FAQ was added.
- R-32 PASS: native controls, visible focus styles, native dialog Escape behavior, search keyboard navigation, and the skip link were checked.
- R-33 PASS: features were edited directly in source with patches; the formatter only formatted the edited component.
- R-34 PASS: both themes passed route scans and visual review; system preference was also exercised.
- R-35 PASS: production builds ran, all route views opened, interactions were recorded above, and the final console was clean.
- R-36 PASS: no new security, compliance, customer, or runtime-performance claims were introduced.
- R-37 PASS: the owner's Material/glass/sage brief and subsequent desktop-only direction are recorded in `DESIGN.md`.
- R-38 PASS: production views use actual application data; explicitly named test fixtures remain isolated to the QA sandbox.
- R-39 PASS for desktop scope: new controls use native elements and accessible names, semantic labels, pointer/disabled states, keyboard focus, and reduced-motion support; final axe scans report no violations.
- R-40 PASS: asset views reserve an aspect ratio, fonts are bundled locally, no render-blocking third-party script was added, and unmeasured performance metrics are not claimed.

### Purpose gate

- R-01 PASS: sage preserves the existing brand; the neutral surface gradient separates reading space from the composer plane.
- R-04 PASS: Phosphor glyphs describe real navigation, file, image, pin, rename, and delete actions.
- R-06 PASS: the existing Hyperlegible family supports model IDs and technical content; mono remains reserved for technical strings.
- R-07 PASS: no decorative background pattern was introduced.
- R-08 PASS: arrows remain directional controls such as send and scroll, without decorative CTA arrows.
- R-09 PASS: status and endpoint labels carry real application context; no promotional badges were added.
- R-10 PASS: only the current thread header and composer use backdrop blur, two surfaces at most per mode.
- R-12 PASS: shadows distinguish floating composer, popovers, and dialogs; static lists and inspector sections remain flat.
- R-13 PASS: no decorative glow was introduced.
- R-14 PASS: views follow conversations, tasks, image output, and editing targets rather than feature-card grids.
- R-19 PASS: CSS transitions acknowledge presses and explain panel/dialog changes; search opens immediately and reduced motion disables movement.
- R-22 PASS: no decorative illustration was added.

### Liveliness

- Design Read PASS: desktop AI workbench, Material with glass accents, declared before implementation and updated after owner steering.
- Dials PASS: ENERGY 2 / RHYTHM 2 / MOTION 2 match the restrained color, mode-specific composition, and short interaction motion.
- Focal point PASS: conversation/composer, agent workspace, image output, or edit target leads each respective mode.
- Whitespace PASS: reading columns, dense inspector controls, and open image stages have separate spacing roles.
- Accent PASS: sage emphasizes actions and selection; ember remains reserved for owner intervention.
- Identity PASS: sage rail, inset workspace, readable technical typography, and the existing run-state nodes repeat across modes.

### Craftsmanship and quality locks

- C-1 PASS: major color, type, spacing, shape, elevation, icon, and motion decisions have written reasons.
- C-2 PASS: the recorded modified controls perform real state changes or navigation.
- C-3 PASS: every view serves an existing workbench mode or configuration task; no filler dashboard was introduced.
- C-4 PASS for desktop scope: 36 layout checks, 24 theme scans, keyboard checks, and recovery checks passed.
- C-5 PASS: no fabricated evidence or customer claims were added.
- R-05 PASS: Chat, Agent, Image, Edit, Settings, and Library follow their actual content needs.
- R-11 PASS: tags, controls, panels, and composer use distinct radii.
- R-15 PASS: actions name their effects, such as connecting a model, creating an image, sending, or resetting filters.
- R-16 PASS: no generic AI marketing language was added.
- R-20 PASS: the original sage identity and technical-reading type remain visible throughout the desktop workbench.
- R-21 PASS: light, dark, and system themes remain available and were exercised.
- R-29 PASS: sage/forest neutrals form the palette; ember and danger retain semantic roles.
- R-30 PASS: the composition follows EZClaw's four real modes and was not copied from another product.
- R-31 PASS: major decisions and the plan review are recorded in `DESIGN.md`.

### UI supplement

- PASS: brand palette, focused accent, no decorative emoji, distinct mode compositions, and no filler dashboard or claims.
- PASS: real destinations and handlers, stateful status markers, restrained glass/elevation, and purposeful motion.
- PASS: actual data and honest first-run states, labelled editable prompts, original controls, and desktop keyboard/theming checks.
- PASS: reserved media space, local fonts, no new blocking scripts, and no invented performance measurements.
