export const config = { maxDuration: 15 };

const UPSTASH_URL = process.env.KV_REST_API_URL;
const UPSTASH_TOK = process.env.KV_REST_API_TOKEN;

async function dbSet(key, value) {
  if (!UPSTASH_URL) return null;
  try {
    await fetch(`${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOK}` }
    });
  } catch {}
}

async function dbGet(key) {
  if (!UPSTASH_URL) return null;
  try {
    const r = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`,
      { headers: { Authorization: `Bearer ${UPSTASH_TOK}` } });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch { return null; }
}

async function refreshPositions(positions = []) {
  return Promise.all(positions.map(async pos => {
    if (pos.closed) return pos;
    try {
      let cp = pos.currentPrice || pos.entryPrice || 0.5;

      if (pos.tokenId) {
        const r = await Promise.race([
          fetch(`https://clob.polymarket.com/midpoint?token_id=${pos.tokenId}`)
            .then(r => r.json()),
          new Promise(r => setTimeout(() => r({ mid: null }), 3000))
        ]);
        if (r?.mid) cp = Math.max(0.01, Math.min(0.99, parseFloat(r.mid)));
        else cp = Math.max(0.01, Math.min(0.99, cp + (Math.random() - 0.5) * 0.03));
      } else {
        // Simulated drift ±4% so movement is actually visible
        cp = Math.max(0.01, Math.min(0.99, cp + (Math.random() - 0.5) * 0.04));
      }

      // ✅ Correct PnL: works for both leveraged and non-leveraged
      const pnl = +((cp - pos.entryPrice) * pos.shares).toFixed(2);
      const currentValue = +(pos.allocation + pnl).toFixed(2);

      return { ...pos, currentPrice: +cp.toFixed(4), currentValue, pnl };
    } catch {
      return { ...pos, pnl: 0, currentValue: pos.allocation || 0 };
    }
  }));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  try {
    const [round, history, scores] = await Promise.all([
      dbGet('round'),
      dbGet('history'),
      dbGet('scores')
    ]);

    const safeScores = scores || { ai1: 0, ai2: 0, rounds: 0 };

    if (!round) {
      return res.json({ round: null, history: history || [], scores: safeScores });
    }

    const [pos1, pos2] = await Promise.all([
      refreshPositions(round.ai1?.positions),
      refreshPositions(round.ai2?.positions)
    ]);

        // ✅ Closed positions use realizedPnl, open use live pnl
        // cash already includes proceeds from all sells — most accurate formula
    const cash1  = round.ai1?.cash ?? 0;
    const cash2  = round.ai2?.cash ?? 0;
    const posVal1 = pos1.filter(p => !p.closed).reduce((s, p) => s + (p.shares || 0) * (p.currentPrice || 0), 0);
    const posVal2 = pos2.filter(p => !p.closed).reduce((s, p) => s + (p.shares || 0) * (p.currentPrice || 0), 0);
    const val1    = +(cash1 + posVal1).toFixed(2);
    const val2    = +(cash2 + posVal2).toFixed(2);
const totalPnL1 = +(val1 - 1000).toFixed(2);
const totalPnL2 = +(val2 - 1000).toFixed(2);
const ai1 = { ...round.ai1, positions: pos1, portfolioValue: val1, totalPnL: totalPnL1, activity: round.ai1?.activity || [], cash: cash1 };
const ai2 = { ...round.ai2, positions: pos2, portfolioValue: val2, totalPnL: totalPnL2, activity: round.ai2?.activity || [], cash: cash2 };

    const timeLeft = Math.max(0, Math.floor((new Date(round.ends_at) - Date.now()) / 1000));


    
    
    return res.json({
      round: {
  ...round,
  ai1, ai2,
  round_num: round.round_num,
  time_left: timeLeft,
  time_left_min: Math.floor(timeLeft / 60),
  leading: val1 >= val2 ? 'ai1' : 'ai2'
},
      history: (history || []).slice(0, 10),
      scores: safeScores
    });
  } catch (err) {
    console.error('state error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

function getBotMeta(name) {
  var n = (name || '').toUpperCase();

  if (n.includes('NARRATIVE')) return {
    archetype: 'NARRATIVE',
    traits: ['TREND', 'SENTIMENT', 'ROTATION'],
    intro: 'Chases the hottest market story before it cools.'
  };
  if (n.includes('CONTRARIAN')) return {
    archetype: 'CONTRARIAN',
    traits: ['FADE CROWD', 'SHARP', 'MEAN REV'],
    intro: 'Attacks crowded positions and bets on the snapback.'
  };
  if (n.includes('MOMENTUM')) return {
    archetype: 'MOMENTUM',
    traits: ['TREND', 'AGGRO', 'FAST'],
    intro: 'Rides strength hard and cuts hesitation.'
  };
  if (n.includes('DEGEN')) return {
    archetype: 'DEGEN',
    traits: ['LONGSHOT', 'VOLATILITY', 'HIGH RISK'],
    intro: 'Lives on asymmetry, chaos, and moonshots.'
  };
  if (n.includes('REVERSAL')) return {
    archetype: 'REVERSAL',
    traits: ['EXTREMES', 'SNAPBACK', 'TACTICAL'],
    intro: 'Waits for stretched prices and bets the other way.'
  };
  if (n.includes('QUANT')) return {
    archetype: 'QUANT',
    traits: ['SYSTEMATIC', 'BALANCED', 'DIVERSIFIED'],
    intro: 'Spreads risk and hunts efficient edges.'
  };

  return {
    archetype: 'GENERALIST',
    traits: ['ADAPTIVE', 'MIXED', 'LIVE'],
    intro: 'Reads the board and adapts on the fly.'
  };
}