"use client";

import { useCallback, useMemo, useRef, useState } from "react";

export type ToastState = { message: string | null; visible: boolean; show: (message: string, ms?: number) => void };

export function useToast(): ToastState {
  const [message, setMessage] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((text: string, ms = 2700) => {
    if (timer.current) clearTimeout(timer.current);
    setMessage(text);
    setVisible(true);
    timer.current = setTimeout(() => setVisible(false), ms);
  }, []);
  return useMemo(() => ({ message, visible, show }), [message, visible, show]);
}

/** A small dark pill: bottom centre on phones, bottom right on desktop. */
export function Toast({ state }: { state: ToastState }) {
  return (
    <div className="db-toast" data-visible={state.visible || undefined} role="status" aria-live="polite">
      {state.message}
    </div>
  );
}
