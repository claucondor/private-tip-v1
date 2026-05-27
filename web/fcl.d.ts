// Ambient module declaration for @onflow/fcl — the package ships no types.
// Cast to `any` lets callers continue using the dynamic FCL surface.
declare module "@onflow/fcl" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fcl: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export = fcl;
}
