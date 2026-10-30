# Finish review (impeccable, in-thread pass)

The harness ran this review inline instead of as a separate reviewer agent, from the captures of the final build (desktop 1440 and mobile 390, full page; studio at 1440 and 390). Build path: code led (no image generation, so no comp). Direction pinned by the owner ("dark cinematic"), so no concept roll; FORM records `seed: none (unavailable)`.

## Round 1

disposition: fix

- **persistence**: fail. PRODUCT.md missing (product truth only inside brief.md). DESIGN.md is written after this review (new world).
- **fidelity**: no comp. TYPE match (Geist, one family; Geist Mono only for timecode and amounts). MATERIAL match (footage is real raster, rendered by the repo's own code and labelled; no imitation material). GROUND match (#000000 screen, #131209 house, as OWN-WORLD names). Contradicted: on phones the mask above the sticky benefits screen covered the section heading at rest. Adaptation: trial chips move under the picture on phones (touch targets of 44px would cover the framing box).
- **ceiling**: unused devices of the world: a "lights down" moment when the screening starts, projector falloff at the screen edges, subtitles on the benefit screens tied to their own timecode.
- **material_fixes**:
  1. Phone: replace the overlay mask with an opaque sticky container so the heading stays visible at rest.
  2. Write PRODUCT.md.
  3. The user's quoted sentence in "two ways" was amber; amber is reserved for Kinora's voice.
  4. The hero picture carried `role="img"`, hiding its live subtitles from screen readers.
  5. First viewport at 1440×900: bring the clip strip up so it shows.
  6. Studio composer on phones: the send button wrapped to its own row.
- **keep**: the subtitle voice split (white for you, amber for Kinora) and the full width 2.39:1 screen in the first viewport.

Floor: no kickers, side stripes, hard shadows, glyph icons or system display faces. Gradient text appears once, on the hero heading, because the owner's chosen `landing-page-design` skill requires it (see brief.md).

## Verdict pass

1. resolved: heading visible at rest; text scrolls under an opaque stuck screen.
2. resolved: PRODUCT.md written.
3. resolved: the quote is tungsten white.
4. resolved: role removed; the figure caption describes the demo.
5. partial: at 1440×900 the strip labels and the top of the strip show; the full 40px strip needs about 900 + 6px.
6. resolved: mode icons drop under 480px wide, the row fits.

remaining: 5 (partial, accepted as an adaptation for 900px tall screens).

disposition: fix (one partial item, accepted by the builder; the owner can ask for a shorter hero)

## Revision 2 (new identity, structure learned from linear.app)

Captures: desktop 1440 and phone 390, first viewport and full page, English and Chinese; interactions driven in a real browser (Keep, drag to point, redo a chapter, approve a quote, invite error).

disposition: fix → resolved in the same pass

- **evidence**: valid; full page captures from the top, every section present.
- **fidelity** (no comp; against OWN-WORLD and the owner's "keep the old feel"): TYPE match (Geist 500 headlines); MATERIAL match (real footage, no imitation material); GROUND match (#000000 and #131209).
- **material_fixes** found and fixed:
  1. The decision card rendered empty (a helper overwrote its children). Fixed.
  2. Elements hidden with the `hidden` attribute still showed where a class set `display`. Added a global `[hidden]` rule.
  3. The framing box then vanished: SVG elements ignore the `.hidden` property. Switched to attribute calls.
  4. "Example" tags overlapped panel contents. Gave them their own strip.
  5. The trailer poster showed the old K logo. Replaced with a frame of the real interface.
  6. The quote's approval line promised more than the product does ("charged only if it succeeds"); it now says the reserved amount is released if a run fails.
- **open**: the launch trailer itself still contains the old logo (frames at 4 to 8 s and 46 to 50 s); a re-render with the new mark is a separate change.
- **keep**: white for you, amber for Kinora; the product window as the hero.
