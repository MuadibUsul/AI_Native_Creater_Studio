'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * AI 回应的朗读（V6-2）：目前用**浏览器自带的语音合成**（界面如实标注），服务端语音合成随 V6-5 接入。
 * "停止说话"只停朗读，不影响进行中的一轮或试改；用户开口时调用方立刻停朗读（打断）。
 */
export function useReplySpeech(locale: 'zh-CN' | 'en') {
  const supported = typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
  const [speaking, setSpeaking] = useState(false);
  const current = useRef<SpeechSynthesisUtterance | null>(null);

  const stop = useCallback(() => {
    if (!supported) return;
    current.current = null;
    window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [supported]);

  const speak = useCallback((text: string) => {
    if (!supported || text.trim().length === 0) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = locale;
    utterance.onend = () => { if (current.current === utterance) { current.current = null; setSpeaking(false); } };
    utterance.onerror = utterance.onend;
    current.current = utterance;
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  }, [locale, supported]);

  useEffect(() => () => { if (supported) window.speechSynthesis.cancel(); }, [supported]);
  return { supported, speaking, speak, stop };
}
