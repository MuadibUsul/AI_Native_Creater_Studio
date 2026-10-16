import { describe, expect, it } from 'vitest';
import { spokenReplyExcerpt, VOICE_REPLY_MAX_CHARACTERS } from './voice-session.js';

describe('AI 语音回应的朗读摘录（Issue #9）', () => {
  it('短回应原样朗读，只合并空白', () => {
    expect(spokenReplyExcerpt('  已把第二段剪短到 3 秒。\n\n要我再看看节奏吗？ ')).toBe('已把第二段剪短到 3 秒。 要我再看看节奏吗？');
  });

  it('长回应在句子边界截断，不念半句话', () => {
    const reply = '第一句说明这次改了什么。第二句说明为什么。第三句是一段很长很长的补充说明，超出了朗读上限。';
    const excerpt = spokenReplyExcerpt(reply, 24);
    expect(excerpt).toBe('第一句说明这次改了什么。第二句说明为什么。');
    expect(excerpt.length).toBeLessThanOrEqual(24);
    const english = spokenReplyExcerpt('I trimmed the second clip. It now ends on the beat. Want me to check the pacing of the rest?', 60);
    expect(english).toBe('I trimmed the second clip. It now ends on the beat.');
  });

  it('第一句就超长时硬截到上限；缺省上限有界', () => {
    expect(spokenReplyExcerpt('一'.repeat(50), 10)).toBe('一'.repeat(10));
    expect(spokenReplyExcerpt('长'.repeat(VOICE_REPLY_MAX_CHARACTERS * 2)).length).toBe(VOICE_REPLY_MAX_CHARACTERS);
  });
});
