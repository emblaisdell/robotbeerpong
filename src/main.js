// Glue: wire the UI to the headless Match engine and the Three.js view. The
// engine simulates a whole turn and records a timeline; the view replays it;
// this file sequences turns, drives the render loop, keeps the panel live, and
// lets you load your own RISC-V firmware into either robot.

import { Match } from './engine.js';
import { PLAYERS, STARTER, MMIO_EQU } from './players.js';
import { assemble } from './riscv.js';
import { GameView } from './view.js';

const $ = (id) => document.getElementById(id);

// Surface uncaught errors into the DOM so headless verification can see them.
function flagError(msg) {
  let el = document.getElementById('errors');
  if (!el) { el = document.createElement('div'); el.id = 'errors'; el.style.display = 'none'; document.body.appendChild(el); }
  el.textContent += msg + '\n';
}
addEventListener('error', (e) => flagError('ERROR: ' + (e.message || e.error)));
addEventListener('unhandledrejection', (e) => flagError('REJECT: ' + (e.reason && e.reason.message || e.reason)));

const ui = {
  selA: $('selA'), selB: $('selB'), blurbA: $('blurbA'), blurbB: $('blurbB'),
  whoA: $('whoA'), whoB: $('whoB'), cupsA: $('cupsA'), cupsB: $('cupsB'),
  drinksA: $('drinksA'), drinksB: $('drinksB'), cardA: $('cardA'), cardB: $('cardB'),
  btnPlay: $('btnPlay'), btnStep: $('btnStep'), log: $('log'), banner: $('banner'), speed: $('speed'),
  customA: $('customA'), customB: $('customB'), srcA: $('srcA'), srcB: $('srcB'),
  statusA: $('statusA'), statusB: $('statusB'), checkA: $('checkA'), checkB: $('checkB'),
};

const RUN_LABEL = '▶ Run match';
let view, match, running = false, speed = 1, seedCounter = 1;

// ---- firmware pickers ----
for (const sel of [ui.selA, ui.selB]) {
  for (const p of PLAYERS) {
    const opt = document.createElement('option');
    opt.value = p.id; opt.textContent = p.name;
    sel.appendChild(opt);
  }
  const opt = document.createElement('option');
  opt.value = 'custom'; opt.textContent = '✎ Custom…';
  sel.appendChild(opt);
}
ui.selA.value = 'sniper';
ui.selB.value = 'lobber';
ui.srcA.value = STARTER;
ui.srcB.value = STARTER;

function refreshUi() {
  for (const L of ['A', 'B']) {
    const isCustom = ui['sel' + L].value === 'custom';
    ui['custom' + L].classList.toggle('show', isCustom);
    ui['blurb' + L].textContent = isCustom
      ? 'Your firmware — edit below, then Assemble or Run.'
      : PLAYERS.find((p) => p.id === ui['sel' + L].value).blurb;
  }
}
ui.selA.onchange = ui.selB.onchange = () => { refreshUi(); newMatch(); };

// Validate one robot's custom source; show the result; return ok.
function validate(L) {
  const status = ui['status' + L];
  try {
    const { code } = assemble(ui['src' + L].value, MMIO_EQU);
    status.className = 'status ok';
    status.textContent = `✓ assembled — ${code.length} bytes`;
    return true;
  } catch (e) {
    status.className = 'status err';
    status.textContent = '✗ ' + e.message;
    return false;
  }
}
ui.checkA.onclick = () => validate('A');
ui.checkB.onclick = () => validate('B');
ui.srcA.oninput = () => { ui.statusA.textContent = ''; ui.statusA.className = 'status'; };
ui.srcB.oninput = () => { ui.statusB.textContent = ''; ui.statusB.className = 'status'; };

// ---- speed ----
ui.speed.querySelectorAll('button').forEach((b) => {
  b.onclick = () => {
    speed = parseFloat(b.dataset.s);
    ui.speed.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
  };
});

// ---- scoreboard ----
function renderScore() {
  if (!match) return;
  const s = match.state();
  ui.whoA.textContent = '· ' + nameOf(s.A.player);
  ui.whoB.textContent = '· ' + nameOf(s.B.player);
  renderCups(ui.cupsA, s.A.cups);
  renderCups(ui.cupsB, s.B.cups);
  ui.drinksA.innerHTML = drinkText(s.A.drinks);
  ui.drinksB.innerHTML = drinkText(s.B.drinks);
  ui.cardA.classList.toggle('turn', s.current === 'A' && !s.winner);
  ui.cardB.classList.toggle('turn', s.current === 'B' && !s.winner);
}
function nameOf(id) { return id === 'custom' ? 'Custom' : (PLAYERS.find((p) => p.id === id) || {}).name; }

// Render the cups in the real 3-2-1 rack triangle (indices 0,1,2 / 3,4 / 5).
const RACK_ROWS = [[0, 1, 2], [3, 4], [5]];
function renderCups(el, alive) {
  el.innerHTML = '';
  for (const row of RACK_ROWS) {
    const r = document.createElement('div');
    r.className = 'rrow';
    for (const i of row) {
      const d = document.createElement('div');
      d.className = 'pip' + (alive[i] ? '' : ' gone');
      r.appendChild(d);
    }
    el.appendChild(r);
  }
}
function drinkText(n) {
  if (n === 0) return '<span class="sober">stone-cold sober</span>';
  return '🍺'.repeat(n) + ` (${n} drink${n > 1 ? 's' : ''})`;
}

// ---- log ----
function logTurn(turn, info) {
  const who = `Unit ${turn.thrower}`;
  let line;
  if (info.result === 'sink') {
    line = `<span class="sink">● ${who} sinks cup ${info.cupIndex}! Unit ${info.victim} drinks.</span>`;
  } else if (turn.crashed) {
    line = `<span class="fizzle">✗ ${who}'s controller crashed (corrupted memory, ${turn.corrupted} byte flips)</span>`;
  } else if (!turn.fired) {
    line = `<span class="fizzle">✗ ${who} never released — froze up mid-swing</span>`;
  } else {
    line = `<b>${who}</b> misses`;
  }
  const drunk = turn.drinks > 0 ? `  [${turn.drinks}🍺]` : '';
  const div = document.createElement('div');
  div.innerHTML = line + `<span style="color:#566">${drunk}</span>`;
  ui.log.prepend(div);
  while (ui.log.children.length > 60) ui.log.removeChild(ui.log.lastChild);
}

function banner(text, ms = 1600) {
  ui.banner.textContent = text;
  ui.banner.classList.add('show');
  clearTimeout(banner._t);
  banner._t = setTimeout(() => ui.banner.classList.remove('show'), ms);
}

// ---- match lifecycle ----
function newMatch() {
  // Validate any custom firmware before building the match.
  const srcA = ui.selA.value === 'custom' ? ui.srcA.value : null;
  const srcB = ui.selB.value === 'custom' ? ui.srcB.value : null;
  let ok = true;
  if (srcA !== null) ok = validate('A') && ok;
  if (srcB !== null) ok = validate('B') && ok;
  if (!ok) {
    match = null; running = false;
    ui.btnPlay.textContent = RUN_LABEL;
    banner('Firmware did not assemble — see the error below.', 3000);
    return;
  }
  match = new Match({ playerA: ui.selA.value, playerB: ui.selB.value, seed: seedCounter++, srcA, srcB });
  running = false;
  ui.btnPlay.textContent = RUN_LABEL;
  ui.log.innerHTML = '';
  if (view) view.setupMatch({ A: ui.selA.value, B: ui.selB.value });
  renderScore();
}

function stepTurn(thenContinue) {
  if (!match || match.winner || view.anim) return;
  const turn = match.simulateTurn();
  if (!turn) return;
  view.playThrow(turn, (outcome) => {
    const info = match.applyOutcome(outcome);
    logTurn(turn, info);
    renderScore();
    if (info.winner) {
      banner(`🏆 Unit ${info.winner} (${nameOf(info.winner === 'A' ? match.robots.A.playerId : match.robots.B.playerId)}) wins!`, 4000);
      running = false;
      ui.btnPlay.textContent = '↻ New match';
    } else if (running && thenContinue) {
      setTimeout(() => stepTurn(true), 250 / speed);
    }
  }, speed);
  renderScore();
}

ui.btnPlay.onclick = () => {
  if (!match || match.winner) { newMatch(); if (!match) return; }
  running = !running;
  ui.btnPlay.textContent = running ? '⏸ Pause' : RUN_LABEL;
  if (running) stepTurn(true);
};
ui.btnStep.onclick = () => {
  if (!match) { newMatch(); if (!match) return; }
  running = false; ui.btnPlay.textContent = RUN_LABEL; stepTurn(false);
};

// ---- boot ----
async function boot() {
  refreshUi();
  view = new GameView($('canvas'));
  try {
    await view.load();
  } catch (e) {
    $('banner').textContent = 'Failed to load models — run from a local web server (see README).';
    $('banner').classList.add('show');
    console.error(e);
    return;
  }
  newMatch();
  window.game = { get view() { return view; }, get match() { return match; } };
  banner('Press ▶ Run match', 2500);
  const loop = () => { view.update(); requestAnimationFrame(loop); };
  loop();

  // Headless self-test: ?auto starts a fast match automatically.
  if (location.search.includes('auto')) {
    document.body.setAttribute('data-loaded', '1');
    speed = 4;
    running = true;
    ui.btnPlay.textContent = '⏸ Pause';
    stepTurn(true);
  }
}
boot();
