// /api/tick.js  — call this every 3-4 min via Vercel cron
export const config = { maxDuration: 25 };

const GROQ_KEY    = process.env.GROQ_API_KEY;
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

// Simulate price drift on existing positions
function driftPrices(positions) {
  return positions.map(p => {
    if (p.closed) return p;
    const drift = (Math.random() - 0.48) * 0.04; // slight upward bias
    const newPrice = Math.max(0.02, Math.min(0.97, p.currentPrice + drift));
    const pnl = +((newPrice - p.entryPrice) * p.shares).toFixed(2);
    return { ...p, currentPrice: +newPrice.toFixed(4), pnl };
  });
}

// Ask the bot whether to sell any positions or open new ones
async function midRoundDecision(bot, positions, cash, markets) {
  const now = new Date();
  const openPositions = positions.filter(p => !p.closed);
  const newActivity = [];

  // ── SELL LOGIC ──────────────────────────────────────────
  const afterSell = openPositions.map(p => {
    const pnlPct = ((p.currentPrice - p.entryPrice) / p.entryPrice) * 100;
    let shouldSell = false;
    let reason = '';

    if (bot.name.includes('MOMENTUM') && pnlPct < -12) { shouldSell = true; reason = 'stop loss'; }
    if (bot.name.includes('REVERSAL') && pnlPct > 18)  { shouldSell = true; reason = 'take profit'; }
    if (bot.name.includes('DEGEN')    && pnlPct < -20) { shouldSell = true; reason = 'blow up'; }
    if (bot.name.includes('QUANT')    && Math.abs(pnlPct) > 22) { shouldSell = true; reason = 'rebalance'; }
    if (pnlPct < -30) { shouldSell = true; reason = 'stop loss'; } // universal hard stop

    if (shouldSell) {
      const saleValue = +(p.shares * p.currentPrice).toFixed(2);
      cash += saleValue;
      newActivity.push({
        time: new Date().toISOString(),
        type: 'sell',
        text: `SOLD ${(p.marketTitle||'').slice(0,22)} ${p.optionName} @ ${Math.round(p.currentPrice*100)}¢  $${saleValue.toFixed(0)} (${reason})`,
        pnl: p.pnl
      });
      return { ...p, closed: true, closedPrice: p.currentPrice };
    }
    return p;
  });

  // ── BUY LOGIC ────────────────────────────────────────────
  // Only buy mid-round if bot has cash and not too many open positions
  const stillOpen = afterSell.filter(p => !p.closed).length;
  const maxPositions = bot.name.includes('MOMENTUM') ? 3 : bot.name.includes('DEGEN') ? 2 : 5;
  const minCashToBuy = 120;

  if (cash >= minCashToBuy && stillOpen < maxPositions && markets?.length) {
    // Find markets bot doesn't already have a position in
    const heldIds = new Set(afterSell.filter(p => !p.closed).map(p => p.marketId));
    const available = markets.filter(m => !heldIds.has(m.id)).slice(0, 10);

    if (available.length > 0 && GROQ_KEY) {
      try {
        const list = available.map((m, i) => {
          const opts = (m.prices||[]).map(p => `${p.optionName}@${p.priceFloat.toFixed(2)}`).join(' | ');
          return `[${i}] "${(m.title||'').slice(0,60)}" — ${opts}`;
        }).join('\n');

        const prompt = `You are ${bot.name}. ${bot.style}
You have $${cash.toFixed(0)} cash. You already have ${stillOpen} open positions.
Should you open a NEW position mid-round? Here are available markets:
${list}

If YES: return JSON with ONE pick: {"buy":true,"marketIndex":0,"optionIndex":0,"allocation":150,"reasoning":"5 words max"}
If NO:  return JSON: {"buy":false}
Return ONLY valid JSON.`;

        const BOTS_REF = {
          'NARRATIVE CHASER 📰': { id: 'mixtral-8x7b-32768' },
          'CONTRARIAN SHARK 🦈': { id: 'mixtral-8x7b-32768' },
          'MOMENTUM RIDER 🚀':   { id: 'llama-3.1-8b-instant' },
          'DEGEN APE 🦍':         { id: 'gemma2-9b-it' },
          'REVERSAL HUNTER 🔄':  { id: 'llama-3.1-8b-instant' },
          'QUANT MACHINE 🤖':    { id: 'mixtral-8x7b-32768' },
        };
        const modelId = BOTS_REF[bot.name]?.id || 'llama-3.1-8b-instant';

        const resp = await Promise.race([
          fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: modelId,
              messages: [{ role: 'user', content: prompt }],
              max_tokens: 120,
              temperature: 0.9
            })
          }).then(r => r.json()),
          new Promise((_,rej) => setTimeout(() => rej(new Error('timeout')), 6000))
        ]);

        if (!resp.error) {
          const text  = resp.choices?.[0]?.message?.content || '';
          const match = text.match(/\{[\s\S]*\}/);
          if (match) {
            const decision = JSON.parse(match[0]);
            if (decision.buy && decision.marketIndex !== undefined) {
              const m   = available[parseInt(decision.marketIndex)];
              const oIdx = parseInt(decision.optionIndex) || 0;
              const po   = (m?.prices||[]).find(p => p.choiceIndex === oIdx) || m?.prices?.[0];
              const cp   = Math.max(0.02, Math.min(0.97, po?.priceFloat ?? 0.5));
              const alloc = Math.min(cash, Math.max(100, Math.min(400, parseInt(decision.allocation) || 150)));
              const shares = +(alloc / cp).toFixed(4);

              afterSell.push({
                marketId: m.id, marketTitle: m.title || 'Unknown',
                category: m.category || 'general',
                tokenId: po?.tokenId || null,
                optionIndex: oIdx, optionName: po?.optionName || 'Yes',
                allocation: alloc, entryPrice: +cp.toFixed(4),
                currentPrice: +cp.toFixed(4), shares, pnl: 0,
                isSimulated: !m.id || m.id.startsWith('cf'),
                reasoning: decision.reasoning || 'mid-round buy'
              });
              cash = +(cash - alloc).toFixed(2);
              newActivity.push({
                time: new Date().toISOString(),
                type: 'buy',
                text: `MID-ROUND BUY ${(m.title||'').slice(0,22)} ${po?.optionName||'Yes'} @ ${Math.round(cp*100)}¢  $${alloc}`,
                pnl: 0
              });
            }
          }
        }
      } catch(e) { console.log('mid-round buy AI call:', e.message); }
    }
  }

  return { positions: afterSell, cash: +cash.toFixed(2), newActivity };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const round = await dbGet('round');
    if (!round || round.settled) {
      return res.status(200).json({ ok: false, reason: 'no active round' });
    }

    // Check if round is past end time
    const endsAt = new Date(round.ends_at);
    if (new Date() > endsAt) {
      return res.status(200).json({ ok: false, reason: 'round ended' });
    }

    // Get current markets for potential mid-round buys
    let markets = [];
    try {
      const stateData = await dbGet('markets_cache');
      if (stateData) markets = stateData;
    } catch {}

    const BOTS_MAP = {
      'NARRATIVE CHASER 📰': { name:'NARRATIVE CHASER 📰', style:'Follow hottest narratives on crypto Twitter and news.' },
      'CONTRARIAN SHARK 🦈': { name:'CONTRARIAN SHARK 🦈', style:'Always fade the crowd. If YES > 65%: buy NO.' },
      'MOMENTUM RIDER 🚀':   { name:'MOMENTUM RIDER 🚀',   style:'Pure momentum. Always bet on the LEADING option.' },
      'DEGEN APE 🦍':         { name:'DEGEN APE 🦍',         style:'Maximum degen. ONLY pick longshots priced UNDER 20%.' },
      'REVERSAL HUNTER 🔄':  { name:'REVERSAL HUNTER 🔄',  style:'Catch mean reversion.' },
      'QUANT MACHINE 🤖':    { name:'QUANT MACHINE 🤖',    style:'Statistical diversification across 4-5 markets.' },
    };

    // Process both bots
    for (const key of ['ai1', 'ai2']) {
      const ai = round[key];
      if (!ai) continue;
      const bot = BOTS_MAP[ai.name] || { name: ai.name, style: 'Trade adaptively.' };

      // Drift prices on existing positions
      ai.positions = driftPrices(ai.positions || []);

      // Mid-round decisions (sell bad / buy new)
      const result = await midRoundDecision(bot, ai.positions, ai.cash ?? 0, markets);
      ai.positions = result.positions;
      ai.cash      = result.cash;
      ai.activity  = [...(ai.activity || []), ...result.newActivity].slice(-30);

      // Recalculate portfolio value
      const posVal = ai.positions
        .filter(p => !p.closed)
        .reduce((s, p) => s + (p.shares||0) * (p.currentPrice||0), 0);
      ai.portfolioValue = +(ai.cash + posVal).toFixed(2);
      ai.totalPnL       = +(ai.portfolioValue - 1000).toFixed(2);
    }

    await dbSet('round', round);
    return res.status(200).json({ ok: true, tick: new Date().toISOString() });
  } catch(e) {
    console.error('tick error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}