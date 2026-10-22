"use server";

import { revalidatePath } from "next/cache";
import { ID } from "node-appwrite";
import { createSessionClient } from "@/lib/appwrite";
import { DATABASE_ID } from "@/lib/schema";

const TABLE = { databaseId: DATABASE_ID, tableId: "items" };

// The session client acts as the signed-in user. New rows get that user's
// permissions by default, so nobody else can read or change them.

export async function addItem(form: FormData): Promise<void> {
  const title = String(form.get("title") ?? "").trim();
  if (!title) return;
  const { tables } = await createSessionClient();
  await tables.createRow({ ...TABLE, rowId: ID.unique(), data: { title, done: false } });
  revalidatePath("/items");
}

export async function toggleItem(rowId: string, done: boolean): Promise<void> {
  const { tables } = await createSessionClient();
  await tables.updateRow({ ...TABLE, rowId, data: { done } });
  revalidatePath("/items");
}

export async function deleteItem(rowId: string): Promise<void> {
  const { tables } = await createSessionClient();
  await tables.deleteRow({ ...TABLE, rowId });
  revalidatePath("/items");
}
