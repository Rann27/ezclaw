# Navy glass redesign verification

2026-11-16. Baseline: `64520f2` on `redesign-ui-desktop`. Visual changes only; no server, database schema, provider, request, or run-state changes.

## What changed

The key color is exactly `#1B365D` in both themes. Shared semantic tokens follow [shadcn theming](https://ui.shadcn.com/docs/theming); the source-owned Button follows its [variant vocabulary](https://ui.shadcn.com/docs/components/button), using CVA, clsx and tailwind-merge. This is a shadcn-informed adaptation of the existing interface, not a wholesale replacement of its native interaction primitives.

The desktop shell now has two inset glass panes, a mode breadcrumb, a shared inset inspector, frosted floating chrome, more precise outline/ghost controls, and a vertical local Settings navigation. All existing destinations, controls, labels, order, and handlers remain. The existing local font and Phosphor icon family remain. No generated image assets or remote fonts were added.

Motion is limited to direct feedback and short panel/dialog transitions. Route entrances were shortened from 320ms/10px to 140ms/4px and cancel on interruption. The composer no longer moves while focused; thread and message rows no longer animate on every mount. Reduced motion skips movement. Video indeterminate progress moves for 4.8 seconds, then rests as a static band while the existing status text continues to describe the run.

## Evidence

- `pnpm --filter @ezclaw/web build`: PASS, includes both frontend TypeScript projects. The existing C++ syntax-highlighting chunk warning remains; no runtime speed or Core Web Vitals measurement is claimed.
- `git diff --check`: PASS.
- 78 layout checks: 13 routes × light/dark × 1024×640, 1440×900 and 1920×1080. No horizontal page/workspace overflow. Each mode's prompt was visible and editable. Routes: Chat, Agent, Image, Edit, Video, Library, and all seven Settings pages.
- 26 whole-page axe-core scans across the 13 routes in both themes: no violations for WCAG 2 A/AA, 2.1 AA, 2.2 AA or best-practice tags. Additional endpoint-dialog scan: no violations. Automated contrast results involving gradient-backed surfaces are incomplete, not asserted as passes from axe.
- Supplemental rendered-color analysis: 344 visible text/control pairs on Chat, Edit and General Settings across both themes. Alpha-composited ancestor fills were checked against every canvas-gradient endpoint. Minimum ratio 5.21:1 in light mode and 7.28:1 in dark mode, no failures. Disabled controls were excluded. This supplements the scanner; it is not a claim to have manually inspected every syntax-highlighted token or every possible generated image.
- AST binding audit: 246 event/state bindings across all eight changed existing TSX files match the baseline after treating the native Button wrapper as `button`. All 14 Edit controls retain their original order and disclosure ancestry. New Button forwards native props; the inspector wrapper only adds a visual heading.
- Final browser console: no warnings or errors during the checks.

Ignored local evidence: `.sandbox-redesign/navy-results.json`, `flow-binding-audit.json`, `navy-build-final.log`, and screenshots prefixed `navy-`. Browser runs use isolated `.sandbox-redesign` data and a local mock provider at port 9911. No real account/provider key or production data was used.

## Recorded browser interactions

- All five mode destinations, Library, and seven Settings destinations load with the correct headings. Light and dark switches update the whole shell and forms.
- Chat: write a draft, open/filter/select a model, confirm the draft survives, send using Ctrl+Enter, receive the mock answer. Open/close the inspector. Ctrl+K opens search instantly; Escape closes it.
- Chat thread: rename to a 120-character title at 1024×640, confirm no overflow, pin, then rename again. Rich mock output renders paragraphs, a table, code and math without expanding the workspace sideways.
- Edit: write instructions before selecting a model or image, select Wajah preservation, select the test image model, upload a local target. Instructions and preservation survive. Open manual compiled prompt, edit it, reset to template, close details, send, receive the edited version, and open Compare.
- Library: search for a nonmatching prompt, observe the existing empty result state, clear it, toggle the favorite filter on and off.
- Endpoint dialog: open, inspect, close with Escape; focus returns to the opener. With reduced motion enabled, computed transition duration is 0s, transform is none, and there are no running dialog animations after the next paint.

## Antislop delivery gate: PASS

### Hard gate

- R-02 PASS: new visible labels contain no em dash; existing product copy is preserved.
- R-03 PASS: all 78 desktop layout checks pass. Mobile testing is excluded by the owner's desktop-only instruction in DESIGN.md.
- R-17 PASS: no statistics were added.
- R-18 PASS: no testimonials were added.
- R-23 PASS: no new logo asset, navigation destination, illustration or avatar was created. Existing wordmark text was restyled under the full redesign brief.
- R-24 PASS: existing destinations remain; all 13 route destinations were loaded in the browser.
- R-25 PASS: automated scans plus 344 supplemental composite checks above; no text contrast failure found.
- R-26 PASS: changed buttons retain original handlers; all three native Button substitutions were exercised through search, dialog close and inspector toggle.
- R-27 PASS: existing empty/loading/error UI remains; filtered Library empty state and model selection blockers were observed.
- R-28 PASS: no FAQ exists or was added.
- R-32 PASS: visible keyboard focus, Ctrl+Enter, Ctrl+K, Escape and focus return were checked.
- R-33 PASS: source changes were written directly with apply_patch; QA scripts do not patch application source.
- R-34 PASS: both themes were rendered and scanned on all 13 routes.
- R-35 PASS: production frontend build and the recorded click-through of changed controls above completed. Unchanged event/state bindings were audited against the baseline.
- R-36 PASS: no performance, security or customer claims were invented.
- R-37 PASS: DESIGN.md records the owner's direction and ENERGY 2 / RHYTHM 2 / MOTION 2 before implementation.
- R-38 PASS: no fabricated product content was added. Preview conversations are explicitly local mock-provider fixtures.
- R-39 PASS: native controls, labels, focus states and existing semantics remain; reduced motion was checked. Visible run movement is finite and leaves a static state.
- R-40 PASS: image/video sizing is unchanged, local fonts remain, and no render-blocking third-party script or invented performance metric was added.

### Purpose gate

- R-01 PASS: the static navy-derived canvas wash exposes glass layering; its purpose is recorded in DESIGN.md.
- R-04 PASS: existing mode/action glyphs describe real controls; no ornamental AI iconography was added.
- R-06 PASS: local Atkinson type is retained for readable model names and long instructions; mono stays on code/paths/shortcuts.
- R-07 PASS: no grid, dot pattern or blueprint background was added.
- R-08 PASS: existing send arrows keep their action meaning; no decorative CTA arrows were added.
- R-09 PASS: no marketing capsule was added. Inspector mode text identifies the active work area.
- R-10 PASS with owner override: full glassmorphism is explicitly requested. Sibling shell panes and floating chrome use glass; inner inspector and text sections add no blur.
- R-12 PASS: shadows identify panes, floating composer, popovers and dialogs; content rows remain flat.
- R-13 PASS: no glow system was added; the focus ring marks actual keyboard/input focus.
- R-14 PASS: no feature-card grid was introduced; settings sections group actual controls.
- R-19 PASS: short, interruptible route feedback and panel transitions follow the recorded motion dial; typing and repeated list mounts stay still.
- R-22 PASS: no unrelated illustrations were added.

### Liveliness

- Dials PASS: ENERGY 2 / RHYTHM 2 / MOTION 2 are recorded in DESIGN.md.
- Consistency PASS: navy accent, layered edges, compact hierarchy and restrained feedback follow those dials.
- Focal point PASS: the current task and composer remain central in work modes; Settings content is the focus beside local navigation.
- Whitespace PASS: 4px spacing system separates controls and sections; desktop density retains 208px/264px rail/inspector and 30px controls.
- Accent PASS: navy marks primary actions and selected states; status amber/red retain their existing purpose.
- Motif PASS: a navy action framed by a fine glass edge repeats across the wordmark, shell and composer.
- Design Read PASS: recorded before source implementation in DESIGN.md.

### Craftsmanship and quality locks

- C-1 PASS: palette, materials, shape, spacing and motion purposes are written in DESIGN.md.
- C-2 PASS: original handlers are preserved and changed controls were exercised.
- C-3 PASS: no template sections or new product actions were added.
- C-4 PASS: desktop sizes, themes, long title, focus return, editable prompts and reduced motion were checked.
- C-5 PASS: no testimonials or customer/usage claims were added.
- R-05 PASS: the existing workbench structure remains; no landing-page template was introduced.
- R-11 PASS: small states, controls, panels and floating surfaces have distinct radii.
- R-15 PASS: actual product action labels are preserved.
- R-16 PASS: no marketing buzzwords were introduced.
- R-20 PASS: real EZClaw modes, run states, model controls and editing lineage remain visible.
- R-21 PASS: light, dark and OS theme preferences remain available.
- R-29 PASS: navy and cool neutrals form the core palette; amber and red indicate actual statuses.
- R-30 PASS: shadcn informs the component system; the existing EZClaw workbench and editing workflow remain its composition.
- R-31 PASS: all major visual choices have a one-line purpose in DESIGN.md.
