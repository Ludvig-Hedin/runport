import { config } from "./config";

/** Reads one secret from the macOS Keychain. Never logged or returned to the agent. */
export async function readSecret(account: string, service = config.keychainService): Promise<string> {
  const proc = Bun.spawn(["security", "find-generic-password", "-s", service, "-a", account, "-w"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) {
    throw new Error(
      `Keychain item "${account}" is missing. Add it once with: ` +
        `security add-generic-password -s ${service} -a ${account} -w`,
    );
  }
  return out.trim();
}

/**
 * Stores a secret in the Keychain without putting it in any process's
 * arguments: `security -i` reads its command from stdin.
 */
export async function writeSecret(account: string, value: string, service = config.keychainService): Promise<void> {
  if (!/^[\w.-]+$/.test(account) || !/^[\w.-]+$/.test(service)) throw new Error("Unsafe Keychain name.");
  if (/[\s"\\]/.test(value)) throw new Error("Refusing to store a secret with spaces, quotes or backslashes.");
  const proc = Bun.spawn(["security", "-i"], { stdin: new Blob([`add-generic-password -U -s ${service} -a ${account} -w "${value}"\n`]), stdout: "ignore", stderr: "ignore" });
  if ((await proc.exited) !== 0) throw new Error(`Could not store ${account} in the Keychain.`);
  const proc2 = Bun.spawn(["security", "find-generic-password", "-s", service, "-a", account, "-w"], { stdout: "pipe", stderr: "ignore" });
  if ((await new Response(proc2.stdout).text()).trim() !== value) throw new Error(`Keychain did not keep ${account}.`);
}
