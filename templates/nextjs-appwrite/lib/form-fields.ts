export type FormField = {
  name: string;
  label: string;
  type?: "text" | "email" | "tel" | "textarea";
  required?: boolean;
  maxLength?: number;
  autoComplete?: string;
};

export type FormState = {
  status: "idle" | "error" | "success";
  message?: string;
  errors?: Record<string, string>;
  token?: string;
};

export const contactFields = [
  { name: "name", label: "Name", required: true, maxLength: 120, autoComplete: "name" },
  { name: "email", label: "Email", type: "email", required: true, maxLength: 254, autoComplete: "email" },
  { name: "message", label: "Message", type: "textarea", required: true, maxLength: 4000 },
] satisfies FormField[];

export const mailAddress = (value: string): boolean =>
  value.length <= 254 && /^[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d-]+(?:\.[a-z\d-]+)+$/i.test(value);

export function fieldLimit(field: FormField): number {
  return Math.min(field.maxLength ?? (field.type === "textarea" ? 4000 : 254), 4000);
}

export function validateFields(fields: readonly FormField[], data: FormData) {
  const values: Record<string, string> = Object.create(null);
  const errors: Record<string, string> = Object.create(null);
  for (const field of fields) {
    const entries = data.getAll(field.name);
    const raw = entries[0] ?? "";
    if (entries.length > 1 || typeof raw !== "string") {
      errors[field.name] = "Enter a single value.";
      continue;
    }
    const value = raw.trim();
    if (!value && field.required) errors[field.name] = "Fill in this field.";
    else if (value.length > fieldLimit(field)) errors[field.name] = `Use at most ${fieldLimit(field)} characters.`;
    else if (value && field.type === "email" && !mailAddress(value)) errors[field.name] = "Enter a valid email address.";
    else values[field.name] = field.type === "email" ? value.toLowerCase() : value;
  }
  return { values, errors };
}

export function looksLikeSpam(honeypot: FormDataEntryValue | null, values: readonly string[]): boolean {
  const text = values.join("\n");
  const links = text.match(/(?:https?:\/\/|www\.)[^\s]+/gi) ?? [];
  return Boolean(honeypot) || links.length > 3 || /(\S)\1{23}/u.test(text) || /<\/?(?:script|iframe)\b/i.test(text);
}
