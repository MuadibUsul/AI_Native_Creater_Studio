import { useEffect, useRef, type RefObject } from 'react';

/** Keep keyboard focus inside an open workflow drawer, then restore its trigger. */
export function useWorkflowDialog(open: boolean, onClose: () => void, trigger: RefObject<HTMLElement | null>) {
  const dialog = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const node = dialog.current;
    if (!node) return;
    const focusable = () => [...node.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((item) => !item.closest('[hidden]'));
    (node.querySelector<HTMLElement>('[autofocus]') ?? focusable()[0] ?? node).focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return; }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) { event.preventDefault(); node.focus(); return; }
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && (document.activeElement === first || !node.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !node.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      requestAnimationFrame(() => trigger.current?.focus());
    };
  }, [open, trigger]);

  return dialog;
}
