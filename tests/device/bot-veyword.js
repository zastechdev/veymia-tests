// Injected into the page (veyword, ?debug). Solves the current puzzle with the game's own rules,
// then lets the game show the result itself.
window.botWord = () => { const r = vw.run; const n = vw.botSolve(r); for (const s of r.slots) vw.view.wordFound(s.cells); vw.save.words += n; vw.after(); return { won: r.won, words: n }; };
