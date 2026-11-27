// Injected into the page (veyhold, ?debug). Plays whole maps with a simple strategy, as fast as possible.
window.botHold = (opts = {}) => {
  const L = vh.level; const T = { archer: 0, cannon: 0, frost: 0, storm: 0 };
  const COLS = 9, ROWS = 14;
  // squares that see the most road come first
  const cand = [];
  for (let cy = 0; cy < ROWS; cy++) for (let cx = 0; cx < COLS; cx++) {
    if (!L.canBuild(cx, cy)) continue;
    let n = 0; for (const k of L.pathCells) { const px = k % COLS, py = Math.floor(k / COLS); if ((px - cx) ** 2 + (py - cy) ** 2 <= 2.4 ** 2) n++; }
    cand.push({ cx, cy, n });
  }
  cand.sort((a, b) => b.n - a.n);
  const plan = opts.plan || ['archer', 'archer', 'cannon', 'frost', 'archer', 'storm', 'cannon', 'storm', 'archer', 'frost', 'storm', 'cannon'];
  let built = 0;
  const spend = () => {
    for (let guard = 0; guard < 20; guard++) {
      const type = plan[built % plan.length];
      const spot = cand.find((c) => L.canBuild(c.cx, c.cy));
      const cheapUp = L.towers.filter((t) => t.lvl < 3).sort((a, b) => L.price(a.type, a.lvl + 1) - L.price(b.type, b.lvl + 1))[0];
      const buildFirst = spot && (L.towers.length < 6 || built % 2 === 0 || !cheapUp);
      if (buildFirst && L.gold >= L.price(type, 1)) { L.build(type, spot.cx, spot.cy); T[type]++; built++; continue; }
      if (cheapUp && L.gold >= L.price(cheapUp.type, cheapUp.lvl + 1)) { L.upgrade(cheapUp); continue; }
      break;
    }
  };
  const dt = 1 / 30; let steps = 0, renders = 0;
  while (!L.over && steps < 30 * 60 * 40) {
    spend();
    if (L.state === 'ready' || L.state === 'break') L.nextWave();
    L.update(dt); steps++;
    if (opts.render && steps % 4 === 0) { vh.view(); renders++; }
  }
  return { map: L.mapIndex, won: L.won, wave: L.wave, waves: L.map.waves, lives: L.lives, stars: L.stars(), kills: L.kills, towers: L.towers.length, built: T, t: Math.round(L.t), renders };
};
