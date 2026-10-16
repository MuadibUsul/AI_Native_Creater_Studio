/**
 * Worker 子进程的环境变量白名单（V5-M3；AGENTS.md：运行未受信代码的子进程不得继承宿主环境）。
 *
 * 渲染执行器（执行项目中的 Custom Motion 组件）、Motion 验证器（分析/采样未受信代码）与媒体探测
 * 子进程都**不需要**数据库连接串、会话/凭据/存储密钥或 Provider Key。过去用 `{ ...process.env }`
 * 会把它们全部交给子进程；现改为：平台启动必需项 + 各子进程声明的少量键/前缀。
 * 新增变量前先确认它不会泄露凭据或连接信息。
 */
const BASE_ALLOWLIST = [
  'PATH', 'Path', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'TZ',
  // Windows 上 Node/Chromium 启动所需
  'SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
] as const;

export interface ChildEnvOptions {
  /** 额外放行的精确键名 */
  keys?: readonly string[];
  /** 额外放行的键名前缀（如 `REMOTION_`） */
  prefixes?: readonly string[];
}

export function childProcessEnv(source: NodeJS.ProcessEnv, options: ChildEnvOptions = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_OPTIONS: '' };
  const allowed = new Set<string>([...BASE_ALLOWLIST, ...(options.keys ?? [])]);
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (allowed.has(key) || (options.prefixes ?? []).some((prefix) => key.startsWith(prefix))) env[key] = value;
  }
  return env;
}

/** 渲染执行器 / 媒体探测 / Motion 验证器共用：Remotion 浏览器与 FFmpeg 路径。 */
export const MEDIA_CHILD_ENV: ChildEnvOptions = {
  keys: ['ANCS_FFMPEG_PATH', 'ANCS_FFPROBE_PATH'],
  prefixes: ['REMOTION_'],
};
