// Injected into the page (veyblock, ?debug). Plays with the game's own bot until the level is won
// or no block fits, then lets the game show the result itself.
window.botBlock = (max = 400) => { const g = vb.game; let n = 0; while (!g.won && !g.over && n++ < max) { const m = vb.bestMove(g); if (!m) break; vb.placed(m.slot, m.x, m.y); } return { won: g.won, over: g.over, score: g.score, moves: g.moves }; };
