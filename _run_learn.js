const { runLearning, loadWeights, loadPredictions } = require('./learn');
async function main() {
  const result = await runLearning([]);
  const p = loadPredictions();
  const total = p.length;
  let verified = 0, correct = 0, above70 = 0, correctAbove70 = 0;
  for (const pred of p) {
    if (pred.predictionCorrect === true) { verified++; correct++; }
    else if (pred.predictionCorrect === false) verified++;
    if ((pred.predictedProbability || 0) >= 70) {
      above70++;
      if (pred.predictionCorrect === true) correctAbove70++;
    }
  }
  console.log('\nResumen: ' + total + ' total | ' + verified + ' verificadas | ' + correct + ' correctas (' + (verified > 0 ? (correct/verified*100).toFixed(1) : '-') + '%)');
  console.log('>=70%: ' + above70 + ' | Correctas >=70%: ' + correctAbove70);
}
main().catch(e => console.error(e));
