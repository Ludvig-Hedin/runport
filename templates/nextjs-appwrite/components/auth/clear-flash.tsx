"use client";

import { useEffect } from "react";
import { clearFlash } from "@/lib/flash-actions";

/** Rendered next to a one-off message: clears it after the first paint. */
export function ClearFlash() {
  useEffect(() => {
    void clearFlash();
  }, []);
  return null;
}
