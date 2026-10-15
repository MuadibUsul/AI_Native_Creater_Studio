'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MAX_ARTICLE_CHARS, STUDIO_ASPECT_RATIOS, type CreateStudioProjectRequest } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { queryKeys } from '@/lib/queries';
import { useI18n } from '@/i18n/I18nProvider';
import { keepStudioBrief } from '@/studio/studio-brief';
import styles from '@/studio/studio.module.css';

type AspectRatio = (typeof STUDIO_ASPECT_RATIOS)[number];
const SHAPES: Record<AspectRatio, { width: number; height: number }> = {
  '16:9': { width: 32, height: 18 }, '9:16': { width: 14, height: 25 }, '1:1': { width: 22, height: 22 }, '4:5': { width: 20, height: 25 },
};

/** 首页输入框带过来的草稿（只在本标签页的 sessionStorage） */
const HOME_DRAFT_KEY = 'ancs-studio-draft';

function readHomeDraft(): { start: 'footage'; brief: string } | { start: 'article'; article: string } | null {
  try {
    const raw = window.sessionStorage.getItem(HOME_DRAFT_KEY);
    window.sessionStorage.removeItem(HOME_DRAFT_KEY);
    const value = raw === null ? null : JSON.parse(raw) as { start?: unknown; brief?: unknown; article?: unknown };
    if (value?.start === 'article' && typeof value.article === 'string') return { start: 'article', article: value.article };
    if (value?.start === 'footage' && typeof value.brief === 'string') return { start: 'footage', brief: value.brief };
  } catch { /* 没有草稿也能正常新建 */ }
  return null;
}

/** 从一句想法里取作品名：第一行，过长截断 */
function titleFromBrief(brief: string): string {
  const line = brief.trim().split(/\r?\n/)[0]?.trim() ?? '';
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}

/**
 * 新建：标题 + 画幅 → 一步建好工程、主序列与 AI 会话，然后进入共看片室。
 * 起点二选一（V6-5）：从素材开始（素材工程）；从文章开始（贴文章，可选"AI 配音讲述"，建图文工程）。
 * 从首页输入框来时：想法预填作品名，进入共看片室后作为第一句话预填在对话框里（不自动发送）；文章预填到文章框。
 */
export default function NewStudioProjectPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const router = useRouter();
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const { messages, locale } = useI18n();
  const t = messages.studioNew;
  const [title, setTitle] = useState('');
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('16:9');
  const [start, setStart] = useState<'footage' | 'article'>('footage');
  const [article, setArticle] = useState('');
  const [narration, setNarration] = useState(true);
  const [touched, setTouched] = useState(false);
  const [brief, setBrief] = useState<string | null>(null);
  useEffect(() => {
    const draft = readHomeDraft();
    if (draft === null) return;
    if (draft.start === 'article') {
      setStart('article');
      setArticle(draft.article);
    } else if (draft.brief.trim().length > 0) {
      setBrief(draft.brief.trim());
      setTitle((current) => (current.length > 0 ? current : titleFromBrief(draft.brief)));
    }
  }, []);
  const create = useMutation({
    mutationFn: (input: CreateStudioProjectRequest) => client.studio.create(workspaceId, input, { idempotencyKey: `studio-${globalThis.crypto.randomUUID()}` }),
    onSuccess: async (ref) => {
      if (brief !== null && start === 'footage') {
        keepStudioBrief(ref.projectId, brief);
      }
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects(workspaceId) });
      router.push(`/w/${workspaceId}/studio/${ref.projectId}`);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (title.trim().length === 0) return;
    if (start === 'article') {
      if (article.trim().length === 0) return;
      create.mutate({ title: title.trim(), aspectRatio, locale, article: { title: title.trim(), text: article.trim() }, narration });
      return;
    }
    create.mutate({ title: title.trim(), aspectRatio, locale });
  };
  const missing = touched && title.trim().length === 0;
  const articleMissing = touched && start === 'article' && article.trim().length === 0;

  return (
    <div className={styles['newPage']} lang={locale}>
      <div>
        <Link className="textbtn small" href={`/?workspaceId=${encodeURIComponent(workspaceId)}`}>{t.back}</Link>
        <h1 className="mt16">{t.title}</h1>
        <p className="muted mt8">{t.body}</p>
      </div>
      <form className="col" onSubmit={submit} noValidate>
        <div className="col" style={{ gap: 8 }}>
          <label htmlFor="studio-title">{t.nameLabel}</label>
          <input
            id="studio-title"
            className="field"
            value={title}
            maxLength={120}
            placeholder={t.namePlaceholder}
            aria-invalid={missing}
            aria-describedby={missing ? 'studio-title-error' : undefined}
            onChange={(event) => setTitle(event.target.value)}
          />
          {missing ? <span id="studio-title-error" className="small" role="alert">{t.nameRequired}</span> : null}
        </div>
        <div className="col" style={{ gap: 8 }}>
          <span id="studio-start-label">{t.startLabel}</span>
          <div className={styles['starts']} role="radiogroup" aria-labelledby="studio-start-label">
            {(['footage', 'article'] as const).map((option) => (
              <button key={option} type="button" role="radio" aria-checked={start === option} className={styles['start']} onClick={() => setStart(option)}>
                <strong>{option === 'footage' ? t.startFootage : t.startArticle}</strong>
                <span>{option === 'footage' ? t.startFootageHint : t.startArticleHint}</span>
              </button>
            ))}
          </div>
        </div>
        {start === 'article' ? (
          <div className="col" style={{ gap: 8 }}>
            <label htmlFor="studio-article">{t.articleLabel}</label>
            <textarea
              id="studio-article"
              className="field"
              rows={10}
              value={article}
              maxLength={MAX_ARTICLE_CHARS}
              placeholder={t.articlePlaceholder}
              aria-invalid={articleMissing}
              aria-describedby={`studio-article-count${articleMissing ? ' studio-article-error' : ''}`}
              onChange={(event) => setArticle(event.target.value)}
            />
            <span id="studio-article-count" className="small muted">{t.articleCount(article.length, MAX_ARTICLE_CHARS)}</span>
            {articleMissing ? <span id="studio-article-error" className="small" role="alert">{t.articleRequired}</span> : null}
            <label className={styles['checkRow']}>
              <input type="checkbox" checked={narration} onChange={(event) => setNarration(event.target.checked)} aria-describedby="studio-narration-hint" />
              <span>{t.narrationLabel}</span>
            </label>
            <span id="studio-narration-hint" className="small muted">{t.narrationHint}</span>
          </div>
        ) : null}
        <div className="col" style={{ gap: 8 }}>
          <span id="studio-aspect-label">{t.aspectLabel}</span>
          <div className={styles['aspects']} role="radiogroup" aria-labelledby="studio-aspect-label">
            {STUDIO_ASPECT_RATIOS.map((ratio) => (
              <button
                key={ratio}
                type="button"
                role="radio"
                aria-checked={aspectRatio === ratio}
                className={styles['aspect']}
                onClick={() => setAspectRatio(ratio)}
              >
                <span className={styles['aspectShape']} style={{ width: SHAPES[ratio].width, height: SHAPES[ratio].height }} aria-hidden="true" />
                {t.aspects[ratio]}
              </button>
            ))}
          </div>
        </div>
        {create.isError ? <p role="alert"><strong>{t.failed}</strong> · {describeError(create.error).message}</p> : null}
        <div className="row">
          <button type="submit" className="btn primary" disabled={create.isPending}>{create.isPending ? t.creating : t.create}</button>
        </div>
      </form>
    </div>
  );
}
