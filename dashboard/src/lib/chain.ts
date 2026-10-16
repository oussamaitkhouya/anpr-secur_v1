/*
 * Hash chain + Ed25519 signatures for evidence and audit records, using WebCrypto only.
 *
 *   hash_i = sha256(prevHash_i + "\n" + canonicalJson(payload_i)),  prevHash_1 = GENESIS
 *   signature_i = Ed25519_sign(privateKey, utf8(hash_i))
 *
 * A record passes when (1) its hash recomputes from its own content, (2) its prevHash equals
 * the previous record's hash, and (3) its signature verifies with the public key.
 * Editing any record breaks (1) for that record; deleting or reordering breaks (2).
 */

export const GENESIS = "0".repeat(64);

/** JSON with object keys sorted, so the same content always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const encoder = new TextEncoder();

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function linkHash(prevHash: string, payload: unknown): Promise<string> {
  return sha256Hex(`${prevHash}\n${canonicalJson(payload)}`);
}

// ---- Ed25519 -------------------------------------------------------------------------

export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** In-memory signing key for the demo. Returns null where the runtime lacks Ed25519. */
export async function generateSigningKey(): Promise<{ keyPair: CryptoKeyPair; publicKeyB64: string } | null> {
  try {
    const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
    const raw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
    return { keyPair, publicKeyB64: toBase64(raw) };
  } catch {
    return null;
  }
}

export async function sign(privateKey: CryptoKey, hash: string): Promise<string> {
  return toBase64(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, encoder.encode(hash)));
}

export async function importPublicKey(publicKeyB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromBase64(publicKeyB64), { name: "Ed25519" }, false, ["verify"]);
}

export async function verifySignature(publicKey: CryptoKey, hash: string, signatureB64: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify({ name: "Ed25519" }, publicKey, fromBase64(signatureB64), encoder.encode(hash));
  } catch {
    return false;
  }
}

// ---- verification --------------------------------------------------------------------

export interface ChainRecord {
  id: string;
  seq: number;
  payload: unknown;
  prevHash: string;
  hash: string;
  signature?: string | null;
}

export interface LinkResult {
  id: string;
  seq: number;
  hashOk: boolean; // content still matches its hash
  linkOk: boolean; // prevHash points at the previous record
  signatureOk: boolean | null; // null = no key or no signature to check
  ok: boolean;
}

export interface ChainResult {
  links: LinkResult[];
  ok: boolean;
  broken: number;
  firstBreakSeq: number | null;
}

/** Verify records in seq order. Without a public key, signatures are reported as unchecked. */
export async function verifyChain(records: ChainRecord[], publicKeyB64: string | null): Promise<ChainResult> {
  const key = publicKeyB64 ? await importPublicKey(publicKeyB64).catch(() => null) : null;
  const sorted = [...records].sort((a, b) => a.seq - b.seq);
  const links: LinkResult[] = [];
  let expectedPrev = GENESIS;
  for (const r of sorted) {
    const hashOk = (await linkHash(r.prevHash, r.payload)) === r.hash;
    const linkOk = r.prevHash === expectedPrev;
    const signatureOk = key && r.signature ? await verifySignature(key, r.hash, r.signature) : null;
    links.push({ id: r.id, seq: r.seq, hashOk, linkOk, signatureOk, ok: hashOk && linkOk && signatureOk !== false });
    expectedPrev = r.hash;
  }
  const brokenLinks = links.filter((l) => !l.ok);
  return { links, ok: brokenLinks.length === 0, broken: brokenLinks.length, firstBreakSeq: brokenLinks[0]?.seq ?? null };
}
