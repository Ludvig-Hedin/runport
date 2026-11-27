import "server-only";
import { randomUUID } from "node:crypto";
import { AppwriteException, type Models } from "node-appwrite";
import { config, createAdminClient } from "@/lib/appwrite";
import { linkLimitExceeded, looksLikeSpam, mailAddress, validateFields, type FormField, type FormState } from "@/lib/form-fields";
import { issueFormToken, verifyFormToken } from "@/lib/form-token";
import { allowed, take } from "@/lib/rate-limit";
import { DATABASE_ID, FORM_SUBMISSIONS_TABLE } from "@/lib/schema";
import { appName } from "@/runport.config";

const retry = "Your message could not be sent. Please try again.";
const slowDown = "Too many attempts. Please try again in a few minutes.";
const success = "Thanks. Your message was received.";
type FormResult = Omit<FormState, "token">;
const failure = (message: string): FormResult => ({ status: "error", message });

export function newFormToken(formId: string): string {
  return issueFormToken(formId, config.apiKey());
}

async function turnstilePassed(data: FormData): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  const siteKey = process.env.TURNSTILE_SITE_KEY;
  if (!secret && !siteKey) return true;
  const response = data.get("cf-turnstile-response");
  if (!secret || !siteKey || typeof response !== "string" || !response || response.length > 2048) return false;
  try {
    const result = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({ secret, response, idempotency_key: randomUUID() }),
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!result.ok) return false;
    const verification = await result.json();
    return verification.success === true && verification.action === "runport-form";
  } catch {
    return false;
  }
}

async function notifyOwner(fields: readonly FormField[], values: Record<string, string>): Promise<string> {
  const to = process.env.RUNPORT_FORM_OWNER_EMAIL?.trim();
  const url = process.env.RUNPORT_FORM_MAIL_URL;
  const token = process.env.RUNPORT_FORM_MAIL_TOKEN;
  const app = process.env.RUNPORT_FORM_MAIL_APP;
  const from = process.env.RUNPORT_FORM_MAIL_FROM;
  if (!to || !url || !token || !app || !from || !mailAddress(to)) return "unconfigured";

  try {
    const endpoint = new URL(url);
    if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && endpoint.hostname === "127.0.0.1")) {
      return "unconfigured";
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Runport-App": app,
      },
      body: JSON.stringify({
        to, from,
        subject: `Form submission for ${appName.replace(/\s+/g, " ").slice(0, 160)}`,
        text: fields.map(({ name, label }) => `${label}:\n${values[name]}`).join("\n\n"),
      }),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(9000),
    });
    if (response.status === 429) return "capped";
    return response.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}

export async function submitForm(formId: string, fields: readonly FormField[], data: FormData): Promise<FormState> {
  const key = config.apiKey();
  const value = data.get("_rp_token");
  const token = typeof value === "string" && verifyFormToken(value, formId, key) ? value : null;
  const result = await saveSubmission(formId, fields, data, token);
  // A retry receives a new nonce, while a valid form keeps the time the visitor
  // has already spent filling it in. The next message starts a new timer.
  const started = result.status === "error" && token ? Number(token.split(".")[0]) : undefined;
  return { ...result, token: issueFormToken(formId, key, started) };
}

async function saveSubmission(formId: string, fields: readonly FormField[], data: FormData, token: string | null): Promise<FormResult> {
  if (!await allowed("form")) return failure(slowDown);
  if (!token) return failure("Please wait a moment before sending again.");
  if (looksLikeSpam(data.get("_rp_extra"), [])) return failure(retry);

  const { errors, values } = validateFields(fields, data);
  if (Object.keys(errors).length) {
    return { ...failure("Check the highlighted fields and try again."), errors: { ...errors } };
  }

  const payload = JSON.stringify(values);
  if (Buffer.byteLength(payload) > 12000) return failure("Please shorten your message and try again.");
  if (looksLikeSpam(null, Object.values(values))) return failure(retry);
  if (linkLimitExceeded(Object.values(values))) return failure("Use at most three links, then try again.");
  const email = fields.find((field) => field.type === "email" && values[field.name]);
  if (email && !take(`form:email:${values[email.name]}`, 4, 60 * 60 * 1000)) return failure(slowDown);
  if (!await turnstilePassed(data)) return failure("Please complete the verification and try again.");

  const rowId = token.split(".")[1];
  const ids = { databaseId: DATABASE_ID, tableId: FORM_SUBMISSIONS_TABLE, rowId };
  const { tables } = createAdminClient();
  try {
    await tables.createRow({ ...ids, data: { formId, payload, notification: "pending" }, permissions: [] });
  } catch (error) {
    // A retry with the same signed token can only create one row and one email.
    if (error instanceof AppwriteException && error.code === 409 && error.type === "row_already_exists") {
      try {
        const existing = await tables.getRow<Models.Row & { formId: string; payload: string }>(ids);
        if (existing.formId === formId && existing.payload === payload) return { status: "success", message: success };
      } catch {
        console.warn("Runport form retry could not be checked");
      }
    }
    console.warn("Runport form storage failed", error instanceof AppwriteException ? error.type : undefined);
    return failure(retry);
  }

  const notification = await notifyOwner(fields, values);
  try {
    await tables.updateRow({ ...ids, data: { notification } });
  } catch {
    // The row was already saved. A failure here cannot turn it into a failed submission.
    console.warn("Runport form notification status could not be recorded");
  }
  return { status: "success", message: success };
}
