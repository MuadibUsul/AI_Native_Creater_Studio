'use client';

import { useState, type ReactElement } from 'react';
import type { z } from 'zod';
import { getComponent } from '@ancs/scene-components';

/**
 * 属性表单（Scene Editor 用）：字段由**组件协议**推导（defaults 提供键与类型，inputSchema 负责校验），
 * 保存前必须通过组件 schema——非法 props 不允许提交（避免渲染期才失败）。
 */

type FieldKind = 'text' | 'number' | 'boolean' | 'json';

interface FieldSpec {
  name: string;
  kind: FieldKind;
  value: unknown;
}

const fieldKindOf = (value: unknown): FieldKind => {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (value === null) return 'text';
  if (typeof value === 'string') return 'text';
  return 'json';
};

export function fieldsFromProps(props: Record<string, unknown>): FieldSpec[] {
  return Object.entries(props).map(([name, value]) => ({ name, kind: fieldKindOf(value), value }));
}

export interface PropFormProps {
  sceneType: string;
  componentVersion: string | null;
  initialProps: Record<string, unknown>;
  onSubmit: (nextProps: Record<string, unknown>, validation: { ok: boolean; messages: string[] }) => void;
  submitLabel?: string;
  disabled?: boolean;
}

export function PropForm({ sceneType, componentVersion, initialProps, onSubmit, submitLabel = '保存属性', disabled = false }: PropFormProps): ReactElement {
  const definition = getComponent(sceneType, componentVersion ?? undefined);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    const entries: Record<string, string> = {};
    for (const field of fieldsFromProps(initialProps)) {
      entries[field.name] = field.kind === 'json' ? JSON.stringify(field.value, null, 2) : String(field.value ?? '');
    }
    return entries;
  });
  const [feedback, setFeedback] = useState<string | null>(null);

  if (definition === null) {
    return <p data-testid="propform-unregistered" className="text-sm text-amber-200">组件未注册（{sceneType}），无法编辑属性。</p>;
  }

  const fields = fieldsFromProps(definition.defaults as Record<string, unknown>);

  const coerceAndSubmit = (): void => {
    const next: Record<string, unknown> = {};
    for (const field of fields) {
      const raw = drafts[field.name] ?? '';
      try {
        if (field.kind === 'number') next[field.name] = raw.trim() === '' ? null : Number(raw);
        else if (field.kind === 'boolean') next[field.name] = raw === 'true';
        else if (field.kind === 'json') next[field.name] = raw.trim() === '' ? null : JSON.parse(raw);
        else next[field.name] = raw === '' ? null : raw;
      } catch {
        setFeedback(`字段「${field.name}」不是合法的 JSON`);
        return;
      }
    }
    // 以组件自身 schema 校验（与渲染同源；服务端/渲染端仍会再次校验）
    const parsed = definition.inputSchema.safeParse(next);
    if (!parsed.success) {
      const messages = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
      setFeedback(messages.join('；'));
      onSubmit(next, { ok: false, messages });
      return;
    }
    setFeedback(null);
    onSubmit(parsed.data as Record<string, unknown>, { ok: true, messages: [] });
  };

  return (
    <form
      data-testid="propform"
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        coerceAndSubmit();
      }}
    >
      {fields.map((field) => (
        <label key={field.name} className="flex flex-col gap-1 text-sm">
          <span className="text-slate-300">
            {field.name}
            <span className="ml-2 text-xs text-slate-500">{field.kind}</span>
          </span>
          {field.kind === 'boolean' ? (
            <select
              name={field.name}
              value={drafts[field.name] ?? 'false'}
              onChange={(event) => setDrafts((current) => ({ ...current, [field.name]: event.target.value }))}
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1"
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : field.kind === 'json' ? (
            <textarea
              name={field.name}
              rows={6}
              value={drafts[field.name] ?? ''}
              onChange={(event) => setDrafts((current) => ({ ...current, [field.name]: event.target.value }))}
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-xs"
            />
          ) : (
            <input
              name={field.name}
              value={drafts[field.name] ?? ''}
              onChange={(event) => setDrafts((current) => ({ ...current, [field.name]: event.target.value }))}
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1"
            />
          )}
        </label>
      ))}
      {feedback !== null ? (
        <p data-testid="propform-feedback" className="text-xs text-rose-300">
          {feedback}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={disabled}
        className="self-start rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
      >
        {submitLabel}
      </button>
    </form>
  );
}

export type PropSchema = z.ZodType<unknown>;
