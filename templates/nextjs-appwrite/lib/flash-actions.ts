"use server";

import { cookies } from "next/headers";

/** Removes the one-off message once it has been shown, so a reload does not repeat it. */
export async function clearFlash(): Promise<void> {
  (await cookies()).delete("rp_flash");
}
