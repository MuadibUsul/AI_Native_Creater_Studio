# Kinora design system (dark cinematic, revision 2)

Recorded from the built pages in this folder (`index.html`, `app.html`, `vi.html`, `404.html`). Where this file and the pages disagree, the pages win and this file is out of date. Machine-readable tokens: `.impeccable/design.json`.

## World

A screening room. The footage is the only light; Kinora speaks in subtitles. White is you, amber is Kinora. Structure and type discipline learned from linear.app: full width hairline bands, left aligned medium weight headlines, product panels.

## Colour

| Token | Value | Role |
|---|---|---|
| `--screen` | `#000000` | Page ground, screens |
| `--house` | `#131209` | Alternate bands, product panels and windows |
| `--panel` | `#181818` | Cards, inputs, rows inside panels |
| `--raise` / `--raise-2` | `#1F1F1F` / `#272727` | Hover and pressed surfaces |
| `--line` | `#313131` | Control borders |
| `--hair` / `--hair-2` | tungsten at 8% / 14% | Band dividers / panel borders |
| `--text` | `#F2EDE4` (tungsten) | Type, your voice |
| `--text-2` | `#B3ADA2` (ash) | Secondary type |
| `--text-3` | `#8A857C` | Tertiary type, the grey half of statements |
| `--amber` | `#F2C14E` | Kinora's voice, trials, the trial range on timelines. Nothing else. |
| `--alert` | `#FF8A7A` | Errors and failed states |
| `--veil` | black at 72% | Behind subtitles and chips on footage |

Light grounds (email, print): ink `#0B0B0A`, amber ink `#A87512`.

## Type

Geist only, with Noto Sans SC for Chinese and Geist Mono for timecode, amounts and step numbers. Headlines weight 500, tracking −2.2% (hero −3%). Sizes from the scale 12, 14, 16, 18, 20, 24, 30, 36, 48, 60 with their paired line heights; Chinese body copy takes line height 1.75.

| Use | Size |
|---|---|
| Hero | 60/60 desktop, 48/48 tablet, 36/40 phone; tonal falloff white to #9B9B9B (the one gradient) |
| Section and feature headings | 48/48, phone 30/36 |
| Statement | 36/40, white lead then `--text-3` |
| Body | 16/24, lede 18/28 |
| Labels, captions | 12/16 and 14/20 |

## Space, radius, elevation

- Spacing only from 2, 4, 8, 12, 16, 24, 32, 40, 48, 64, 80, 96. Bands: 80 phone, 96 desktop, divided by a `--hair` line.
- Radius: 4 for small controls, 8 for buttons and inputs, 12 for panels, windows and the invite row (inner radius = outer minus gap), full for pills and chips. Footage inside windows is square cornered.
- Elevation is a hairline border, not a shadow. Popovers alone take `0 16px 40px rgba(0,0,0,.55)`.

## Components

- **Header**: 64px, full width, black at 72% with blur, hairline under it; lockup left, links 14px, language, pill "Request an invite".
- **Invite form**: one row (input and primary button) inside a 12px panel; inline errors in `--alert`; the preview says nothing was sent.
- **Product window**: `--house`, 12px radius, bar 44px; conversation column 300px (bubble for you, amber reply, decision card with Keep in amber and Undo quiet); picture 2.39:1 (4:3 on phones) with subtitles on a veil, framing box dashed white with a "here" tag, trial chip outlined amber; clip strip with timecode and an amber trial range.
- **Statement**: white sentence, grey continuation, never a kicker above it.
- **Columns**: three columns divided by 1px hairlines (grid gap on a hairline ground), line drawings at 1.5px tungsten 42%, amber only for Kinora's line.
- **Feature block**: heading left, grey paragraph right, panel below; example data carries an "Example" tag in its own strip.
- **Subtitles**: 18/28 desktop, 14/24 phone, weight 500, veil, 2px by 12px padding, white for you, amber for Kinora.

## Motion

One curve: `cubic-bezier(0.22, 1, 0.36, 1)`; 300ms for colour and opacity, 500 to 700ms for movement, 2400ms for the trial push in. Headings rise 32px once from a visible resting state. The tagline lights word by word. The mark draws white then amber 380ms later. Reduced motion shows end states.

## Brand

See `vi.html` and `brand/`. Mark: two subtitle lines (44u white over 28u amber, 7u lines, 6u gap, 7u clear space). Never swap the colours, equalise the lines, recolour the amber, add glows, stretch, or set it on busy footage without the veil.

## Not canonized

- The hero heading's tonal gradient exists because the `landing-page-design` skill requires it; it is not a pattern for other headings.
- The first design (`index-v1.html`) used a floating pill navigation and weight 600 headlines; revision 2 replaced both.
