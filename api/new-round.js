export const config = { maxDuration: 25 };

const GROQ_KEY    = process.env.GROQ_API_KEY;
const UPSTASH_URL = process.env.KV_REST_API_URL;
const UPSTASH_TOK = process.env.KV_REST_API_TOKEN;

// ── LitVM chain config ──────────────────────────────────────────────────
const LITVM_RPC   = 'https://liteforge.rpc.caldera.xyz/http';
const LITVM_CHAIN = 4441;

async function dbGet(key) {
  if (!UPSTASH_URL) return null;
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${UPSTASH_TOK}` } });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch { return null; }
}

async function dbSet(key, value) {
  if (!UPSTASH_URL) return;
  try {
    await fetch(
      `${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`,
      { headers: { Authorization: `Bearer ${UPSTASH_TOK}` } }
    );
  } catch {}
}

const GAMMA = 'https://gamma-api.polymarket.com';

async function fetchCategory(tag, limit = 10) {
  try {
    const url = `${GAMMA}/markets?active=true&closed=false&tag_slug=${tag}&limit=${limit}&sort_by=volume24h&ascending=false`;
    const r = await Promise.race([
      fetch(url, { headers: { Accept: 'application/json' } }),
      new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 5000))
    ]);
    const data = await r.json();
    return Array.isArray(data) ? data : (data.markets || data.data || []);
  } catch (e) { console.log(`fetchCategory ${tag}:`, e.message); return []; }
}

async function fetchTopVolume(limit = 15) {
  try {
    const url = `${GAMMA}/markets?active=true&closed=false&limit=${limit}&sort_by=volume24h&ascending=false`;
    const r = await Promise.race([
      fetch(url, { headers: { Accept: 'application/json' } }),
      new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 5000))
    ]);
    const data = await r.json();
    return Array.isArray(data) ? data : (data.markets || data.data || []);
  } catch (e) { console.log('fetchTopVolume:', e.message); return []; }
}

function parseGammaMarket(m) {
  if (!m) return null;
  let outcomes = m.outcomes || ['Yes','No'];
  if (typeof outcomes === 'string') { try { outcomes = JSON.parse(outcomes); } catch { outcomes = ['Yes','No']; } }
  if (!Array.isArray(outcomes)) outcomes = ['Yes','No'];

  let tokenIds = m.clobTokenIds || m.clob_token_ids || [];
  if (typeof tokenIds === 'string') { try { tokenIds = JSON.parse(tokenIds); } catch { tokenIds = []; } }

  let outcomePrices = m.outcomePrices || [];
  if (typeof outcomePrices === 'string') { try { outcomePrices = JSON.parse(outcomePrices); } catch { outcomePrices = []; } }

  const prices = outcomes.map((outcome, i) => {
    const cp = Math.max(0.01, Math.min(0.99, outcomePrices[i] ? parseFloat(outcomePrices[i]) : 0.5));
    return { choiceIndex: i, optionName: String(outcome), tokenId: tokenIds[i] || null, priceFloat: cp };
  });

  return {
    id:        m.conditionId || m.id || m.condition_id,
    title:     m.question    || m.title || m.name,
    category:  m.category    || m.tags?.[0]?.slug || 'general',
    volume24h: parseFloat(m.volume24hr || m.volumeNum || m.volume || 0),
    prices,
    tokens: outcomes.map((o, i) => ({ token_id: tokenIds[i] || null, outcome: String(o) }))
  };
}

async function getMarkets() {
  const nowUTC      = new Date();
  const roundStartM = nowUTC.getUTCHours() * 60 + nowUTC.getUTCMinutes();
  const roundEndM   = roundStartM + 20;

  const [m5, m15, m1h, m4h, mDaily] = await Promise.all([
    fetchCategory('5m',    30),
    fetchCategory('15m',   25),
    fetchCategory('1h',    20),
    fetchCategory('4h',    15),
    fetchCategory('daily', 15)
  ]);
  console.log(`Raw: 5m=${m5.length} 15m=${m15.length} 1h=${m1h.length} 4h=${m4h.length} daily=${mDaily.length}`);

  const COINS = ['bitcoin','btc','ethereum','eth','solana','sol','xrp','ripple','dogecoin','doge','bnb','binance','hype','hyperliquid'];
  const seen  = new Set();

  function parseTimeWindow(title) {
    const rangeMatch = (title||'').match(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/);
    if (rangeMatch) {
      return {
        startM: parseInt(rangeMatch[1]) * 60 + parseInt(rangeMatch[2]),
        endM:   parseInt(rangeMatch[3]) * 60 + parseInt(rangeMatch[4])
      };
    }
    const single = (title||'').match(/\bat\s+(\d{1,2}):(\d{2})/i);
    if (single) {
      const endM = parseInt(single[1]) * 60 + parseInt(single[2]);
      return { startM: endM - 5, endM };
    }
    return null;
  }

  function isLiveDuringRound(market) {
    const t = (market.title || '').toLowerCase();
    if (!COINS.some(c => t.includes(c))) return false;
    const isUpDown = t.includes('up') || t.includes('down') ||
                     t.includes('higher') || t.includes('lower') ||
                     t.includes('above')  || t.includes('below');
    if (!isUpDown) return false;
    const tw = parseTimeWindow(market.title);
    if (!tw) return true;
    let { startM, endM } = tw;
    if (endM < startM) endM += 1440;
    return startM < roundEndM && endM > roundStartM;
  }

  const all = [...m5, ...m15, ...m1h, ...m4h, ...mDaily]
    .map(parseGammaMarket)
    .filter(m => {
      if (!m?.id || !m?.title || seen.has(m.id)) return false;
      if (!isLiveDuringRound(m)) return false;
      seen.add(m.id);
      return true;
    })
    .sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0));

  console.log(`Live during round [${roundStartM}–${roundEndM} UTC min]: ${all.length} markets`);
  if (all.length >= 3) return { markets: all.slice(0, 40), source: 'polymarket' };
  return { markets: getCryptoFallback(), source: 'simulated' };
}

function getCryptoFallback() {
  const now  = new Date();
  const h    = now.getUTCHours();
  const m    = now.getUTCMinutes();
  const m5s  = Math.floor(m / 5) * 5;
  const m5e  = m5s + 5;
  const pad  = n => String(n).padStart(2, '0');
  const m15s = Math.floor(m / 15) * 15;
  const m15e = m15s + 15;
  const h4s  = Math.floor(h / 4) * 4;
  const h4e  = h4s + 4;

  const COINS_FB = [
    { name: 'Bitcoin',  sym: 'BTC',  tag: 'btc'  },
    { name: 'Ethereum', sym: 'ETH',  tag: 'eth'  },
    { name: 'Solana',   sym: 'SOL',  tag: 'sol'  },
    { name: 'XRP',      sym: 'XRP',  tag: 'xrp'  },
    { name: 'Dogecoin', sym: 'DOGE', tag: 'doge' },
    { name: 'BNB',      sym: 'BNB',  tag: 'bnb'  },
    { name: 'HYPE',     sym: 'HYPE', tag: 'hype' },
  ];

  const markets = [];
  let vol = 600000;

  COINS_FB.forEach(function(coin) {
    vol -= 20000;
    const up   = +(0.44 + Math.random() * 0.12).toFixed(2);
    const down = +(1 - up).toFixed(2);
    function mk(id, title, v) {
      return {
        id, title, category: 'crypto', volume24h: v,
        prices: [
          { choiceIndex:0, optionName:'Up',   priceFloat: up,   tokenId: null },
          { choiceIndex:1, optionName:'Down', priceFloat: down, tokenId: null }
        ],
        tokens: []
      };
    }
    markets.push(mk(`cf_${coin.tag}_5m`,    `${coin.name} Up or Down - 5 min  ${h}:${pad(m5s)}-${h}:${pad(m5e)} UTC`, vol));
    markets.push(mk(`cf_${coin.tag}_15m`,   `${coin.name} Up or Down - 15 min  ${h}:${pad(m15s)}-${h}:${pad(m15e)} UTC`, vol - 50000));
    markets.push(mk(`cf_${coin.tag}_1h`,    `${coin.name} Up or Down - 1 hour  ${h}:00-${h+1}:00 UTC`, vol - 100000));
    markets.push(mk(`cf_${coin.tag}_4h`,    `${coin.name} Up or Down - 4 hour  ${pad(h4s)}:00-${pad(h4e)}:00 UTC`, vol - 150000));
    markets.push(mk(`cf_${coin.tag}_daily`, `${coin.name} Up or Down - daily`, vol - 180000));
  });

  return markets;
}

const BOTS = [
  { id:'mixtral-8x7b-32768',    name:'NARRATIVE CHASER 📰', emoji:'📰', color:'#a855f7',
    style:'Follow hottest narratives on crypto Twitter and news. Pick markets matching trending topics. Be directional — LONG hot narratives, SHORT dying ones.' },
  { id:'mixtral-8x7b-32768',    name:'CONTRARIAN SHARK 🦈', emoji:'🦈', color:'#ef4444',
    style:'Always fade the crowd. If YES > 65%: buy NO. If YES < 30%: buy YES. At least 3 of 4 picks must go against consensus.' },
  { id:'llama-3.1-8b-instant',  name:'MOMENTUM RIDER 🚀',  emoji:'🚀', color:'#22c55e',
    style:'Pure momentum. Always bet on the LEADING option (higher price). Prefer high-volume markets. Concentrated portfolio, 3 picks max.' },
  { id:'gemma2-9b-it',          name:'DEGEN APE 🦍',        emoji:'🦍', color:'#ff6b00',
    style:'Maximum degen. ONLY pick longshots priced UNDER 20%. Moonshot only. 2-3 concentrated bets. Go big or go home.' },
  { id:'llama-3.1-8b-instant',  name:'REVERSAL HUNTER 🔄',  emoji:'🔄', color:'#f59e0b',
    style:'Catch mean reversion. Find options above 75% or below 20% — bet opposite. Everything reverts to 50/50.' },
  { id:'mixtral-8x7b-32768',    name:'QUANT MACHINE 🤖',   emoji:'🤖', color:'#00aaff',
    style:'Statistical diversification across 4-5 markets. Target 40-60% probability options — that\'s where mispricings live.' },
];

function isMarketLive(market, now = new Date()) {
  const title = market?.title || '';
  const rangeMatch = title.match(/(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/);
  const single = title.match(/\bat\s+(\d{1,2}):(\d{2})/i);
  let startM, endM;
  if (rangeMatch) {
    startM = parseInt(rangeMatch[1], 10) * 60 + parseInt(rangeMatch[2], 10);
    endM   = parseInt(rangeMatch[3], 10) * 60 + parseInt(rangeMatch[4], 10);
  } else if (single) {
    endM   = parseInt(single[1], 10) * 60 + parseInt(single[2], 10);
    startM = endM - 5;
  } else {
    return true;
  }
  let nowM = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (endM < startM) endM += 1440;
  if (nowM < startM && endM > 1440) nowM += 1440;
  return nowM >= startM && nowM < endM;
}

async function buildPortfolio(bot, markets) {
  const now = new Date();
  const liveMarkets = markets.filter(m => isMarketLive(m, now));
  const sourceMarkets = (liveMarkets.length ? liveMarkets : markets).slice(0, 15);

  const list = sourceMarkets.map((m, i) => {
    const opts = (m.prices || [])
      .map(p => `${p.optionName}@${p.priceFloat.toFixed(2)}`)
      .join(' | ');
    const vol = m.volume24h ? ` [vol:$${(m.volume24h / 1000).toFixed(0)}k]` : '';
    return `[${i}] [${m.category}] "${m.title}"${vol} — ${opts}`;
  }).join('\n');

  const prompt = `You are ${bot.name}.\n${bot.style}\n\nLIVE POLYMARKET CRYPTO MARKETS:\n${list}\n\nBudget: $1000.\n- marketIndex: 0 to ${Math.min(14, sourceMarkets.length - 1)}\n- optionIndex: 0 or 1\n- allocation: $100-$550, total ≤ $1000\n- picks: choose between 2 and 5 positions\n\nReturn ONLY JSON:\n{"strategy":"punchy one-liner max 15 words","picks":[{"marketIndex":0,"optionIndex":0,"allocation":300,"reasoning":"3-5 words"}]}`;

  let strategy = `${bot.name} enters the arena`;
  let picks = [];

  if (GROQ_KEY) {
    try {
      const resp = await Promise.race([
        fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: bot.id, messages: [{ role: 'user', content: prompt }], max_tokens: 350, temperature: 0.95 })
        }).then(r => r.json()),
        new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 8000))
      ]);
      if (!resp.error) {
        const text  = resp.choices?.[0]?.message?.content || '';
        const match = text.match(/\{[\s\S]*\}/);
        if (match) { const p = JSON.parse(match[0]); strategy = p.strategy || strategy; picks = p.picks || []; }
      }
    } catch(e) { console.log('Groq:', e.message); }
  }

  if (!picks.length) {
    const count = 2 + Math.floor(Math.random() * 4);
    const idxs  = [...Array(Math.min(15, sourceMarkets.length)).keys()].sort(() => Math.random() - .5).slice(0, count);
    picks = idxs.map(i => {
      const m = sourceMarkets[i];
      const yes = m.prices?.[0]?.priceFloat ?? .5;
      let opt   = Math.random() > .5 ? 0 : 1;
      if (bot.name.includes('CONTRARIAN')) opt = yes > .5 ? 1 : 0;
      if (bot.name.includes('DEGEN'))      opt = yes < .25 ? 0 : 1;
      if (bot.name.includes('MOMENTUM'))   opt = yes > .5 ? 0 : 1;
      if (bot.name.includes('REVERSAL'))   opt = yes > .65 ? 1 : (yes < .35 ? 0 : Math.random() > .5 ? 0 : 1);
      return { marketIndex: i, optionIndex: opt, allocation: 100 + Math.floor(Math.random() * 450), reasoning: 'fallback pick' };
    });
  }

  const rawTotal = picks.reduce((s, p) => s + Math.max(100, Math.min(550, parseInt(p.allocation) || 250)), 0);
  const scale    = rawTotal > 1000 ? 1000 / rawTotal : 1;

  const positions = picks.map(pick => {
    const m    = sourceMarkets[parseInt(pick.marketIndex)];
    if (!m?.id) return null;
    const oIdx  = parseInt(pick.optionIndex) || 0;
    const po    = (m.prices||[]).find(p => p.choiceIndex === oIdx) || (m.prices||[])[0];
    const cp    = Math.max(.01, Math.min(.99, po?.priceFloat ?? .5));
    const rawAlloc = Math.max(100, Math.min(550, parseInt(pick.allocation) || 250));
    const alloc = Math.floor(rawAlloc * scale);
    if (alloc < 50) return null;
    const shares = +(alloc / cp).toFixed(4);
    return {
      marketId:     m.id,
      marketTitle:  m.title || 'Unknown',
      category:     m.category || 'general',
      tokenId:      po?.tokenId || m.tokens?.[oIdx]?.token_id || null,
      optionIndex:  oIdx,
      optionName:   po?.optionName || (oIdx === 0 ? 'Yes' : 'No'),
      allocation:   alloc,
      entryPrice:   +cp.toFixed(4),
      currentPrice: +cp.toFixed(4),
      shares,
      pnl:          0,
      isSimulated:  !m.id || m.id.startsWith('cf'),
      reasoning:    pick.reasoning || ''
    };
  }).filter(Boolean);

  const activity = positions.map(p => ({
    time: new Date().toISOString(),
    type: 'buy',
    text: `BOUGHT ${(p.marketTitle||'').slice(0,22)} ${p.optionName} @ ${Math.round(p.entryPrice*100)}¢  $${p.allocation}`,
    pnl: 0
  }));

  if (!positions.length) {
    const idxs = [0, 1].map(i => Math.min(i, sourceMarkets.length - 1));
    idxs.forEach(i => {
      const m  = sourceMarkets[i];
      if (!m?.id) return;
      const po = m.prices?.[0];
      const cp = Math.max(0.01, Math.min(0.99, po?.priceFloat ?? 0.5));
      positions.push({
        marketId: m.id, marketTitle: m.title || 'Unknown',
        category: m.category || 'general',
        tokenId: po?.tokenId || null, optionIndex: 0,
        optionName: po?.optionName || 'Yes',
        allocation: 200, entryPrice: +cp.toFixed(4),
        currentPrice: +cp.toFixed(4),
        shares: +(200 / cp).toFixed(4),
        pnl: 0, isSimulated: true, reasoning: 'emergency fallback'
      });
    });
  }

  const totalSpent = positions.reduce((s, p) => s + p.allocation, 0);
  const cash = Math.max(0, +(1000 - totalSpent).toFixed(2));
  return { strategy, positions, activity, cash };
}

function calcValue(bot) {
  const cash   = bot.cash ?? 0;
  const posVal = (bot.positions || [])
    .filter(p => !p.closed)
    .reduce((s, p) => s + (p.shares || 0) * (p.currentPrice || p.entryPrice || 0), 0);
  return Math.max(0, +(cash + posVal).toFixed(2));
}

async function settle(prev) {
  // Close and settle on-chain round
  if (prev.bettingRoundId) {
    try {
      const { ethers } = await import('ethers');
      const provider = new ethers.JsonRpcProvider(LITVM_RPC);
      const wallet   = new ethers.Wallet(process.env.CONTRACT_OWNER_KEY, provider);
      const contract = new ethers.Contract(process.env.BATTLE_CONTRACT_ADDR, [
        'function closeRound(uint256 roundId) external',
        'function settleRound(uint256 roundId, uint8 winner) external',
        'function getRound(uint256 roundId) view returns (bool open, bool settled, uint8 winner, uint256 totalSide1, uint256 totalSide2, uint256 totalPool, uint256 feeAmount, string label)'
      ], wallet);

      const v1 = calcValue(prev.ai1);
      const v2 = calcValue(prev.ai2);
      const onChainWinner = v1 >= v2 ? 1 : 2;
      const rid = prev.bettingRoundId;

      const roundData = await contract.getRound(rid);
      if (roundData.open) {
        const closeTx = await contract.closeRound(rid, { gasLimit: 100000 });
        await closeTx.wait();
        console.log(`On-chain round ${rid} closed`);
      }
      if (!roundData.settled) {
        const settleTx = await contract.settleRound(rid, onChainWinner, { gasLimit: 100000 });
        await settleTx.wait();
        console.log(`On-chain round ${rid} settled, winner: ${onChainWinner}`);
      }
    } catch(e) { console.log('on-chain settle failed:', e.message); }
  }
}

// ── On-chain startRound on LitVM ────────────────────────────────────────
async function startOnChainRound(label) {
  const contractAddr = process.env.BATTLE_CONTRACT_ADDR;
  const ownerKey     = process.env.CONTRACT_OWNER_KEY;

  if (!contractAddr || !ownerKey) {
    console.log('Missing BATTLE_CONTRACT_ADDR or CONTRACT_OWNER_KEY');
    return null;
  }

  try {
    const { ethers } = await import('ethers');
    const provider = new ethers.JsonRpcProvider(LITVM_RPC);
    const wallet   = new ethers.Wallet(ownerKey, provider);
    const network  = await provider.getNetwork();
    console.log(`Chain: ${network.chainId}, addr: ${contractAddr.slice(0,10)}, keyLen: ${ownerKey.length}`);

    const contract = new ethers.Contract(contractAddr, [
      'function startRound(string calldata label) external returns (uint256)',
      'function nextRoundId() view returns (uint256)',
      'function closeRound(uint256 roundId) external',
      'function settleRound(uint256 roundId, uint8 winner) external',
      'function getRound(uint256 roundId) view returns (bool open, bool settled, uint8 winner, uint256 totalSide1, uint256 totalSide2, uint256 totalPool, uint256 feeAmount, string label)'
    ], wallet);

    // nextRoundId is the NEXT one to be created, so current = nextRoundId - 1
    const nextId = await contract.nextRoundId();
    const currentId = Number(nextId) - 1;

    // If there's an existing open round, close it first
    if (currentId >= 1) {
      try {
        const roundData = await contract.getRound(currentId);
        if (roundData.open) {
          console.log(`Closing stuck open round ${currentId}...`);
          const closeTx = await contract.closeRound(currentId, { gasLimit: 100000 });
          await closeTx.wait();
          console.log(`Round ${currentId} closed`);
        }
        if (!roundData.open && !roundData.settled) {
          console.log(`Settling round ${currentId}...`);
          const settleTx = await contract.settleRound(currentId, 1, { gasLimit: 100000 });
          await settleTx.wait();
          console.log(`Round ${currentId} settled`);
        }
      } catch(e) { console.log('cleanup failed:', e.message); }
    }

    console.log(`Starting new round with label: "${label}"`);
    const tx = await contract.startRound(label, { gasLimit: 300000 });
    const receipt = await tx.wait();
    console.log(`startRound tx: ${receipt.hash}`);

    // New round ID is what nextRoundId was before the call
    const newRoundId = Number(nextId);
    console.log(`bettingRoundId = ${newRoundId}`);
    return newRoundId;

  } catch(e) {
    console.log('startOnChainRound failed:', e.message);
    if (e.shortMessage) console.log('short:', e.shortMessage);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const prev = await dbGet('round');

    if (prev?.ai1?.positions?.length && !prev.settled) {
      await dbSet('round', { ...prev, settled: true });
      await settle(prev);
    }

    const scores   = await dbGet('scores') || { rounds: 0 };
    const roundNum = (scores.rounds || 0) + 1;

    const shuffled = [...BOTS].sort(() => Math.random() - .5);
    const b1 = shuffled[0], b2 = shuffled[1];

    const { markets, source } = await getMarkets();
    const p1 = await buildPortfolio(b1, markets);
    await new Promise(r => setTimeout(r, 1500));
    const p2 = await buildPortfolio(b2, markets);

    // ✅ Start on-chain round on LitVM BEFORE saving round state
    const bettingRoundId = await startOnChainRound(`${b1.name} vs ${b2.name}`);

    const round = {
      id: Date.now(),
      round_num: roundNum,
      started_at: new Date().toISOString(),
      ends_at: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
      matchup: `${b1.name} vs ${b2.name}`,
      data_source: source,
      markets_count: markets.length,
      markets: markets.slice(0, 40),
      bettingRoundId: bettingRoundId,  
      ai1: {
        name: b1.name, emoji: b1.emoji, color: b1.color, model: b1.id,
        strategy: p1.strategy, positions: p1.positions, activity: p1.activity, cash: p1.cash
      },
      ai2: {
        name: b2.name, emoji: b2.emoji, color: b2.color, model: b2.id,
        strategy: p2.strategy, positions: p2.positions, activity: p2.activity, cash: p2.cash
      }
    };

    await dbSet('round', round);

    return res.status(200).json({
      ok: true, round_num: roundNum, matchup: round.matchup,
      data_source: source, markets_loaded: markets.length,
      ends_at: round.ends_at, bettingRoundId
    });
  } catch(err) {
    console.error('CRASH:', err.message);
    return res.status(500).json({ error: err.message });
  }
}