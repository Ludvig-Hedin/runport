"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { type AccountState, changePassword, deleteAccount, signOutDevices, updateName } from "@/lib/account";
import { type Appearance, resolveAppearance } from "./appearance";
import { Message } from "./card";
import { Field, PasswordField, Spinner, SubmitButton } from "./controls";

// The account page, like Clerk's <UserProfile />: name, password and
// signed-in devices. Rendered by <UserProfile /> in index.tsx.

export type DeviceInfo = {
  id: string;
  label: string;
  /** ISO time; formatted in the browser so it shows the visitor's own time zone. */
  signedInAt: string;
  current: boolean;
};

const signedIn = (iso: string) =>
  `Signed in ${new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}`;

/** The sign-in time in the visitor's own time zone. Rendered after mount, as the server cannot know it. */
function SignedInAt({ iso, id }: { iso: string; id: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => setText(signedIn(iso)), [iso]);
  return <p id={id} className="rp-device-detail">{text ?? "\u00a0"}</p>;
}

type Props = {
  appearance?: Appearance;
  name: string;
  email: string;
  passwordMode: boolean;
  /** null when the list could not be loaded. */
  devices: DeviceInfo[] | null;
  backHref: string;
};

function Section({ appearance, title, description, children, danger }: {
  appearance?: Appearance;
  title: string;
  description?: string;
  children: React.ReactNode;
  danger?: boolean;
}) {
  const { cls } = resolveAppearance(appearance);
  return (
    <section className={cls("card", "rp-section")} data-variant="raised" data-danger={danger || undefined}>
      <header className="rp-section-head">
        <h2 className="rp-section-title">{title}</h2>
        {description && <p className="rp-section-text">{description}</p>}
      </header>
      {children}
    </section>
  );
}

function AccountMessage({ appearance, error, notice, signedOut }: AccountState & { appearance?: Appearance }) {
  const { cls } = resolveAppearance(appearance);
  return <Message appearance={appearance} notice={notice} error={signedOut ? (
    <>You are signed out. <Link href="/login" className={cls("link")}>Sign in</Link> again.</>
  ) : error} />;
}

function NameForm({ appearance, name }: { appearance?: Appearance; name: string }) {
  const [state, action] = useActionState<AccountState, FormData>(updateName, {});
  const [value, setValue] = useState(name);
  const [saved, setSaved] = useState(name);
  const { cls } = resolveAppearance(appearance);
  const changed = value.trim() !== saved.trim();
  // The server returns the name it stored; that is the saved one, whatever was typed since.
  useEffect(() => {
    if (state.name !== undefined) setSaved(state.name);
  }, [state]);
  return (
    <form action={action} className={cls("form")}>
      <Field appearance={appearance} label="Name" name="name" autoComplete="name" maxLength={128}
        value={value} onChange={(e) => setValue(e.target.value)} />
      <AccountMessage appearance={appearance} {...state} notice={changed ? undefined : state.notice} />
      <div className="rp-section-actions">
        <SubmitButton appearance={appearance} ready={changed && value.trim().length > 0}>Save</SubmitButton>
      </div>
    </form>
  );
}

function PasswordForm({ appearance, email }: { appearance?: Appearance; email: string }) {
  const [state, action] = useActionState(changePassword, {});
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const form = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const { cls } = resolveAppearance(appearance);
  useEffect(() => {
    if (state.error) {
      // Wrong current password is the usual case: put the cursor back there.
      const field = form.current?.querySelector<HTMLInputElement>('input[name="current"]');
      field?.focus();
      field?.select();
    }
    if (state.notice) {
      setCurrent("");
      setNext("");
      router.refresh(); // other devices were signed out: reload the device list
      // Keep keyboard users where they were: on the confirmation.
      requestAnimationFrame(() => form.current?.querySelector<HTMLElement>("[role=status]")?.focus());
    }
  }, [state, router]);
  return (
    <form ref={form} action={action} className={cls("form")}>
      {/* Lets password managers know which account this password belongs to. */}
      <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
      <PasswordField appearance={appearance} label="Current password" name="current" required autoComplete="current-password"
        value={current} onChange={(e) => setCurrent(e.target.value)} />
      <PasswordField appearance={appearance} label="New password" name="password" required minLength={8} autoComplete="new-password"
        value={next} onChange={(e) => setNext(e.target.value)}
        aside={<span className="rp-hint">At least 8 characters</span>} />
      <AccountMessage appearance={appearance} {...state} />
      <div className="rp-section-actions">
        <SubmitButton appearance={appearance} ready={current.length > 0 && next.length >= 8}>Change password</SubmitButton>
      </div>
    </form>
  );
}

function Devices({ appearance, devices }: { appearance?: Appearance; devices: DeviceInfo[] | null }) {
  const [list, setList] = useState(devices ?? []);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<AccountState>({});
  const [, startTransition] = useTransition();
  const router = useRouter();
  const listRef = useRef<HTMLUListElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const { cls } = resolveAppearance(appearance);
  const others = list.filter((d) => !d.current);

  if (devices === null) {
    return (
      <div className="rp-section-actions" style={{ justifyContent: "space-between" }}>
        <Message appearance={appearance} error="Couldn't load your devices." />
        <button type="button" className={cls("secondaryButton")} onClick={() => router.refresh()}>Try again</button>
      </div>
    );
  }

  const run = (id?: string) => {
    setBusy(id ?? "all");
    startTransition(async () => {
      const result = await signOutDevices(id);
      setMessage(result);
      setBusy(null);
      if (result.error) return;
      const remaining = list.filter((d) => d.current || (id ? d.id !== id : false));
      setList(remaining);
      // Keep keyboard focus nearby: the next device's button, or the message.
      requestAnimationFrame(() => {
        const next = listRef.current?.querySelector<HTMLButtonElement>("button");
        (next ?? statusRef.current)?.focus();
      });
    });
  };

  return (
    <>
      <ul ref={listRef} className="rp-devices">
        {list.map((device) => (
          <li key={device.id} className="rp-device">
            <div className="rp-device-text">
              <p className="rp-device-name">
                {device.label}
                {device.current && <span className="rp-badge">This device</span>}
              </p>
              <SignedInAt iso={device.signedInAt} id={`rp-device-${device.id}`} />
            </div>
            {!device.current && (
              <button type="button" className={cls("link")} disabled={busy !== null} aria-busy={busy === device.id || undefined}
                aria-label={`Sign out ${device.label}`} aria-describedby={`rp-device-${device.id}`}
                onClick={() => run(device.id)}>
                {busy === device.id ? <Spinner /> : "Sign out"}
              </button>
            )}
          </li>
        ))}
      </ul>
      <div ref={statusRef} tabIndex={-1} className="rp-status">
        <AccountMessage appearance={appearance} {...message} />
      </div>
      {others.length > 1 && (
        <div className="rp-section-actions">
          <button type="button" className={cls("secondaryButton")} disabled={busy !== null} aria-busy={busy === "all" || undefined}
            onClick={() => run()}>
            {busy === "all" ? <Spinner /> : "Sign out all other devices"}
          </button>
        </div>
      )}
    </>
  );
}

function DeleteAccount({ appearance, email }: { appearance?: Appearance; email: string }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const { cls } = resolveAppearance(appearance);
  useEffect(() => {
    if (!open && returnFocus.current) {
      opener.current?.focus();
      returnFocus.current = false;
    }
  }, [open]);
  if (!open) {
    return (
      <div className="rp-section-actions">
        <button ref={opener} type="button" className={cls("secondaryButton", "rp-danger-button")} onClick={() => setOpen(true)}>
          Delete account
        </button>
      </div>
    );
  }
  return <DeleteAccountForm appearance={appearance} email={email} onCancel={() => {
    returnFocus.current = true;
    setOpen(false);
  }} />;
}

function DeleteAccountForm({ appearance, email, onCancel }: { appearance?: Appearance; email: string; onCancel: () => void }) {
  const [state, action, pending] = useActionState(deleteAccount, {});
  const [confirm, setConfirm] = useState("");
  const { cls } = resolveAppearance(appearance);
  return (
    <form action={action} className={cls("form")}>
      <Field appearance={appearance} label="Type your email to confirm" placeholder={email} name="confirm" autoComplete="off" autoFocus
        autoCapitalize="none" spellCheck={false} value={confirm} readOnly={pending} onChange={(e) => setConfirm(e.target.value)} />
      <AccountMessage appearance={appearance} {...state} />
      <div className="rp-section-actions">
        <button type="button" className={cls("link")} disabled={pending} onClick={onCancel}>Cancel</button>
        <SubmitButton appearance={appearance} className="rp-danger-solid" pendingLabel="Deleting…"
          ready={confirm.trim().toLowerCase() === email.toLowerCase()}>
          Delete my account
        </SubmitButton>
      </div>
    </form>
  );
}

export function UserProfileView({ appearance, name, email, passwordMode, devices, backHref }: Props) {
  const { style, cls } = resolveAppearance(appearance);
  return (
    <main className={cls("root", "rp-profile")} style={style}>
      <div className="rp-profile-inner">
        <Link href={backHref} className={cls("link", "rp-back")}>← Back</Link>
        <header className="rp-profile-head">
          <h1 className={cls("title")}>Account</h1>
          <p className={cls("subtitle")}>Signed in as <strong>{email}</strong></p>
        </header>

        <Section appearance={appearance} title="Profile" description="Your name as the app shows it.">
          <NameForm appearance={appearance} name={name} />
        </Section>

        {passwordMode && (
          <Section appearance={appearance} title="Password">
            <PasswordForm appearance={appearance} email={email} />
          </Section>
        )}

        <Section appearance={appearance} title="Devices" description="Where you are signed in right now.">
          <Devices key={devices?.map((d) => d.id).join() ?? "error"} appearance={appearance} devices={devices} />
        </Section>

        <Section appearance={appearance} title="Delete account" danger
          description="Removes your account and the data that belongs only to you in this app. This cannot be undone. Things you shared with others stay with them.">
          <DeleteAccount appearance={appearance} email={email} />
        </Section>
      </div>
    </main>
  );
}
