'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
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
