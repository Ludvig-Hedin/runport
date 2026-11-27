import { connection } from "next/server";
import type { Appearance } from "@/components/auth/appearance";
import { contactFields, type FormField, type FormState } from "@/lib/form-fields";
import { newFormToken, submitForm } from "@/lib/form-submission";
import { PublicFormControls } from "./public-form-controls";

type PublicFormProps = {
  id: string;
  fields: readonly FormField[];
  submitLabel?: string;
  appearance?: Appearance;
};

export async function PublicForm({ id, fields, submitLabel = "Send", appearance }: PublicFormProps) {
  if (!/^[a-z0-9-]{1,64}$/.test(id) || !fields.length || fields.length > 12 ||
      new Set(fields.map((field) => field.name)).size !== fields.length ||
      fields.some((field) => !/^[a-z][a-z0-9_-]{0,63}$/.test(field.name) ||
        field.name === "constructor" || field.name === "prototype" ||
        (field.maxLength !== undefined && (!Number.isInteger(field.maxLength) || field.maxLength < 1)))) {
    throw new Error("Give the form a unique ID and 1–12 fields with unique names and valid lengths.");
  }
  await connection();
  // The schema is captured on the server. Submitted data cannot change the fields or destination.
  async function submit(_previous: FormState, data: FormData) {
    "use server";
    return submitForm(id, fields, data);
  }

  return (
    <PublicFormControls
      action={submit}
      fields={fields}
      initialToken={newFormToken(id)}
      siteKey={process.env.TURNSTILE_SITE_KEY}
      submitLabel={submitLabel}
      appearance={appearance}
    />
  );
}

export function ContactForm({ fields = contactFields, ...props }: Partial<PublicFormProps> = {}) {
  return <PublicForm id="contact" submitLabel="Send message" {...props} fields={fields} />;
}
