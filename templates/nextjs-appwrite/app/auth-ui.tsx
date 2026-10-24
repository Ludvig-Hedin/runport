// Shared look for the sign-in, reset and unlock screens.

export const field =
  "w-full rounded-md border border-neutral-300 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900";

export const primaryButton =
  "rounded-md bg-neutral-900 px-3 py-2 font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900";

export const secondaryButton =
  "rounded-md border border-neutral-300 px-3 py-2 font-medium disabled:opacity-50 dark:border-neutral-700";

export function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 p-6">
      <h1 className="text-2xl font-semibold">{title}</h1>
      {children}
    </main>
  );
}

export function FormMessage({ error, notice }: { error?: string; notice?: string }) {
  if (error) return <p role="alert" className="text-sm text-red-600">{error}</p>;
  if (notice) return <p role="status" className="text-sm text-neutral-600 dark:text-neutral-400">{notice}</p>;
  return null;
}
