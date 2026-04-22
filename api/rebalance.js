export const config = { maxDuration: 25 };

const UPSTASH_URL = process.env.KV_REST_API_URL;
const UPSTASH_TOK = process.env.KV_REST_API_TOKEN;

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

// ── PRICE ──────────────────────────────────────────────────
async function getLatestPrice(pos) {
  let cp = pos.currentPrice || pos.entryPrice || 0.5;
  if (pos.tokenId) {
    try {
      const r = await Promise.race([
        fetch(`https://clob.polymarket.com/midpoint?token_id=${pos.tokenId}`).then(r => r.json()),
        new Promise(r => setTimeout(() => r({ mid: null }), 3000))
      ]);
      if (r?.mid) cp = Math.max(0.01, Math.min(0.99, parseFloat(r.mid)));
      else cp = Math.max(0.01, Math.min(0.99, cp + (Math.random() - 0.5) * 0.06));
    } catch { cp = Math.max(0.01, Math.min(0.99, cp + (Math.random() - 0.5) * 0.06)); }
  } else {
    cp = Math.max(0.01, Math.min(0.99, cp + (Math.random() - 0.5) * 0.06));
  }
  return +cp.toFixed(4);
}

// ── POSITION DECISION ──────────────────────────────────────
function decide(botName, pos, timeLeftPct, cash) {
  if (pos.closed) return 'skip';
  const pnlPct  = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
  const roll    = Math.random();
  const hasCash = cash >= 100;

  // Final minutes — exit anything decisively
  if (timeLeftPct < 0.15) {
    if (pnlPct > 8  && roll > 0.45) return 'sell_all';
    if (pnlPct < -20 && roll > 0.40) return 'sell_all';
    return 'hold';
  }

  if (botName.includes('MOMENTUM')) {
    // Pyramids winners, cuts losers fast
    if (pnlPct < -12  && roll > 0.30) return 'sell_all';
    if (pnlPct >  60  && roll > 0.25) return 'sell_all';
    if (pnlPct >  28  && roll > 0.42) return 'sell_half';
    if (pnlPct >  14  && hasCash && roll > 0.58) return 'add';
    return 'hold';
  }
  if (botName.includes('CONTRARIAN')) {
    // Avg down (believes in reversion), exits fast on wins
    if (pnlPct >  20  && roll > 0.35) return 'sell_all';
    if (pnlPct >  10  && roll > 0.52) return 'sell_half';
    if (pnlPct < -42  && roll > 0.40) return 'sell_all';
    if (pnlPct < -15  && hasCash && roll > 0.60) return 'add'; // avg down
    return 'hold';
  }
  if (botName.includes('DEGEN')) {
    // Diamond hands, yolos more on runners
    if (pnlPct < -55  && roll > 0.50) return 'sell_all';
    if (pnlPct >  80  && roll > 0.38) return 'sell_half';
    if (pnlPct > 120  && roll > 0.28) return 'sell_all';
    if (pnlPct >  40  && hasCash && roll > 0.52) return 'add'; // yolo more
    return 'hold';
  }
  if (botName.includes('REVERSAL')) {
    // Exits as soon as reversal plays out
    if (pnlPct >  15  && roll > 0.38) return 'sell_all';
    if (pnlPct >   7  && roll > 0.52) return 'sell_half';
    if (pnlPct < -25  && roll > 0.40) return 'sell_all';
    return 'hold';
  }
  if (botName.includes('QUANT')) {
    // Tight systematic stops, most active rebalancer
    if (pnlPct >  12  && roll > 0.35) return 'sell_half';
    if (pnlPct >  26  && roll > 0.28) return 'sell_all';
    if (pnlPct < -10  && roll > 0.38) return 'sell_all';
    if (Math.abs(pnlPct) < 4 && hasCash && roll > 0.68) return 'add';
    return 'hold';
  }
  if (botName.includes('NARRATIVE')) {
    // Holds while narrative runs, exits when priced in
    if (pnlPct >  28  && roll > 0.38) return 'sell_half';
    if (pnlPct >  48  && roll > 0.30) return 'sell_all';
    if (pnlPct < -18  && roll > 0.42) return 'sell_all';
    if (pnlPct >  12  && hasCash && roll > 0.58) return 'add';
    return 'hold';
  }
  return 'hold';
}

// ── NEW BUY LOGIC ──────────────────────────────────────────
// ── AI BRAIN — asks Groq what to do with current positions ─
async function askBotToRebalance(botData, markets, timeLeftSec, totalDurSec) {
  const botName    = botData.name || '';
  const botStyle   = botData.style || '';
  const timeLeftPct = totalDurSec > 0 ? (timeLeftSec / totalDurSec * 100).toFixed(0) : '50';
  const openPos    = (botData.positions || []).filter(p => !p.closed);
  const cash       = +(botData.cash ?? 0);

  // Describe current positions to the AI
  const posDesc = openPos.map((p, i) => {
    const pnlPct = (((p.currentPrice - p.entryPrice) / p.entryPrice) * 100).toFixed(1);
    const pnl    = ((p.currentPrice - p.entryPrice) * p.shares).toFixed(2);
    return `[pos${i}] ${p.marketTitle} | ${p.optionName} | entry:${Math.round(p.entryPrice*100)}¢ now:${Math.round(p.currentPrice*100)}¢ | pnl:${pnl>0?'+':''}$${pnl} (${pnlPct}%) | allocated:$${p.allocation}`;
  }).join('\n');

  // Available markets to buy into
  const existingIds = new Set(openPos.map(p => p.marketId));
  const available = (markets || [])
    .filter(m => m?.id && !existingIds.has(m.id))
    .slice(0, 10)
    .map((m, i) => {
      const opts = (m.prices||[]).map(p => `${p.optionName}@${Math.round(p.priceFloat*100)}¢`).join(' | ');
      return `[new${i}] "${m.title}" — ${opts}`;
    }).join('\n');

  const prompt = `You are ${botName}.
${botStyle}

CURRENT PORTFOLIO — ${timeLeftPct}% of round remaining, cash available: $${cash.toFixed(2)}

YOUR OPEN POSITIONS:
${posDesc || 'none'}

AVAILABLE NEW MARKETS:
${available || 'none'}

Based on your strategy and current PnL, decide what to do RIGHT NOW.
For each open position decide: "hold", "sell", or "add" (add more cash to it).
If selling, choose ANY percentage 1-100. Examples: sell 25% to take small profits, sell 75% to de-risk, sell 100% to fully exit.
Optionally open 1-2 new positions from available markets if you see opportunity.
Be decisive. React to the numbers.

Return ONLY JSON:
{
  "positions": [
    {"posIndex": 0, "action": "hold|sell|add", "sellPercent": 100, "addAmount": 0}
  ],
  "newBuys": [
    {"marketIndex": 0, "optionIndex": 0, "allocation": 150}
  ]
}
sellPercent is 1-100. 100 = full exit, 50 = half, 25 = quarter etc. Only needed when action is "sell".
addAmount only needed when action is "add" (min $50).
newBuys can be empty array.`;

  try {
    const GROQ_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_KEY) return null;
    const resp = await Promise.race([
      fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model:       botData.model || 'llama-3.1-8b-instant',
          messages:    [{ role: 'user', content: prompt }],
          max_tokens:  400,
          temperature: 0.9
        })
      }).then(r => r.json()),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 7000))
    ]);

    const text  = resp.choices?.[0]?.message?.content || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch(e) { console.log('Groq rebalance:', e.message); }
  return null;
}

// ── REBALANCE ONE BOT ──────────────────────────────────────
async function rebalanceBot(botData, markets, timeLeftSec, totalDurSec) {
  if (!botData) return botData;

  const botName  = botData.name || '';
  let   cash     = +(botData.cash ?? 0);
  const activity = [...(botData.activity || [])];
  let   positions = [...(botData.positions || [])];
  const openPos  = positions.filter(p => !p.closed);

  // First update all prices
  await Promise.all(positions.map(async (pos, i) => {
    if (pos.closed) return;
    const newPrice     = await getLatestPrice(pos);
    positions[i]       = { ...pos, currentPrice: newPrice, pnl: +((newPrice - pos.entryPrice) * pos.shares).toFixed(2) };
  }));

  // Ask AI what to do
  const decision = await askBotToRebalance({ ...botData, positions, cash }, markets, timeLeftSec, totalDurSec);

  if (decision) {
  

    // Execute position actions
    const openPositions = positions.filter(p => !p.closed);
    (decision.positions || []).forEach(d => {
      const posIdx    = d.posIndex;
      const pos       = openPositions[posIdx];
      if (!pos) return;
      const globalIdx = positions.findIndex(p => p.marketId === pos.marketId && !p.closed);
      if (globalIdx === -1) return;

      const action   = d.action;
      const cp       = pos.currentPrice;

          if (action === 'sell') {
        const pct        = Math.max(1, Math.min(100, parseInt(d.sellPercent) || 100)) / 100;
        const soldShares = +(pos.shares * pct).toFixed(4);
        const proceeds   = +(cp * soldShares).toFixed(2);
        const realizedPnl = +((cp - pos.entryPrice) * soldShares).toFixed(2);
        cash = +(cash + proceeds).toFixed(2);

        const pctLabel = pct === 1 ? '' : ` ${Math.round(pct*100)}%`;
        const pnlStr   = (realizedPnl >= 0 ? '+' : '-') + '$' + Math.abs(realizedPnl).toFixed(2);
        activity.push({
          time: new Date().toISOString(), type: 'sell',
          text: `SOLD${pctLabel} ${(pos.marketTitle||'').slice(0,22)} ${pos.optionName} @ ${Math.round(cp*100)}¢  ${pnlStr}`,
          pnl: realizedPnl
        });

        if (pct >= 0.99) {
          // Full close
          positions[globalIdx] = { ...pos, closed: true, closedPrice: cp, closedAt: new Date().toISOString(), realizedPnl, pnl: realizedPnl };
        } else {
          // Partial — reduce shares and allocation proportionally
          const remShares = +(pos.shares * (1 - pct)).toFixed(4);
          const remAlloc  = +(pos.allocation * (1 - pct)).toFixed(2);
          positions[globalIdx] = { ...pos, shares: remShares, allocation: remAlloc, pnl: +((cp - pos.entryPrice) * remShares).toFixed(2) };
        }
      }
    });

        // Execute new buys — use same availableMarkets array that was sent to Groq
    const stillOpenIds     = new Set(positions.filter(p => !p.closed).map(p => p.marketId));
    const availableMarkets = (markets || []).filter(m => m?.id && !stillOpenIds.has(m.id)).slice(0, 10);

    (decision.newBuys || []).slice(0, 2).forEach(buy => {
      if (cash < 100) return;
      const openCount = positions.filter(p => !p.closed).length;
      if (openCount >= 5) return;
      const market = availableMarkets[parseInt(buy.marketIndex)];
      if (!market?.prices?.length) return;
      const oIdx   = parseInt(buy.optionIndex) || 0;
      const po     = market.prices.find(p => p.choiceIndex === oIdx) || market.prices[0];
      const cp     = Math.max(0.01, Math.min(0.99, po?.priceFloat ?? 0.5));
      const buyAmt = Math.max(100, Math.min(550, Math.min(cash, parseInt(buy.allocation) || 150)));
      if (buyAmt < 100 || cash < buyAmt) return;
      const shares = +(buyAmt / cp).toFixed(4);
      cash         = +(cash - buyAmt).toFixed(2);
      const newPos = {
        marketId:    market.id,
        marketTitle: market.title || 'Unknown',
        category:    market.category || 'general',
        tokenId:     po?.tokenId || null,
        optionIndex: oIdx,
        optionName:  po?.optionName || (oIdx === 0 ? 'Yes' : 'No'),
        allocation:  buyAmt,
        entryPrice:  +cp.toFixed(4),
        currentPrice:+cp.toFixed(4),
        shares,
        pnl:         0,
        isSimulated: !market.id || market.id.startsWith('cf'),
        reasoning:   'rebalance buy',
        boughtAt:    new Date().toISOString()
      };
      positions.push(newPos);
      // ← fixed: inline text instead of calling undefined msg()
      activity.push({
        time: new Date().toISOString(),
        type: 'buy',
        text: `BOUGHT ${(market.title||'').slice(0,22)} ${po?.optionName||'Yes'} @ ${Math.round(cp*100)}¢  $${buyAmt}`,
        pnl: 0
      });
    });
    
    } else {
    // Groq failed — fallback: randomly sell anything with >5% gain or <-8% loss
    console.log(`${botName}: Groq failed, running fallback decisions`);
    positions.forEach((pos, globalIdx) => {
      if (pos.closed) return;
      const pnlPct = ((pos.currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
      const roll   = Math.random();
      if (pnlPct > 5  && roll > 0.50) {
        const proceeds    = +(pos.currentPrice * pos.shares).toFixed(2);
        const realizedPnl = +((pos.currentPrice - pos.entryPrice) * pos.shares).toFixed(2);
        cash = +(cash + proceeds).toFixed(2);
        const pnlStr = (realizedPnl >= 0 ? '+' : '-') + '$' + Math.abs(realizedPnl).toFixed(2);
        activity.push({ time: new Date().toISOString(), type: 'sell', text: `SOLD ${(pos.marketTitle||'').slice(0,22)} ${pos.optionName} @ ${Math.round(pos.currentPrice*100)}¢  ${pnlStr}`, pnl: realizedPnl });
        positions[globalIdx] = { ...pos, closed: true, closedPrice: pos.currentPrice, closedAt: new Date().toISOString(), realizedPnl, pnl: realizedPnl };
      } else if (pnlPct < -8 && roll > 0.55) {
        const proceeds    = +(pos.currentPrice * pos.shares).toFixed(2);
        const realizedPnl = +((pos.currentPrice - pos.entryPrice) * pos.shares).toFixed(2);
        cash = +(cash + proceeds).toFixed(2);
        const pnlStr = '-$' + Math.abs(realizedPnl).toFixed(2);
        activity.push({ time: new Date().toISOString(), type: 'sell', text: `SOLD ${(pos.marketTitle||'').slice(0,22)} ${pos.optionName} @ ${Math.round(pos.currentPrice*100)}¢  ${pnlStr}`, pnl: realizedPnl });
        positions[globalIdx] = { ...pos, closed: true, closedPrice: pos.currentPrice, closedAt: new Date().toISOString(), realizedPnl, pnl: realizedPnl };
      }
    });
  }

  return { ...botData, positions, cash: +cash.toFixed(2), activity };
}

// ── HANDLER ────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const round = await dbGet('round');
    if (!round)        return res.json({ ok: false, reason: 'no round' });
    if (round.settled) return res.json({ ok: false, reason: 'settled' });

    const now         = Date.now();
    const endsAt      = new Date(round.ends_at).getTime();
    const startedAt   = new Date(round.started_at).getTime();
    const timeLeftSec = Math.max(0, Math.floor((endsAt - now) / 1000));
    const totalDurSec = Math.max(1, Math.floor((endsAt - startedAt) / 1000));
    const elapsed     = Math.floor((now - startedAt) / 1000);

    if (timeLeftSec < 30) return res.json({ ok: false, reason: 'too close to end' });
    if (elapsed < 60)     return res.json({ ok: false, reason: 'too early' });

    const markets = round.markets || [];
    const [ai1, ai2] = await Promise.all([
      rebalanceBot(round.ai1, markets, timeLeftSec, totalDurSec),
      rebalanceBot(round.ai2, markets, timeLeftSec, totalDurSec)
    ]);

    // Re-read round ID before saving to prevent race condition with new-round
const freshCheck = await dbGet('round');
if (!freshCheck || freshCheck.id !== round.id) {
  console.log('Round changed during rebalance — aborting save');
  return res.json({ ok: false, reason: 'round changed' });
}
await dbSet('round', { ...round, ai1, ai2, last_rebalanced: new Date().toISOString() });
    console.log(`Rebalanced | ${round.matchup} | ${timeLeftSec}s left | cash: $${ai1.cash} / $${ai2.cash}`);
    return res.json({ ok: true, timeLeftSec, ai1Cash: ai1.cash, ai2Cash: ai2.cash });
  } catch (err) {
    console.error('rebalance error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}