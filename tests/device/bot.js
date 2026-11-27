// Injected into the page. Plays a run with a simple bot until it ends.
window.botPlay = (opts = {}) => {
  const r = vf.run; const log = [];
  const realLevelUp = r.ev.levelUp;
  r.ev.levelUp = (o) => {
    const pr = (x) => (x.kind === 'weapon' ? (x.isNew ? (r.weapons.size < 3 ? 3 : 1) : 4) : x.kind === 'passive' ? (x.isNew ? 1.5 : 2.2) : 0);
    o.sort((a, b) => pr(b) - pr(a));
    if (opts.uiLevelUps) { realLevelUp(o); vf.ui.currentOptions = o; document.querySelector('.opt').click(); }
    else r.choose(o[0]);
  };
  const realEnd = r.ev.end; let ended = null;
  r.ev.end = (win) => { ended = win; if (opts.keepEnd) realEnd(win); };
  // falling: get back up up to opts.continues times (through the real Continue button when uiLevelUps), else the run ends
  let continued = 0;
  r.ev.downed = () => {
    if (continued < (opts.continues || 0)) {
      continued++;
      if (opts.uiLevelUps) { vf.ui.showDowned(r); document.querySelector('[data-act=continue]').click(); } else r.continueRun();
    } else r.finish(false);
  };
  let steps = 0, lastMin = -1, renders = 0;
  const dt = 1 / 30, limit = (opts.maxT || 700) * 30;
  while (!r.over && steps < limit) {
    let mx = 0, my = 0;
    for (const e of r.enemies) {
      if (!e.alive) continue;
      const dx = r.px - e.x, dy = r.py - e.y, d2 = dx * dx + dy * dy, R = e.boss ? 260 : 130;
      if (d2 < R * R) { const w = (e.boss ? 8 : e.elite ? 3 : 1) / Math.max(400, d2); mx += dx * w; my += dy * w; }
    }
    let best = null, bd = 1e12;
    for (const p of r.pickups) { if (!p.alive) continue; const d = (p.x - r.px) ** 2 + (p.y - r.py) ** 2 * (p.kind === 'chest' ? 0.3 : 1); if (d < bd) { bd = d; best = p; } }
    if (best && bd < 400 * 400) { const d = Math.sqrt(bd) || 1, danger = Math.hypot(mx, my), gw = danger < 0.01 ? 0.03 : 0.008; mx += (best.x - r.px) / d * gw; my += (best.y - r.py) / d * gw; }
    const l = Math.hypot(mx, my);
    if (l > 0) { mx /= l; my /= l; } else { mx = Math.cos(steps / 90); my = Math.sin(steps / 90); }
    if (!r.paused) r.update(dt, mx, my); else if (!document.querySelector('.opt')) r.paused = false;
    if (opts.render && steps % 3 === 0) { vf.draw(); renders++; }
    steps++;
    const m = Math.floor(r.t / 60);
    if (m !== lastMin) { lastMin = m; log.push(`${m}m L${r.level} hp${Math.round(r.hp)}/${r.maxHp} k${r.kills} alive${r.enemies.filter((e) => e.alive).length} g${r.gold} ${[...r.weapons].map((x) => x[0] + x[1].lvl).join(',')} | ${[...r.passives].map((x) => x[0] + x[1]).join(',')}`); }
  }
  return { t: +r.t.toFixed(1), won: r.won, over: r.over, ended, level: r.level, kills: r.kills, gold: r.gold, revivesLeft: r.revives, continues: r.continues, renders, log };
};
