/** Runs a command and returns stdout. Throws with stderr on a non-zero exit. */
export async function run(cmd: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd[0]} ${cmd[1] ?? ""} failed: ${err.trim() || out.trim()}`);
  return out.trim();
}

export async function succeeds(cmd: string[], cwd?: string): Promise<boolean> {
  try {
    await run(cmd, cwd);
    return true;
  } catch {
    return false;
  }
}
