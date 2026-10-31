---
name: Video Downloader
description: Marketing site for a private, free Chrome extension that saves the video you're watching.
colors:
  ember: "#ff6a1a"
  ember-light: "#ffb347"
  ember-deep: "#c7430c"
  signal: "#5ae2c6"
  ink: "#0b0907"
  ink-raised: "#120f0c"
  ink-high: "#1a1613"
  bone: "#f2ece3"
  bone-dim: "#c9bfb0"
  bone-faint: "#8a8072"
  hairline: "rgba(242, 236, 227, 0.08)"
  hairline-strong: "rgba(242, 236, 227, 0.16)"
typography:
  display:
    fontFamily: "Fraunces, Iowan Old Style, Palatino, Times New Roman, serif"
    fontSize: "clamp(44px, 8vw, 96px)"
    fontWeight: 400
    lineHeight: 0.98
    letterSpacing: "-0.035em"
    fontVariation: "'opsz' 144, 'SOFT' 0"
  headline:
    fontFamily: "Fraunces, Iowan Old Style, Palatino, Times New Roman, serif"
    fontSize: "clamp(32px, 4.4vw, 56px)"
    fontWeight: 400
    lineHeight: 1.02
    letterSpacing: "-0.025em"
    fontVariation: "'opsz' 72"
  title:
    fontFamily: "Fraunces, Iowan Old Style, Palatino, Times New Roman, serif"
    fontSize: "22px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Figtree, -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 500
    letterSpacing: "0.08em"
rounded:
  sm: "5px"
  md: "8px"
  lg: "14px"
  full: "999px"
spacing:
  gutter: "28px"
  grid-gap: "48px"
  section: "96px"
  container: "1180px"
components:
  button-primary:
    backgroundColor: "{colors.ember}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "14px 26px"
  button-primary-hover:
    backgroundColor: "{colors.ember-light}"
    textColor: "{colors.ink}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.bone}"
    rounded: "{rounded.md}"
    padding: "14px 26px"
  nav-cta:
    backgroundColor: "{colors.ember}"
    textColor: "{colors.ink}"
    rounded: "7px"
    padding: "9px 18px"
  booth:
    backgroundColor: "{colors.ink-raised}"
    textColor: "{colors.bone-dim}"
    rounded: "{rounded.lg}"
  code-chip:
    backgroundColor: "{colors.ink-high}"
    textColor: "{colors.ember-light}"
    rounded: "{rounded.sm}"
    padding: "3px 9px"
---

# Design System: Video Downloader

## Overview

**Creative North Star: "The Signal Booth"**

A broadcast control room after hours, written up by a good magazine. The page is ink-dark and warm; a single ember accent marks what is live and what to press, and a teal signal light confirms that things are working. Serif headlines carry editorial authority and trust; small mono readouts carry the technical precision of a capture in progress. Atmosphere comes from the room itself (a faint ember wash in the corners, fine scanlines over everything), never from glowing components.

Density is calm: one idea per section, generous vertical rhythm, hairlines doing the structural work. Components are refined and restrained: flat surfaces, hairline borders, the accent reserved for the one primary action and for live data.

**Key Characteristics:**
- Dark, warm ink ground with ember as the only saturated hue; teal appears only as a "live / OK" signal.
- Fraunces display with an italic ember accent word in each headline; Figtree body; JetBrains Mono for readouts and labels only.
- Hairline ledgers instead of card grids.
- The booth panel (a schematic of the popup mid-download) is the signature object.
- No glows, no gradient text, no eyebrow labels above headings.

## Colors

One warm accent on warm darkness, with a cool signal for status.

### Primary
- **Ember** (#ff6a1a): Primary buttons, the nav Download button, filled segments in the booth meter, step numerals, FAQ toggles. The color of "press this" and "this is capturing".
- **Ember Light** (#ffb347): The italic accent word in headlines, inline prose links, code text, booth tags, hover state of primary buttons.
- **Ember Deep** (#c7430c): Ambient wash in the page background and scrollbar hover only. Never behind text.

### Secondary
- **Signal Teal** (#5ae2c6): Live/OK status only: the booth LED, "42% done", "3 found", hero-meta bullets, and the ethics block heading.

### Neutral
- **Ink** (#0b0907): Page background.
- **Ink Raised** (#120f0c): Booth, use-case panels, ethics and author blocks.
- **Ink High** (#1a1613): Inline code chips and the scrollbar thumb.
- **Bone** (#f2ece3): Headlines and primary text.
- **Bone Dim** (#c9bfb0): Body copy, ledes, card text.
- **Bone Faint** (#8a8072): Meta labels, footer, booth secondary text. Darkest neutral allowed for text (4.5:1+ on Ink).
- **Hairline / Hairline Strong** (8% / 16% Bone): Section dividers, ledger rules, panel borders.

### Named Rules
**The One Ember Rule.** Ember fills exactly one kind of thing per view: the primary action, or live capture data. Everything else is ink, bone, or hairline.

**The Signal Is Status Rule.** Teal means "working / found / OK". Never use it for decoration or emphasis.

## Typography

**Display Font:** Fraunces (with Iowan Old Style, Palatino, serif)
**Body Font:** Figtree (with system-ui)
**Label/Mono Font:** JetBrains Mono (with ui-monospace)

**Character:** An editorial, slightly soft optical-size serif set tight and large against a friendly, neutral sans. Mono is the voice of the instrument panel, used only for readouts, tags, and code.

### Hierarchy
- **Display** (400, clamp(44px, 8vw, 96px), 0.98): The hero headline only. One italic light-weight accent phrase in Ember Light.
- **Headline** (400, clamp(32px, 4.4vw, 56px), 1.02): Section titles, with one italic accent word. Final CTA runs larger (up to 72px).
- **Title** (500, 22px, 1.2): Feature, step, use-case, and FAQ headings in Fraunces. Lead features step up to 30px at weight 400.
- **Body** (400, 15–19px, 1.55–1.7): Figtree in Bone Dim. Measure capped at 52–68ch.
- **Label** (500, 11–12px, 0.08–0.14em, uppercase): JetBrains Mono for hero meta, booth header and tags. Tabular numerals in readouts.

### Named Rules
**The No Kicker Rule.** Headings stand alone. No eyebrow, section number, or mono label above a heading.

**The Mono Means Measurement Rule.** Mono only for code, data, and readouts, never as "technical" costume on prose.

## Layout

Single 1180px container with 28px gutters; navigation shares the same gutter. Sections are separated by a full-width hairline and 96px of vertical padding (hero 112px top). The hero is a full-width headline over a two-column split (copy left, booth right) that stacks under 960px. Features use a six-column ledger: two lead items spanning three columns, then six items spanning two; it becomes two columns under 900px and one under 620px. Short sequences (How it works) read across in three columns; longer procedures (Install) read down with an italic numeral column (72px, 56px on mobile). Headings get more space above than below.

## Elevation & Depth

Flat by default with tonal layering: Ink, then Ink Raised panels, then Ink High chips. Depth comes from hairline borders and tone, not shadow. Two neutral shadows exist, both offset downward and black, never colored.

### Shadow Vocabulary
- **Button lift** (`box-shadow: 0 10px 24px -14px rgba(0, 0, 0, 0.9)`): Primary button only.
- **Booth float** (`box-shadow: 0 30px 60px -30px rgba(0, 0, 0, 0.8)`): The hero booth panel only.

### Named Rules
**The No Halo Rule.** No zero-offset or colored glow on any element. Atmosphere belongs to the page background (ember wash, scanlines), not to components.

## Shapes

Gently rounded rectangles: 14px for panels, 8px for buttons, 5–6px for chips and inline code, full round only for status dots. Borders are 1px hairlines. No left/right accent borders, no clipped or angled silhouettes.

## Components

### Buttons
- **Shape:** Gently rounded (8px).
- **Primary:** Solid Ember with Ink text, 14px × 26px, weight 600, optional 17px stroke icon. Button lift shadow.
- **Hover / Focus:** Fills to Ember Light and rises 1px (ease-out 200ms); focus is a 2px Ember Light outline offset 3px.
- **Secondary:** Transparent with Hairline Strong border and Bone text; hover darkens the border to Bone Dim and adds a 4% bone wash.

### Cards / Containers
- **Corner Style:** 14px.
- **Background:** Ink Raised.
- **Shadow Strategy:** None (see Elevation), except the booth.
- **Border:** 1px Hairline; the booth uses Hairline Strong.
- **Internal Padding:** 32–44px for content panels, 18–20px for booth rows.

### Navigation
Sticky, 72% Ink with an 18px backdrop blur and a bottom hairline. Fraunces wordmark with the extension icon; Figtree 14px links in Bone Dim brightening to Bone on hover; a compact solid-Ember Download button. Under 780px only the wordmark and Download remain.

### FAQ disclosure
Hairline-separated `<details>` rows with 21px Fraunces questions. The toggle is a drawn 14px plus in Ember whose vertical bar collapses to a minus when open. Answers cap at 68ch.

### Signal Booth (signature)
A schematic of the extension popup mid-download, not a screenshot. Mono header ("This page · 3 found") with a static teal LED; rows for a downloading video (title, quality tag, segment meter, readout with Pause chip), an embedded player with a "Resolve Stream" action, and a slide deck. The segment meter is one bar per segment: filled Ember bars pulse for saved segments, dim hairline bars mark what remains. Motion stops under `prefers-reduced-motion`.

## Do's and Don'ts

### Do:
- **Do** keep Ember (#ff6a1a) to the primary action and live capture data (The One Ember Rule).
- **Do** use hairline ledgers (1px, 16% Bone) to structure feature lists instead of boxed cards.
- **Do** give each headline exactly one italic Ember Light accent word or phrase.
- **Do** keep text at Bone Faint (#8a8072) or brighter on Ink.
- **Do** theme browser surfaces: Ember selection, ink scrollbars, Ember Light focus outlines.

### Don't:
- **Don't** add glows or colored shadows to buttons, logos, dots, or avatars (The No Halo Rule).
- **Don't** use gradient text; the accent word is a solid color.
- **Don't** put kickers, eyebrows, or section numbers above headings (The No Kicker Rule).
- **Don't** add pulsing or looping decoration; the booth meter is the one authored motion.
- **Don't** style the booth as a literal screenshot of the popup, whose real palette differs.
