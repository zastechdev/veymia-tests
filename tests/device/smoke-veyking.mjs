// Plays veyking inside the real app (Windows WebView2 or Android WebView) or a browser, through the
// Chrome DevTools Protocol, and checks that everything works.
// Usage: node smoke-veyking.mjs <cdp-url | lite:<cdp-url>> <results-dir> <platform>
import { chromium } from 'playwright-core';
import { connectLite } from './cdp-lite.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [cdp = 'http://127.0.0.1:9222', out = 'device-results', platform = 'device'] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const results = []; const errors = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info: String(info) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${info}`); };
const shot = async (page, name) => { try { await page.screenshot({ path: join(out, `${platform}-veyking-${name}.png`) }); } catch (e) { console.log('screenshot failed', name, e.message); } };
const FPS_MIN = Number(process.env.FPS_MIN || 25);

let browser = null, page = null;
if (cdp.startsWith('lite:')) page = await connectLite(cdp.slice(5));
else {
  browser = await chromium.connectOverCDP(cdp, { timeout: 60000 });
  for (let i = 0; i < 60 && !page; i++) {
    for (const c of browser.contexts()) for (const p of c.pages()) if ((await p.title().catch(() => '')).includes('veyking')) page = p;
    if (!page) await new Promise((r) => setTimeout(r, 1000));
  }
}
if (!page) { console.log('veyking page not found'); process.exit(2); }
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const fpsFor = (ms) => page.evaluate((ms) => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; performance.now() - t0 < ms ? requestAnimationFrame(f) : res(n / (ms / 1000)); }; requestAnimationFrame(f); }), ms);
const pt = (sq) => page.evaluate((s) => vk.squarePoint(s), sq);
const tap = async (x, y) => { if (page.tapAt) await page.tapAt(x, y); else await page.mouse.click(x, y); await page.waitForTimeout(120); };
const tapMove = async (u) => { const a = await pt(u.slice(0, 2)), b = await pt(u.slice(2, 4)); await tap(a.x, a.y); await tap(b.x, b.y); };
const dragMove = async (u) => { const a = await pt(u.slice(0, 2)), b = await pt(u.slice(2, 4)); const pts = []; for (let k = 0; k <= 8; k++) pts.push({ x: a.x + (b.x - a.x) * k / 8, y: a.y + (b.y - a.y) * k / 8 });
  if (page.swipePath) await page.swipePath(pts); else { await page.mouse.move(a.x, a.y); await page.mouse.down(); for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y); await page.mouse.up(); } await page.waitForTimeout(150); };
const waitAi = async () => { await page.waitForTimeout(350); await page.waitForFunction(() => !vk.thinking && !vk.busy && (vk.mode !== 'ai' || vk.ended || vk.moves.length % 2 === 0), null, { timeout: 30000 }).catch(() => {}); await page.waitForTimeout(250); };

await page.evaluate(() => { localStorage.clear(); localStorage.setItem('veyking.debug', '1'); location.reload(); });
await page.waitForFunction(() => window.vk && document.querySelector('.logo'), null, { timeout: 30000 });
await page.evaluate(() => { vk.save.settings.sound = false; });
await page.waitForTimeout(500);
await shot(page, '1-menu');
check('menu loads', (await page.textContent('.logo')) === 'veyking');
const vp = await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
check('screen size', vp[0] > 200 && vp[1] > 200, vp.join('x'));
check('font loaded', await page.evaluate(() => document.fonts.check('700 16px Fredoka')));
check('pieces drawn as images', await page.evaluate(() => Object.keys(vk.view.imgs).length === 12 && Object.values(vk.view.imgs).every((i) => i.naturalWidth > 0)));
check('the computer thinks in a background worker', await page.evaluate(() => vk.usingWorker()));
await page.click('[data-act=setup]'); await page.waitForTimeout(150);
check('8 computer levels to choose from', await page.evaluate(() => document.querySelectorAll('.lvc').length === 8));
await page.click('[data-act=lvl][data-arg="3"]'); await page.click('[data-act=color][data-arg="0"]'); await page.click('[data-act=start]'); await page.waitForTimeout(400);
// tap a piece: legal moves show
const e2 = await pt('e2'); await tap(e2.x, e2.y);
check('tapping a pawn shows its 2 moves', await page.evaluate(() => vk.view.targets.length === 2));
const e4 = await pt('e4'); await tap(e4.x, e4.y); await page.waitForTimeout(200);
check('tapping a target square moves the piece', await page.evaluate(() => vk.moves[0] === 'e2e4'));
await waitAi(); await page.waitForTimeout(300);
check('the computer replies', await page.evaluate(() => vk.moves.length === 2 && vk.pos.side === 0), await page.evaluate(() => vk.moves.join(' ')));
// a real drag
await dragMove('g1f3'); await waitAi(); await page.waitForTimeout(300);
check('dragging a piece moves it', await page.evaluate(() => vk.moves[2] === 'g1f3' && vk.moves.length === 4));
// an illegal move is refused
const before = await page.evaluate(() => vk.moves.length);
await tapMove('f3f6');
check('an illegal move is refused', await page.evaluate((n) => vk.moves.length === n, before));
await shot(page, '2-game');
// hint and undo
await page.click('#hint-btn'); await waitAi(); await page.waitForTimeout(200);
check('hint shows a move arrow', await page.evaluate(() => !!vk.view.hint));
await page.click('#undo-btn'); await page.waitForTimeout(300);
check('undo takes back your move and the reply', await page.evaluate(() => vk.moves.length === 2 && vk.pos.side === 0));
// continue later
await page.click('[data-act=pause]'); await page.waitForTimeout(100); await page.click('#ui [data-act=menu]'); await page.waitForTimeout(200);
check('menu offers Continue', (await page.locator('[data-act=resume]').count()) === 1);
await page.click('[data-act=resume]'); await page.waitForTimeout(400);
check('continue brings the same game back', await page.evaluate(() => vk.moves.length === 2 && vk.mode === 'ai'));
// scholar's mate against the weakest level, forced position: checkmate is detected and recorded
await page.evaluate(() => { vk.save.settings.flip = false; vk.startFriend(); });
for (const u of ['e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6']) await tapMove(u);
await page.waitForTimeout(500);
await tapMove('h5f7'); await page.waitForTimeout(1500);
check('checkmate ends the game', await page.evaluate(() => vk.ended && vk.pos.status() === 'checkmate' && /White wins/.test(document.querySelector('.results h2')?.textContent || '')));
// castling and promotion rules through the real board
await page.evaluate(() => { vk.ui.close(); vk.startFriend(); vk.pos.load('r3k2r/pPpppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1'); vk.view.pos = vk.pos; vk.save.settings.autoQueen = true; vk.save.settings.flip = false; });
await tapMove('e1g1'); await page.waitForTimeout(500);
check('castling moves the rook too', await page.evaluate(() => vk.pos.fen().startsWith('r3k2r/pPpppppp/8/8/8/8/PPPPPPPP/R4RK1')));
await tapMove('e8g8'); await page.waitForTimeout(500);
await tapMove('b7b8'); await page.waitForTimeout(500);
check('a pawn on the last rank becomes a queen', await page.evaluate(() => vk.pos.fen().split('/')[0].includes('Q')), await page.evaluate(() => vk.pos.fen()));
// puzzles
await page.evaluate(() => { vk.ui.close(); vk.ui.showPuzzles(0); }); await page.waitForTimeout(150);
check('puzzle list loads', await page.evaluate(() => document.querySelectorAll('.lv').length >= 10));
await page.click('[data-act=puzzle][data-arg="0:0"]'); await page.waitForTimeout(400);
const sol = await page.evaluate(() => vk.SETS[0][0].move);
const wrongMove = await page.evaluate((sol) => { const p = vk.pos; const l = p.legal().map((m) => p.uci(m)).filter((u) => u !== sol); for (const u of l) { const m = p.fromUci(u); p.make(m); const mate = p.status() === 'checkmate'; p.undo(); if (!mate) return u; } return l[0]; }, sol);
await tapMove(wrongMove); await page.waitForTimeout(1000);
check('a wrong puzzle move is taken back', await page.evaluate(() => vk.moves.length === 0 && !vk.ended));
await tapMove(sol); await page.waitForTimeout(1300);
check('the right move solves the puzzle', await page.evaluate(() => vk.ended && !!vk.save.solved['1-0'] && !!document.querySelector('.results')));
await shot(page, '3-solved');
// a mate-in-2 puzzle played through: the defender answers, then we mate
await page.evaluate(() => { vk.ui.close(); vk.startPuzzle(1, 0); }); await page.waitForTimeout(400);
const p2 = await page.evaluate(() => vk.SETS[1][0].move);
await tapMove(p2); await waitAi(); await page.waitForTimeout(800);
const mateMove = await page.evaluate(() => { const p = vk.pos; for (const m of p.legal()) { p.make(m); const ok = p.status() === 'checkmate'; p.undo(); if (ok) return p.uci(m); } return ''; });
await tapMove(mateMove); await page.waitForTimeout(1300);
check('mate in 2: defender replies, then checkmate solves it', await page.evaluate(() => vk.ended && !!vk.save.solved['2-0']), `${p2} ... ${mateMove}`);
// daily puzzle stays the same today
const d1 = await page.evaluate(() => { vk.ui.close(); vk.startDaily(); return vk.pos.fen(); });
const d2 = await page.evaluate(() => { vk.startDaily(); return vk.pos.fen(); });
check('daily puzzle is the same all day', d1 === d2);
// the strongest level answers in good time and the board stays smooth
await page.evaluate(() => { vk.ui.close(); vk.startAi(7, 0); }); await page.waitForTimeout(300);
const t0 = Date.now(); await tapMove('d2d4'); await page.waitForTimeout(100);
const fps = await fpsFor(2000);
await waitAi(); const took = Date.now() - t0;
check('Champion level replies within 6 seconds', await page.evaluate(() => vk.moves.length === 2) && took < 6000, `${took} ms`);
check('frame rate while the computer thinks', fps >= FPS_MIN, `${fps.toFixed(1)} fps`);
await shot(page, '4-champion');
await page.evaluate(() => { vk.storeGame(); localStorage.setItem('veyking.save.v1', JSON.stringify(vk.save)); location.reload(); });
await page.waitForFunction(() => window.vk && document.querySelector('.logo'), null, { timeout: 30000 });
check('save survives restart', await page.evaluate(() => !!vk.save.solved['1-0'] && !!vk.save.game));
await page.evaluate(() => { localStorage.removeItem('veyking.debug'); });
check('no script errors', errors.length === 0, errors.slice(0, 5).join(' | '));
writeFileSync(join(out, `${platform}-veyking-results.json`), JSON.stringify({ platform, results, errors }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (browser) await browser.close().catch(() => {}); else page.close();
process.exit(failed.length ? 1 : 0);
