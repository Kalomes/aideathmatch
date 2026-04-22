export const config = { maxDuration: 15 };

const UPSTASH_URL = process.env.KV_REST_API_URL;
const UPSTASH_TOK = process.env.KV_REST_API_TOKEN;
const RPC_URL     = process.env.ARBITRUM_RPC_URL;      // add to Vercel env
const OWNER_KEY   = process.env.CONTRACT_OWNER_KEY;    // add to Vercel env
const CONTRACT    = process.env.BATTLE_CONTRACT_ADDR;  // add to Vercel env

const ABI = [
  'function startRound() returns (uint256)',
  'function settle(uint256 roundId, uint8 winner)'
];

async function dbGet(key) {
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${UPSTASH_TOK}` } });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { ethers } = await import('ethers');
    const provider   = new ethers.JsonRpcProvider(RPC_URL);
    const wallet     = new ethers.Wallet(OWNER_KEY, provider);
    const contract   = new ethers.Contract(CONTRACT, ABI, wallet);

    const round  = await dbGet('round');
    if (!round)  return res.json({ ok: false, reason: 'no round' });

    const v1     = round.ai1?.portfolioValue || 1000;
    const v2     = round.ai2?.portfolioValue || 1000;
    const winner = v1 >= v2 ? 1 : 2;

    const tx = await contract.settle(round.bettingRoundId, winner);
    await tx.wait();

    return res.json({ ok: true, winner, tx: tx.hash });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}