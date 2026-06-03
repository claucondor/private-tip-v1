/// Sign-derive MemoKey using the connected Flow Wallet.
///
/// FCL's signUserMessage returns a CompositeSignature[] from the wallet. We
/// concatenate signature bytes + send to a server route that runs the SDK's
/// deriveBabyJubKeypairFromBytes (HKDF-SHA256) and returns the keypair. We
/// route through the server because the SDK pulls heavy deps into the
/// client bundle.

export const DERIVE_MESSAGE = "openjanus-memokey-derive-v1";

/** Convert a UTF-8 string to a lowercase hex string without using Buffer. */
function utf8ToHex(s: string): string {
  const bytes = new TextEncoder().encode(s);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function deriveMemoKeyFromWallet(): Promise<{
  privkey: bigint;
  pubkey: { x: bigint; y: bigint };
}> {
  const fcl = await import("@onflow/fcl");
  // 1. Wallet signs the fixed message via FCL — pops up wallet UI.
  const msgHex = utf8ToHex(DERIVE_MESSAGE);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sigs: Array<{ signature: string }> = await (fcl as any).currentUser.signUserMessage(msgHex);
  if (!sigs || sigs.length === 0) {
    throw new Error("Wallet did not return a signature");
  }
  // 2. Concatenate all returned signatures into one byte blob — gives us
  // enough entropy regardless of weight scheme.
  const sigBytes: number[] = [];
  for (const cs of sigs) {
    const hex = cs.signature.startsWith("0x")
      ? cs.signature.slice(2)
      : cs.signature;
    for (let i = 0; i < hex.length; i += 2) {
      sigBytes.push(parseInt(hex.slice(i, i + 2), 16));
    }
  }
  // 3. Server route runs SDK's deriveBabyJubKeypairFromBytes.
  const res = await fetch("/api/memokey/derive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sigBytes }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(`deriveMemoKey server: ${err.error ?? res.statusText}`);
  }
  const data = await res.json();
  return {
    privkey: BigInt(data.privkey),
    pubkey: { x: BigInt(data.pubkey.x), y: BigInt(data.pubkey.y) },
  };
}
