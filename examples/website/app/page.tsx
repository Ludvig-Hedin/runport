import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex max-w-lg flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Runport test website</h1>
      <p>A small website for checking pages, links and the site password.</p>
      <nav className="flex gap-4">
        <Link className="underline" href="/about">About</Link>
      </nav>
    </main>
  );
}
