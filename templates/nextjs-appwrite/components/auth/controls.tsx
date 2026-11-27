"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { type Appearance, resolveAppearance } from "./appearance";

// Interactive pieces shared by the auth forms.

export function Spinner() {
  return <span className="rp-spinner" aria-hidden="true" />;
}

type SubmitProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  appearance?: Appearance;
  variant?: "primary" | "secondary" | "link";
  /** Disable until the form has what it needs. */
  ready?: boolean;
  ref?: React.Ref<HTMLButtonElement>;
};

const VARIANT_ELEMENT = { primary: "primaryButton", secondary: "secondaryButton", link: "link" } as const;

/** A submit button that shows a spinner while its form is sending. */
export function SubmitButton({ appearance, variant = "primary", ready = true, children, ...rest }: SubmitProps) {
  const { pending, data } = useFormStatus();
  const { cls } = resolveAppearance(appearance);
  // With several submit buttons in one form, only the pressed one spins.
  const mine = pending && (rest.name === undefined || data?.get(rest.name) === rest.value);
  return (
    <button
      {...rest}
      disabled={pending || !ready || rest.disabled}
      aria-busy={mine || undefined}
      className={cls(VARIANT_ELEMENT[variant], rest.className)}
    >
      {mine ? (
        <>
          <Spinner />
          <span className="sr-only">{children}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}

type FieldProps = {
  appearance?: Appearance;
  label: string;
  /** Shown at the right of the label, such as a "Forgot password?" link. */
  aside?: React.ReactNode;
  invalid?: boolean;
  /** A message under the field. Shown only after the person leaves the field. */
  hint?: string;
} & React.InputHTMLAttributes<HTMLInputElement>;

/** Tracks whether the person has left the field once, so errors don't shout while typing. */
function useTouched(onBlur?: React.FocusEventHandler<HTMLInputElement>) {
  const [touched, setTouched] = useState(false);
  return {
    touched,
    onBlur: (event: React.FocusEvent<HTMLInputElement>) => {
      setTouched(true);
      onBlur?.(event);
    },
  };
}

export function Field({ appearance, label, aside, invalid, hint, ...input }: FieldProps) {
  const id = useId();
  const { cls } = resolveAppearance(appearance);
  const { touched, onBlur } = useTouched(input.onBlur);
  const showHint = !!hint && touched;
  return (
    <div className="rp-field">
      <label htmlFor={id} className={cls("label")}>
        {label}
      </label>
      <input
        id={id}
        aria-invalid={invalid || showHint || undefined}
        aria-describedby={showHint ? `${id}-hint` : undefined}
        {...input}
        onBlur={onBlur}
        className={cls("input", input.className)}
      />
      {showHint && (
        <p id={`${id}-hint`} className="rp-field-error">
          {hint}
        </p>
      )}
      {aside && <div className="rp-aside">{aside}</div>}
    </div>
  );
}

export function PasswordField({ appearance, label, aside, invalid, hint, ...input }: FieldProps) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const { cls } = resolveAppearance(appearance);
  const { touched, onBlur } = useTouched(input.onBlur);
  const showHint = !!hint && touched;
  return (
    <div className="rp-field">
      <label htmlFor={id} className={cls("label")}>
        {label}
      </label>
      <div className="rp-password">
        <input
          id={id}
          aria-invalid={invalid || showHint || undefined}
          aria-describedby={showHint ? `${id}-hint` : undefined}
          {...input}
          onBlur={onBlur}
          type={shown ? "text" : "password"}
          className={cls("input", input.className)}
        />
        <button
          type="button"
          className="rp-reveal"
          aria-controls={id}
          aria-pressed={shown}
          onClick={() => setShown((s) => !s)}
        >
          {shown ? "Hide" : "Show"}
        </button>
      </div>
      {showHint && (
        <p id={`${id}-hint`} className="rp-field-error">
          {hint}
        </p>
      )}
      {aside && <div className="rp-aside">{aside}</div>}
    </div>
  );
}

type CodeInputProps = {
  appearance?: Appearance;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
  disabled?: boolean;
};

/** Six boxes over one real input, so paste and iOS/Android code autofill just work. */
export function CodeInput({ appearance, value, onChange, invalid, disabled }: CodeInputProps) {
  const ref = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const { cls } = resolveAppearance(appearance);
  const digits = value.split("");
  const active = Math.min(value.length, 5);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div className={cls("codeInput")} data-invalid={invalid || undefined}>
      <input
        ref={ref}
        name="code"
        value={value}
        disabled={disabled}
        aria-label="6-digit code"
        aria-invalid={invalid || undefined}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="\d{6}"
        maxLength={6}
        required
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(event) => {
          const next = event.target.value.replace(/\D/g, "").slice(0, 6);
          onChange(next);
        }}
      />
      <div className="rp-code-boxes" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="rp-code-box" data-active={focused && i === active}>
            {digits[i] ?? (focused && i === active ? <span className="rp-code-caret" /> : null)}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Counts down from `seconds` each time `resetKey` changes. */
export function useCooldown(seconds: number, resetKey: unknown): number {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    setLeft(seconds);
    const timer = setInterval(() => setLeft((s) => (s <= 1 ? (clearInterval(timer), 0) : s - 1)), 1000);
    return () => clearInterval(timer);
  }, [seconds, resetKey]);
  return left;
}
