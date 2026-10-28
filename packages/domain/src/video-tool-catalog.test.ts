import { describe, expect, it } from 'vitest';
import { videoToolDescriptorOf, videoToolDescriptorSchema } from '@ancs/contracts';
import { defaultAgentToolCatalog } from './agent-tools.js';

/**
 * V7 工具桥 video-tool.v1（裁决 0021）：DSH 侧注册的代理工具由 ANCS 工具目录派生，名称、效果与输入 Schema 一一对应。
 * 工具目录变了（新增、改名、改效果），这里会提醒同步桥上的描述。
 */
describe('video-tool.v1 mapping of the ANCS tool catalog', () => {
  const descriptors = defaultAgentToolCatalog().descriptors();
  const bridged = descriptors.map(videoToolDescriptorOf);

  it('maps every catalog tool to a valid v1 descriptor without changing it', () => {
    expect(bridged).toHaveLength(descriptors.length);
    bridged.forEach((tool, index) => {
      expect(videoToolDescriptorSchema.safeParse(tool).success).toBe(true);
      const { protocolVersion, concurrencySafe, timeoutMs, ...original } = tool;
      expect(original).toEqual(descriptors[index]);
      expect({ protocolVersion, concurrencySafe: typeof concurrencySafe, timeoutMs: typeof timeoutMs }).toEqual({ protocolVersion: 'video-tool.v1', concurrencySafe: 'boolean', timeoutMs: 'number' });
    });
  });

  it('only read tools run in parallel; the draft, the plan and quotes stay serial', () => {
    for (const tool of bridged) expect(tool.concurrencySafe).toBe(tool.effect === 'READ');
  });

  it('the only metered tool is the quote, and it cannot spend money by itself', () => {
    const metered = bridged.filter((tool) => tool.metered);
    expect(metered.map((tool) => [tool.name, tool.effect])).toEqual([['quote_generation', 'GENERATE']]);
    expect(bridged.filter((tool) => tool.effect === 'GENERATE').map((tool) => tool.name)).toEqual(['quote_generation']);
  });
});
