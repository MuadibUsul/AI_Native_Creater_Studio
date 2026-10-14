'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { IDENTITY_CONSENT_KINDS, type IdentityConsentKind, type IdentityProfile } from '@ancs/contracts';
import type { IdentityConsentStatement } from '@ancs/sdk';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { useI18n } from '@/i18n/I18nProvider';
import { QuietIcon } from '@/ui/QuietIcon';
import styles from '@/studio/studio.module.css';

/**
 * V6-7 我的形象与声音：建档案 → 上传参考照片与声音样本 → 读声明并授权（只增不改的授权记录，可撤回）。
 * 之后在作品里让 AI 用数字人讲一段，AI 报价、你确认后才生成。换参考素材后需要重新授权。
 */

const profilesKey = (workspaceId: string) => ['identity-profiles', workspaceId] as const;
const ACCEPT: Record<IdentityConsentKind, string> = { LIKENESS: 'image/png,image/jpeg,image/webp', VOICE: 'audio/*' };
const randomKey = (prefix: string): string => `${prefix}-${globalThis.crypto.randomUUID()}`;

export default function IdentityPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const { messages, locale } = useI18n();
  const t = messages.identity;
  const profiles = useQuery({ queryKey: profilesKey(workspaceId), queryFn: () => client.identities.list(workspaceId) });
  const statement = useQuery({ queryKey: ['identity-statement', workspaceId], queryFn: () => client.identities.consentStatement(workspaceId), staleTime: 10 * 60_000 });
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: (value: string) => client.identities.create(workspaceId, value, { idempotencyKey: randomKey('identity') }),
    onSuccess: async () => { setName(''); await queryClient.invalidateQueries({ queryKey: profilesKey(workspaceId) }); },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim().length > 0) create.mutate(name.trim());
  };

  return (
    <div className={styles['newPage']} lang={locale}>
      <div>
        <Link className="textbtn small" href={`/?workspaceId=${encodeURIComponent(workspaceId)}`}>{t.back}</Link>
        <h1 className="mt16">{t.title}</h1>
        <p className="muted mt8">{t.intro}</p>
      </div>
      {profiles.isError ? <p role="alert">{t.loadFailed} · {describeError(profiles.error).message}</p> : null}
      {profiles.data !== undefined && profiles.data.length === 0 ? <p className="muted">{t.empty}</p> : null}
      {(profiles.data ?? []).map((profile) => (
        <IdentityCard key={profile.id} workspaceId={workspaceId} profile={profile} statement={statement.data ?? null} />
      ))}
      <form className="col" style={{ gap: 8 }} onSubmit={submit}>
        <label htmlFor="identity-name">{t.nameLabel}</label>
        <div className="row">
          <input id="identity-name" className="field" value={name} maxLength={80} placeholder={t.namePlaceholder} onChange={(event) => setName(event.target.value)} />
          <button type="submit" className="btn" disabled={create.isPending || name.trim().length === 0}><QuietIcon name="plus" />{create.isPending ? t.creating : t.create}</button>
        </div>
        {create.isError ? <p role="alert">{t.failed} · {describeError(create.error).message}</p> : null}
      </form>
    </div>
  );
}

function IdentityCard({ workspaceId, profile, statement }: { workspaceId: string; profile: IdentityProfile; statement: IdentityConsentStatement | null }) {
  const { messages } = useI18n();
  const t = messages.identity;
  return (
    <section className={styles['identityCard']} aria-label={profile.name}>
      <h2>{profile.name}</h2>
      <div className={styles['identityParts']}>
        {IDENTITY_CONSENT_KINDS.map((kind) => <IdentityPart key={kind} workspaceId={workspaceId} profile={profile} kind={kind} statement={statement} />)}
      </div>
      <details className={styles['earlier']}>
        <summary>{t.history} ({profile.history.length})</summary>
        {profile.history.length === 0 ? <p>{t.historyEmpty}</p> : (
          <ol>
            {profile.history.map((record) => (
              <li key={record.id}>{t.historyRow(new Date(record.createdAt).toLocaleString(), t.parts[record.kind], t.actions[record.action], record.statementVersion)}</li>
            ))}
          </ol>
        )}
      </details>
    </section>
  );
}

function IdentityPart({ workspaceId, profile, kind, statement }: { workspaceId: string; profile: IdentityProfile; kind: IdentityConsentKind; statement: IdentityConsentStatement | null }) {
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const { messages, locale } = useI18n();
  const t = messages.identity;
  const part = kind === 'LIKENESS' ? profile.likeness : profile.voice;
  const input = useRef<HTMLInputElement | null>(null);
  const [subject, setSubject] = useState<'SELF' | 'AUTHORIZED_OTHER'>('SELF');
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: profilesKey(workspaceId) });
  const onError = (caught: unknown) => setError(`${t.failed} · ${describeError(caught).message}`);

  const upload = useMutation({
    mutationFn: async (file: File) => {
      setProgress(0);
      const asset = await client.assets.uploadResumable(workspaceId, {
        assetType: kind === 'LIKENESS' ? 'SOURCE_IMAGE' : 'VOICE_AUDIO', filename: file.name, contentType: file.type || 'application/octet-stream', data: file,
      }, { onProgress: ({ uploadedBytes, totalBytes }) => setProgress(totalBytes === 0 ? 0 : Math.round((uploadedBytes / totalBytes) * 100)) });
      // 上传完成后等媒体检查完成再设为参考（最多约 60 秒）
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const detail = await client.assets.get(workspaceId, asset.id);
        const current = detail.versions.find((version) => version.id === detail.currentVersionId);
        if (current?.status === 'READY') break;
        if (current?.status === 'FAILED') throw new Error(t.uploadFailed);
        await new Promise((done) => { setTimeout(done, 1000); });
      }
      return client.identities.setReference(workspaceId, profile.id, { kind, assetId: asset.id }, { idempotencyKey: randomKey('identity-ref') });
    },
    onSuccess: async () => { setProgress(null); setError(null); await refresh(); },
    onError: (caught) => { setProgress(null); onError(caught); },
  });
  const grant = useMutation({
    mutationFn: () => client.identities.grantConsent(workspaceId, profile.id, { kind, subject, statementVersion: statement?.version ?? '', locale }, { idempotencyKey: randomKey('identity-consent') }),
    onSuccess: async () => { setError(null); await refresh(); },
    onError,
  });
  const revoke = useMutation({
    mutationFn: () => client.identities.revokeConsent(workspaceId, profile.id, kind, { idempotencyKey: randomKey('identity-revoke') }),
    onSuccess: async () => { setError(null); await refresh(); },
    onError,
  });
  const status = part.ready ? 'READY' : part.reference === null ? 'NO_REFERENCE' : 'NO_CONSENT';
  const lastGrant = profile.history.find((record) => record.kind === kind && record.action === 'GRANT');
  const needsReconsent = part.reference !== null && part.consent === null && lastGrant !== undefined && profile.history.find((record) => record.kind === kind)?.action === 'GRANT';

  return (
    <div className={styles['identityPart']} data-status={status}>
      <div className={styles['generationHead']}>
        <QuietIcon name={kind === 'LIKENESS' ? 'image' : 'voice'} />
        <strong>{t.parts[kind]}</strong>
        <span className={styles['generationBadge']}>{t.status[status]}</span>
      </div>
      <p className="small muted">{t.hints[kind]}</p>
      <p className="small">{part.reference === null ? t.noReference : t.reference(part.reference.filename)}</p>
      <div className={styles['actions']}>
        <button type="button" className="btn small" disabled={upload.isPending} onClick={() => input.current?.click()}>
          <QuietIcon name="upload" />{progress !== null ? t.uploading(progress) : part.reference === null ? t.upload[kind] : t.replace}
        </button>
        <input ref={input} type="file" hidden accept={ACCEPT[kind]} aria-label={t.upload[kind]} onChange={(event) => { const file = event.target.files?.[0]; if (file !== undefined) upload.mutate(file); event.target.value = ''; }} />
      </div>
      {part.consent !== null ? (
        <div className={styles['actions']}>
          <span className="small">{t.consented(new Date(part.consent.grantedAt).toLocaleString(), t.subjects[part.consent.subject])}</span>
          <button type="button" className="btn small" disabled={revoke.isPending} onClick={() => revoke.mutate()}>{revoke.isPending ? t.revoking : t.revoke}</button>
        </div>
      ) : part.reference !== null && statement !== null ? (
        <div className="col" style={{ gap: 6 }}>
          {needsReconsent ? <p className="small">{t.reconsent}</p> : null}
          <strong className="small">{t.statementTitle}</strong>
          <blockquote className={styles['identityStatement']}>{statement.statements[kind][locale]}</blockquote>
          <div className={styles['actions']} role="radiogroup" aria-label={t.subjectLabel}>
            {(['SELF', 'AUTHORIZED_OTHER'] as const).map((option) => (
              <label key={option} className={styles['checkRow']}>
                <input type="radio" name={`subject-${profile.id}-${kind}`} checked={subject === option} onChange={() => setSubject(option)} />
                <span>{t.subjects[option]}</span>
              </label>
            ))}
          </div>
          <div className={styles['actions']}>
            <button type="button" className="btn primary small" disabled={grant.isPending} onClick={() => grant.mutate()}><QuietIcon name="check" />{grant.isPending ? t.granting : t.grant}</button>
          </div>
        </div>
      ) : null}
      {error !== null ? <p className={styles['alert']} role="alert">{error}</p> : null}
    </div>
  );
}
