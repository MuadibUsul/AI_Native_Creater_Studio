'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { STUDIO_ASPECT_RATIOS, type CreateStudioProjectRequest } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { queryKeys } from '@/lib/queries';
import { useI18n } from '@/i18n/I18nProvider';
import styles from '@/studio/studio.module.css';

type AspectRatio = (typeof STUDIO_ASPECT_RATIOS)[number];
const SHAPES: Record<AspectRatio, { width: number; height: number }> = {
  '16:9': { width: 32, height: 18 }, '9:16': { width: 14, height: 25 }, '1:1': { width: 22, height: 22 }, '4:5': { width: 20, height: 25 },
};

/** V6-1c 新建：标题 + 画幅 → 一步建好素材工程、主序列与 AI 会话，然后进入共看片室。 */
export default function NewStudioProjectPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const router = useRouter();
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const { messages, locale } = useI18n();
  const t = messages.studioNew;
  const [title, setTitle] = useState('');
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('16:9');
  const [touched, setTouched] = useState(false);
  const create = useMutation({
    mutationFn: (input: CreateStudioProjectRequest) => client.studio.create(workspaceId, input, { idempotencyKey: `studio-${globalThis.crypto.randomUUID()}` }),
    onSuccess: async (ref) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects(workspaceId) });
      router.push(`/w/${workspaceId}/studio/${ref.projectId}`);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (title.trim().length === 0) return;
    create.mutate({ title: title.trim(), aspectRatio, locale });
  };
  const missing = touched && title.trim().length === 0;

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
