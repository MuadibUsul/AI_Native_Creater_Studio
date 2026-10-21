'use client';

import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ProductionPlan, StudioFootage, StudioState } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { useI18n } from '@/i18n/I18nProvider';
import { QuietIcon } from '@/ui/QuietIcon';
import styles from './studio.module.css';

/**
 * 无限画布上成片屏幕旁边的画框（参照 Stitch 的多画板并排）：素材、制作计划（场景与剪辑意图）、文章。
 * 画框只读服务端已有的事实；改动仍然经对话 / 语音交给 AI，或在素材面板里操作。
 */

export function BoardFrame({ label, frameKey, children }: { label: string; frameKey: 'footage' | 'plan' | 'article'; children: ReactNode }) {
  return (
    <section data-board-frame data-frame-key={frameKey} className={styles['boardFrame']} aria-label={label}>
      <h3 className={styles['boardLabel']}>{label}</h3>
      <div className={styles['boardFrameBody']}>{children}</div>
    </section>
  );
}

const FOOTAGE_SHOWN = 8;

/** 素材卡的画面：视频取一帧（只读元数据，不下载整段），图片直接显示，其他显示图标；取不到时退回图标 */
function FootagePreview({ workspaceId, item }: { workspaceId: string; item: StudioFootage }) {
  const client = useAncsClient();
  const [failed, setFailed] = useState(false);
  const visual = item.status === 'READY' && (item.kind === 'video' || item.kind === 'image');
  const url = useQuery({
    queryKey: ['studio', 'footage-preview', workspaceId, item.assetId, item.footageId],
    queryFn: () => client.assets.downloadUrl(workspaceId, item.assetId),
    enabled: visual && !failed,
    staleTime: 4 * 60_000,
    retry: false,
  });
  const src = url.data?.url;
  if (!visual || failed || src === undefined) {
    return <span className={styles['footageThumb']} aria-hidden="true"><QuietIcon name={item.kind === 'audio' ? 'voice' : item.kind === 'image' ? 'image' : 'film'} /></span>;
  }
  return item.kind === 'image'
    ? <img className={styles['footageThumb']} src={src} alt="" onError={() => setFailed(true)} />
    : <video className={styles['footageThumb']} src={`${src}#t=0.5`} muted playsInline preload="metadata" aria-hidden="true" tabIndex={-1} onError={() => setFailed(true)} />;
}

export function FootageBoardFrame({ workspaceId, footage, onOpenDetails }: { workspaceId: string; footage: StudioFootage[]; onOpenDetails: () => void }) {
  const { messages } = useI18n();
  const t = messages.studio.board;
  const tf = messages.studio.footage;
  const shown = footage.slice(0, FOOTAGE_SHOWN);
  return (
    <BoardFrame label={t.footage(footage.length)} frameKey="footage">
      <ul className={styles['footageGrid']}>
        {shown.map((item) => (
          <li key={item.assetId} className={styles['footageCard']} data-status={item.status}>
            <FootagePreview workspaceId={workspaceId} item={item} />
            <strong title={item.name}>{item.name}</strong>
            <span>{item.duration !== null ? tf.seconds(item.duration) : tf.kinds[item.kind]} · {tf.status[item.status]}</span>
          </li>
        ))}
      </ul>
      <button type="button" className="textbtn small" onClick={onOpenDetails}>
        {footage.length > shown.length ? t.footageMore(footage.length - shown.length) : t.footageDetails}
      </button>
    </BoardFrame>
  );
}

export function PlanBoardFrame({ plan }: { plan: ProductionPlan }) {
  const { messages } = useI18n();
  const t = messages.studio.board;
  return (
    <BoardFrame label={t.plan(plan.version)} frameKey="plan">
      <p className={styles['planLogline']}>{plan.blueprint.logline}</p>
      <p className={styles['planMeta']}>
        {t.planStructure(plan.blueprint.structure)}
        {plan.blueprint.targetDurationSeconds !== null ? ` · ${t.planTarget(String(plan.blueprint.targetDurationSeconds))}` : ''}
      </p>
      {plan.changedSincePlan ? <p className={styles['planStale']}>{t.planStale}</p> : null}
      <ol className={styles['planScenes']}>
        {plan.scenes.map((scene) => (
          <li key={scene.id}>
            <div className={styles['planSceneHead']}>
              <strong>{scene.title}</strong>
              {scene.window !== null ? <span>{scene.window.start}–{scene.window.end} s</span> : null}
              {scene.sources.length > 0 ? <span>{t.sceneSources(scene.sources.length)}</span> : null}
            </div>
            <p>{scene.goal}</p>
            {scene.intents.length > 0 ? (
              <ul className={styles['planIntents']}>
                {scene.intents.map((intent) => (
                  <li key={intent.id} title={intent.reason}><b>{t.intents[intent.type]}</b>{intent.targetFeeling}</li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>
    </BoardFrame>
  );
}

function hostOf(url: string | null): string | null {
  if (url === null || url === '') return null;
  try { return new URL(url).host; } catch { return null; }
}

export function ArticleBoardFrame({ article, locale }: { article: NonNullable<StudioState['project']['article']>; locale: string }) {
  const { messages } = useI18n();
  const t = messages.studio.board;
  const host = hostOf(article.sourceUrl ?? null);
  return (
    <BoardFrame label={t.article} frameKey="article">
      <p className={styles['planLogline']}>{article.title}</p>
      <p className={styles['planMeta']}>{t.articleFacts(article.paragraphs, article.characters.toLocaleString(locale))}{host !== null ? ` · ${t.articleSource(host)}` : ''}</p>
    </BoardFrame>
  );
}
