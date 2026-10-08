import { describe, expect, it } from 'vitest';
import { mapProxyPtsToSourcePts, mapSourcePtsToProxyPts, mediaProxyStreamTimeMapSchema } from './media-proxy.js';

describe('N02-03 media proxy PTS mapping', () => {
  it('maps VFR source PTS by exact timebase instead of average fps', () => {
    const mapping = mediaProxyStreamTimeMapSchema.parse({
      schemaVersion: '1.0', kind: 'PTS_AFFINE', streamType: 'VIDEO', sourceStreamIndex: 0, proxyStreamIndex: 0,
      sourceTimeBase: { numerator: 1, denominator: 15_360 }, proxyTimeBase: { numerator: 1, denominator: 90_000 },
      sourceOriginPts: '0', proxyOriginPts: '0', sourceDurationTicks: '61440', proxyDurationTicks: '360000',
      anchors: [
        { position: 'START', sourcePts: '0', proxyPts: '0' },
        { position: 'MIDDLE', sourcePts: '30720', proxyPts: '180000' },
        { position: 'END', sourcePts: '61440', proxyPts: '360000' },
      ],
    });
    expect(mapSourcePtsToProxyPts(mapping, '512')).toBe('3000');
    expect(mapSourcePtsToProxyPts(mapping, '1024')).toBe('6000');
    expect(mapSourcePtsToProxyPts(mapping, '1536')).toBe('9000');
    expect(mapProxyPtsToSourcePts(mapping, '9000')).toBe('1536');
  });
});
