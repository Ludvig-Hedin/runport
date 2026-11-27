"use client";

import { useActionState, useId, useState } from "react";
import { type Appearance, resolveAppearance } from "@/components/auth/appearance";
import { SubmitButton } from "@/components/auth/controls";
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
  const { cls, style } = resolveAppearance(appearance);
  const [values, setValues] = useState<Record<string, string>>({});
  const [state, submit, pending] = useActionState(action, { status: "idle" } satisfies FormState);
  const [lastState, setLastState] = useState(state);
  const [challengeToken, setChallengeToken] = useState("");
  if (state !== lastState) {
    setLastState(state);
    setChallengeToken("");
    if (state.status === "success") setValues({});
  }
  const ready = fields.every((field) => !field.required || values[field.name]?.trim());

  return (
    <form action={submit} style={style} className={`${cls("root")} ${cls("form")} rp-public-form`} aria-busy={pending}>
      <input name="_rp_token" type="hidden" value={state.token ?? initialToken} />
      <div hidden>
        <label htmlFor={`${id}-extra`}>Leave this field empty</label>
        <input name="_rp_extra" id={`${id}-extra`} tabIndex={-1} autoComplete="off" />
      </div>
      {fields.map((field) => {
        const inputId = `${id}-${field.name}`;
        const error = state.errors?.[field.name];
        const props = {
          id: inputId, name: field.name, required: field.required, readOnly: pending,
          autoComplete: field.autoComplete, maxLength: fieldLimit(field), className: cls("input"),
          value: values[field.name] ?? "",
          onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
            const value = event.target.value;
            setValues((current) => ({ ...current, [field.name]: value }));
          },
          "aria-invalid": error ? true : undefined,
          "aria-describedby": error ? `${inputId}-error` : undefined,
        };
        return (
          <div key={field.name} className="rp-field">
            <label htmlFor={inputId} className={cls("label")}>{field.label}</label>
            {field.type === "textarea" ? <textarea {...props} rows={5} /> : <input {...props} type={field.type ?? "text"} />}
            {error && <p className="rp-public-field-error" id={`${inputId}-error`}>{error}</p>}
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
        <p role="status" className={pending ? cls("notice") : state.status === "success" ? cls("notice") : undefined}>
          {pending ? "Sending your message…" : state.status === "success" ? state.message : ""}
        </p>
        <p role="alert" className={!pending && state.status === "error" ? cls("alert") : undefined}>
          {!pending && state.status === "error" ? state.message : ""}
        </p>
      </div>
    </form>
  );
}
