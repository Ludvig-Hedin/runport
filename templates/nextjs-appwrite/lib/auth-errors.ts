import "server-only";
import { AppwriteException } from "node-appwrite";

export const TOO_MANY_ATTEMPTS = "Too many attempts. Wait a few minutes and try again.";
export const INVALID_EMAIL = "Enter a valid email address.";
const UNREACHABLE = "Can't reach the server. Try again in a moment.";

/** Plain sentences for the Appwrite errors people actually run into. */
const PLAIN: Record<string, string> = {
  user_invalid_credentials: "Wrong email or password.",
  user_already_exists: "That email already has an account. Sign in instead.",
  user_email_already_exists: "That email already has an account. Sign in instead.",
  user_not_found: "This link has expired or is not valid. Ask for a new one.",
  user_invalid_token: "This link has expired or was already used. Ask for a new one.",
  user_password_recently_used: "Choose a password you haven't used before.",
  password_personal_data: "Choose a password that doesn't contain your name or email.",
  user_blocked: "This account is blocked. Contact the site owner.",
  user_password_reset_required: "You need to choose a new password. Use \"Forgot password?\" to get a link.",
  password_pwned: "That password has appeared in a data leak. Choose a different one.",
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmail(value: string): boolean {
  return EMAIL.test(value);
}

/** A short message for the person filling in the form. */
export function friendlyError(error: unknown, fallback: string): string {
  if (!(error instanceof AppwriteException)) {
    console.error(error);
    return UNREACHABLE;
  }
  if (error.code === 429) return TOO_MANY_ATTEMPTS;
  if (!error.code || error.code >= 500) return UNREACHABLE;
  const known = PLAIN[error.type];
  if (known) return known;
  // Appwrite's own wording reads like a system message, so show the
  // screen's own fallback and keep the detail in the server log.
  console.warn(`auth: ${error.type} ${error.message}`);
  return fallback;
}
