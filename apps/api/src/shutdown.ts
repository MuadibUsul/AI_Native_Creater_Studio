/**
 * 优雅退出（生产部署）：SIGTERM / SIGINT →
 * 1. 标记排空（/ready 返回 503，负载均衡摘掉实例），等 drainMs 让摘除生效；
 * 2. 停止接新连接、等进行中的请求处理完（Fastify close）；
 * 3. 释放数据库连接池；退出码 0。
 * 整个过程超过 timeoutMs 强制退出（退出码 1）。重复信号不会重复执行。
 */

export interface ShutdownOptions {
  drainMs: number;
  timeoutMs: number;
  /** 停止接新连接并等进行中的请求（Fastify app.close） */
  closeServer: () => Promise<void>;
  /** 释放其余资源（数据库连接池等） */
  closeResources: () => Promise<void>;
  exit: (code: number) => void;
  log: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export function createShutdown(options: ShutdownOptions) {
  let draining = false;
  let started: Promise<void> | null = null;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const shutdown = (signal: string): Promise<void> => {
    if (started !== null) return started;
    draining = true;
    options.log(`收到 ${signal}：开始排空（${String(options.drainMs)} ms 后停止接新请求，最长 ${String(options.timeoutMs)} ms）`);
    const timer = setTimeout(() => {
      options.log('优雅退出超时，强制退出');
      options.exit(1);
    }, options.timeoutMs);
    timer.unref?.();
    started = (async () => {
      try {
        if (options.drainMs > 0) await sleep(options.drainMs);
        await options.closeServer();
        await options.closeResources();
        clearTimeout(timer);
        options.log('已优雅退出');
        options.exit(0);
      } catch (error) {
        clearTimeout(timer);
        options.log(`退出时出错：${error instanceof Error ? error.message : String(error)}`);
        options.exit(1);
      }
    })();
    return started;
  };
  return { shutdown, isDraining: () => draining };
}
