import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const css = read('apps/web/src/app/ui-tokens.css');
const reference = JSON.parse(read('docs/V04/ANCS_v0.4_Design_Tokens.json')) as {
  themes: Record<'light' | 'dark', Record<string, string>>;
  contrastPairs: { foreground: string; background: string; minimum: number }[];
};

function themeColors(selector: string): Record<string, string> {
  const block = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))?.[1];
  if (!block) throw new Error(`missing token block: ${selector}`);
  return Object.fromEntries(
    [...block.matchAll(/--ui-([\w-]+):\s*(#[0-9a-fA-F]{6});/g)]
      .map((match) => [`ui.${match[1]!.replaceAll('-', '.')}`, match[2]!.toUpperCase()]),
  );
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((index) => {
    const value = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function visualViolations(source: string, scope: 'ui' | 'content'): string[] {
  if (scope === 'content') return [];
  const issues: string[] = [];
  if (/(?:linear|radial|conic)-gradient\(/.test(source)) issues.push('gradient');
  if (/backdrop-filter\s*:\s*blur\(/.test(source)) issues.push('backdrop-blur');
  if (/filter\s*:\s*(?:grayscale|invert|brightness)\(/.test(source)) issues.push('media-color-filter');
  for (const [, hex] of source.matchAll(/(#[0-9a-fA-F]{3,4}(?:[0-9a-fA-F]{3,4})?)\b/g)) {
    if (hex && !/^#(?:(.)\1{2,3}|(..)\2{2,3})$/i.test(hex)) {
      issues.push(`color:${hex}`);
    }
  }
  return issues;
}

function isMediaContentSelector(selector: string): boolean {
  return selector.split(',').every((part) => /^(?:\.cover(?:\b|[-:])|\.art-\d+(?:\b|:)|\.genericPreview\b|\.media-content\b|\.brand-content\b|\[data-content-theme\])/.test(part.trim()));
}

function uiRules(source: string): { selector: string; body: string }[] {
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((rule) => ({ selector: rule[1]!.trim(), body: rule[2]! }))
    .filter((rule) => !isMediaContentSelector(rule.selector));
}

const cssFiles = [
  'apps/web/src/app/globals.css',
  'apps/web/src/app/quiet-frame.css',
  'apps/web/src/app/ui-tokens.css',
  'apps/web/src/components/quiet-frame/workspace.css',
  'apps/web/src/components/quiet-frame/workflow.css',
  'apps/web/src/components/quiet-frame/legacy.module.css',
  'apps/web/src/components/quiet-frame/delivery.module.css',
  'apps/web/src/ui/finance-workspace.module.css',
];

function effectDebt(path: string, source: string): string[] {
  return uiRules(source).flatMap(({ selector, body }) => {
    return [
      ...[...body.matchAll(/(?:linear|radial|conic)-gradient\(/g)].map(() => `${path}|${selector}|gradient`),
      ...[...body.matchAll(/(?:backdrop-filter|filter)\s*:\s*blur\(/g)].map(() => `${path}|${selector}|blur`),
    ];
  });
}

const legacyCss = 'apps/web/src/app/quiet-frame.css';
const knownLegacyEffects = [
  '.little-frames .frame', '.little-frames .frame:nth-child(2)', '.little-frames .frame:nth-child(3)',
  '.viewer.graph', '.voice-hero', '.voice-sphere',
].map((selector) => `${legacyCss}|${selector}|gradient`).concat([
  '.prompt-dock', '.modal-backdrop', '.topbar',
].map((selector) => `${legacyCss}|${selector}|blur`));

const legacyHexBudgets: Record<string, number> = {
  'apps/web/src/app/globals.css': 0,
  'apps/web/src/app/quiet-frame.css': 249,
  'apps/web/src/components/quiet-frame/workspace.css': 3,
  'apps/web/src/components/quiet-frame/workflow.css': 14,
  'apps/web/src/components/quiet-frame/legacy.module.css': 2,
  'apps/web/src/components/quiet-frame/delivery.module.css': 8,
  'apps/web/src/ui/finance-workspace.module.css': 0,
};

const uiHexCount = (source: string) => uiRules(source)
  .reduce((count, rule) => count + [...rule.body.matchAll(/#[0-9a-fA-F]{3,4}(?:[0-9a-fA-F]{3,4})?\b/g)].length, 0);

describe('v0.4 UI token foundation', () => {
  it('light/dark colors have identical semantic keys, match the reference, and pass specified contrast pairs', () => {
    const light = themeColors(':root');
    const dark = themeColors('body\\.theme-dark');
    expect(light).toEqual(reference.themes.light);
    expect(dark).toEqual(reference.themes.dark);
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
    for (const theme of [light, dark]) {
      for (const pair of reference.contrastPairs) {
        const left = luminance(theme[pair.foreground]!);
        const right = luminance(theme[pair.background]!);
        expect((Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05)).toBeGreaterThanOrEqual(pair.minimum);
      }
    }
  });

  it('keeps runtime UI tokens neutral and rejects a bad UI example without flagging content color', () => {
    expect(visualViolations(css, 'ui')).toEqual([]);
    expect(visualViolations('.btn { background: linear-gradient(#ff0000, #0000ff); filter: grayscale(1); }', 'ui'))
      .toEqual(expect.arrayContaining(['gradient', 'media-color-filter', 'color:#ff0000', 'color:#0000ff']));
    expect(visualViolations('.media-content { background: #ff0000; }', 'content')).toEqual([]);
    expect(visualViolations('.btn { background: #ff000080; }', 'ui')).toContain('color:#ff000080');
    expect(css).toContain('--ui-space-16: 64px');
    expect(css).toContain('--ui-control-touch-target: 44px');
    expect(css).toContain('--ui-motion-drawer: 200ms');
    expect(css).toContain('--bg: var(--ui-bg-canvas)');
    expect(css).toMatch(/\.field\s*\{[^}]*border-color:\s*var\(--ui-border-control\)/);
    expect(css).toMatch(/\.btn\.blue\s*\{[^}]*color:\s*var\(--ui-fg-primary\)/);
    expect(css).toMatch(/\.btn\.blue:hover\s*\{[^}]*background:\s*var\(--ui-bg-hover\)/);
    expect(css).toMatch(/\.switch\[aria-checked="true"\]:after\s*\{[^}]*background:\s*var\(--ui-action-primary-fg\)/);
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--ui-focus-ring\)/);
    expect(read('apps/web/src/app/layout.tsx')).toMatch(/import ['"]\.\/quiet-frame\.css['"];\s*import ['"]\.\/ui-tokens\.css['"]/);
  });

  it('detects added decorative effects in UI CSS while tracking the existing migration debt', () => {
    const actual = cssFiles.flatMap((path) => effectDebt(path, read(path))).sort();
    const remaining = [...knownLegacyEffects];
    const unexpected = actual.filter((issue) => {
      const index = remaining.indexOf(issue);
      if (index < 0) return true;
      remaining.splice(index, 1);
      return false;
    });
    expect(unexpected).toEqual([]);
    expect(actual).toContain(`${legacyCss}|.voice-hero|gradient`);
    expect(effectDebt('apps/web/src/app/ui-tokens.css', `${css}\n.btn { backdrop-filter: blur(12px); }`))
      .toContain('apps/web/src/app/ui-tokens.css|.btn|blur');
    expect(effectDebt('content.css', '.media-content { background: linear-gradient(#ff0000, #0000ff); }')).toEqual([]);
    expect(effectDebt('mixed.css', '.media-content, .btn { background: linear-gradient(#ff0000, #0000ff); }')).toContain('mixed.css|.media-content, .btn|gradient');
  });

  it('fails when UI color debt grows, while media content colors stay outside the UI scan', () => {
    for (const path of cssFiles.filter((file) => file !== 'apps/web/src/app/ui-tokens.css')) {
      expect(uiHexCount(read(path))).toBeLessThanOrEqual(legacyHexBudgets[path]!);
    }
    expect(uiHexCount('.btn { background: #ff0000; }')).toBe(1);
    expect(uiHexCount('.media-content { background: #ff0000; }')).toBe(0);
    expect(uiHexCount('.cover-art { background: #ff0000; }')).toBe(0);
    expect(uiHexCount(`${read(legacyCss)}\n.btn { background: #ff0000; }`))
      .toBeGreaterThan(legacyHexBudgets[legacyCss]!);
    expect(uiHexCount(`${read(legacyCss)}\n.cover-art { background: #ff0000; }`))
      .toBe(legacyHexBudgets[legacyCss]);
  });
});
