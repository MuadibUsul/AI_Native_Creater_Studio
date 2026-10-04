'use client';

import { useParams } from 'next/navigation';
import { RenderReview } from '@/ui/RenderReview';

/**
 * Render 与审核页面（P07-05 / §86、§87）：预检 + 渲染队列状态 + QA 报告（逐项检查）。
 * （P05-03 的诚实占位在 P07 接线后退役——本页现在是真实链路；批准与受控导出属 P07-06。）
 */

export default function RenderPage() {
  const params = useParams<{ workspaceId: string; projectId: string }>();
  return <RenderReview workspaceId={params.workspaceId} projectId={params.projectId} />;
}
