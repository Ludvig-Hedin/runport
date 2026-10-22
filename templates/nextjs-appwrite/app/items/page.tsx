import { redirect } from "next/navigation";
import { Query, type Models } from "node-appwrite";
import { createSessionClient } from "@/lib/appwrite";
import { getUser } from "@/lib/session";
import { signOut } from "@/lib/auth";
import { DATABASE_ID } from "@/lib/schema";
import { addItem, deleteItem, toggleItem } from "./actions";

type Item = Models.Row & { title: string; done: boolean };

export default async function ItemsPage() {
  const user = await getUser();
  if (!user) redirect("/login");

  const { tables } = await createSessionClient();
  const { rows } = await tables.listRows<Item>({
    databaseId: DATABASE_ID,
    tableId: "items",
    queries: [Query.orderDesc("$createdAt"), Query.limit(100)],
  });

  return (
    <main className="mx-auto flex max-w-lg flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Items</h1>
        <form action={signOut}>
          <button className="text-sm underline">Sign out {user.name || user.email}</button>
        </form>
      </header>

      <form action={addItem} className="flex gap-2">
        <input
          name="title"
          required
          placeholder="New item"
          className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button className="rounded-md bg-neutral-900 px-3 py-2 font-medium text-white dark:bg-neutral-100 dark:text-neutral-900">
          Add
        </button>
      </form>

      {rows.length === 0 ? (
        <p className="text-neutral-500">Nothing here yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-neutral-200 dark:divide-neutral-800">
          {rows.map((item) => (
            <li key={item.$id} className="flex items-center gap-3 py-2">
              <form action={toggleItem.bind(null, item.$id, !item.done)}>
                <button aria-label={item.done ? "Mark as not done" : "Mark as done"} className="size-5 rounded border border-neutral-400">
                  {item.done ? "✓" : ""}
                </button>
              </form>
              <span className={item.done ? "flex-1 text-neutral-400 line-through" : "flex-1"}>{item.title}</span>
              <form action={deleteItem.bind(null, item.$id)}>
                <button className="text-sm text-neutral-500 underline">Delete</button>
              </form>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
