// Gives a Railway service its own address, for example todo.runport.app:
// Publishes a routing CNAME before registration, then applies Railway's exact records.
// Run from anywhere:
//   bun src/custom-domain.ts <domain> <service> <port> <railway-linked folder>
// Needs a Cloudflare API token with "Edit zone DNS" for the zone, stored once:
//   security add-generic-password -s runport-prod -a cloudflare-dns-token -w
// Without it nothing is registered: Railway asks for a certificate the moment
// a domain exists, and failed attempts before DNS is in place lock the name out
// at Let's Encrypt for an hour or more.
// Safe to rerun: existing records with the right value are left alone.

import { Resolver } from "node:dns/promises";

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
const zoneId = zone.id;

type Wanted = { dnsRecords: { recordType: string; fqdn: string; requiredValue: string }[]; token?: string; dnsHost?: string };
type RailwayDomain = { domain: string; type: "service" | "custom"; targetPort: number | null };

const lookupDns = (r: Pick<DnsRecord, "type" | "name">) =>
  api<{ id: string; content: string; proxied?: boolean }[]>(`/zones/${zoneId}/dns_records?type=${r.type}&name=${r.name}`);

async function writeDns(r: DnsRecord, existingId?: string): Promise<void> {
  const body = JSON.stringify({ ...r, ttl: 1, proxied: false });
  if (existingId) await api(`/zones/${zoneId}/dns_records/${existingId}`, { method: "PUT", body });
  else await api(`/zones/${zoneId}/dns_records`, { method: "POST", body });
  console.log(`${existingId ? "updated" : "created"}  ${r.type} ${r.name}`);
}

async function railwayRecords(): Promise<Wanted> {
  const { domains } = JSON.parse(await railway(["domain", "list", "--service", service, "--json"])) as { domains: RailwayDomain[] };
  if (domains.some((candidate) => candidate.domain === domain && candidate.type === "custom")) {
    const { domain: status } = JSON.parse(await railway(["domain", "status", domain, "--service", service, "--json"]));
    return { dnsRecords: status.dnsRecords, token: status.verification?.token, dnsHost: status.verification?.dnsHost };
  }

  // Railway returns the domain-specific target and verification TXT after
  // registration. Before that, publish the service's own Railway CNAME.
  const route = { type: "CNAME" as const, name: domain };
  const [existing] = await lookupDns(route);
  const available = domains.find((entry) => entry.type === "service" && (entry.targetPort === Number(port) || entry.targetPort === null));
  if (existing && (!available || existing.content !== available.domain || existing.proxied)) {
    throw new Error(`DNS for ${domain} already points elsewhere. Nothing was registered.`);
  }
  const target = available?.domain ?? (JSON.parse(await railway(
    ["domain", "--service", service, "--port", port, "--json"],
  )) as { domain: string }).domain?.replace(/^https:\/\//, "");
  if (!target?.endsWith(".up.railway.app")) throw new Error("Railway did not supply a service domain. Nothing was registered.");
  if (!existing) await writeDns({ ...route, content: target });
  // Query an external resolver so a local cached NXDOMAIN does not stall setup.
  const resolver = new Resolver({ timeout: 2_000, tries: 1 });
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  for (let attempt = 0; attempt < 20; attempt++) {
    const published = await resolver.resolveCname(domain).catch(() => []);
    if (published.some((name) => name.replace(/\.$/, "") === target)) {
      const created = JSON.parse(await railway(["domain", domain, "--service", service, "--port", port, "--json"])).customDomainCreate.status;
      return { dnsRecords: created.dnsRecords, token: created.verificationToken, dnsHost: created.verificationDnsHost };
    }
    await Bun.sleep(3_000);
  }
  throw new Error(`The CNAME for ${domain} hasn't propagated yet. Nothing was registered. Retry when DNS resolves.`);
}
const wanted = await railwayRecords();
const records: DnsRecord[] = [
  ...wanted.dnsRecords.map((r): DnsRecord => ({ type: r.recordType.endsWith("CNAME") ? "CNAME" : "TXT", name: r.fqdn, content: r.requiredValue })),
  ...(wanted.token && wanted.dnsHost ? [{ type: "TXT" as const, name: `${wanted.dnsHost}.${zoneName}`, content: wanted.token }] : []),
];

// 2. Cloudflare: create or fix each record.
for (const r of records) {
  const existing = await lookupDns(r);
  const quoted = r.type === "TXT" ? `"${r.content}"` : r.content;
  const same = existing.find((e) => !e.proxied && (e.content === r.content || e.content === quoted));
  if (same) {
    console.log(`ok       ${r.type} ${r.name}`);
    continue;
  }
  // Railway needs the record unproxied to issue its certificate.
  await writeDns(r, existing[0]?.id);
}
console.log(`DNS set. Railway issues the certificate for https://${domain} within a few minutes.`);
