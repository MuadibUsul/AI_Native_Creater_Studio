'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { queryKeys, useNarrative } from '@/lib/queries';
import { StateBlock } from '@/ui/StateBlock';

/**
 * Script 页面（P05-03）：
 * - 空：导入文章链接 → 抽取事实 → 生成叙事（Mock LLM 驱动的 V1 链路，经 SDK）；
 * - 正常：章节/旁白块列表；块可**锁定/解锁**、可编辑文本（锁定后改文本 → 409，界面明确提示）；
 * - 状态矩阵：加载 / 失败 / 空 / 正常 / 冲突（锁定 409）。
 */

export default function ScriptPage() {
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const params = useParams<{ workspaceId: string; projectId: string }>();
  const workspaceId = params.workspaceId;
  const projectId = params.projectId;

  const narrative = useNarrative(workspaceId, projectId);
  const [articleUrl, setArticleUrl] = useState('');
  const [blockError, setBlockError] = useState<string | null>(null);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');

  const importAndGenerate = useMutation({
    mutationFn: async (url: string) => {
      const document = await client.content.create(workspaceId, projectId, { sourceType: 'URL_ARTICLE', url });
      await client.evidence.extract(workspaceId, projectId, document.document.id);
      return client.narrative.generate(workspaceId, projectId, document.document.id, { targetDurationMs: 120_000 });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.narrative(workspaceId, projectId) });
    },
  });

  const updateBlock = useMutation({
    mutationFn: (input: { blockId: string; text?: string; locked?: boolean }) =>
      client.narrative.updateBlock(workspaceId, projectId, narrative.data?.id ?? '', input.blockId, {
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.locked !== undefined ? { locked: input.locked } : {}),
      }),
    onSuccess: () => {
      setBlockError(null);
      setEditingBlockId(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.narrative(workspaceId, projectId) });
    },
    onError: (error) => {
      const described = describeError(error);
      setBlockError(described.kind === 'conflict' ? `锁定旁白不可静默修改（${described.code ?? 'CONFLICT'}）：请先解锁。` : described.message);
    },
  });

  if (narrative.isPending) return <StateBlock variant="loading" title="正在加载叙事计划…" />;
  if (narrative.isError) {
    const described = describeError(narrative.error);
    return (
      <StateBlock
        variant={described.kind === 'forbidden' ? 'forbidden' : described.kind === 'notFound' ? 'error' : 'error'}
        title="加载叙事计划失败"
        description={described.message}
        diagnostics={described.code ?? undefined}
        action={{ label: '重试', onClick: () => void narrative.refetch() }}
      />
    );
  }

  const plan = narrative.data;
  if (plan === null || plan === undefined) {
    return (
      <StateBlock
        variant="empty"
        title="还没有叙事计划"
        description="导入一篇文章：系统会先归一化为 ContentDocument、抽取可追溯事实（Claim/Citation），再生成叙事计划（V1 使用 Mock LLM，明确提示非真实模型结果）。"
      >
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (articleUrl.trim() !== '') importAndGenerate.mutate(articleUrl.trim());
          }}
        >
          <input
            aria-label="文章链接"
            value={articleUrl}
            onChange={(event) => setArticleUrl(event.target.value)}
            placeholder="https://news.example/article"
            className="w-80 rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
          />
          <button type="submit" disabled={importAndGenerate.isPending} className="rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50">
            {importAndGenerate.isPending ? '生成中…' : '导入并生成叙事'}
          </button>
        </form>
        {importAndGenerate.isError ? (
          <p className="text-xs text-rose-300">{describeError(importAndGenerate.error).message}</p>
        ) : null}
      </StateBlock>
    );
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">{plan.title}</h1>
        <span className="text-xs text-slate-400">
          revision {plan.revision} · {plan.estimatedDurationMs} ms · {plan.generation.method}
          {plan.generation.promptVersion !== null ? `（${plan.generation.promptVersion}）` : ''}
        </span>
      </div>
      <p className="text-sm text-slate-300">{plan.thesis}</p>
      {blockError !== null ? (
        <StateBlock variant="conflict" title="旁白块操作被拒绝" description={blockError} action={{ label: '知道了', onClick: () => setBlockError(null) }} />
      ) : null}
      {plan.chapters.map((chapter) => (
        <div key={chapter.id} className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-slate-400">{chapter.title}</h2>
          <ul className="flex flex-col gap-2">
            {plan.narrationBlocks
              .filter((block) => block.chapterId === chapter.id)
              .map((block) => (
                <li key={block.id} className="rounded border border-slate-800 bg-slate-900/60 p-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      {editingBlockId === block.id ? (
                        <div className="flex flex-col gap-2">
                          <textarea
                            aria-label={`旁白文本 ${block.id}`}
                            value={editingText}
                            onChange={(event) => setEditingText(event.target.value)}
                            rows={3}
                            className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm"
                          />
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => updateBlock.mutate({ blockId: block.id, text: editingText })}
                              className="rounded bg-sky-600 px-2 py-1 text-xs text-white"
                            >
                              保存文本
                            </button>
                            <button type="button" onClick={() => setEditingBlockId(null)} className="rounded border border-slate-600 px-2 py-1 text-xs">
                              取消
                            </button>
                          </div>
                        </div>
                      ) : (
                        <p className="text-sm">{block.text}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        onClick={() => updateBlock.mutate({ blockId: block.id, locked: !block.locked })}
                        className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
                      >
                        {block.locked ? '解锁' : '锁定'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingBlockId(block.id);
                          setEditingText(block.text);
                        }}
                        className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
                      >
                        编辑
                      </button>
                    </div>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {block.id} · {block.estimatedDurationMs} ms · {block.locked ? '已锁定' : '未锁定'} · {block.claimIds.length} 条事实引用
                  </p>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
