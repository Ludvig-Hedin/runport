"use server";

import { revalidatePath } from "next/cache";
import { ID } from "node-appwrite";
import { createSessionClient } from "@/lib/appwrite";
import { ownerData } from "@/lib/owner";
import { DATABASE_ID } from "@/lib/schema";

const TABLE = { databaseId: DATABASE_ID, tableId: "items" };

export async function addItem(form: FormData): Promise<void> {
  const title = String(form.get("title") ?? "").trim();
  if (!title) return;
  const { tables } = await createSessionClient();
  const { data, permissions } = await ownerData();
  await tables.createRow({ ...TABLE, rowId: ID.unique(), data: { ...data, title, done: false }, permissions });
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
