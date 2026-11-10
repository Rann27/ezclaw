# EZClaw: Material workspace

Updated 2026-11-10 from the owner's brief: Material surfaces, glass accents, smooth lightweight motion, and the existing EZClaw green.

Design Read: a desktop-only local AI workbench for conversations, file-based agent work, image generation, and image editing. Material structure with restrained glass, designed for a future native desktop application. ENERGY 2 / RHYTHM 2 / MOTION 2.

Session override from the owner: desktop only. Mobile responsiveness, touch-specific layouts, navigation drawers, and mobile breakpoint testing are outside scope. This overrides antislop R-03's mobile requirement; desktop keyboard access, contrast, and working controls still apply.

Scope correction: visual redesign only. Preserve the original workflow, field availability, control order, validation, and request behavior. Do not add prerequisite steps, hide the edit composer until an image exists, wrap previously visible controls in a new accordion, or introduce new prompt-writing actions.

## System

| Decision | Choice and reason |
| --- | --- |
| Brand | Sage `#8EA66B` stays on primary actions and selected states to preserve EZClaw's identity. Dark ink on sage preserves readable contrast. |
| Canvas | `#EAF0E7` surrounds an inset workspace, separating navigation from the task without a heavy divider. |
| Surfaces | `#F3F6F0` for quiet panels; `#FFFFFF` for the main work surface. Sage-tinted neutrals make the workspace belong to the brand. |
| Ink | `#20291E` primary and `#4F5D48` secondary provide readable green-toned contrast. |
| Dark | Forest surfaces maintain the same depth hierarchy and green identity. Light, dark, and system preferences remain available. |
| Type | Locally bundled Atkinson Hyperlegible Next improves recognition of similar letters in model names; its mono sibling is reserved for code, paths, and parameters. No remote fonts. |
| Scale | UI 14px, reading 15px/1.6, page titles 20-24px, welcome headlines 22px. Text stays readable while more content fits on screen. |
| Space | 4px base, 6-8px control gaps, 12-16px section gaps, and 12px welcome padding. Compact grouping replaces large empty margins. |
| Shape | 4px tags, 6px controls, 10px panels, 14px composer/dialog. Shape communicates role without adding visual bulk. |
| Desktop density | 30px controls, 208px permanent rail, 264px inspector, 44px header. Desktop pointer controls reserve more room for work. |
| Content width | Work surfaces and composers use available width up to 1120px; prose stays at 78ch. Settings and Library use a 1280px container with 24px gutters. |
| Elevation | Composer, popovers, and dialogs get shadows because they sit above content. Static lists and inspector sections stay flat. |
| Glass | Only the thread header and current composer use backdrop blur, with opaque fallbacks. They frame scrollable work and remain legible. Sidebar, inspector, cards, and dialogs are solid. |
| Icons | Existing Phosphor glyphs describe actual actions: conversation, folder, image, brush, search. Filled glyphs indicate selection. No new logo or generated assets. |
| Motion | CSS transform/opacity transitions, 140ms press feedback and 220ms panel/dialog transitions, explain response and depth. Reduced motion removes movement. No animation package or decorative loops. |

## Composition

The work is the focal point. Navigation and compact welcome text stay left aligned. Chat, Agent, Image, and Edit use the wider work area with small gutters. Edit displays the image stage and complete composer together from the first render, including before choosing a model or image. The upload stage is a compact horizontal row, preserving the original controls and keyboard order.

```text
+-------------------+----------------------------------+----------------+
| EZClaw            | Thread title       Thread actions|                |
| Search            +----------------------------------+ Model          |
|                   |                                  | Harness        |
| Chat / Agent      | Conversation / task / image stage | System prompt  |
| Image / Edit      |                                  | Parameters     |
| Library           |                                  |                |
| New thread        |                                  |                |
| Actual history    |       Floating composer          |                |
| Settings + theme  +----------------------------------+----------------+
+-------------------+
```

The desktop shell has a permanent rail and an inline inspector controlled by the owner. It never switches to mobile navigation or a modal inspector. The intended minimum window is 1024 by 640 CSS pixels. Thread actions use named icon buttons so long titles retain space. Native packaging is future work; this change remains in the existing React frontend.

## Identity and purpose

- The sage rail, inset work surface, and generous composer form the repeating EZClaw workspace motif.
- Thread nodes communicate real completed, running, pending approval, and failed states. Ember means an approval or question needs the owner; red means error or destruction.
- All original editing controls stay in their original sequence: references, preservation options, instruction field, existing compiled-prompt details, model/output controls, and submit. The instruction draft can be written before selecting an image, and remains while a model or target is selected.
- Empty screens explain the next action. Loading names the resource. Errors preserve retry and recovery behavior.
- No invented usage metrics, customer claims, activity, imagery, or navigation destinations.

## Plan review

Rejected stat-card dashboards and green glow backgrounds because the app's job is making and reviewing model outputs. Kept the real four-mode structure, original font, icon family, and sage value; changed surface hierarchy, spacing, composition, controls, and state transitions to meet the new brief.

## Verification

See `docs/REDESIGN-VERIFICATION.md` for checks, browser click-through, and the antislop delivery gate. Field Core Web Vitals are not measured by this redesign.
