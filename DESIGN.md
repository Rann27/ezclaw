# EZClaw: Navy glass workspace

Updated 2026-11-16 from the owner's brief: a full glassmorphism redesign, informed by shadcn/ui, with the new key color `#1B365D`. Desktop only, compact, and ready to feel at home in a future native desktop window.

Design Read: a personal desktop AI workbench for Chat, Agent, Image, Edit, Video, and Library. Architectural navy glass, precise controls, and a quiet reading surface. ENERGY 2 / RHYTHM 2 / MOTION 2.

## Boundaries

Preserve every existing workflow, field, validation, keyboard shortcut, control order, and request. Edit instructions remain visible before selecting a target or model. No new setup steps, hidden fields, suggestion actions, navigation destinations, or fictional activity. Desktop starts at 1024 × 640; the owner's desktop-only instruction overrides mobile requirements.

## System

| Decision | Implementation and purpose |
| --- | --- |
| Brand | `#1B365D`, a deep navy, is the exact primary action color in both themes. White text makes primary actions readable. Selection uses a pale navy tint in light mode and a muted blue panel in dark mode. |
| Light palette | Slate canvas `#E4EBF4`, white reading surface `#F8FAFD`, ink `#17243A`, secondary ink `#4C5D75`, border `#CDD7E5`. The cool canvas makes translucent white surfaces visible. |
| Dark palette | Canvas `#0B1220`, surface `#111C2D`, raised `#162337`, ink `#EEF3FB`, secondary ink `#B4C2D7`. Navy has depth without a saturated blue cast across the text. |
| shadcn foundation | Semantic background/foreground, card, popover, primary, secondary, muted, accent, border, input, ring, and sidebar tokens. Source-owned Button variants use CVA with merged utility classes. Outline, ghost, default, and destructive states follow the shadcn component vocabulary. Existing native dialog, select, checkbox, and keyboard behaviors remain intact. |
| Glass | Frosted navigation and inset workspace establish two sibling panes. A translucent thread header and composer sit over scrolling content; dialogs and menus are glass when open. The owner explicitly requests glassmorphism, overriding the antislop 1–2 surface cap. Inspector sections and text cards use calm fills without additional backdrop filters. No stacked full-screen blur or animated blur. |
| Backdrop | One static, low contrast diagonal wash derived only from navy separates the two panes and reveals their transparency. No orbs, particle effects, grids, or background animation. |
| Edges | Fine cool borders, a one-pixel inner highlight on glass, and small shadows only on elevated surfaces. They distinguish the layers without glowing UI. |
| Type | Existing locally bundled Atkinson Hyperlegible Next gives model names, instructions, and long answers clear letterforms. Its mono sibling stays on code, paths, and shortcut hints. UI 13–14px, reading 15px/1.6, headings 20–24px. |
| Density | Permanent 208px rail, 264px inspector, 44px thread header, 30px controls. 4px base spacing; 6–8px within controls and 12–16px between groups. No large empty hero. |
| Shape | 5px small states, 7px controls, 12px panels, 16px floating surfaces. Full radius only for switches and genuine round markers. |
| Layout | Left-aligned work, full-width composer up to 1120px, prose at 78ch. Inspector is a distinct inset utility panel; Settings uses a fixed local navigation column alongside its content. All settings destinations remain the same. |
| Iconography | Existing Phosphor family retained. Chat bubble, terminal, image, brush, video, and library glyphs describe real modes; no invented logo or generated assets. |
| Motion | CSS transitions for feedback (140ms), popovers (180ms), dialogs and inspector (220ms), strong ease-out `cubic-bezier(.23,1,.32,1)`. Route changes fade 140ms with at most 4px travel; rapid changes cancel the previous animation. No composer movement while typing, no entrance on every thread or message, no moving navigation icons, no animated dimensions for decoration. Search is instant. Reduced motion skips movement. |

## Composition

```text
+------------------+--------------------------------------+----------------+
| EZClaw           | Mode / Thread                  Actions|                |
| Search      Ctrl K+--------------------------------------+ Model          |
| Chat             |                                      | Harness        |
| Agent            | Actual conversation / image / video  | Parameters     |
| Image / Edit     |                                      |                |
| Video / Library  |                                      |                |
| New + history    |                                      |                |
| Settings + theme |          Frosted composer            |                |
+------------------+--------------------------------------+----------------+

Settings: heading + narrow local navigation | settings sections
Library: heading + compact filter strip    | actual image collection
Edit: target stage + visible full composer | original editing controls
```

The repeated motif is a navy action framed by a fine glass edge. Work stays the focal point. Empty states explain the next action and do not create new ones. Real running/waiting/error states keep their existing semantics. The new Video mode receives the same component treatment as the other four modes.

## Plan review

The generic landing-page layout suggested by the UI/UX database is unsuitable for an existing workbench. Keep the actual product structure and its controls. The owner's exact navy replaces suggested blue CTA colors; existing local type replaces remote Inter. Use shadcn's semantic component structure and fine control treatment, then give the two-pane desktop shell the glass character requested here. Density stays compact from the prior brief.

## Verification

See `docs/NAVY-GLASS-VERIFICATION.md` for build, desktop layouts, original-control checks, browser interactions, contrast and the delivery gate. No measured Core Web Vitals or runtime frame-rate claim is made.
