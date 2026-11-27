// Minimal page driver over the raw DevTools protocol (page target only).
// Android WebView does not support the browser-level commands Playwright needs, so the
// Android test uses this instead; it offers the same few methods smoke.mjs calls.
export async function connectLite(httpBase) {
  let list = [];
  for (let i = 0; i < 60; i++) {
    try { list = await (await fetch(httpBase + '/json')).json(); } catch { list = []; }
    if (list.some((t) => t.type === 'page')) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const target = list.find((t) => t.type === 'page' && /vey(forge|hold)/.test(t.title)) || list.find((t) => t.type === 'page');
  if (!target) throw new Error('no page target at ' + httpBase);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const waiting = new Map(); const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) { const { res, rej } = waiting.get(msg.id); waiting.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
    else if (msg.method) listeners.forEach((l) => l(msg));
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const n = ++id; waiting.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params })); });
  await send('Runtime.enable'); await send('Page.enable');
  const errorHandlers = [];
  listeners.push((m) => {
    if (m.method === 'Runtime.exceptionThrown') errorHandlers.forEach((h) => h(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errorHandlers.forEach((h) => h(m.params.args.map((a) => a.value ?? a.description).join(' ')));
  });
  const evaluate = async (fn, arg) => {
    const expr = typeof fn === 'string' ? fn : `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`;
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const key = (type, k) => evaluate(([t, kk]) => { window.dispatchEvent(new KeyboardEvent(t, { key: kk, bubbles: true })); }, [type, k]);
  const page = {
    evaluate,
    on: (ev, h) => { if (ev === 'pageerror' || ev === 'console') errorHandlers.push(ev === 'console' ? (t) => h({ type: () => 'error', text: () => t }) : h); },
    click: (sel) => evaluate((s) => { const e = document.querySelector(s); if (!e) throw new Error('not found: ' + s); e.click(); }, sel),
    textContent: (sel) => evaluate((s) => document.querySelector(s)?.textContent ?? null, sel),
    waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms)),
    waitForFunction: async (fn, _a, opts = {}) => {
      const end = Date.now() + (opts.timeout || 30000);
      while (Date.now() < end) { try { if (await evaluate(fn)) return; } catch { /* page reloading */ } await new Promise((r) => setTimeout(r, 300)); }
      throw new Error('waitForFunction timed out');
    },
    keyboard: { down: (k) => key('keydown', k), up: (k) => key('keyup', k) },
    locator: (sel) => ({ count: () => evaluate((s) => document.querySelectorAll(s).length, sel) }),
    screenshot: async ({ path }) => { const { writeFileSync } = await import('node:fs'); const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path, Buffer.from(r.data, 'base64')); },
    // real touch input through the DevTools Input domain (goes through the WebView's own touch handling)
    touchDrag: async (x, y, dy, holdMs) => {
      const pt = (yy) => [{ x, y: yy, id: 1, radiusX: 8, radiusY: 8, force: 1 }];
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(y) });
      for (let i = 1; i <= 6; i++) await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(y + (dy * i) / 6) });
      await new Promise((r) => setTimeout(r, holdMs));
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    },
    // a real swipe in any direction through the DevTools Input domain
    swipe: async (x, y, dx, dy) => {
      const pt = (k) => [{ x: x + dx * k, y: y + dy * k, id: 3, radiusX: 8, radiusY: 8, force: 1 }];
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(0) });
      for (let i = 1; i <= 6; i++) { await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(i / 6) }); await new Promise((r) => setTimeout(r, 16)); }
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    },
    // a real tap through the DevTools Input domain
    tapAt: async (x, y) => {
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id: 2, radiusX: 6, radiusY: 6, force: 1 }] });
      await new Promise((r) => setTimeout(r, 60));
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    },
    close: () => ws.close()
  };
  return page;
}
