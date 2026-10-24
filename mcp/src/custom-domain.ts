// Gives a Railway service its own address, for example todo.runport.app:
// registers it on Railway, then creates the DNS records in Cloudflare.
// Run from anywhere:
//   bun src/custom-domain.ts <domain> <service> <port> <railway-linked folder>
// Needs a Cloudflare API token with "Edit zone DNS" for the zone, stored once:
//   security add-generic-password -s runport-prod -a cloudflare-dns-token -w
// Without it nothing is registered: Railway asks for a certificate the moment
// a domain exists, and failed attempts before DNS is in place lock the name out
// at Let's Encrypt for an hour or more.
// Safe to rerun: existing records with the right value are left alone.

export {};

type DnsRecord = { type: "CNAME" | "TXT"; name: string; content: string };

const args = process.argv.slice(2);
if (args.length !== 4 || args.some((a) => !a)) throw new Error("Usage: bun src/custom-domain.ts <domain> <service> <port> <folder>");
const [domain, service, port, folder] = args as [string, string, string, string];
if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) throw new Error(`"${domain}" is not a plain host name.`);

async function railway(args: string[]): Promise<string> {
  const proc = Bun.spawn(["railway", ...args], { cwd: folder, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`railway ${args[0]} failed: ${(err || out).trim()}`);
  return out;
}

async function keychain(account: string): Promise<string | null> {
  const proc = Bun.spawn(["security", "find-generic-password", "-s", "runport-prod", "-a", account, "-w"], { stdout: "pipe", stderr: "ignore" });
  const out = (await new Response(proc.stdout).text()).trim();
  return (await proc.exited) === 0 && out ? out : null;
}

// 0. Cloudflare access first, so the domain is never registered without DNS.
const token = await keychain("cloudflare-dns-token");
if (!token) throw new Error("No Cloudflare DNS token in the Keychain (runport-prod / cloudflare-dns-token). Add it first; nothing was registered.");
const zoneName = domain.split(".").slice(-2).join(".");

const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  const body = (await res.json()) as { success: boolean; result: T; errors: { message: string }[] };
  if (!body.success) throw new Error(`Cloudflare: ${body.errors.map((e) => e.message).join("; ")}`);
  return body.result;
};

const [zone] = await api<{ id: string }[]>(`/zones?name=${zoneName}`);
if (!zone) throw new Error(`Zone ${zoneName} is not reachable with the DNS token. Nothing was registered.`);

// 1. Railway: create the domain, or read it back when it already exists.
type Wanted = { dnsRecords: { recordType: string; fqdn: string; requiredValue: string }[]; token?: string; dnsHost?: string };
async function railwayRecords(): Promise<Wanted> {
  const status = await railway(["domain", "status", domain, "--service", service, "--json"]).then(
    (out) => JSON.parse(out).domain as { dnsRecords: Wanted["dnsRecords"]; verification?: { token: string; dnsHost: string } },
    () => null,
  );
  if (status) return { dnsRecords: status.dnsRecords, token: status.verification?.token, dnsHost: status.verification?.dnsHost };
  const created = JSON.parse(await railway(["domain", domain, "--service", service, "--port", port, "--json"])).customDomainCreate.status;
  return { dnsRecords: created.dnsRecords, token: created.verificationToken, dnsHost: created.verificationDnsHost };
}
const wanted = await railwayRecords();
const records: DnsRecord[] = [
  ...wanted.dnsRecords.map((r): DnsRecord => ({ type: r.recordType.endsWith("CNAME") ? "CNAME" : "TXT", name: r.fqdn, content: r.requiredValue })),
  ...(wanted.token && wanted.dnsHost ? [{ type: "TXT" as const, name: `${wanted.dnsHost}.${zoneName}`, content: wanted.token }] : []),
];

// 2. Cloudflare: create or fix each record.
for (const r of records) {
  const existing = await api<{ id: string; content: string }[]>(`/zones/${zone.id}/dns_records?type=${r.type}&name=${r.name}`);
  const quoted = r.type === "TXT" ? `"${r.content}"` : r.content;
  const same = existing.find((e) => e.content === r.content || e.content === quoted);
  if (same) {
    console.log(`ok       ${r.type} ${r.name}`);
    continue;
  }
  // Railway needs the record unproxied to issue its certificate.
  const body = JSON.stringify({ type: r.type, name: r.name, content: r.content, ttl: 1, proxied: false });
  if (existing[0]) await api(`/zones/${zone.id}/dns_records/${existing[0].id}`, { method: "PUT", body });
  else await api(`/zones/${zone.id}/dns_records`, { method: "POST", body });
  console.log(`${existing[0] ? "updated" : "created"}  ${r.type} ${r.name}`);
}
console.log(`DNS set. Railway issues the certificate for https://${domain} within a few minutes.`);
