'use client';

import Link from 'next/link';
import { useI18n } from '@/i18n/I18nProvider';
import { QuietIcon } from './QuietIcon';

/**
 * 旧 V4 流水线下线时（服务端 /capabilities 报告 legacyPipeline = off），旧页面上的说明与去共看片室的入口。
 * 素材剪辑 / 文章讲述作品给出 studioHref 直接打开这个作品；其余去共看片室新建。
 */
export function LegacyPipelineNotice({ workspaceId, studioHref = null }: { workspaceId: string; studioHref?: string | null }) {
  const t = useI18n().messages.legacy;
  return <div className="notice" role="note" data-legacy-off="">
    <QuietIcon name="info" />
    <div>
      <strong>{t.title}</strong>
      <p className="small mt8">{t.body}</p>
      <Link className="btn small primary mt8" href={studioHref ?? `/w/${workspaceId}/studio/new`}>{studioHref === null ? t.newInStudio : t.openStudio}</Link>
    </div>
  </div>;
}
