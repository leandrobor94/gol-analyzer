const fs = require('fs');
const p = JSON.parse(fs.readFileSync('predictions.json', 'utf8'));

const retros = [];

function exists(matchName) {
  return p.some(x => x.match && x.match.includes(matchName) && x.predictedProbability >= 70);
}

// Helper to build retro entry
function retro(match, teamHome, teamAway, minute, scoreH, scoreA, prob, finalH, finalA, league) {
  const goalAfter = !(finalH === null || finalA === null) && (finalH !== scoreH || finalA !== scoreA);
  const correct = finalH === null ? null : ((prob >= 70 && goalAfter) || (prob < 70 && !goalAfter));
  return {
    id: null,
    match,
    league: league || match.toLowerCase().replace(/\s+/g, '-'),
    teamHome,
    teamAway,
    timestamp: new Date().toISOString(),
    analysisMinute: minute,
    scoreAtAnalysis: { home: scoreH, away: scoreA },
    predictedProbability: prob,
    predictedScorer: null,
    predictedTimeWindow: prob >= 70 ? 'Dentro de los proximos 8-12 min' : 'Temprano, revaluar en 15-20 min',
    finalScore: finalH !== null ? { home: finalH, away: finalA } : null,
    goalAfterAnalysis: finalH !== null ? goalAfter : null,
    actualGoalMinute: null,
    actualScorer: null,
    predictionCorrect: correct,
    lastSeenMinute: minute,
    lastSeenScore: { home: scoreH, away: scoreA },
    stats: {
      xgHome: null, xgAway: null, xgotHome: null, xgotAway: null,
      sotHome: null, sotAway: null, shotsInsideBoxHome: null, shotsInsideBoxAway: null,
      bigChancesHome: null, bigChancesAway: null, totalShotsHome: null, totalShotsAway: null,
      hitWoodworkHome: null, hitWoodworkAway: null, cornersHome: null, cornersAway: null,
      savesHome: null, savesAway: null, possessionHome: null, possessionAway: null,
      touchesOppBoxHome: null, touchesOppBoxAway: null, passesFinalThirdHome: null, passesFinalThirdAway: null,
      crossesHome: null, crossesAway: null, tacklesHome: null, tacklesAway: null,
      interceptionsHome: null, interceptionsAway: null, errorsLeadingToShotHome: null, errorsLeadingToShotAway: null,
      clearancesHome: null, clearancesAway: null
    },
    _retro: true
  };
}

// 1-2. Japan U17 vs Indonesia U17 (74%, min 30, 0-0 → FT 3-1)
if (!exists('Japan U17')) {
  retros.push(retro('Japan U17 vs Indonesia U17', 'Japan U17', 'Indonesia U17', 30, 0, 0, 74, 3, 1, 'AFC U17 Asian Cup'));
  console.log('Creada: Japan U17 vs Indonesia U17 74% → CORRECTO');
}

// 3. Celta Vigo vs Levante (80%, min 74, 1-0 → FT 2-3)
if (!exists('Celta Vigo')) {
  retros.push(retro('Celta Vigo vs Levante', 'Celta Vigo', 'Levante', 74, 1, 0, 80, 2, 3, 'La Liga'));
  console.log('Creada: Celta Vigo vs Levante 80% → CORRECTO');
}

// 4. Kifisia vs Atromitos (86%, min 72, 0-0 → FT 0-3)
if (!exists('Kifisia')) {
  retros.push(retro('Kifisia vs Atromitos', 'Kifisia', 'Atromitos', 72, 0, 0, 86, 0, 3, 'Super League Greece'));
  console.log('Creada: Kifisia vs Atromitos 86% → CORRECTO');
}

// 5. Panetolikos vs AEL Larissa (81%, min 84, 0-0 → FT 1-1)
if (!exists('Panetolikos')) {
  retros.push(retro('Panetolikos vs AEL Larissa', 'Panetolikos', 'AEL Larissa', 84, 0, 0, 81, 1, 1, 'Super League Greece'));
  console.log('Creada: Panetolikos vs AEL Larissa 81% → CORRECTO');
}

// 6. Dep. Tachira vs Metropolitanos (75%, min 26, 1-0 → ?)
if (!exists('Tachira')) {
  retros.push(retro('Dep. Tachira vs Metropolitanos', 'Dep. Tachira', 'Metropolitanos', 26, 1, 0, 75, null, null, 'Venezuelan Primera Division'));
  console.log('Creada: Dep. Tachira vs Metropolitanos 75% → SIN VERIFICAR');
}

// 7. Daejeon Citizen vs Ulsan Hyundai (70%, min 71, 0-2 → ?)
if (!exists('Daejeon')) {
  retros.push(retro('Daejeon Citizen vs Ulsan Hyundai', 'Daejeon Citizen', 'Ulsan Hyundai', 71, 0, 2, 70, null, null, 'K League 1'));
  console.log('Creada: Daejeon Citizen vs Ulsan Hyundai 70% → SIN VERIFICAR');
}

// 8-9. CD Everest vs Real Apodaca (70%, min 40, 0-0) + (82%, min 73, 0-0)
if (!exists('CD Everest')) {
  retros.push(retro('CD Everest vs Real Apodaca', 'CD Everest', 'Real Apodaca', 40, 0, 0, 70, null, null, 'Liga Premier Serie A Mexico'));
  retros.push(retro('CD Everest vs Real Apodaca', 'CD Everest', 'Real Apodaca', 73, 0, 0, 82, null, null, 'Liga Premier Serie A Mexico'));
  console.log('Creadas: CD Everest vs Real Apodaca 70% + 82% → SIN VERIFICAR');
}

// 10-11. Santamarina vs Arsenal Sarandi (78%, min 62, 0-0) + (88%, min 83, 0-0)
if (!exists('Santamarina')) {
  retros.push(retro('Santamarina vs Arsenal Sarandi', 'Santamarina', 'Arsenal Sarandi', 62, 0, 0, 78, null, null, 'Primera Nacional Argentina'));
  retros.push(retro('Santamarina vs Arsenal Sarandi', 'Santamarina', 'Arsenal Sarandi', 83, 0, 0, 88, null, null, 'Primera Nacional Argentina'));
  console.log('Creadas: Santamarina vs Arsenal Sarandi 78% + 88% → SIN VERIFICAR');
}

// 12. Ferro vs Colegiales (70%, min 46, 0-0 → ?)
if (!exists('Ferro vs Colegiales')) {
  retros.push(retro('Ferro vs Colegiales', 'Ferro', 'Colegiales', 46, 0, 0, 70, null, null, 'Primera Nacional Argentina'));
  console.log('Creada: Ferro vs Colegiales 70% → SIN VERIFICAR');
}

// 13. Sportivo Italiano vs Club Lujan (90%, min 83, 0-0 → ?)
if (!exists('Sportivo Italiano')) {
  retros.push(retro('Sportivo Italiano vs Club Lujan', 'Sportivo Italiano', 'Club Lujan', 83, 0, 0, 90, null, null, 'Primera C Argentina'));
  console.log('Creada: Sportivo Italiano vs Club Lujan 90% → SIN VERIFICAR');
}

console.log('\nTotal actual: ' + p.length + ', agregando: ' + retros.length);
if (retros.length > 0) {
  p.push(...retros);
  fs.writeFileSync('predictions.json', JSON.stringify(p, null, 2));
  console.log('predictions.json actualizado.');
}
