import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const MIN_AGE = 1500;
const MAX_AGE = 24 * 60 * 60 * 1000;
const signature = (body: string, form: string, key: string) =>
  createHmac("sha256", key).update(`runport-form:${form}:${body}`).digest("hex");

export function issueFormToken(form: string, key: string, now = Date.now()): string {
  const body = `${now}.${randomBytes(16).toString("hex")}`;
  return `${body}.${signature(body, form, key)}`;
}

export function verifyFormToken(token: string, form: string, key: string, now = Date.now()): boolean {
  if (!/^\d{1,16}\.[a-f0-9]{32}\.[a-f0-9]{64}$/.test(token)) return false;
  const [issued, nonce, signed] = token.split(".");
  const age = now - Number(issued);
  return age >= MIN_AGE && age <= MAX_AGE &&
    timingSafeEqual(Buffer.from(signed, "hex"), Buffer.from(signature(`${issued}.${nonce}`, form, key), "hex"));
}
