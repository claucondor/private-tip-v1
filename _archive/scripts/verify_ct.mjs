import { JsonRpcProvider, Interface } from "ethers";
const PROXY = "0x025efe7e89acdb8F315C804BE7245F348AA9c538";
const p = new JsonRpcProvider("https://testnet.evm.nodes.onflow.org", 545);
const iface = new Interface([
  "function nonce(address) view returns (uint256)",
  "function hasPubkey(address) view returns (bool)",
  "function locked(address) view returns (uint256)",
]);
const accounts = {
  alice: "0x000000000000000000000002b7557ee5d4a32d06",
  // try to fetch COA addresses on the fly via Cadence too
};
for (const [name, addr] of Object.entries(accounts)) {
  const lk = await p.call({ to: PROXY, data: iface.encodeFunctionData("locked", [addr]) });
  const hp = await p.call({ to: PROXY, data: iface.encodeFunctionData("hasPubkey", [addr]) });
  const nc = await p.call({ to: PROXY, data: iface.encodeFunctionData("nonce", [addr]) });
  console.log(name, addr, "locked=", iface.decodeFunctionResult("locked", lk)[0].toString(), "hasPk=", iface.decodeFunctionResult("hasPubkey", hp)[0], "nonce=", iface.decodeFunctionResult("nonce", nc)[0].toString());
}
