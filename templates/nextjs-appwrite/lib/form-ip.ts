import { isIP } from "node:net";

export function formIpBucket(address: string): string {
  const ip = address.split("%")[0];
  const version = isIP(ip);
  if (version !== 6) return version === 4 ? ip : "unknown";

  const canonical = new URL(`http://[${ip}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(canonical);
  if (mapped) {
    const high = parseInt(mapped[1], 16);
    const low = parseInt(mapped[2], 16);
    return [high >> 8, high & 255, low >> 8, low & 255].join(".");
  }
  const [start, end] = canonical.split("::");
  const leading = start ? start.split(":") : [];
  const trailing = end ? end.split(":") : [];
  const groups = end === undefined ? leading : [
    ...leading, ...Array<string>(8 - leading.length - trailing.length).fill("0"), ...trailing,
  ];
  return `${groups.slice(0, 4).join(":")}::/64`;
}
