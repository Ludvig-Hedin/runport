import { config } from "./config";

/** Reads one secret from the macOS Keychain. Never logged or returned to the agent. */
export async function readSecret(account: string): Promise<string> {
  const proc = Bun.spawn(["security", "find-generic-password", "-s", config.keychainService, "-a", account, "-w"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) {
    throw new Error(
      `Keychain item "${account}" is missing. Add it once with: ` +
        `security add-generic-password -s ${config.keychainService} -a ${account} -w`,
    );
  }
  return out.trim();
}
