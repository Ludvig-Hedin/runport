export async function requireConfirmedDelivery(response: Response): Promise<void> {
  if (!response.ok) throw new Error(`Alert mail failed (HTTP ${response.status}).`);
  const receipt = await response.json().catch(() => null) as { sent?: unknown; failed?: unknown } | null;
  if (receipt?.sent !== 1 || receipt.failed !== 0) {
    throw new Error("Alert mail delivery was not confirmed by the Worker.");
  }
}
