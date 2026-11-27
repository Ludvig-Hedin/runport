import Link from "next/link";

export default function About() {
  return (
    <main className="mx-auto flex max-w-lg flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">About this test</h1>
      <p>This page uses the same Next.js starter as Runport apps.</p>
      <Link className="underline" href="/">Home</Link>
    </main>
  );
}
