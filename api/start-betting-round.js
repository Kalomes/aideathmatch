export const config = { maxDuration: 15 };

const OWNER_KEY = process.env.CONTRACT_OWNER_KEY;
const CONTRACT  = process.env.BATTLE_CONTRACT_ADDR;

const ABI = [
  'function startRound()',
  'function getCurrentRoundId() view returns (uint256)'
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { ethers } = await import('ethers');
    const provider = new ethers.JsonRpcProvider('https://liteforge.rpc.caldera.xyz/http');
    const wallet   = new ethers.Wallet(OWNER_KEY, provider);
    const contract = new ethers.Contract(CONTRACT, ABI, wallet);

    const tx      = await contract.startRound({ gasLimit: 300000 });
    await tx.wait();
    const roundId = await contract.getCurrentRoundId();
    return res.json({ ok: true, bettingRoundId: Number(roundId) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}