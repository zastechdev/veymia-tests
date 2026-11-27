// Injected into the page (veygrove, ?debug). Plays the garden like an active player for a stretch
// of simulated time (acting every 5 seconds), using the game's own bot.
window.botGrove = (seconds = 3600) => {
  const g = vg.garden;
  for (let t = 0; t < seconds; t += 5) { g.tick(5); vg.botStep(g); g.events = g.events.filter((e) => e.t === 'level'); }
  g.events.length = 0; vg.afterAction(); vg.ui.close();
  return { level: g.s.level, coins: g.s.coins, plots: g.ownedPlots(), perks: g.s.perks, harvests: g.s.total, decor: g.s.decor.length };
};
