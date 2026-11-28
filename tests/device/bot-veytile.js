// Injected into the page (veytile, ?debug). Clears the current board with the game's own bot
// (takes free pairs, shuffles when stuck), then lets the game show the result itself.
window.botTile = () => { const b = vt.board; const r = vt.botPlay(b); vt.after(); return r; };
