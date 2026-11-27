"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { signOut } from "@/lib/auth";
import { type Appearance, resolveAppearance } from "./appearance";
import { useFormStatus } from "react-dom";
import { Spinner } from "./controls";

type Props = { name: string; email: string; appearance?: Appearance };

function initials(name: string, email: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  return (words[0]?.[0] ?? email[0] ?? "?").toUpperCase();
}

function SignOutItem({ className }: { className: string }) {
  const { pending } = useFormStatus();
  return (
    <button role="menuitem" data-menu-item disabled={pending} aria-busy={pending || undefined} className={className}>
      {pending ? (
        <Spinner />
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" />
          <path d="M10 17l-5-5 5-5" />
          <path d="M5 12h11" />
        </svg>
      )}
      Sign out
    </button>
  );
}

/** The round avatar that opens a small account menu, like Clerk's UserButton. */
export function UserButtonMenu({ name, email, appearance }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const { style, cls } = resolveAppearance(appearance);
  const label = initials(name, email);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    root.current?.querySelector<HTMLElement>("[data-menu-item]")?.focus();
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className={cls("userButton", "rp-root")} style={style}>
      <button
        ref={trigger}
        type="button"
        className="rp-userButton-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Account menu for ${name || email}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={cls("userButtonAvatar")}>{label}</span>
      </button>
      {open && (
        <div id={menuId} role="menu" className={cls("userButtonMenu")}>
          <div className="rp-userButton-who">
            <span className={cls("userButtonAvatar")} aria-hidden="true">{label}</span>
            <div className="rp-userButton-text">
              {name && <p className="rp-userButton-name">{name}</p>}
              <p className={name ? "rp-userButton-email" : "rp-userButton-name"}>{email}</p>
            </div>
          </div>
          <Link href="/account" role="menuitem" data-menu-item className={cls("userButtonMenuItem")} onClick={() => setOpen(false)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="8" r="4" />
              <path d="M4 20a8 8 0 0 1 16 0" />
            </svg>
            Manage account
          </Link>
          <form action={signOut}>
            <SignOutItem className={cls("userButtonMenuItem")} />
          </form>
        </div>
      )}
    </div>
  );
}
