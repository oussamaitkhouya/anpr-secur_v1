import { describe, expect, it } from "vitest";
import { canonicalJson, generateSigningKey, GENESIS, linkHash, sha256Hex, sign, verifyChain, type ChainRecord } from "./chain";

async function buildChain(n: number) {
  const key = await generateSigningKey();
  const records: ChainRecord[] = [];
  let prevHash = GENESIS;
  for (let seq = 1; seq <= n; seq++) {
    const payload = { seq, readId: `rd-${seq}`, capturedAt: `2026-10-08T10:0${seq}:00.000Z` };
    const hash = await linkHash(prevHash, payload);
    records.push({ id: `ev-${seq}`, seq, payload, prevHash, hash, signature: key ? await sign(key.keyPair.privateKey, hash) : null });
    prevHash = hash;
  }
  return { records, publicKey: key?.publicKeyB64 ?? null };
}

describe("canonicalJson", () => {
  it("is independent of key order and skips undefined", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: undefined }] })).toBe(canonicalJson({ a: [2, { d: 3 }], b: 1 }));
  });
});

describe("sha256Hex", () => {
  it("matches the standard test vector", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("verifyChain", () => {
  it("accepts an untouched chain, signatures included", async () => {
    const { records, publicKey } = await buildChain(5);
    const result = await verifyChain(records, publicKey);
    expect(result.ok).toBe(true);
    expect(result.links.every((l) => l.hashOk && l.linkOk)).toBe(true);
    if (publicKey) expect(result.links.every((l) => l.signatureOk === true)).toBe(true);
  });

  it("pinpoints a record whose content was edited after signing", async () => {
    const { records, publicKey } = await buildChain(5);
    records[2] = { ...records[2], payload: { ...(records[2].payload as object), capturedAt: "2026-10-08T09:51:00.000Z" } };
    const result = await verifyChain(records, publicKey);
    expect(result.ok).toBe(false);
    expect(result.broken).toBe(1);
    expect(result.firstBreakSeq).toBe(3);
    expect(result.links[2].hashOk).toBe(false);
  });

  it("detects a deleted record through the broken link", async () => {
    const { records, publicKey } = await buildChain(5);
    const result = await verifyChain(records.filter((r) => r.seq !== 2), publicKey);
    expect(result.ok).toBe(false);
    expect(result.firstBreakSeq).toBe(3);
    expect(result.links.find((l) => l.seq === 3)?.linkOk).toBe(false);
  });

  it("detects a re-hashed forgery through the signature", async () => {
    const { records, publicKey } = await buildChain(3);
    if (!publicKey) return; // runtime without Ed25519: nothing to check
    const forged = { ...records[2], payload: { forged: true } };
    forged.hash = await linkHash(forged.prevHash, forged.payload); // attacker can recompute the hash...
    const result = await verifyChain([records[0], records[1], forged], publicKey);
    expect(result.links[2].hashOk).toBe(true);
    expect(result.links[2].signatureOk).toBe(false); // ...but cannot sign without the private key
    expect(result.ok).toBe(false);
  });
});
