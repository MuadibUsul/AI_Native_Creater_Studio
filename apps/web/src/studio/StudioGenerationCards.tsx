'use client';

import Link from 'next/link';
import { OUTSIDE_REGION_CHANGE_THRESHOLD, type Generation, type GenerationBudget } from '@ancs/contracts';
import { useI18n } from '@/i18n/I18nProvider';
import { QuietIcon } from '@/ui/QuietIcon';
import { formatUsdMicros } from './studio-time';
import styles from './studio.module.css';

/**
 * 付费生成的报价卡（V6-7/V6-8）：AI 只能报价；这里由你确认或放弃。
 * - 待确认：做什么、约多少秒、费用区间、供应商模型（测试替身会标明）、预算情况；"确认生成（最多 $x）"/"不要了"；
 * - 进行中：只调用一次、不会自动重试；
 * - 结果：实际花费（成功/失败）、待对账说明；选区重绘时如实说明圈外是否被改。
 * 结果本身作为确认那一轮的试改出现在对话里（与其他修改一样采用或撤回）。
 */

export interface GenerationCardsProps {
  generations: Generation[];
  budget: GenerationBudget;
  workspaceId: string;
  canEdit: boolean;
  pendingId: string | null;
  error: string | null;
  onAccept: (generation: Generation) => void;
  onDecline: (generation: Generation) => void;
}

/** 卡片里要展示的：待确认/进行中/待对账，以及最近一小时内结束的（结果与花费）。 */
export function visibleGenerations(generations: readonly Generation[], now = Date.now()): Generation[] {
  return generations.filter((item) => item.status === 'QUOTED' || item.status === 'RUNNING' || item.status === 'NEEDS_RECONCILIATION'
    || (item.completedAt !== null && now - Date.parse(item.completedAt) < 3_600_000)
    || (item.status === 'EXPIRED' && now - Date.parse(item.expiresAt) < 3_600_000)).slice(0, 4);
}

export function StudioGenerationCards(props: GenerationCardsProps) {
  const { messages } = useI18n();
  const t = messages.studio.generation;
  if (props.generations.length === 0) return null;
  const remaining = props.budget.limitMicros === null ? null : Math.max(0, props.budget.limitMicros - props.budget.spentMicros - props.budget.reservedMicros);
  return (
    <div className={styles['generations']} aria-label={t.label}>
      {props.generations.map((item) => {
        const busy = props.pendingId === item.id;
        const charged = item.chargedMicros === null ? null : formatUsdMicros(item.chargedMicros);
        return (
          <article key={item.id} className={styles['generationCard']} data-status={item.status} aria-label={`${t.kinds[item.kind]} · ${item.summary}`}>
            <header className={styles['generationHead']}>
              <QuietIcon name="film" />
              <strong>{t.kinds[item.kind]}</strong>
              {item.implementation === 'SCRIPTED' ? <span className={styles['generationBadge']}>{t.testDouble}</span> : null}
            </header>
            <p className={styles['generationSummary']}>{item.summary}</p>
            <p className={styles['lineMeta']}>
              {t.quote(item.estimatedSeconds, formatUsdMicros(item.estimate.minMicros), formatUsdMicros(item.estimate.maxMicros))} · {t.provider(item.model)}
            </p>
            {item.status === 'QUOTED' ? (
              <>
                <p className={styles['lineMeta']}>{remaining === null ? t.budgetMissing : t.budget(formatUsdMicros(remaining))}</p>
                <div className={styles['actions']}>
                  <button type="button" className="btn primary small" disabled={!props.canEdit || busy} onClick={() => props.onAccept(item)}>
                    <QuietIcon name="check" />{busy ? t.confirming : t.confirm(formatUsdMicros(item.estimate.maxMicros))}
                  </button>
                  <button type="button" className="btn small" disabled={!props.canEdit || busy} onClick={() => props.onDecline(item)}>{t.decline}</button>
                </div>
              </>
            ) : item.status === 'RUNNING' ? (
              <p role="status">{t.running}</p>
            ) : item.status === 'EXPIRED' ? (
              <p className={styles['lineMeta']}>{t.expired}</p>
            ) : item.status === 'DECLINED' ? (
              <p className={styles['lineMeta']}>{t.declined}</p>
            ) : item.status === 'NEEDS_RECONCILIATION' ? (
              <p className={styles['alert']} role="alert">{t.reconciliation}</p>
            ) : item.status === 'SUCCEEDED' ? (
              <>
                <p className={styles['lineMeta']}>{t.succeeded(charged ?? '—')}</p>
                {item.outsideRegionChange !== null && item.outsideRegionChange > OUTSIDE_REGION_CHANGE_THRESHOLD ? <p className={styles['lineMeta']}>{t.outsideChanged}</p> : null}
              </>
            ) : (
              <p className={styles['lineMeta']}>{t.failed2(item.chargedMicros !== null && item.chargedMicros > 0 ? charged : null)}</p>
            )}
            {item.kind === 'AVATAR_CLIP' && item.status === 'QUOTED' ? (
              <Link className="textbtn small" href={`/w/${props.workspaceId}/studio/identity`}>{t.identityLink}</Link>
            ) : null}
          </article>
        );
      })}
      {props.error !== null ? <div className={styles['alert']} role="alert">{props.error}</div> : null}
    </div>
  );
}
