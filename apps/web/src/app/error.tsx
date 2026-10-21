'use client';

import Link from 'next/link';
import { useI18n } from '@/i18n/I18nProvider';
import { QuietIcon } from '@/ui/QuietIcon';

/** 页面渲染出错：外壳仍在，给出重试与回到创作台；错误编号便于对照服务端日志（不展示错误详情）。 */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useI18n().messages.system.error;
  return <div className="page narrow">
    <div className="empty-state" role="alert">
      <h1>{t.title}</h1>
      <p className="muted mt8">{t.body}</p>
      <div className="row gap8 mt24" style={{ justifyContent: 'center' }}>
        <button type="button" className="btn primary" onClick={reset}><QuietIcon name="undo" />{t.retry}</button>
        <Link className="btn" href="/"><QuietIcon name="grid" />{t.home}</Link>
      </div>
      {error.digest !== undefined ? <p className="small muted mt16">{t.reference(error.digest)}</p> : null}
    </div>
  </div>;
}
