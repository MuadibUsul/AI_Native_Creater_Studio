/**
 * 首页输入框里的一句想法 → 新建页预填作品名 → 共看片室对话框预填（不自动发送）。
 * 只放在本标签页的 sessionStorage，不上传；读一次即删除。
 */
const briefKey = (projectId: string) => `ancs-studio-brief:${projectId}`;

export function keepStudioBrief(projectId: string, brief: string): void {
  try { window.sessionStorage.setItem(briefKey(projectId), brief); } catch { /* 预填只是便利 */ }
}

export function takeStudioBrief(projectId: string): string | null {
  try {
    const value = window.sessionStorage.getItem(briefKey(projectId));
    window.sessionStorage.removeItem(briefKey(projectId));
    return value === null || value.trim().length === 0 ? null : value;
  } catch {
    return null;
  }
}
