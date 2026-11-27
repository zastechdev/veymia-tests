// Injected into the page (veyrune, ?debug). Plays the current level to the end with the rules
// directly (no animations), like a good player: looks one move ahead, goes for the goals.
// Uses the free +5 moves when it runs out, as a player would.
window.botRune = (opts = {}) => {
  const b = vr.board, def = b.def;
  const value = () => {
    let v = b.score * 0.03;
    for (const g of def.goals) v -= (g.type === 'ice' ? b.ice.flat().reduce((a, x) => a + x, 0) * 0.7 : b.goalLeft(g)) * (g.type === 'score' ? 0.03 : g.type === 'collect' ? 20 : 60);
    return v;
  };
  let moves = 0, extra = false;
  for (let guard = 0; guard < 300; guard++) {
    if (def.goals.length && b.done()) break;
    if (b.movesLeft <= 0) { if (def.goals.length && !b.extraUsed && opts.extra !== false) { b.addMoves(5); extra = true; continue; } break; }
    const list = b.findMoves();
    if (!list.length) { b.reshuffle(); continue; }
    let best = list[0], bestV = -Infinity;
    for (const [p, q] of list) { const s = b.snapshot(); b.swap(p, q); const v = value() + Math.random(); b.restore(s); if (v > bestV) { bestV = v; best = [p, q]; } }
    b.swap(best[0], best[1]); moves++;
  }
  const won = def.goals.length ? b.done() : true;
  vr.view.reset(b);   // show the final board; the game then plays the ending (rush, results) itself
  return { level: def.index, won, score: b.score, moves, extra, movesLeft: b.movesLeft, goals: def.goals.map((g) => b.goalLeft(g)) };
};
