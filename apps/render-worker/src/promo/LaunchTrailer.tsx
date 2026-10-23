import * as React from 'react';
import { AbsoluteFill, interpolate, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from 'remotion';
import { AuroraScene, CoastScene, FilmFinish, RoadScene, WaterfallScene } from './landscapes';
import {
  BEAT, BigWord, Caption, Chip, CodePanel, COLORS, DISPLAY, Effect, Flash, focus, FULL, LogoMark, PointerDrag, ramp, shake, UiShot, VoiceBars,
  Backdrop, easeInOut, type Box, type Cam, type Capture,
} from './trailer-kit';

/**
 * ANCS 发布预告片（约 50 秒，1920×1080 / 30fps，120 BPM：每拍 15 帧）。与 scripts/promo/soundtrack.mjs 同一节拍网格。
 *   S1   0–4 s   一句话：首页输入框里逐字打出需求（真实界面连拍）
 *   S2   4–8 s   标志落下（产品特效模板：冲击波 / 爆炸 / 漏光）
 *   S3   8–16 s  主段落：SAY IT · POINT AT IT · WATCH IT CUT · KEEP IT + 风光快剪
 *   S4  16–24 s  说与指：语音字幕、框选画面
 *   S5  24–32 s  特效即代码：模板源码 + 实时运行
 *   S6  32–40 s  交给 AI 剪完：计划 → 剪 → 自检 → 交付（真实界面连拍）
 *   S7  40–46 s  快剪蒙太奇
 *   S8  46–50 s  片尾
 * 画面里的产品界面来自 scripts/promo/capture-ui.mjs 的真实截图；特效直接运行产品特效模板库的代码（templates 由渲染脚本注入）。
 */

export const TRAILER_FRAMES = 1500;
export interface LaunchTrailerProps { templates: Record<string, string>; capture: Capture | null }

const B = (beats: number) => beats * BEAT;

export const LaunchTrailer: React.FC<LaunchTrailerProps> = ({ templates, capture }) => {
  const img = (name: string): string | string[] | undefined => capture?.captured[name];
  const box = (shot: string, key: string): Box | undefined => capture?.boxes[shot]?.[key];
  const frameBox = (shot: string, prefix: string): Box | undefined => {
    const boxes = capture?.boxes[shot] ?? {};
    const key = Object.keys(boxes).find((name) => name.startsWith(`frame:${prefix}`));
    return key === undefined ? undefined : boxes[key];
  };
  const ctx: Ctx = { img, box, frameBox, templates };
  return (
    <AbsoluteFill style={{ background: COLORS.ink, fontFamily: DISPLAY }}>
      <Sequence durationInFrames={120}><S1Prompt {...ctx} /></Sequence>
      <Sequence from={120} durationInFrames={120}><S2Logo {...ctx} /></Sequence>
      <Sequence from={240} durationInFrames={240}><S3Drop {...ctx} /></Sequence>
      <Sequence from={480} durationInFrames={240}><S4TalkPoint {...ctx} /></Sequence>
      <Sequence from={720} durationInFrames={240}><S5Effects {...ctx} /></Sequence>
      <Sequence from={960} durationInFrames={240}><S6Delegate {...ctx} /></Sequence>
      <Sequence from={1200} durationInFrames={180}><S7Montage {...ctx} /></Sequence>
      <Sequence from={1380} durationInFrames={120}><S8End {...ctx} /></Sequence>
      {/* 全片转场重音（与配乐的冲击点对齐） */}
      <Flash at={120} length={10} />
      <Flash at={240} length={8} />
      <Flash at={480} length={6} peak={0.5} />
      <Flash at={720} length={6} peak={0.5} />
      <Flash at={960} length={6} peak={0.4} />
      <Flash at={1200} length={8} />
      <Flash at={1380} length={10} />
      <FilmFinish grain={0.05} vignette={0.5} />
    </AbsoluteFill>
  );
};

interface Ctx {
  img: (name: string) => string | string[] | undefined;
  box: (shot: string, key: string) => Box | undefined;
  frameBox: (shot: string, prefix: string) => Box | undefined;
  templates: Record<string, string>;
}

/** 连拍取一张（缺省取最后一张） */
const pick = (value: string | string[] | undefined, index = -1): string | undefined => (Array.isArray(value) ? value.at(index) : value);

// ---------------------------------------------------------------- S1 一句话（0–4 s）
const S1Prompt: React.FC<Ctx> = ({ img, box }) => {
  const frame = useCurrentFrame();
  const typing = img('home-type');
  const prompt = box('home-typed', 'prompt') ?? box('home-type', 'prompt');
  const start: Cam = prompt === undefined ? { ...FULL, zoom: 1.6 } : { ...focus(prompt, 0.9), zoom: focus(prompt, 0.9).zoom * 1.05 };
  const settle: Cam = prompt === undefined ? FULL : { cx: prompt.x + prompt.width / 2, cy: prompt.y + prompt.height / 2 - 60, zoom: 1.35 };
  const frames = Array.isArray(typing) ? typing : [];
  const src = frame < 12 ? pick(img('home-empty')) : frames.length === 0 ? pick(img('home-typed')) : frames[Math.min(frames.length - 1, Math.floor(((frame - 12) / 80) * frames.length))];
  const appear = ramp(frame, 0, 18, 0, 1);
  // 最后 14 帧：快速推进输入框（送出），接标志落下
  const push = ramp(frame, 104, 120, 1, 2.4, easeInOut);
  const blur = ramp(frame, 108, 120, 0, 14);
  return (
    <AbsoluteFill>
      <Backdrop intensity={appear} />
      <AbsoluteFill style={{ opacity: appear, transform: `scale(${String(push)})`, filter: `blur(${String(blur)}px)` }}>
        <UiShot src={src} from={start} to={settle} duration={100} width={1720} tilt={[14, 4, -10, -3]} />
      </AbsoluteFill>
      <Caption text="Every video starts with a sentence." at={30} out={104} y="88%" size={44} color={COLORS.text} weight={600} />
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- S2 标志（4–8 s）
const S2Logo: React.FC<Ctx> = ({ templates }) => {
  const frame = useCurrentFrame();
  const logoIn = ramp(frame, 0, 14, 0, 1);
  const scale = interpolate(logoIn, [0, 1], [2.4, 1]) * ramp(frame, 20, 120, 1, 1.08, easeInOut);
  const blur = ramp(frame, 0, 8, 26, 0);
  const sky = ramp(frame, 0, 40, 0, 0.55);
  const out = ramp(frame, 108, 120, 0, 1);
  return (
    <AbsoluteFill style={{ transform: `${shake(frame, 0, 26, 14)} scale(${String(1 + out * 0.4)})`, filter: `blur(${String(out * 12)}px)` }}>
      <AbsoluteFill style={{ opacity: sky, filter: 'blur(3px) saturate(1.2)', transform: `scale(${String(1.15 - frame * 0.0008)})` }}><AuroraScene /></AbsoluteFill>
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse at center, rgba(5,6,12,0.2) 0%, rgba(5,6,12,0.85) 70%)' }} />
      <Effect code={templates['light-leak']} params={{ color: '#8f6bff', intensity: 0.8, direction: 'left' }} from={2} duration={50} seed="logo-leak" />
      <Effect code={templates['burst']} params={{ color: COLORS.violet, color2: COLORS.cyan, size: 0.9, intensity: 0.55 }} from={0} duration={34} x={460} y={40} width={1000} height={1000} seed="logo-burst" />
      <Effect code={templates['shockwave']} params={{ color: '#a99bff', rings: 3, thickness: 1.4 }} from={0} duration={44} x={360} y={-60} width={1200} height={1200} seed="logo-ring" />
      <Effect code={templates['sparkles']} params={{ color: '#ffffff', count: 40, size: 1.1 }} from={40} duration={80} seed="logo-sparkles" />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 44, transform: `scale(${String(scale)})`, filter: `blur(${String(blur)}px)`, opacity: logoIn }}>
          <LogoMark size={190} draw={ramp(frame, 0, 22, 0.2, 1)} glow={1 + Math.sin(frame / 8) * 0.15} />
          <div style={{ fontFamily: DISPLAY, fontWeight: 900, fontSize: 230, letterSpacing: '-0.05em', color: '#fff', lineHeight: 1, textShadow: `0 0 60px ${COLORS.violet}aa` }}>ANCS</div>
        </div>
      </AbsoluteFill>
      <BigWord text="AI-NATIVE CREATOR STUDIO" mode="track" at={20} size={40} weight={600} y="66%" color="#c9cdf5" letterSpacing="0.3em" />
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- S3 主段落（8–16 s）
const S3Drop: React.FC<Ctx> = ({ img, box, frameBox, templates }) => {
  const frame = useCurrentFrame();
  const words: { text: string; shot: string | string[] | undefined; cam: [Cam, Cam]; sequenceRate?: number }[] = [
    { text: 'SAY IT.', shot: pick(img('home-typed')), cam: [focus(box('home-typed', 'prompt'), 0.85), focus(box('home-typed', 'prompt'), 0.7)] },
    { text: 'POINT AT IT.', shot: pick(img('effect-marked')) ?? pick(img('board-done')), cam: [focus(box('effect-marked', 'area'), 0.9), focus(box('effect-marked', 'area'), 0.75)] },
    { text: 'WATCH IT CUT.', shot: img('board-run'), cam: [{ ...FULL, zoom: 1.25 }, { ...FULL, zoom: 1.12 }], sequenceRate: 0.5 },
    { text: 'KEEP IT.', shot: pick(img('board-done')), cam: [focus(box('board-done', 'monitor') ?? frameBox('board-done', 'Video'), 0.9), focus(box('board-done', 'monitor') ?? frameBox('board-done', 'Video'), 0.75)] },
  ];
  const block = Math.floor(frame / B(2));
  const montage = frame >= B(8);
  const scenes = [AuroraScene, CoastScene, RoadScene, WaterfallScene];
  const cut = Math.floor((frame - B(8)) / BEAT);
  const Scene = scenes[((cut % 4) + 4) % 4]!;
  const local = (frame - B(8)) % BEAT;
  const monitorShots = ['monitor-aurora', 'monitor-coast', 'monitor-road', 'monitor-waterfall'];
  const showUi = cut % 2 === 1;
  return (
    <AbsoluteFill>
      <Backdrop hue="cyan" />
      {!montage && block < 4 ? (
        <Sequence from={block * B(2)} durationInFrames={B(2)} key={block}>
          <UiShot src={words[block]!.shot} from={words[block]!.cam[0]} to={words[block]!.cam[1]} duration={B(2)} width={1780} tilt={[block % 2 === 0 ? 8 : -6, 0, block % 2 === 0 ? -8 : 8, 0]} dim={0.45} sequenceRate={words[block]!.sequenceRate} />
          <BigWord text={words[block]!.text} at={0} out={B(2)} size={block === 2 ? 190 : 230} gradient={block % 2 === 1} />
        </Sequence>
      ) : null}
      {montage ? (
        <AbsoluteFill style={{ transform: `scale(${String(interpolate(local, [0, BEAT], [1.14, 1.0], { extrapolateRight: 'clamp' }))}) rotate(${String((cut % 2 === 0 ? -1 : 1) * interpolate(local, [0, BEAT], [1.2, 0], { extrapolateRight: 'clamp' }))}deg)` }}>
          {showUi && img(monitorShots[cut % 4]!) !== undefined
            ? <UiShot src={pick(img(monitorShots[cut % 4]!))} from={{ ...focus(box(monitorShots[cut % 4]!, 'monitor'), 0.98) }} to={focus(box(monitorShots[cut % 4]!, 'monitor'), 0.82)} duration={BEAT} chrome={false} width={1920} />
            : <Scene />}
        </AbsoluteFill>
      ) : null}
      {montage ? <Effect code={templates['light-leak']} params={{ color: '#ff9a4a', intensity: 0.55, direction: 'right' }} from={B(8)} duration={B(3)} seed="drop-leak" /> : null}
      <Sequence from={B(8)} durationInFrames={B(8)}>
        <AbsoluteFill style={{ background: 'linear-gradient(180deg, rgba(5,6,12,0) 50%, rgba(5,6,12,0.75) 100%)' }} />
        <BigWord text="Drop in your footage." mode="rise" at={4} out={B(4)} size={110} y="78%" />
        <BigWord text="AI cuts the first version." mode="rise" at={B(4)} out={B(8)} size={110} y="78%" gradient />
      </Sequence>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- S4 说与指（16–24 s）
const S4TalkPoint: React.FC<Ctx> = ({ img, box }) => {
  const frame = useCurrentFrame();
  const caption = box('voice-partial', 'caption') ?? box('voice-partial', 'dock');
  const talkCam = caption === undefined ? { ...FULL, zoom: 1.3 } : focus({ x: caption.x - 160, y: caption.y - 260, width: caption.width + 320, height: caption.height + 300 }, 0.95);
  const voiceRun = img('voice-run');
  const area = box('effect-marked', 'area');
  const monitor = box('effect-marked', 'monitor') ?? area;
  const pointCam = focus(monitor, 0.92);
  // 画出来的框选：截图坐标 → 画面坐标（UiShot 宽 1100、左 80、垂直居中，镜头 pointCam 终点）
  const winW = 1100;
  const winH = winW * (900 / 1600);
  const winX = 80;
  const winY = (1080 - winH) / 2;
  const toScreen = (x: number, y: number): [number, number] => {
    const s = (winW / 1600) * pointCam.zoom;
    return [winX + winW / 2 + (x - pointCam.cx) * s, winY + winH / 2 + (y - pointCam.cy) * s];
  };
  const dragFrom = area === undefined ? [winX + 200, winY + 120] as [number, number] : toScreen(area.x, area.y);
  const dragTo = area === undefined ? [winX + 800, winY + 420] as [number, number] : toScreen(area.x + area.width, area.y + area.height);
  return (
    <AbsoluteFill>
      <Backdrop hue="violet" />
      <Sequence durationInFrames={120}>
        <UiShot src={frame < 40 ? pick(img('voice-partial')) : (Array.isArray(voiceRun) ? voiceRun : pick(img('voice-partial')))} from={{ ...talkCam, zoom: talkCam.zoom * 1.08 }} to={talkCam} duration={120} delay={0} width={1100} x={80} tilt={[6, 2, 14, 6]} sequenceRate={Array.isArray(voiceRun) ? voiceRun.length / 120 : undefined} />
        <VoiceBars x={300} y={890} width={660} height={90} at={6} out={118} />
        <BigWord text="Talk to it." mode="slam" at={6} out={120} size={150} x={1260} y="40%" align="left" />
        <Caption text="Speak naturally — in English or Chinese." at={26} out={120} x={1264} y="52%" align="left" size={40} maxWidth={600} />
      </Sequence>
      <Sequence from={120} durationInFrames={120}>
        <UiShot src={frame < 186 ? pick(img('effect-marked')) ?? pick(img('board-done')) : pick(img('effect-trial-b')) ?? pick(img('effect-marked'))} from={{ ...pointCam, zoom: pointCam.zoom * 0.92 }} to={pointCam} duration={40} width={winW} x={winX} />
        <PointerDrag from={dragFrom} to={dragTo} at={10} length={26} hold={30} />
        <BigWord text="Point at it." mode="slam" at={4} out={120} size={150} x={1260} y="40%" align="left" gradient />
        <Caption text={'Any moment. Any area. “Here” means what you point at.'} at={24} out={120} x={1264} y="52%" align="left" size={40} maxWidth={600} />
      </Sequence>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- S5 特效即代码（24–32 s）
const S5Effects: React.FC<Ctx> = ({ img, box, templates }) => {
  const frame = useCurrentFrame();
  const sparkles = templates['sparkles'] ?? '';
  const code = sparkles.trim();
  const marquee = ['Burst', 'Glow', 'Sparkles', 'Shockwave', 'Light leak', 'Confetti', 'Title card', 'Key points', 'Big number', 'Steps', 'Quote'];
  return (
    <AbsoluteFill>
      <Backdrop hue="violet" />
      {/* 24–28 s：左边代码逐字打出，右边同一段代码在跑 */}
      <Sequence durationInFrames={120}>
        <CodePanel code={code} title="sparkles · effect template" at={6} charsPerFrame={16} width={860} height={700} x={70} y={250} />
        <div style={{ position: 'absolute', left: 980, top: 290, width: 880, height: 495, borderRadius: 18, overflow: 'hidden', boxShadow: `0 40px 120px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.14), 0 0 90px ${COLORS.cyan}40`, opacity: ramp(frame, 0, 12, 0, 1) }}>
          <div style={{ position: 'absolute', left: 0, top: 0, width: 1920, height: 1080, transform: 'scale(0.4583)', transformOrigin: '0 0' }}><AuroraScene /></div>
          <Effect code={templates['sparkles']} params={{ color: '#ffffff', count: 60, size: 1.5 }} from={30} duration={90} width={880} height={495} seed="fx-sparkles" />
        </div>
        <BigWord text="Effects, written as code." mode="rise" at={2} out={120} size={84} y="13%" />
        <Caption text="Readable templates the AI picks and tunes — rendered in a sandbox." at={40} out={120} y="85%" size={34} />
      </Sequence>
      {/* 28–30 s：海岸日落 + 爆炸 / 冲击波 / 漏光，节拍上 */}
      <Sequence from={120} durationInFrames={60}>
        <AbsoluteFill style={{ transform: `scale(${String(ramp(frame - 120, 0, 60, 1.08, 1.0))}) ${shake(frame, 120, 16, 10)} ${shake(frame, 150, 12, 8)}` }}><CoastScene /></AbsoluteFill>
        <Effect code={templates['burst']} params={{ color: '#ff6a00', color2: '#ffd25a', size: 1.2, intensity: 1 }} from={0} duration={36} x={950} y={260} width={480} height={480} seed="fx-burst" />
        <Effect code={templates['shockwave']} params={{ color: '#9fd8ff', rings: 3, thickness: 1.2 }} from={30} duration={30} x={790} y={110} width={800} height={800} seed="fx-shock" />
        <Effect code={templates['glow']} params={{ color: '#ffe3a0', intensity: 0.7, pulses: 2 }} from={0} duration={60} x={890} y={200} width={600} height={600} seed="fx-glow" />
      </Sequence>
      {/* 30–32 s：真实界面里的同一个特效（试改，等你决定要不要） */}
      <Sequence from={180} durationInFrames={60}>
        <UiShot src={pick(img('voice-trial-b')) ?? pick(img('effect-trial-b'))} from={focus(box('voice-trial-b', 'monitor'), 0.95)} to={focus(box('voice-trial-b', 'monitor'), 0.6)} duration={60} width={1700} tilt={[0, 4, 0, -4]} />
        <AbsoluteFill style={{ background: 'linear-gradient(180deg, rgba(5,6,12,0.85) 0%, rgba(5,6,12,0) 22%)' }} />
        <Caption text="Every change arrives as a trial. Keep it — or don’t." at={6} out={60} y="5%" size={44} color={COLORS.text} weight={600} />
      </Sequence>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 36, display: 'flex', gap: 14, transform: `translateX(${String(-frame * 3)}px)`, opacity: frame >= 120 && frame < 180 ? 1 : 0 }}>
        {[...marquee, ...marquee].map((name, i) => <Chip key={`${name}${String(i)}`} text={name} active={i % 4 === Math.floor(frame / 7) % 4} size={24} />)}
      </div>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- S6 交给 AI 剪完（32–40 s）
const S6Delegate: React.FC<Ctx> = ({ img, box }) => {
  const frame = useCurrentFrame();
  const run = img('board-run');
  const runFrames = Array.isArray(run) ? run : [];
  const progress = runFrames.length === 0 ? 0 : (frame - 60) / 100;
  const stage = frame < 60 ? -1 : progress < 0.3 ? 0 : progress < 0.65 ? 1 : progress < 0.95 ? 2 : 3;
  const card = box('board-done', 'card');
  const goal = box('new-delegate', 'input');
  const brief = goal === undefined ? undefined : { x: goal.x - 40, y: goal.y - 130, width: goal.width + 80, height: goal.height + 420 };
  const canvas = box('board-plan', 'canvas');
  const out = ramp(frame, 200, 240, 0, 1);
  return (
    <AbsoluteFill>
      <Backdrop hue="cyan" />
      <Sequence durationInFrames={60}>
        <UiShot src={pick(img('new-delegate'))} from={{ ...focus(brief, 0.95), zoom: focus(brief, 0.95).zoom * 1.1 }} to={focus(brief, 0.95)} duration={60} width={1000} x={840} tilt={[4, 2, -16, -8]} />
        <BigWord text="Brief it once." mode="slam" at={2} out={60} size={130} x={90} y="46%" align="left" />
        <Caption text="Set the goal, the length and a spending cap." at={18} out={60} x={94} y="58%" align="left" size={36} maxWidth={640} />
      </Sequence>
      <Sequence from={60} durationInFrames={100}>
        <UiShot src={runFrames.length > 0 ? runFrames : pick(img('board-plan'))} from={{ ...focus(canvas, 1), zoom: focus(canvas, 1).zoom * 1.15 }} to={focus(canvas, 1)} duration={100} width={1640} y={190} sequenceRate={runFrames.length / 100} />
      </Sequence>
      <div style={{ position: 'absolute', top: 70, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 18, opacity: frame >= 54 && frame < 166 ? ramp(frame, 54, 64, 0, 1) : 0 }}>
        {['Plans', 'Cuts', 'Checks its work', 'Delivers'].map((label, i) => <Chip key={label} text={`${String(i + 1)}  ${label}`} active={stage >= i} size={30} />)}
      </div>
      <Sequence from={160} durationInFrames={80}>
        <AbsoluteFill style={{ transform: `scale(${String(1 + out * 0.25)})`, filter: `blur(${String(out * 10)}px)` }}>
          <UiShot src={pick(img('board-done'))} from={focus(card, 0.8)} to={{ ...FULL, zoom: 1.0 }} duration={50} width={1640} />
        </AbsoluteFill>
        <BigWord text="You stay in charge." mode="rise" at={8} out={80} size={96} y="88%" gradient />
      </Sequence>
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- S7 快剪（40–46 s）
const S7Montage: React.FC<Ctx> = ({ img, box, templates }) => {
  const frame = useCurrentFrame();
  // 八分音符一刀（7.5 帧）：边界取整，长期不漂离节拍
  const half = BEAT / 2;
  const cut = Math.floor(frame / half);
  const cutStart = Math.ceil(cut * half);
  const cutLength = Math.ceil((cut + 1) * half) - cutStart;
  const local = frame - cutStart;
  const scenes = [AuroraScene, RoadScene, CoastScene, WaterfallScene];
  const shots = ['board-final', 'effect-trial-c', 'voice-trial-a', 'export-done', 'tasks', 'monitor-aurora', 'board-done', 'home-typed'];
  // 真实产出：产品导出的成片（含特效图层），按刀取不同时刻
  const exported = img('export-video');
  const kind = cut % 3;
  const shotName = shots[cut % shots.length]!;
  const Scene = scenes[cut % scenes.length]!;
  const words: [string, number][] = [['FOOTAGE.', 0], ['ARTICLES.', B(2)], ['VOICE.', B(4)], ['EFFECTS.', B(6)]];
  const finale = frame >= B(8);
  return (
    <AbsoluteFill>
      {!finale ? (
        <AbsoluteFill style={{ transform: `scale(${String(interpolate(local, [0, half], [1.1, 1.0]))})` }}>
          {kind === 1 && img(shotName) !== undefined
            ? <UiShot src={pick(img(shotName))} from={focus(box(shotName, 'monitor'), 0.9)} to={focus(box(shotName, 'monitor'), 0.8)} duration={cutLength} delay={cutStart} chrome={false} width={1920} />
            : kind === 2 && typeof exported === 'string'
              ? <Sequence from={cutStart} durationInFrames={cutLength}><OffthreadVideo src={staticFile(exported)} trimBefore={(cut * 37) % 300} muted /></Sequence>
              : <><Scene /><Effect code={templates[cut % 2 === 0 ? 'sparkles' : 'glow']} params={cut % 2 === 0 ? { color: '#ffffff', count: 30 } : { color: '#ffd7a0', intensity: 0.6 }} from={cutStart} duration={cutLength} seed={`m${String(cut)}`} /></>}
        </AbsoluteFill>
      ) : (
        <AbsoluteFill>
          <Backdrop hue="violet" />
          <UiShot src={pick(img('board-final')) ?? pick(img('board-done'))} from={{ ...FULL, zoom: 1.3 }} to={{ ...FULL, zoom: 1.0 }} duration={B(4)} delay={B(8)} width={1500} dim={0.35} tilt={[10, 2, 0, 0]} />
        </AbsoluteFill>
      )}
      <AbsoluteFill style={{ background: 'rgba(5,6,12,0.35)' }} />
      <Effect code={templates['shockwave']} params={{ color: '#ffffff', rings: 2, thickness: 0.8 }} from={B(8)} duration={30} x={360} y={-60} width={1200} height={1200} seed="one-studio" />
      {words.map(([text, at]) => <BigWord key={text} text={text} at={at} out={at + B(2)} size={250} />)}
      <BigWord text="ONE STUDIO." at={B(8)} size={250} gradient />
    </AbsoluteFill>
  );
};

// ---------------------------------------------------------------- S8 片尾（46–50 s）
const S8End: React.FC<Ctx> = ({ templates }) => {
  const frame = useCurrentFrame();
  const fadeOut = ramp(frame, 100, 120, 0, 1);
  const logoIn = ramp(frame, 0, 16, 0, 1);
  return (
    <AbsoluteFill style={{ transform: shake(frame, 0, 20, 12) }}>
      <AbsoluteFill style={{ opacity: 0.35, filter: 'blur(4px)' }}><AuroraScene /></AbsoluteFill>
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse at center, rgba(5,6,12,0.35) 0%, rgba(5,6,12,0.92) 75%)' }} />
      <Effect code={templates['shockwave']} params={{ color: '#a99bff', rings: 3, thickness: 1.2 }} from={0} duration={40} x={460} y={40} width={1000} height={1000} seed="end-ring" />
      <Effect code={templates['sparkles']} params={{ color: '#ffffff', count: 30, size: 0.9 }} from={10} duration={110} seed="end-sparkles" />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', transform: 'translateY(-70px)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 34, opacity: logoIn, transform: `scale(${String(interpolate(logoIn, [0, 1], [1.5, 1]) * ramp(frame, 16, 120, 1, 1.05))})` }}>
          <LogoMark size={140} draw={ramp(frame, 0, 20, 0.3, 1)} />
          <div style={{ fontFamily: DISPLAY, fontWeight: 900, fontSize: 170, letterSpacing: '-0.05em', color: '#fff', lineHeight: 1, textShadow: `0 0 50px ${COLORS.violet}99` }}>ANCS</div>
        </div>
      </AbsoluteFill>
      <BigWord text="The editor that listens." mode="rise" at={14} size={78} y="63%" gradient weight={800} />
      <Caption text="AI-native Creator Studio  ·  Invite-only beta" at={30} y="72%" size={32} color="#c9cdf5" />
      <Caption text="Pre-release build. In this preview the AI’s replies and speech recognition are scripted; the footage is generated by code." at={40} y="92%" size={22} color="rgba(255,255,255,0.5)" weight={400} />
      <AbsoluteFill style={{ background: '#000', opacity: fadeOut }} />
    </AbsoluteFill>
  );
};
