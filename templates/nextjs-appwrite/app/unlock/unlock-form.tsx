import { FormMessage, field, primaryButton } from "../auth-ui";

export function UnlockForm({ next, error }: { next: string; error?: string }) {
  return (
    <form method="post" action="/unlock/submit" className="flex flex-col gap-3">
      <input type="hidden" name="next" value={next} />
      <input
        name="password"
        type="password"
        required
        autoFocus
        placeholder="Password"
        autoComplete="current-password"
        className={field}
      />
      <FormMessage error={error} />
      <button className={primaryButton}>Unlock</button>
    </form>
  );
}
