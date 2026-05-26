// Ambient module declarations for packages that lack TypeScript definitions

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare module "circomlibjs" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function buildBabyjub(): Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function buildPoseidon(): Promise<any>;
}

declare module "snarkjs" {
  export const groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasmPath: string,
      zkeyPath: string
    ): Promise<{ proof: unknown; publicSignals: string[] }>;
    verify(
      vkey: unknown,
      publicSignals: string[],
      proof: unknown
    ): Promise<boolean>;
  };
}
