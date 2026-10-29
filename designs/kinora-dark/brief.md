# Kinora dark cinematic: design brief

Working brief for the two deliverables in this folder. It is development material: nothing here is served by the pages.

Requested by the owner: "a new design by the skill", using three public skills (JimLiu/baoyu-design, pbakaus/impeccable, elayadesign/ai-design-skills `landing-page-design`). Answers given: **both** a landing page and an app prototype, **dark cinematic**.

## Product truth

See `PRODUCT.md` in this folder.

## Surface 1: landing page (`index.html`). Mode: Persuade

- Visitor: a creator who shoots more than they can edit (travel, explainers, small brand films), arriving from the trailer or a shared link.
- Job: understand "talk and point, then keep or undo" within one viewport, and request an invite.
- Primary action, in working form: the email field and "Request an invite" in the hero, repeated at the end.
- Proof: the product shown working (the hero demo you can operate, the 50 second trailer of the real build). No testimonials or logos exist, so none are shown.
- Risk reversal from product truth: quotes before spending, a monthly cap, nothing overwritten.

### Direction contract

THESIS: The page is a screening room. The footage is the only light in the room, and Kinora speaks in subtitles. It refuses the category default (a headline beside an app screenshot, a purple AI glow).

OWN-WORLD: Projection black for the screen and its letterbox; a warm dark house (#131209) between screenings; tungsten white type; subtitle amber reserved for the editor's voice and for anything still on trial; a white dashed framing box for pointing. Geist only, Geist Mono for timecode. Footage is square cornered and full width; controls are small and quiet.

STORY: A person asks for a change while pointing; Kinora answers in a subtitle and plays a trial; the visitor can press Keep or Undo, or point at the picture themselves; then reads why they stay in charge, and asks for an invite.

FIRST VIEWPORT: Floating nav. A title band: two line headline with the tonal falloff, one line of subhead, the email form with one proof line. Below it the 2.39:1 screen spans the content width with the scripted scene running, subtitles inside the lower picture, the trial chip top left, and a thin clip strip with timecode under the screen.

FORM: Screening room with subtitles; direction pinned by the owner ("dark cinematic"), so no concept roll ran. seed: none (unavailable)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Signature interaction: the hero scene (spoken line, framing box drawing itself, amber reply, push in trial, Keep or Undo that really change the picture and the strip), and drag on the picture to point yourself.

Motion grammar: everything settles on cubic-bezier(0.22, 1, 0.36, 1); subtitles rise 8px and fade; the framing box draws its stroke; the trial is a slow push in; the tagline lights word by word like a subtitle being spoken; section headings rise once. Reduced motion shows the end states.

## Surface 2: app prototype (`app.html`). Mode: Operate

- Visitor: the same creator, now working: home (start a video, continue one) and the studio (watch, talk, point, keep or undo, export).
- Shell stays the product's own: sidebar on home; top bar, conversation panel, monitor, timeline in the studio. Standard controls only.
- The world lends four things: Geist type, the black and tungsten palette with amber for the editor, cinema density (the picture is the largest thing on screen), and one signature move.

### Direction contract

THESIS: The studio is a screening with the editor sitting next to you: the picture dominates, and the editor's latest line appears as a subtitle on the picture while the full conversation stays in the side panel. It refuses the grey editor with a purple accent.

OWN-WORLD: Same palette and type as the landing page. Panels are #181818 on a black ground, borders #313131, amber only for the editor's voice, trials and the trial range on the timeline.

STORY: Pick a project, watch it, frame an area, ask, read the subtitle, keep or undo, export.

FIRST VIEWPORT: Studio at 1440 wide: top bar (back, project, saved, AI spend this month, review, tasks, language, Export); left panel 360px conversation with decision card and composer; the monitor fills the rest with transport and the timeline below it.

FORM: Product shell with one signature move (subtitles on the monitor). seed: none (unavailable)

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Where the three skills disagreed, and the call

| Topic | baoyu-design | impeccable | landing-page-design | Call |
|---|---|---|---|---|
| Hero heading gradient | avoid gradient tropes | gradient text is a default to refuse unless the brief earns it | required: white to #9B9B9B | Applied, hero heading only: the owner asked for this skill, and on black it reads as a projector's light falloff. No other gradient anywhere. |
| Testimonials and logos | placeholders marked, never invented | claims are uninventable | write believable names and brands | None shown. Proof is the working demo and the real trailer. |
| Section reveals | none | no identical entrance on every section; visible by default | every section rises 32px once | Headings rise once from a visible default; the hero, the benefits screen and the tagline each have their own motion. |
| Fonts | avoid Inter, Fraunces | avoid the training default list | Geist, Manrope or Poppins only | Geist, one family; Geist Mono for timecode; Noto Sans SC for Chinese glyphs. |
| Chinese line height | 1.7 to 1.8 for CJK reading | readable measure | keep the scale's paired line height | Chinese body text gets 1.75; Latin keeps the scale. |
| Kicker above headings | none | banned | none | No kickers. |
| Pricing, legal links | mark missing facts | do not invent | ship legal links | No pricing section; Privacy and Terms are shown disabled "at launch". |

impeccable's CLI (context loader, concept roll, comp gates, detector) did not run in this container; the craft floor and mode rules were applied by hand, and the finish review is an in-thread pass (no image generation, so the build is code led).

## Synthetic material to replace before any real use

- All footage is the repo's own procedural landscapes (`apps/render-worker/src/promo/landscapes.tsx`), labelled as demo footage.
- The hero conversation and every studio reply are scripted.
- Project names, dates, the AI spend figure and the quote amount in the prototype are examples, labelled.
- The invite form sends nothing; it says so.
