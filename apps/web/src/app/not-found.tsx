'use client';

import Link from 'next/link';
import { useI18n } from '@/i18n/I18nProvider';
import { QuietIcon } from '@/ui/QuietIcon';

/** 找不到页面（链接过期、作品被删除或地址打错）：说明原因并回到创作台。 */
export default function NotFound() {
  const t = useI18n().messages.system.notFound;
  return <div className="page narrow">
    <div className="empty-state" role="status">
      <h1>{t.title}</h1>
      <p className="muted mt8">{t.body}</p>
      <Link className="btn primary mt24" href="/"><QuietIcon name="grid" />{t.home}</Link>
    </div>
  </div>;
}
