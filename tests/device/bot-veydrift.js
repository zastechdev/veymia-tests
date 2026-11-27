// Injected into the page (veydrift, ?debug). Races the current track to the finish with the game's
// own bot driver (a good player), without drawing, then lets the game show the result itself.
window.botDrift = (opts = {}) => {
  const r = vd.race, skill = opts.skill ?? 0.85;
  let guard = 0, frames = 0;
  while (r.state !== 'done' && guard++ < 60 * 400) {
    r.update(1 / 60, vd.botInput(r, skill));
    if (r.state !== 'done') r.events.length = 0;
    if (opts.render && guard % 6 === 0) frames++;
  }
  r.events = r.events.filter((e) => e.kind === 'finish');
  return { track: r.def.index, place: r.p.place, time: Math.round(r.p.finished * 10) / 10, hits: r.p.hits, coins: r.p.coins, laps: r.lapTimes.length };
};
