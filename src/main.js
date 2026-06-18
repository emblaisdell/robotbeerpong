// Glue: wire the UI to the headless Match engine and the Three.js view.
// The engine resolves a whole turn instantly; the view animates it; this file
// sequences turns, drives the render loop, and keeps the scoreboard/log live.

import { Match } from './engine.js';
import { PLAYERS } from './players.js';
import { GameView } from './view.js';
import { MRAD } from './constants.js';

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
  btnPlay: $('btnPlay'), btnStep: $('btnStep'), log: $('log'), banner: $('banner'),
  speed: $('speed'),
};

let view, match, running = false, speed = 1, seedCounter = 1;

// ---- strategy pickers ----
for (const sel of [ui.selA, ui.selB]) {
  for (const p of PLAYERS) {
    const opt = document.createElement('option');
    opt.value = p.id; opt.textContent = p.name;
    sel.appendChild(opt);
  }
}
ui.selA.value = 'sniper';
ui.selB.value = 'lobber';
function refreshBlurbs() {
  ui.blurbA.textContent = PLAYERS.find((p) => p.id === ui.selA.value).blurb;
  ui.blurbB.textContent = PLAYERS.find((p) => p.id === ui.selB.value).blurb;
}
ui.selA.onchange = ui.selB.onchange = () => { refreshBlurbs(); newMatch(); };
refreshBlurbs();

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
function nameOf(id) { return PLAYERS.find((p) => p.id === id).name; }
function renderCups(el, alive) {
  el.innerHTML = '';
  alive.forEach((a) => {
    const d = document.createElement('div');
    d.className = 'pip' + (a ? '' : ' gone');
    el.appendChild(d);
  });
}
function drinkText(n) {
  if (n === 0) return '<span class="sober">stone-cold sober</span>';
  return '🍺'.repeat(n) + ` (${n} drink${n > 1 ? 's' : ''})`;
}

// ---- log ----
function logTurn(ev) {
  const who = `Robot ${ev.thrower}`;
  const yaw = ((ev.command?.yawMrad || 0) / MRAD).toFixed(2);
  let line;
  if (ev.fizzle) {
    line = `<span class="fizzle">✗ ${who} fumbled the ball (corrupted memory / crash, ${ev.corrupted} byte flips)</span>`;
  } else if (ev.result === 'sink') {
    line = `<span class="sink">● ${who} sinks cup ${ev.cupIndex}! Robot ${ev.victim} drinks.</span>`;
  } else {
    const where = ev.result === 'offtable' ? 'off the table' : 'the table';
    line = `<b>${who}</b> misses (lands on ${where}), aim ${yaw} rad`;
  }
  const drunk = ev.drinks > 0 ? `  [${ev.drinks}🍺]` : '';
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
  match = new Match({ playerA: ui.selA.value, playerB: ui.selB.value, seed: seedCounter++ });
  running = false;
  ui.btnPlay.textContent = '▶ Play match';
  ui.log.innerHTML = '';
  if (view) view.setupMatch({ A: ui.selA.value, B: ui.selB.value });
  renderScore();
}

function stepTurn(thenContinue) {
  if (match.winner || view.anim) return;
  const ev = match.runTurn();
  if (!ev) return;
  logTurn(ev);
  view.playTurn(ev, () => {
    renderScore();
    if (ev.winner) {
      banner(`🏆 Robot ${ev.winner} (${nameOf(ev.winner === 'A' ? match.robots.A.playerId : match.robots.B.playerId)}) wins!`, 4000);
      running = false;
      ui.btnPlay.textContent = '↻ New match';
    } else if (running && thenContinue) {
      setTimeout(() => stepTurn(true), 250 / speed);
    }
  }, speed);
  renderScore();
}

ui.btnPlay.onclick = () => {
  if (match.winner) { newMatch(); return; }
  running = !running;
  ui.btnPlay.textContent = running ? '⏸ Pause' : '▶ Play match';
  if (running) stepTurn(true);
};
ui.btnStep.onclick = () => { running = false; ui.btnPlay.textContent = '▶ Play match'; stepTurn(false); };

// ---- boot ----
async function boot() {
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
  banner('Press ▶ Play match', 2500);
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
