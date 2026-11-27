"use client";

import Link from "next/link";
import { useActionState, useEffect, useState, useTransition } from "react";
import { type AccountState, changePassword, deleteAccount, signOutDevices, updateName } from "@/lib/account";
import { type Appearance, resolveAppearance } from "./appearance";
import { Message } from "./card";
import { Field, PasswordField, Spinner, SubmitButton } from "./controls";

// The account page, like Clerk's <UserProfile />: name, password, signed-in
// devices and account deletion. Rendered by <UserProfile /> in index.tsx.

export type DeviceInfo = {
  id: string;
  label: string;
  detail: string;
  current: boolean;
};

type Props = {
  appearance?: Appearance;
  name: string;
  email: string;
  passwordMode: boolean;
  devices: DeviceInfo[];
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

function NameForm({ appearance, name }: { appearance?: Appearance; name: string }) {
  const [state, action] = useActionState<AccountState, FormData>(updateName, {});
  const [value, setValue] = useState(name);
  const [saved, setSaved] = useState(name);
  const { cls } = resolveAppearance(appearance);
  const changed = value.trim() !== saved.trim();
  // A notice means the server saved it: that value is now the saved one.
  useEffect(() => {
    if (state.notice) setSaved(value);
    // Only when a new answer arrives, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  return (
    <form action={action} className={cls("form")}>
      <Field appearance={appearance} label="Name" name="name" autoComplete="name" maxLength={128}
        value={value} onChange={(e) => setValue(e.target.value)} />
      <Message appearance={appearance} error={state.error} notice={changed ? undefined : state.notice} />
      <div className="rp-section-actions">
        <SubmitButton appearance={appearance} ready={changed}>Save</SubmitButton>
      </div>
    </form>
  );
}

function PasswordForm({ appearance, email }: { appearance?: Appearance; email: string }) {
  const [state, action] = useActionState(changePassword, {});
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const { cls } = resolveAppearance(appearance);
  // Clear both fields once the change went through.
  useEffect(() => {
    if (!state.notice) return;
    setCurrent("");
    setNext("");
  }, [state]);
  return (
    <form action={action} className={cls("form")}>
      {/* Lets password managers know which account this password belongs to. */}
      <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
      <PasswordField appearance={appearance} label="Current password" name="current" required autoComplete="current-password"
        value={current} onChange={(e) => setCurrent(e.target.value)} />
      <PasswordField appearance={appearance} label="New password" name="password" required minLength={8} autoComplete="new-password"
        value={next} onChange={(e) => setNext(e.target.value)}
        aside={<span className="rp-hint">At least 8 characters</span>} />
      <Message appearance={appearance} error={state.error} notice={state.notice} />
      <div className="rp-section-actions">
        <SubmitButton appearance={appearance} ready={current.length > 0 && next.length >= 8}>Change password</SubmitButton>
      </div>
    </form>
  );
}

function Devices({ appearance, devices }: { appearance?: Appearance; devices: DeviceInfo[] }) {
  const [list, setList] = useState(devices);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<AccountState>({});
  const [, startTransition] = useTransition();
  const { cls } = resolveAppearance(appearance);
  const others = list.filter((d) => !d.current);

  const run = (id?: string) => {
    setBusy(id ?? "all");
    startTransition(async () => {
      const result = await signOutDevices(id);
      setMessage(result);
      if (!result.error) setList((l) => l.filter((d) => d.current || (id ? d.id !== id : false)));
      setBusy(null);
    });
  };

  return (
    <>
      <ul className="rp-devices">
        {list.map((device) => (
          <li key={device.id} className="rp-device">
            <div className="rp-device-text">
              <p className="rp-device-name">
                {device.label}
                {device.current && <span className="rp-badge">This device</span>}
              </p>
              <p className="rp-device-detail">{device.detail}</p>
            </div>
            {!device.current && (
              <button type="button" className={cls("link")} disabled={busy !== null} aria-busy={busy === device.id || undefined}
                onClick={() => run(device.id)}>
                {busy === device.id ? <Spinner /> : "Sign out"}
              </button>
            )}
          </li>
        ))}
      </ul>
      <Message appearance={appearance} error={message.error} notice={message.notice} />
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
  const [state, action] = useActionState(deleteAccount, {});
  const [confirm, setConfirm] = useState("");
  const { cls } = resolveAppearance(appearance);
  if (!open) {
    return (
      <div className="rp-section-actions">
        <button type="button" className={cls("secondaryButton", "rp-danger-button")} onClick={() => setOpen(true)}>
          Delete account
        </button>
      </div>
    );
  }
  return (
    <form action={action} className={cls("form")}>
      <Field appearance={appearance} label={`Type ${email} to confirm`} name="confirm" autoComplete="off" autoFocus
        autoCapitalize="none" spellCheck={false} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      <Message appearance={appearance} error={state.error} />
      <div className="rp-section-actions">
        <button type="button" className={cls("link")} onClick={() => { setOpen(false); setConfirm(""); }}>
          Cancel
        </button>
        <SubmitButton appearance={appearance} className="rp-danger-solid"
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
          <Devices appearance={appearance} devices={devices} />
        </Section>

        <Section appearance={appearance} title="Delete account" danger
          description="Removes your account and everything you have saved in this app. This cannot be undone.">
          <DeleteAccount appearance={appearance} email={email} />
        </Section>
      </div>
    </main>
  );
}
