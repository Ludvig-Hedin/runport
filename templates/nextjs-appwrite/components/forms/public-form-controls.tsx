"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import { type Appearance, resolveAppearance } from "@/components/auth/appearance";
import { Field, SubmitButton } from "@/components/auth/controls";
import { fieldLimit, type FormField, type FormState } from "@/lib/form-fields";
import { Turnstile } from "./turnstile";

type Props = {
  action: (state: FormState, data: FormData) => Promise<FormState>;
  fields: readonly FormField[];
  initialToken: string;
  siteKey?: string;
  submitLabel: string;
  appearance?: Appearance;
};

export function PublicFormControls({ action, fields, initialToken, siteKey, submitLabel, appearance }: Props) {
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const { cls, style } = resolveAppearance(appearance);
  const [values, setValues] = useState<Record<string, string>>({});
  const [state, submit, pending] = useActionState(action, { status: "idle", token: initialToken } satisfies FormState);
  const [lastState, setLastState] = useState(state);
  const [editedFields, setEditedFields] = useState<Record<string, boolean>>({});
  const [challengeToken, setChallengeToken] = useState("");
  if (state !== lastState) {
    setLastState(state);
    setEditedFields({});
    setChallengeToken("");
    if (state.status === "success") setValues({});
  }
  useEffect(() => {
    if (state.errors) form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  const ready = fields.every((field) => !field.required || values[field.name]?.trim());
  const showError = !pending && state.status === "error" &&
    (!state.errors || Object.keys(state.errors).some((name) => !editedFields[name]));

  return (
    <form ref={form} action={submit} style={style} className={`${cls("root")} ${cls("form")} rp-public-form`} aria-busy={pending}>
      <input name="_rp_token" type="hidden" value={state.token} />
      <div hidden>
        <label htmlFor={`${id}-extra`}>Leave this field empty</label>
        <input name="_rp_extra" id={`${id}-extra`} tabIndex={-1} autoComplete="off" />
      </div>
      {fields.map((field) => {
        const inputId = `${id}-${field.name}`;
        const error = editedFields[field.name] ? undefined : state.errors?.[field.name];
        const props = {
          name: field.name, required: field.required, readOnly: pending,
          autoComplete: field.autoComplete, maxLength: fieldLimit(field),
          value: values[field.name] ?? "",
          onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
            const value = event.target.value;
            setValues((current) => ({ ...current, [field.name]: value }));
            if (error) setEditedFields((current) => ({ ...current, [field.name]: true }));
          },
        };
        if (field.type !== "textarea") {
          return <Field key={field.name} appearance={appearance} label={field.label} error={error} {...props} type={field.type ?? "text"} />;
        }
        return (
          <div key={field.name} className="rp-field">
            <label htmlFor={inputId} className={cls("label")}>{field.label}</label>
            <textarea {...props} rows={5} id={inputId} className={cls("input")}
              aria-invalid={!!error || undefined} aria-describedby={error ? `${inputId}-error` : undefined} />
            {error && <p className="rp-field-error" id={`${inputId}-error`}>{error}</p>}
          </div>
        );
      })}
      {siteKey && (
        <>
          <Turnstile siteKey={siteKey} resetOn={state} onToken={setChallengeToken} />
          <input name="cf-turnstile-response" type="hidden" value={challengeToken} />
        </>
      )}
      <SubmitButton appearance={appearance} ready={ready && (!siteKey || !!challengeToken)}>{submitLabel}</SubmitButton>
      <div className="rp-public-form-status">
        <p role="status" className={pending ? "rp-public-form-pending" : state.status === "success" ? cls("notice") : undefined}>
          {pending ? "Sending your message…" : state.status === "success" ? state.message : ""}
        </p>
        <p role="alert" className={showError ? cls("alert") : undefined}>
          {showError ? state.message : ""}
        </p>
      </div>
    </form>
  );
}
