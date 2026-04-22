import { ethers } from 'ethers';

const USDAI_ADDR = '0x6127ea36Dc821044635Bec25AE384Ab92E059f69';
const ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)'
];
const AMOUNT = ethers.parseUnits('100', 18);
const claimed = new Set();

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { address } = req.body || {};
  if (!address || !ethers.isAddress(address)) {
    return res.json({ ok: false, error: 'bad address' });
  }
  if (claimed.has(address.toLowerCase())) {
    return res.json({ ok: false, error: 'already claimed' });
  }
  try {
    const provider = new ethers.JsonRpcProvider('https://liteforge.rpc.caldera.xyz/http');
    const wallet   = new ethers.Wallet(process.env.CONTRACT_OWNER_KEY, provider);
    const token    = new ethers.Contract(USDAI_ADDR, ABI, wallet);
    const tx       = await token.transfer(address, AMOUNT);
    await tx.wait();
    claimed.add(address.toLowerCase());
    return res.json({ ok: true });
  } catch(e) {
    return res.json({ ok: false, error: e.shortMessage || e.message });
  }
}