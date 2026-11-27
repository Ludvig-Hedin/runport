import "server-only";
import { AppwriteException } from "node-appwrite";

export const TOO_MANY_ATTEMPTS = "Too many attempts. Wait a few minutes and try again.";
export const INVALID_EMAIL = "Enter a valid email address.";
const UNREACHABLE = "Can't reach the server. Try again in a moment.";

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
  return error.message || fallback;
}
