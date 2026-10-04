'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { queryKeys, useAssets } from '@/lib/queries';
import { StateBlock } from '@/ui/StateBlock';

/**
 * Assets 页面（P05-03）：列出项目资产 + 上传（上传意图 → 直传 → 确认；经 SDK，客户端不持 Provider Key）。
 * 状态矩阵：加载 / 失败 / 空（可上传）/ 正常 / 验证失败（类型/大小）。
 */

export default function AssetsPage() {
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const params = useParams<{ workspaceId: string; projectId: string }>();
  const workspaceId = params.workspaceId;
  const projectId = params.projectId;
  const assets = useAssets(workspaceId, projectId);
  const [file, setFile] = useState<File | null>(null);

  /**
   * 外部处理（Native Fallback，P06-07）：展示 Provider 任务引用；用户上传产物后回绑。
   * 只处理**用户提供的文件**（不以内置自动化冒充 Provider 完成）。
   */
  const externalResults = useQuery({
    queryKey: [...queryKeys.assets(workspaceId, projectId), 'external-results'],
    queryFn: () => client.billing.externalResults(workspaceId, { onlyUnfulfilled: true, limit: 20 }),
  });
  const [rebindAssetId, setRebindAssetId] = useState<Record<string, string>>({});
  const rebind = useMutation({
    mutationFn: (input: { generationId: string; assetId: string }) =>
      client.billing.rebindExternalResult(workspaceId, input.generationId, { assetId: input.assetId, note: '平台外处理完成后回绑' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...queryKeys.assets(workspaceId, projectId), 'external-results'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.assets(workspaceId, projectId) });
    },
  });

  const upload = useMutation({
    mutationFn: async (chosen: File) => {
      // V1 类型判定（可在后续界面中改类）：图片 → SOURCE_IMAGE；音频 → VOICE_AUDIO；其余 → USER_UPLOAD
      const assetType = chosen.type.startsWith('image/')
        ? ('SOURCE_IMAGE' as const)
        : chosen.type.startsWith('audio/')
          ? ('VOICE_AUDIO' as const)
          : ('USER_UPLOAD' as const);
      const data = new Uint8Array(await chosen.arrayBuffer());
      return client.assets.upload(workspaceId, {
        assetType,
        filename: chosen.name,
        contentType: chosen.type === '' ? 'application/octet-stream' : chosen.type,
        data,
        projectId,
      });
    },
    onSuccess: () => {
      setFile(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.assets(workspaceId, projectId) });
    },
  });

  if (assets.isPending) return <StateBlock variant="loading" title="正在加载资产…" />;
  if (assets.isError) {
    const described = describeError(assets.error);
    return (
      <StateBlock
        variant={described.kind === 'forbidden' ? 'forbidden' : 'error'}
        title="加载资产失败"
        description={described.message}
        action={{ label: '重试', onClick: () => void assets.refetch() }}
      />
    );
  }

  const items = assets.data ?? [];
  const uploadError = upload.isError ? describeError(upload.error) : null;

  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Assets</h1>

      <form
        className="flex items-center gap-3 rounded border border-slate-800 bg-slate-900/60 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (file !== null) upload.mutate(file);
        }}
      >
        <input
          aria-label="选择文件"
          type="file"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          className="text-sm"
        />
        <button
          type="button"
          onClick={() => {
            if (file !== null) upload.mutate(file);
          }}
          disabled={file === null || upload.isPending}
          className="rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50"
        >
          {upload.isPending ? '上传中…' : '上传（直传签名 URL）'}
        </button>
        <span className="text-xs text-slate-500">上传前服务器会校验类型/大小/声明一致性（MIME 指纹）</span>
      </form>

      {uploadError !== null ? (
        <StateBlock
          variant={uploadError.kind === 'validation' ? 'error' : 'error'}
          title="上传失败"
          description={uploadError.message}
          diagnostics={uploadError.code ?? undefined}
          action={{ label: '重试', onClick: () => { if (file !== null) upload.mutate(file); } }}
        />
      ) : null}

      {/* 外部处理（Native Fallback，P06-07） */}
      <section data-testid="external-results" className="flex flex-col gap-2 rounded border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="text-sm font-semibold text-slate-300">外部处理（Native Fallback）</h2>
        {externalResults.isPending ? <p className="text-xs text-slate-500">正在加载 Provider 任务引用…</p> : null}
        {externalResults.isError ? <p className="text-xs text-rose-300">任务引用加载失败（可稍后重试）。</p> : null}
        {(externalResults.data ?? []).length === 0 && externalResults.data !== undefined ? (
          <p className="text-xs text-slate-500">没有待回绑的 Provider 任务引用。（真实 Provider 任务在 P06 接入后出现；平台外的处理产物可上传后在此回绑。）</p>
        ) : null}
        {(externalResults.data ?? []).map((generation) => (
          <div key={generation.id} data-testid={`external-result-${generation.id}`} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono text-slate-300">{generation.providerId}</span>
            <span className="text-slate-500">任务 {generation.providerJobId?.slice(0, 12) ?? generation.id.slice(0, 12)}…</span>
            <span className="text-slate-500">{generation.status}</span>
            <select
              aria-label={`回绑资产 ${generation.id}`}
              value={rebindAssetId[generation.id] ?? ''}
              onChange={(event) => setRebindAssetId((current) => ({ ...current, [generation.id]: event.target.value }))}
              className="rounded border border-slate-700 bg-slate-950 px-1 py-0.5"
            >
              <option value="">选择该任务的外部产物（READY 资产）…</option>
              {items.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.assetType} · {asset.id.slice(0, 10)}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={rebind.isPending || (rebindAssetId[generation.id] ?? '') === ''}
              onClick={() => {
                const assetId = rebindAssetId[generation.id];
                if (assetId !== undefined && assetId !== '') rebind.mutate({ generationId: generation.id, assetId });
              }}
              className="rounded border border-slate-600 px-2 py-0.5 hover:bg-slate-800 disabled:opacity-40"
            >
              回绑
            </button>
          </div>
        ))}
        {rebind.isError ? (
          <p className="text-xs text-rose-300">回绑失败：{describeError(rebind.error).message}（{describeError(rebind.error).code ?? 'ERROR'}）</p>
        ) : null}
      </section>

      {items.length === 0 ? (
        <StateBlock variant="empty" title="还没有资产" description="上传图片/音频/B-roll 后可在场景中绑定（真实素材必须来自上传或来源导入）。" />
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-slate-400">
            <tr>
              <th className="py-2">资产</th>
              <th>类型</th>
              <th>状态</th>
              <th>来源</th>
              <th>保留类</th>
            </tr>
          </thead>
          <tbody>
            {items.map((asset) => (
              <tr key={asset.id} className="border-t border-slate-800">
                <td className="py-2">{asset.id.slice(0, 14)}…</td>
                <td>{asset.assetType}</td>
                <td>{asset.status}</td>
                <td>{asset.origin}</td>
                <td>{asset.retentionClass}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
