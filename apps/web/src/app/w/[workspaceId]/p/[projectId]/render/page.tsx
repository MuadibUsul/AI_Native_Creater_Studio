'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useProjectVersions } from '@/lib/queries';
import { StateBlock } from '@/ui/StateBlock';

/**
 * Render 页面（P05-03 诚实占位）：**成片渲染不在本期接线**（P07-05/P07-04）。
 * 这里只展示"可渲染快照"（项目版本）与合成前置条件，不提供假按钮。
 */

export default function RenderPage() {
  const params = useParams<{ workspaceId: string; projectId: string }>();
  const versions = useProjectVersions(params.projectId);

  return (
    <section className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold">Render</h1>
      <StateBlock
        variant="info"
        title="成片渲染将在 P07 接线（尚未实现）"
        description="本期只完成预览与编辑；最终合成（Remotion Worker / FFmpeg / QA / 审批）属于 P07。此处不提供假按钮。"
      />
      <div className="rounded border border-slate-800 bg-slate-900/60 p-4">
        <h2 className="text-sm font-semibold text-slate-300">可渲染快照（项目版本）</h2>
        {versions.isPending ? <p className="mt-2 text-sm text-slate-400">正在加载版本…</p> : null}
        {versions.isError ? <p className="mt-2 text-sm text-rose-300">版本加载失败（仍可继续编辑）。</p> : null}
        {versions.data !== undefined && versions.data.length === 0 ? (
          <p className="mt-2 text-sm text-slate-400">
            还没有版本快照。可在 <Link className="text-sky-300 hover:underline" href={`/w/${params.workspaceId}/p/${params.projectId}/history`}>History</Link> 了解编辑事件；自动快照按事件数量触发。
          </p>
        ) : null}
        {versions.data !== undefined && versions.data.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {versions.data.slice(0, 5).map((version) => (
              <li key={version.id} className="text-slate-300">
                v{version.versionNumber} · {version.reason} · {new Date(version.createdAt).toLocaleString()}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
