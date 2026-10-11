import { config } from 'zod';

/**
 * 浏览器端最早执行的入口（Next.js instrumentation-client：先于任何应用代码与水合）。
 *
 * 严格 CSP（无 unsafe-eval）下关闭 Zod 的 JIT：Zod 4 在**构造**对象 schema 时以 `new Function('')`
 * 探测能否使用 eval，即使被捕获也会触发 `securitypolicyviolation`（V5-M4 浏览器验证实测）。
 * 必须在任何契约 schema 被构造之前执行，因此这里**只导入 zod 本身**——导入 `@ancs/contracts`
 * 会先构造全部 schema，探测就已经发生了。web 与 contracts 解析到同一个 zod 实例。
 */
config({ jitless: true });
