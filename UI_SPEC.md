# MiniBook (`Books`) — Stage-2 UI Design & Visual System Specification

> **Revision V2** (resolves `@ui-critic` review #11).  
> **Companion to:** [PRODUCT_DESIGN.md](../design/PRODUCT_DESIGN.md) · [ARCHITECTURE.md](../design/ARCHITECTURE.md) · [tokens.css](tokens.css)  
> **Visual Benchmark:** **Apple Books (iBooks)** for calm editorial typography and distraction-free reading + **First-Class Android E-Ink Mode (`墨水屏模式`)** (`#FFFFFF` / `#000000` strict 1-bit chrome, zero motion, zero scroll).

---

## 1. Design Direction & Aesthetic Stance

| Dimension | Specification |
|---|---|
| **Aesthetic Direction** | **Editorial Quietude / Print-First Minimalism** — inspired by fine Penguin Classics / Foil-Stamped Cloth Editions, Apple Books (iOS 18 / macOS Sequoia), and Carta 1200 E-Ink typography. |
| **DFII Score** | **14 / 15** (`Impact 4 + Fit 4 + Feasibility 3 + Performance 4 − Consistency Risk 1 = 14` — Execute fully). |
| **Differentiation Anchor** | *If screenshotted with the logo removed, how do you recognize MiniBook?* **The page is the product:** zero permanent chrome while reading (only a single `11px` `40%`-opacity caption at the bottom-right corner), museum-grade bilingual typesetting (`Literata` + `Songti SC / Noto Serif CJK` capped at `<= 34em` with generous margins), cover-only shelf tiles with a single quiet progress hairline (`▬▬▬▬▭▭ 62%`), and an uncompromising `1-bit` `#000000`/`#FFFFFF` E-Ink transformation (`:root[data-eink="1"]`). |
| **Differentiation Callout** | **This avoids generic AI/Material UI by** eliminating bottom tab bars, floating action buttons, card containers, unread badges, reading-streak widgets, and continuous sliders — replacing them with **Apple Books editorial whitespace, cover-as-label shelves, and discrete stepper controls** that work identically on OLED phones, wide desktop spreads, and 16-grayscale E-Ink panels. |

---

## 2. Color & Theme System (`tokens.css`)

Every visual surface, text hierarchy level, divider, elevation shadow, and highlight is driven exclusively by `--mb-*` custom properties in [`tokens.css`](tokens.css). No component may write raw hex, `rgba()`, `box-shadow`, `border-radius`, or `transition` values outside `tokens.css` (enforced by the Stage-3 Vitest CSS linter per `ARCHITECTURE.md` §9.2).

### 2.1 Four Apple Books Reading Themes (+ E-Ink Override)

| Theme (`data-theme`) | Swatch Display | `--mb-bg` (Page) | `--mb-bg-sheet` | `--mb-fg` (Body Ink) | `--mb-fg-quiet` | `--mb-line` | `--mb-accent` | Contrast Ratio |
|---|---|---|---|---|---|---|---|---|
| `original` *(light default)* | `Aa` chip (`aria-label="Original"`) | `#FFFFFF` | `#FFFFFF` | `#1C1C1E` | `#6E6E73` | `#E5E5EA` | `#007AFF` | **17.0 : 1** (AAA) |
| `paper` *(warm stone)* | `Aa` chip (`aria-label="Paper"`) | `#EEEDE8` | `#EEEDE8` | `#2A2926` | `#686660` | `#DAD8D0` | `#007AFF` | **12.2 : 1** (AAA) |
| `calm` *(warm sepia)* | `Aa` chip (`aria-label="Calm"`) | `#F4ECD8` | `#F4ECD8` | `#3B3024` | `#786855` | `#DFD3B8` | `#007AFF` | **10.9 : 1** (AAA) |
| `quiet` *(low-glare grey)* | `Aa` chip (`aria-label="Quiet"`) | `#F2F2F7` | `#F2F2F7` | `#2C2C2E` | `#6E6E73` | `#DCDCE2` | `#007AFF` | **12.5 : 1** (AAA) |
| `:root[data-eink="1"]` | *E-Ink Mode* | `#FFFFFF` | `#FFFFFF` | `#000000` | `#000000` | `#000000` | `#000000` | **21.0 : 1** (1-bit) |

- **Appearance (Light / Dark / Match System, `AppSettings.appearanceMode`, default `'system'`):** Orthogonal to the theme, exactly like Apple Books. Every theme above is its **Light** palette; each theme also has a **Dark** palette, selected via `data-appearance="dark"` (or `data-appearance="system"` while `prefers-color-scheme: dark`). `data-theme` is always set to the chosen theme. The legacy `matchSystemTheme` boolean is kept as a mirror of `appearanceMode === 'system'`.

  | Theme | Light (`--mb-bg` / `--mb-fg`) | Dark `--mb-bg` | Dark `--mb-fg` | Dark `--mb-fg-quiet` | Dark `--mb-line` | Dark `--mb-accent` |
  |---|---|---|---|---|---|---|
  | `original` | `#FFFFFF` / `#1C1C1E` | `#141416` | `#E5E5EA` | `#98989F` | `#2C2C2E` | `#0A84FF` |
  | `paper` | `#EEEDE8` / `#2A2926` | `#232220` | `#D6D4CE` | `#96938B` | `#3A3834` | `#0A84FF` |
  | `calm` | `#F4ECD8` / `#3B3024` | `#2B251E` | `#DDD2C0` | `#A39580` | `#443A2E` | `#0A84FF` (amber highlights) |
  | `quiet` | `#F2F2F7` / `#2C2C2E` | `#2C2C2E` | `#D8D8DC` | `#98989F` | `#444448` | `#0A84FF` |

  Legacy settings migrate as: `matchSystemTheme: true` → `'system'`; `false` → `'dark'` for Quiet, `'light'` otherwise.
- **E-Ink attribute lifecycle:** E-Ink mode sets `document.documentElement.dataset.eink = '1'`. When E-Ink mode is off, the attribute is removed (`delete document.documentElement.dataset.eink`), so `:root[data-eink="1"]` never matches when off.

### 2.2 Read-Aloud (TTS) Highlight Tokens

| Mode / Theme | Sentence Highlight (`--mb-hl-sentence`) | Sentence Underline (`--mb-hl-sentence-underline`) | Active Word Highlight (`--mb-hl-word-underline`) |
|---|---|---|---|
| **Original (Light)** | `rgba(0, 122, 255, 0.11)` | `none` | `2px solid #007AFF` (`offset: 0.18em`) |
| **Paper (Warm Stone)** | `rgba(0, 122, 255, 0.13)` | `none` | `2px solid #0066D6` (`offset: 0.18em`) |
| **Calm (Sepia)** | `rgba(168, 104, 18, 0.16)` | `none` | `2px solid #8A540C` (`offset: 0.18em`) |
| **Quiet (Dark)** | `rgba(10, 132, 255, 0.22)` | `none` | `2px solid #409CFF` (`offset: 0.18em`) |
| **E-Ink (`[data-eink="1"]`)** | `transparent` *(forbidden!)* | **`2px solid #000000`** (`offset: 0.18em`) | `none` *(word highlight disabled per R4)* |

---

## 3. Typography & Book Typesetting System

### 3.1 Font Stacks & Pairings

1. **Literary Serif (`--mb-font-serif`, default for *Serif* and fallback for *Original*)**:
   - **Latin / Cyrillic / Greek:** `"Literata"` (variable optical-size `7..72`, weights `400..700`, bundled WOFF2), falling back to `"Georgia"`, `"Bitstream Charter"`, `"Charter"`.
   - **CJK (Simplified / Traditional / Japanese):** `"Songti SC"`, `"STSong"`, `"Noto Serif CJK SC"`, `"Noto Serif SC"`, `"Source Han Serif SC"`, `"Noto Serif CJK JP"`, `serif`.
2. **Clean UI & Reading Sans (`--mb-font-sans` & `--mb-font-ui`)**:
   - `-apple-system`, `BlinkMacSystemFont`, `"SF Pro Text"`, `"Inter"`, `"Roboto"`, `system-ui`, `"PingFang SC"`, `"Noto Sans CJK SC"`, `"Noto Sans SC"`, `sans-serif`.
   - Including `"Inter"` and `"Roboto"` ahead of generic `system-ui` guarantees clean neo-grotesque metrics on Android and Linux hosts without falling back to wide `DejaVu Sans`.
3. **Publisher Original (`Original`)**:
   - Preserves embedded EPUB/KF8 `@font-face` declarations and paragraph spacing rules while enforcing theme foreground/background colors (`!important` on `html, body`) so publisher CSS can never cause black-on-black text in `Quiet` mode.

### 3.2 UI Type Scale (Strictly 3 Sizes + Bare-Page Caption)

| Role | Token | Size / Line-Height | Weight | Tracking | Usage |
|---|---|---|---|---|---|
| **Large Title** | `--mb-ui-title-size` | `28px / 34px` | `700` | `-0.022em` | `Library` header, `Settings` header |
| **UI Body / Control** | `--mb-ui-body-size` | `16px / 22px` | `400` (`600` labels) | `-0.01em` | Sheet rows, TOC chapters, voice list, buttons, menu items |
| **UI Caption** | `--mb-ui-caption-size` | `12px / 16px` | `500` | `0em` | Cover progress (`62%`, `New`, `Finished ✓`), scrubber bar labels |
| **Bare-Page Caption** | `--mb-page-caption-size` | `11px / 14px` | `400` (`600` E-Ink) | `0.01em` | Persistent bottom-right `3 pages left in chapter` (`40%` opacity normal, `100%` `#000` E-Ink) |

### 3.3 Book Page Typesetting & Constant Pagination Geometry (`ARCHITECTURE.md` §6.3, §8.7)

| Parameter | Specification |
|---|---|
| **Base Text Size (`100%`)** | `18px` on phones (`< 840px`) · `19px` on desktop/tablet (`>= 840px`). **12 discrete steps**: `80%`, `90%`, `95%`, `100%`, `105%`, `110%`, `120%`, `135%`, `150%`, `165%`, `180%`, `200%`. |
| **Line Spacing** | **Tight** `1.45` · **Normal** `1.60` (default) · **Loose** `1.80`. CJK-primary books (`lang^="zh"` or `lang^="ja"`) automatically add `+0.10` (`1.55` / `1.70` / `1.90`). In E-Ink mode, minimum is clamped to **Normal**. |
| **Side Margins (`m`)** | Phones (`< 840px`): **Narrow** `24px` · **Medium** `32px` (default) · **Wide** `48px`. Wide viewports (`>= 840px`): multiplied by `×1.5` (`36px` · `48px` · `72px`). |
| **Constant Top / Bottom Margins (`pt`, `pb`)** | **`pt = 48px + var(--m-safe-top)`**, **`pb = 64px + var(--m-safe-bottom)`** (constant at all times!).<br>On a `393×852` phone (`--m-safe-top: 59px`, `--m-safe-bottom: 34px`), `pt = 107px` and `pb = 98px`.<br>The top chrome bar (`height: 44px + var(--m-safe-top) = 103px <= 107px`), the bottom scrubber bar (`height: 62px + var(--m-safe-bottom) = 96px <= 98px`), and the Read-Aloud floating bar (`bottom: 10px + var(--m-safe-bottom) = 44px`, `height: 48px`, top at `y = 760px` vs text bottom at `y = 754px`) **overlay the constant top/bottom margins without ever changing `pt` or `pb`**. Showing or auto-hiding the chrome or Read-Aloud bar causes **zero reflow, zero line-break shift, and zero page-count change**. |
| **Column Measure (`Cw`)** | Hard cap **`Cw <= 34em`** (`round(34 * fontSize)` px) per column on all viewports. Integer multicol formula (`ARCHITECTURE.md` §6.3):<br>`Vw = floor(frameWidth / (2*n)) * (2*n)`<br>`P = Vw / n`<br>`gMin = (n == 2) ? max(2*m, 64) : 2*m`<br>`Cw = min(P - gMin, M)` (adjusted by `-1` if `P - Cw` is odd)<br>`G = P - Cw` (even integer, `n * (Cw + G) === Vw`). |
| **Two-Page Spread (`n = 2`)** | Active when `Vw >= 1100px` in landscape. Two equal columns of width `Cw <= 34em` with pure whitespace center gutter `G >= 64px` (no center vertical hairline; e.g., at `1280×820` with `19px` text: `P = 640px`, `Cw = 528px` (`27.8em`), center gutter `G = 112px`, outer margins `G/2 = 56px`). |
| **Paragraphs & Indentation** | First-line indent `text-indent: 1.5em` (Latin) / `2.0em` (CJK); `margin: 0` (zero inter-paragraph gap). First paragraph after `h1, h2, h3` has `text-indent: 0`. |
| **Justification & Hyphenation** | Default `Justify: On`: `text-align: justify; hyphens: auto; -webkit-hyphens: auto; hanging-punctuation: first allow-end last; line-break: strict; text-justify: inter-character; widows: 2; orphans: 2;`. Uses the book's `lang` attribute on the content root so hyphenation dictionaries engage and prevent word rivers. |

---

## 4. Screen & Component Specifications

### 4.1 Library (`LibraryScreen.tsx` & `CoverTile.tsx`)
- **Header:** Large title `Library` (`28px`) on left; two `44×44px` icon-only buttons on right: `+` (*Add books*) and `⚙` (*Settings*). Top padding `calc(var(--m-safe-top) + 16px)`.
- **Grid Geometry:** `grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 20px; padding: 0 24px calc(24px + var(--m-safe-bottom));` (`max-width: 1200px; margin: 0 auto` on PC Web).
- **Cover Tile (`2:3` aspect ratio):**
  - Books with embedded cover art: `aspect-ratio: 2 / 3; object-fit: cover; border-radius: var(--mb-radius-xs); border: 1px solid var(--mb-cover-border); box-shadow: var(--mb-shadow-cover);`. In E-Ink mode, cover images remain images (untouched; the E-Ink panel dithers raster artwork natively), with `border: 2px solid #000000; border-radius: 0; box-shadow: none`.
  - **Typographic Fallback Cover (`.txt` / `.md` / coverless EPUB):** Solid `--mb-bg-cover-fallback` tile (`2:3`) with `1px` inner hairline frame, displaying the book's **Title** (`text-wrap: balance` in `--mb-font-serif`, `600` weight), a `24px` horizontal rule `──`, and **Author** (`11px` serif). In E-Ink mode, typographic covers use `#FFFFFF` fill and `#000000` border/text.
  - **Quiet Status Line (`12px` under each cover, `margin-top: 8px`, height `16px`):**
    - *In Progress:* Thin progress track (`44px × 3px`, `--mb-line` track with `--mb-fg` fill) + percentage label `62%` (`--mb-fg-quiet`). **In E-Ink mode (`[data-eink="1"]`):** progress bar graphic is hidden; displays text only `62 %` (`PRODUCT_DESIGN.md` §8.2 R1).
    - *Unread:* `New` (`--mb-fg-quiet`).
    - *Completed:* `Finished ✓` (`--mb-fg-quiet`).
  - **No titles printed below covers** (Apple Books convention).
- **Context Menu / Popover (`Book info / Remove`):**
  - Triggered by long-press (mobile) or right-click (PC Web).
  - Displays compact **Book info** header (Title, Author, `Format · Size · Added date`, e.g., `AZW3 (KF8) · 1.4 MB · Added Nov 13`) + 2 action rows (`>= 44px` height each): `Mark as finished` (neutral row, no checkmark on unread/in-progress books) and `Remove…` (in `--mb-danger`).

### 4.2 Reader Bare Page & Touch Zones (`ReaderScreen.tsx`)
- **Default State:** 100% distraction-free page. Status bar and home indicator are hidden on Android/iOS (`device.setImmersive(true)`), while `pt = 48px + var(--m-safe-top)` and `pb = 64px + var(--m-safe-bottom)` remain constant. Only the text block and a single `11px` caption (`3 pages left in chapter`, `--mb-fg-caption`) inside the bottom margin (`right: G/2`, `bottom: calc(12px + var(--m-safe-bottom))`) are visible.
- **Touch Zones:** Left `28%` = Previous Page · Center `44%` = Toggle Chrome · Right `28%` = Next Page (mirrored automatically for `dir="rtl"` books).

### 4.3 1-Tap Reader Chrome (`Chrome.tsx`)
- Summoned by a single tap in the center `44%` zone. Overlays `pt` and `pb` without shifting or dimming the page underneath (zero scrim, zero reflow).
- **Top Bar (`height: calc(44px + var(--m-safe-top))`, `padding-top: var(--m-safe-top)`, solid `var(--mb-bg)`, `1px` bottom border `var(--mb-line)`):**
  - Left: `‹ Library` back button (`min-height: 44px`, `padding: 0 12px`, `1.5px` stroke chevron + `16px` label).
  - Right: **4 icon buttons** in normal mode (**5 icon buttons** in E-Ink mode, making **5 total controls** in normal mode and **6 total controls** in E-Ink mode), each `44×44px` with `20×20px` SVG (`1.5px` stroke):
    1. **Refresh (`⟳`)** — *rendered ONLY when `data-eink="1"`* (`PRODUCT_DESIGN.md` §8.3 #3).
    2. **Bookmark (`🔖`)** — outline ribbon when unset; solid filled ribbon when current page is bookmarked.
    3. **Contents (`☰`)** — opens the 3-tab `Contents · Bookmarks · Search` sheet.
    4. **Appearance (`Aa`)** — opens the `Appearance` sheet.
    5. **Read Aloud (`🎧`)** — starts Read Aloud immediately from the first sentence on the current page and replaces chrome with the Read-Aloud bar.
- **Bottom Scrubber Bar (`padding: 8px 24px calc(10px + var(--m-safe-bottom))`, solid `var(--mb-bg)`, `1px` top border `var(--mb-line)`):**
  - Row 1 (`12px` `--mb-fg-quiet`, single-line ellipsis): `Book Title · Chapter Title` (e.g., `A Tale of Two Cities · Book the First — I. The Period`).
  - Row 2 (Normal mode): Horizontal scrubber track (`height: 3px`, `--mb-line` with `--mb-accent` fill and `14px` `--mb-accent` thumb, `44px` vertical touch hit-box) + percentage label `7%` on right.
  - Row 2 (E-Ink mode replacement per `PRODUCT_DESIGN.md` §8.2 R1): Discrete stepped bar `‹ Chapter` · `12 %` · `Chapter ›` + `Go to %` button (`44px` tall, `2px solid #000000` borders, zero sliders).

### 4.4 Appearance Sheet (`Appearance.tsx`)
- Bottom sheet on phones (`border-radius: 20px 20px 0 0` in normal mode, `0px` in E-Ink mode; `padding-bottom: calc(16px + var(--m-safe-bottom))`; `360px` anchored popover on PC Web). No title bar in either mode.
- **Controls (all discrete steppers/segments `>= 44px` tall, zero sliders, consistent `16px` `--mb-fg` row labels):**
  1. **Text Size Stepper:** `A−` (`44px` tall) · `Aa 100%` (center readout, 12 steps `80%…200%`) · `A+` (`44px` tall).
  2. **Font Family (3-segment control, `44px` tall):** `Original` · `Serif` · `Sans`.
  3. **Theme Swatches (`48px` height):**
     - Four `Aa` chips rendered in each theme's exact `--mb-bg` and `--mb-fg` (`aria-label="Original"`, `aria-label="Paper"`, `aria-label="Calm"`, `aria-label="Quiet"` — the swatch IS the label per `PRODUCT_DESIGN.md` §4.4, avoiding duplicate `"Original"` text). Active swatch has a `2px solid var(--mb-accent)` selection ring.
     - Preceded by a 3-segment **Appearance** control (`Light` · `Dark` · `Match System`, `44px` tall) that sets only `appearanceMode`; swatches set only `theme` and preview the active Light or Dark palette. The active swatch is `settings.theme` regardless of appearance.
     - *In E-Ink mode:* Swatch and system-match rows are replaced by **Text boldness** (`−` `1` `+`, steps `0–3` corresponding to `0–0.6px` glyph stroke compensation per `PRODUCT_DESIGN.md` §8.4).
  4. **Line Spacing Stepper (`44px` row):** Label `Line spacing` + `−` `Normal` `+` (`Tight` · `Normal` · `Loose`).
  5. **Margins Stepper (`44px` row):** Label `Margins` + `−` `Medium` `+` (`Narrow` · `Medium` · `Wide`).
  6. **Justify Text Toggle (`44px` row):** Label `Justify text` + switch (`On` / `Off` 2px-bordered segmented buttons in E-Ink mode, active inverted `#000000` fill / `#FFFFFF` text).

### 4.5 Contents / Bookmarks / Search Sheet (`Contents.tsx`)
- **Top 3-Segment Bar (`44px` height):** `Contents` · `Bookmarks` · `Search`.
- **Contents Tab:** Hierarchical list (`>= 44px` per row); nested chapters indented `16px` per level; current chapter in `700` bold; book percentage (`1%`, `3%`, `5%`) right-aligned in `--mb-fg-quiet`.
- **Bookmarks Tab:** Rows showing `Chapter · %` on line 1 and `First line snippet of bookmarked page` on line 2, with swipe-to-delete (and explicit `✕` `44×44px` button in E-Ink mode).
- **Search Tab:** Single clean input field (`44px` height) + streaming result rows showing `…context snippet with **bold match**… · Chapter · %`.

### 4.6 Read-Aloud Floating Bar & Voice Sheet (`ReadAloudBar.tsx`, `VoiceSheet.tsx`)
- **Read-Aloud Floating Bar (`PRODUCT_DESIGN.md` §4.6):**
  - **Normal mode:** Floating pill/bar inside the constant bottom margin (`left: 16px; right: 16px; bottom: calc(10px + var(--m-safe-bottom)); height: 48px; border-radius: var(--mb-radius-lg)`), sitting below the `y = 754px` text bottom and above the `34px` home-indicator zone (`y = 760..808px`).
  - **E-Ink mode (`[data-eink="1"]`):** Full-width bar docked at the bottom edge (`left: 0; right: 0; bottom: 0; height: calc(52px + var(--m-safe-bottom)); border-top: 2px solid #000000; border-radius: 0; background: #FFFFFF; box-shadow: none`).
  - **Exact 6 controls (`>= 44×44px` each):**
    1. `✕` (*Stop Read Aloud* — closes bar, leaves reader at current spoken sentence)
    2. `⏮` (*Previous sentence*; long-press = previous paragraph)
    3. `⏸` / `▶` (*Play / Pause*, `44×44px` primary transport button)
    4. `⏭` (*Next sentence*; long-press = next paragraph)
    5. `1.0×` (*Voice & Speed button* — opens `VoiceSheet`)
    6. `⏾` (*Sleep timer* — `Off · 15 · 30 · 45 · 60 min · End of chapter`)
- **Voice & Speed Sheet (`VoiceSheet.tsx` — `PRODUCT_DESIGN.md` §4.6 & §7):**
  - Clean bottom sheet (`padding-bottom: calc(16px + var(--m-safe-bottom))`), with **nothing boxed in cards**:
  1. **Speed Stepper Row:** Label `Speed` (`16px`) + discrete stepper `−` `1.0×` `+` (`0.5×–3.0×`, `0.1` steps). No preset chip clutter, no duplicate sleep timer row.
  2. **Voice List for the Book's Language:** Flat hairline-divided rows (`>= 44px` height) listing available voices for the book's language:
     - **System voices** first, grouped by installed engine (on Android: `sherpa-onnx`, `MultiTTS`, `System`).
     - **Edge neural voices** and **Custom server voices** below (shown when enabled in Settings).
     - Active voice is marked with a single `✓` on the right.
  3. **Slow-Voice Notice (shown only when the currently selected voice is measured slower than real time, `RTF >= 0.9`):**
     - Single non-modal line: `"This voice generates 4.5× slower than it speaks; expect pauses."` with inline action `"Use system voice"`.
  4. **Footer Link:** `"More voices…"` (opens Settings → Read Aloud).

---

## 5. Android E-Ink Mode (`墨水屏模式`) Component Matrix

| Component | Standard Mode (LCD / OLED) | E-Ink Mode (`:root[data-eink="1"]`) |
|---|---|---|
| **Palette** | 4 themes (`Original`, `Paper`, `Calm`, `Quiet`) | Strict 2-colour **`#FFFFFF` and `#000000` ONLY** |
| **Borders & Dividers** | `1px` `--mb-line` (`#E5E5EA` / `#444448`) | `1px solid #000000` row dividers; **`2px solid #000000`** sheets, buttons, and tiles |
| **Corner Radius** | `4px–20px` (`--mb-radius-*`) | **`0px` everywhere** (`border-radius: 0 !important` — zero anti-aliased corner arcs) |
| **Shadows & Scrims** | Soft elevation shadows + translucent backdrop scrim | **`none` / `transparent`** (sheets are opaque `#FFFFFF` with `2px solid #000000` border) |
| **Motion** | `180ms` page slide, `220ms` sheet rise | **`0ms` instant swap** (`transition: none !important; animation: none !important`) |
| **Lists & Grids** | Native vertical scroll | **`PagedList`** (`overflow: hidden`, zero scrollbars, fills viewport height with 3 rows of 4 covers, footer `‹ Prev` · `1 / 3` · `Next ›`) |
| **Cover Art & Progress** | Cover art + thin progress bar + `62%` | Cover images untouched (typographic covers restyled to `#000`/`#FFF`); **text-only progress:** `62 %`, `New`, `Finished ✓` |
| **Reader Top Chrome** | **5 controls:** `‹ Library`, `🔖`, `☰`, `Aa`, `🎧` | **6 controls:** `‹ Library`, **`⟳` (Full Refresh)**, `🔖`, `☰`, `Aa`, `🎧` |
| **Reader Scrubber** | Continuous slider + `%` | **Discrete Stepper:** `‹ Chapter` · `12 %` · `Chapter ›` + `Go to %` |
| **Read-Aloud Bar** | Floating rounded bar (`16px` side inset) | **Full-width docked bar** (`left: 0; right: 0; bottom: 0; border-top: 2px solid #000000; border-radius: 0`) |
| **Toggles & Steppers** | Animated pill switch; soft stepper | **2px-bordered `On` / `Off` buttons** (active inverted `#000000` fill / `#FFFFFF` text; no redundant `[ ]` brackets inside bordered boxes) |
| **TTS Highlight** | Soft sentence tint + active word underline | **Sentence-only `2px solid #000000` underline** (zero background tint, zero word highlight) |

---

## 6. App Icon Specification (`Books` — iOS / Android / Web)

Following the minimalist app suite (`Play`, `Podcasts`, `Files`, **`Books`**), the `Books` icon shares the warm paper / frosted charcoal plates and signature vermilion accent (`#FF4800`) of `Podcasts`:

| Variant | Asset Name | Background Plate | Book Motif | Bookmark Ribbon Accent |
|---|---|---|---|---|
| **Light (Default / Any)** | `AppIcon-1024.png` | Warm archival paper `#F5F3EE` | Open book pages & spine in deep ink `#18181A` (`68px` rounded geometric stroke at `1024×1024` scale) | Signature vermilion ribbon `#FF4800` descending from the upper right page |
| **Dark (iOS 18+ Dark)** | `AppIcon-Dark-1024.png` | Frosted charcoal vertical gradient `#363940 → #1E2025` | Crisp warm off-white `#F4F5F7` open book pages & spine | Vibrant vermilion ribbon `#FF4800` |
| **iOS Tinted (Monochrome)** | `AppIcon-Tinted-1024.png` | Deep carbon `#1C1E22` | Pure monochrome `#F4F5F7` open book silhouette | Pure monochrome `#F4F5F7` ribbon (`100%` luminance-ready for iOS tint shader) |
