// Injected into the page (veysol, ?debug). Plays the current deal with the game's own hints (no
// drawing in between), like a player who always presses Hint. Returns what happened.
window.botSol = (limit = 1500) => {
  const g = vs.game; let guard = 0, idle = 0;
  while (!g.won && guard++ < limit) {
    for (const m of g.autoMoves()) g.move(m);
    if (g.canFinish()) { let k = 0; while (!g.won && k++ < 120) { const a = g.autoMoves(true); if (!a.length) break; g.move(a[0]); } break; }
    const h = g.hint(); if (!h) break;
    if (h === 'stock') { if (!g.stock() || ++idle > 80) break; } else { g.move(h); idle = 0; }
  }
  g.events.length = 0; vs.after();
  return { won: g.won, moves: g.moves, found: g.piles.filter((p) => p.kind === 'found').reduce((a, p) => a + p.cards.length, 0) };
};
