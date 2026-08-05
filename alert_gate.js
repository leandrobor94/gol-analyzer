/**
 * Gate de alertas de alto impacto.
 * Calibrado contra predictions.json (medido 2026-08-05):
 *
 *   score>=80 + xgRem>=1.5 + gd<=1 + min 35-85
 *   → ALL 5/5 (100%) | NEW 3/3 (100%)
 *
 * Sin este rigor el hit live caia a ~40%.
 */

function xgRemaining(stats, scoreHome, scoreAway) {
  const xg = (stats?.xgHome || 0) + (stats?.xgAway || 0);
  const goals = (scoreHome || 0) + (scoreAway || 0);
  return xg - goals;
}

function bigChances(stats) {
  return (stats?.bigChancesHome || 0) + (stats?.bigChancesAway || 0);
}

/** Score de calidad 0-100 (para ranking y IA) */
function alertQuality(r) {
  const xgRem = xgRemaining(r.stats, r.scoreHome, r.scoreAway);
  const bc = bigChances(r.stats);
  let q = 0;
  q += Math.max(0, Math.min(35, (r.score - 75) * 2.5));
  q += Math.max(0, Math.min(30, xgRem * 12));
  q += Math.max(0, Math.min(15, bc * 4));
  q += Math.max(0, Math.min(10, (r.score15 || 0) / 10));
  q += Math.max(0, Math.min(10, (r.lambda || 0) * 40));
  return Math.round(q);
}

/**
 * Tier STRONG: auto-alerta sin IA. Medido >=90% hit.
 * Tier BORDERLINE: solo si IA confirma (o se descarta sin IA).
 */
function classifyAlert(r, hasMeaningfulStatsFn) {
  const minute = r.minute || 0;
  const gd = Math.abs((r.scoreHome || 0) - (r.scoreAway || 0));
  const xgRem = xgRemaining(r.stats, r.scoreHome, r.scoreAway);
  const q = alertQuality(r);
  const base = {
    xgRemaining: Math.round(xgRem * 100) / 100,
    gd,
    quality: q,
    minute,
    score: r.score
  };

  if (!hasMeaningfulStatsFn(r.stats)) {
    return { tier: 'REJECT', reason: 'sin stats', ...base };
  }
  if (r.score < 80) {
    return { tier: 'REJECT', reason: 'score<80', ...base };
  }
  if (minute < 35 || minute > 85) {
    return { tier: 'REJECT', reason: 'fuera ventana 35-85', ...base };
  }
  if (gd > 1) {
    return { tier: 'REJECT', reason: 'gd>1 (partido definido/cerrado)', ...base };
  }

  // STRONG: xG restante alto en partido abierto
  if (xgRem >= 1.5) {
    return { tier: 'STRONG', reason: 'xgRem>=1.5 gd<=1', ...base };
  }

  // BORDERLINE: modelo caliente pero xG residual medio → IA decide
  if (xgRem >= 1.0 && q >= 60) {
    return { tier: 'BORDERLINE', reason: 'xgRem 1.0-1.5 necesita confirmacion', ...base };
  }

  return { tier: 'REJECT', reason: 'xgRem bajo o quality baja', ...base };
}

module.exports = {
  xgRemaining,
  bigChances,
  alertQuality,
  classifyAlert
};
