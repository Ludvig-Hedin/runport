/**
 * An error whose message was written by us and is safe to show the owner.
 * Anything else that reaches a route is replaced by a fixed message, so
 * provider text (which can echo inputs or secrets) never leaves the server.
 */
export class SafeError extends Error {}

export function safeMessage(error: unknown, fallback = "Something went wrong. Nothing more was changed."): string {
  return error instanceof SafeError && error.message.length < 400 ? error.message : fallback;
}
