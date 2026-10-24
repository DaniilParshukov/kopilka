import { GameEngine } from './core/GameEngine.js';
import { LocalStorageAdapter } from './core/LocalStorageAdapter.js';
import { LocalPrices } from './prices/LocalPrices.js';
import { lessons, lessonTabs, riskNames } from './lessons.js';
import { loadNews } from './news.js';

// ===== Настройки =====

const GAME_ID = 'player';       // одно сохранение на браузер
const PLAYER_KEY = 'copilka-player-name';
const START_CASH = 10000;
const SALARY_DAYS = [[10, 'Аванс'], [25, 'Зарплата']];
const MONTHS_TOTAL = 12;
const CHART_DAYS = 30;          // окно мини-графиков и изменения цены
const QUANTITIES = ['1', '25', '50', 'MAX'];
const CARD_STATES = ['active', 'locked', 'unlock'];

// Шаблоны одиночной игры (экран «Выбери шаблон игры»)
const TEMPLATES = {
  training: { dayMs: 4000, openAll: false, lifeEvents: 'normal' },
  advanced: { dayMs: 3000, openAll: true, lifeEvents: 'high' }
};

// Ряды игрового поля
const LAYOUT = [
  ['savings', 'bonds'],
  ['funds', 'currency'],
  ['stocks', 'gold']
];

// opensAt — игровой месяц, с которого категорию можно открыть.
// slots — инструменты карточки; role связывает слот с тикером в game.tickers.
const CATEGORIES = {
  savings: { title: 'Накопительный счёт', lesson: 'savings', opensAt: 1 },
  bonds: {
    title: 'Облигации', lesson: 'ofz', opensAt: 2,
    slots: [
      { role: 'ofz', name: 'ОФЗ', unit: 'шт.' },
      { role: 'corp', name: 'Корпоративная', unit: 'шт.', title: 'Корпоративные облигации', short: 'Корп. облигации' },
      { role: 'vdo', name: 'ВДО', unit: 'шт.' }
    ]
  },
  funds: {
    title: 'ПИФы', lesson: 'funds', opensAt: 3,
    slots: [
      { role: 'fund1', name: 'ПИФ 1', unit: 'pai' },
      { role: 'fund2', name: 'ПИФ 2', unit: 'pai' }
    ]
  },
  stocks: {
    title: 'Акции', lesson: 'stocks', opensAt: 4,
    slots: [
      { role: 'stock1', name: 'Акция 1', unit: 'шт.' },
      { role: 'stock2', name: 'Акция 2', unit: 'шт.' },
      { role: 'stock3', name: 'Акция 3', unit: 'шт.' }
    ]
  },
  currency: {
    title: 'Валюта', lesson: 'currency', opensAt: 5,
    slots: [
      { role: 'usd', name: 'Доллар / USD', unit: '$' },
      { role: 'cny', name: 'Юань / CNY', unit: '¥', inactive: true } // данных по юаню нет — временно неактивен
    ]
  },
  gold: {
    title: 'Золото', lesson: 'gold', opensAt: 6,
    slots: [{ role: 'gold', name: '1 лот = 1 г', unit: 'г', title: 'Золото' }]
  }
};

const LESSON_CATEGORY = {
  savings: 'savings', ofz: 'bonds', corp: 'bonds', vdo: 'bonds',
  funds: 'funds', stocks: 'stocks', currency: 'currency', gold: 'gold'
};

// ===== Состояние =====

const storage = new LocalStorageAdapter();
const engine = new GameEngine(storage, null, { notify: toast, nameOf: tickerName });
let prices = null;
let game = null;

const ui = {
  capitalMode: 'capital',
  metricMode: {},       // ticker -> 'value' | 'profit'
  qty: {},              // ticker -> '1' | '25' | '50' | 'MAX'
  savingsForm: null,    // null | 'deposit' | 'withdraw'
  lesson: null,         // { key, unlocking }
  pause: new Set(),     // причины паузы: lesson, modal, hidden, console, finished
  updaters: [],         // обновление значений карточек без перестройки DOM
  news: [],             // новости игрового года (с псевдонимами), по возрастанию даты
  newsShown: 0          // сколько новостей уже выведено в ленту
};

const $ = (id) => document.getElementById(id);

// ===== Форматирование =====

const NBSP = ' ';

function group(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

function money(value, signed = false) {
  const sign = value < 0 ? '−' : (signed && value > 0 ? '+' : '');
  return `${sign}${group(Math.abs(Math.round(value)))}${NBSP}₽`;
}

function formatPrice(value) {
  const rounded = Math.round(value * 100) / 100;
  if (Number.isInteger(rounded)) return group(rounded);
  const [int, frac] = rounded.toFixed(2).split('.');
  return `${group(int)},${frac}`;
}

function percent(value, signed = true) {
  const rounded = Math.round(value * 10) / 10;
  const sign = rounded < 0 ? '−' : (signed && rounded > 0 ? '+' : '');
  return `${sign}${Math.abs(rounded).toFixed(1).replace('.', ',')}%`;
}

// Дневное изменение цены: движения, которые округлились бы до 0,0%, показываем с двумя знаками; знак — по факту
function changePercent(value) {
  const digits = value !== 0 && Math.abs(value) < 0.05 ? 2 : 1;
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(digits).replace('.', ',')}%`;
}

function trendClass(value) {
  return value > 0 ? 'up' : value < 0 ? 'down' : 'flat';
}

function plural(n, [one, few, many]) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

function formatUnits(quantity, unit) {
  const label = unit === 'pai' ? plural(quantity, ['пай', 'пая', 'паёв']) : unit;
  return `${group(quantity)}${NBSP}${label}`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text, onClick) {
  const node = el('button', className, text);
  node.type = 'button';
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

// ===== Графики =====

const SVG_NS = 'http://www.w3.org/2000/svg';

// viewBox 100×100 растягивается под контейнер, толщина линии не масштабируется.
// Цвет — по изменению за последний день (up), по умолчанию по двум последним точкам;
// 'neutral' — тёмный график без оценки (ставка банка в итогах).
const CHART_TONES = {
  up: ['#397E62', 'grad-up'],
  down: ['#C65A4D', 'grad-down'],
  neutral: ['#252925', 'grad-neutral']
};

function drawChart(svg, series, up = !(series[series.length - 1] < series[series.length - 2])) {
  svg.innerHTML = '';
  if (!series.length) return;
  if (series.length === 1) series = [series[0], series[0]];

  const max = Math.max(...series);
  const min = Math.min(...series);
  const range = max - min;
  const line = series.map((v, i) => {
    const x = (i / (series.length - 1)) * 100;
    const y = range ? ((max + 0.12 * range - v) / (1.24 * range)) * 100 : 50;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');

  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');

  const [stroke, gradient] = CHART_TONES[up === 'neutral' ? 'neutral' : up ? 'up' : 'down'];

  const area = document.createElementNS(SVG_NS, 'polygon');
  area.setAttribute('points', `0,100 ${line} 100,100`);
  area.setAttribute('fill', `url(#${gradient})`);

  const path = document.createElementNS(SVG_NS, 'polyline');
  path.setAttribute('points', line);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', stroke);
  path.setAttribute('stroke-width', 1.5);
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('vector-effect', 'non-scaling-stroke');

  svg.append(area, path);
}

function chartElement() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.classList.add('chart');
  return svg;
}

// ===== Уведомления =====

function toast(message, type = '') {
  const box = $('toasts');
  const node = el('div', `toast${type ? ` toast--${type}` : ''}`, message);
  box.append(node);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => node.remove(), 3500);
}

// ===== Цены и тикеры =====

function tickerName(ticker) {
  for (const category of Object.values(CATEGORIES)) {
    for (const slot of category.slots || []) {
      if (game?.tickers[slot.role] === ticker) return slot.name;
    }
  }
  return ticker;
}

function currentPrice(ticker) {
  return Number(prices.getPrice(ticker, game.date)) || 0;
}

function priceSeries(ticker) {
  const history = prices.getHistory(ticker);
  const today = Math.min(prices.getDay(game.date), history.length - 1);
  return history.slice(Math.max(0, today - CHART_DAYS), today + 1).filter((v) => v > 0);
}

// Изменение цены к вчерашнему календарному дню, %. В выходные цена в данных повторяется — будет 0.
function dailyChange(ticker) {
  const history = prices.getHistory(ticker);
  const today = Math.min(prices.getDay(game.date), history.length - 1);
  const current = history[today];
  const previous = history[today - 1];
  return current > 0 && previous > 0 ? ((current - previous) / previous) * 100 : 0;
}

async function loadTickerRows() {
  const response = await fetch('prices/tickers.csv');
  if (!response.ok) throw new Error('Не удалось загрузить tickers.csv');
  const byYear = {};
  for (const line of (await response.text()).split(/\r?\n/)) {
    const [year, name, ticker, , reliable] = line.split(',').map((s) => s.trim());
    if (!/^\d{4}$/.test(year) || !ticker) continue;
    (byYear[year] ||= []).push({ name, ticker, reliable: reliable === '+' });
  }
  return byYear;
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// Строки года в tickers.csv: 1-я — ОФЗ, 2–5 — корпоративные (надёжные) и ВДО, дальше акции,
// в конце банк, золото, доллар и два фонда.
function pickTickers(rows) {
  const has = (ticker) => prices.getHistory(ticker).length > 0;
  const special = new Set(['BANK', 'GLDRUB', 'USD']);
  const bonds = rows.slice(1, 5);
  const funds = rows.filter((r) => r.name.startsWith('Фонд') && has(r.ticker));
  const stocks = shuffle(rows.slice(5).filter((r) => !special.has(r.ticker) && !funds.includes(r) && has(r.ticker)));
  const corp = shuffle(bonds.filter((r) => r.reliable))[0] || bonds[0];
  const vdo = shuffle(bonds.filter((r) => !r.reliable))[0] || bonds[bonds.length - 1];

  const picked = {
    ofz: rows[0], corp, vdo,
    fund1: funds[0], fund2: funds[1],
    stock1: stocks[0], stock2: stocks[1], stock3: stocks[2],
    usd: rows.find((r) => r.ticker === 'USD'),
    gold: rows.find((r) => r.ticker === 'GLDRUB')
  };

  const tickers = { bank: 'BANK' };
  const titles = {};
  for (const [role, row] of Object.entries(picked)) {
    if (!row) continue;
    tickers[role] = row.ticker;
    titles[role] = row.name;
  }
  return { tickers, titles };
}

// ===== Игра =====

function monthIndex(date = game.date) {
  return (date.getFullYear() - game.year) * 12 + date.getMonth() - 8;
}

function sumHistory(...types) {
  return game.history.filter((h) => types.includes(h.type)).reduce((sum, h) => sum + (Number(h.amount) || 0), 0);
}

// Внешние поступления: стартовый капитал, зарплаты, жизненные события
function contributions() {
  return START_CASH + sumHistory('SALARY', 'CASH_CHANGE');
}

function capital() {
  return engine.getTotalValue(game.portfolio);
}

function updateCardAvailability() {
  const month = monthIndex() + 1;
  for (const [key, category] of Object.entries(CATEGORIES)) {
    if (category.opensAt <= month && game.cards[key] === 'locked') game.cards[key] = 'unlock';
  }
}

async function save() {
  try {
    await storage.saveGame(GAME_ID, game);
  } catch (error) {
    console.error('Не удалось сохранить игру:', error);
  }
}

async function createGame(templateKey, player) {
  const template = TEMPLATES[templateKey];
  const byYear = await loadTickerRows();
  const years = Object.keys(byYear);
  const year = years[Math.floor(Math.random() * years.length)];

  prices = await LocalPrices.create(year);
  engine.prices = prices;

  game = {
    year: Number(year),
    date: new Date(Number(year), 8, 1),
    player,
    mode: 'solo',
    template: templateKey,
    dayMs: template.dayMs,
    lifeEvents: template.lifeEvents,
    portfolio: { cash: START_CASH, bankBalance: 0, assets: {}, assetValues: {} },
    history: [],
    monthlyEvents: {},
    pendingEvent: null,
    ...pickTickers(byYear[year]),
    cards: Object.fromEntries(Object.keys(CATEGORIES).map((key) => [key, template.openAll ? 'active' : 'locked'])),
    finished: false
  };
  updateCardAvailability();
  await save();
}

async function loadGame() {
  const saved = await storage.loadGame(GAME_ID);
  if (!saved?.tickers || !saved.year || !saved.cards) return false;
  game = saved;
  prices = await LocalPrices.create(String(game.year));
  engine.prices = prices;
  return true;
}

async function advanceDay() {
  if (!game || game.finished || ui.pause.size) return;

  const previousMonth = monthIndex();
  engine.nextDay(game);

  if (monthIndex() >= MONTHS_TOTAL) {
    finishGame();
  } else if (monthIndex() !== previousMonth) {
    updateCardAvailability();
    renderField();
  }

  renderMonth();
  refresh();
  renderNews();
  if (game.pendingEvent) showLifeEvent(game.pendingEvent);
  await save();
}

// ===== Новости =====

function isoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Псевдонимы только для акций: новости в prices/news.csv касаются компаний-эмитентов акций
async function initNews() {
  const aliases = {};
  for (const slot of CATEGORIES.stocks.slots) {
    const ticker = game.tickers[slot.role];
    if (ticker) aliases[ticker] = slot.name;
  }
  try {
    ui.news = await loadNews(game.year, aliases);
  } catch (error) {
    console.error('Не удалось загрузить новости:', error);
    ui.news = [];
  }
  ui.newsShown = -1;
  renderNews();
}

// Лента: уже наступившие новости, свежие сверху. «Событие 03.2» — игровой месяц и номер новости в нём.
function renderNews() {
  if (!game) return;
  const today = isoDate(game.date);
  const visible = ui.news.filter((n) => n.date <= today);
  if (visible.length === ui.newsShown) return;
  ui.newsShown = visible.length;

  const perMonth = {};
  const items = visible.map((item) => {
    const [y, m, d] = item.date.split('-').map(Number);
    const month = Math.min(MONTHS_TOTAL, Math.max(1, monthIndex(new Date(y, m - 1, d)) + 1));
    perMonth[month] = (perMonth[month] || 0) + 1;
    return { ...item, order: `Событие ${String(month).padStart(2, '0')}.${perMonth[month]}` };
  });

  const box = $('news');
  box.innerHTML = '';
  for (const item of items.reverse()) {
    const article = el('article', 'news__item');
    article.append(el('span', 'm-caption', item.order), el('h3', 't-label', item.title), el('p', '', item.text));
    box.append(article);
  }
  box.scrollTop = 0;
}

function setPaused(reason, paused) {
  if (paused) ui.pause.add(reason);
  else ui.pause.delete(reason);
  document.body.classList.toggle('is-paused', ui.pause.size > 0);
}

// ===== Шапка =====

function renderHeader() {
  $('free-money').textContent = money(game.portfolio.cash);
  $('free-money').classList.toggle('down', Math.round(game.portfolio.cash) < 0);

  const total = capital();
  const isCapital = ui.capitalMode === 'capital';
  const value = $('capital-value');
  const profit = total - contributions();
  value.textContent = isCapital ? money(total) : money(profit, true);
  value.className = `m-metric nowrap ${isCapital ? '' : trendClass(Math.round(profit))}`;
  for (const btn of $('capital-switch').children) {
    btn.classList.toggle('is-active', btn.dataset.mode === ui.capitalMode);
  }
}

// Сегменты дней пересоздаются раз в день: анимация заполнения текущего дня
// запускается заново, а её окончание (animationend) двигает игру на следующий день.
function renderMonth() {
  // После окончания игры дата уже 1 сентября следующего года — показываем заполненный последний месяц
  const date = game.finished ? new Date(game.year + 1, 7, 31) : game.date;
  const index = monthIndex(date);
  const year = date.getFullYear();
  const month = date.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = game.finished ? daysInMonth + 1 : date.getDate();

  $('month-title').textContent = `Месяц ${index + 1} / ${MONTHS_TOTAL}`;

  const days = $('month-days');
  days.innerHTML = '';
  for (let d = 1; d <= daysInMonth; d++) {
    const state = d < today ? ' is-done' : d === today ? ' is-current' : '';
    days.append(el('span', `month__day${state}`));
  }

  const paydays = $('month-paydays');
  paydays.innerHTML = '';
  for (const [day, label] of SALARY_DAYS) {
    const mark = el('span', 'payday', label);
    mark.style.left = `${((day - 0.5) / daysInMonth) * 100}%`;
    paydays.append(mark);
  }
}

// ===== Карточки =====

function refresh() {
  renderHeader();
  ui.updaters.forEach((update) => update());
}

function renderField() {
  ui.updaters = [];
  const field = $('field');
  field.innerHTML = '';
  for (const row of LAYOUT) {
    const rowBox = el('div', 'field__row');
    row.forEach((key) => rowBox.append(renderCategory(key)));
    field.append(rowBox);
  }
}

function renderCategory(key) {
  const category = CATEGORIES[key];
  const box = el('section', 'category raised');
  box.style.flex = `${category.slots ? category.slots.length : 1} 1 0`;
  box.dataset.card = key;

  const state = game.cards[key];
  if (state !== 'active') return renderClosedCategory(key, box, state);

  const title = el('div', 'category__title t-label');
  const help = button('help m-control', '?', () => openLesson(category.lesson));
  help.title = 'Обучение';
  title.append(el('span', '', category.title), help);

  const body = el('div', 'category__body');
  if (key === 'savings') {
    body.append(renderSavings());
  } else {
    category.slots.forEach((slot, i) => {
      if (i > 0) body.append(el('span', 'vsep'));
      body.append(renderInstrument(slot));
    });
  }

  box.append(title, body);
  return box;
}

const LOCK_ICON = '<svg viewBox="0 0 56 56" fill="none" stroke="#8E9788" stroke-width="2.5" stroke-linecap="round"><rect x="13" y="24" width="30" height="22" rx="4"/><path d="M19 24v-6a9 9 0 0 1 18 0v6M28 33v6"/></svg>';
const UNLOCK_ICON = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="4" y="9" width="12" height="8" rx="1.5"/><path d="M7 9V6a3 3 0 0 1 5.8-1.1"/></svg>';

function renderClosedCategory(key, box, state) {
  const category = CATEGORIES[key];
  const isLocked = state === 'locked';
  box.className = `category category--closed category--${state}`;

  const title = el('div', 'category__title');
  title.append(el('span', isLocked ? 't-label' : 't-heading', category.title));

  const access = el('div', 'access');
  if (isLocked) {
    access.innerHTML = LOCK_ICON;
  } else {
    const btn = button('unlock-btn t-label', undefined, () => openLesson(category.lesson, key));
    btn.innerHTML = `${UNLOCK_ICON}<span>Открыть</span>`;
    access.append(btn);
  }

  box.append(title, access);
  return box;
}

// --- Накопительный счёт ---

function bankNetDeposits() {
  return sumHistory('BANK_OPEN') - sumHistory('BANK_WITHDRAW');
}

function renderSavings() {
  return ui.savingsForm ? renderSavingsForm(ui.savingsForm) : renderSavingsDefault();
}

function renderSavingsDefault() {
  const box = el('div', 'instrument');

  const rateBox = el('div');
  const rate = el('div', 'm-metric');
  rateBox.append(el('span', 't-caption flat', 'Ставка'), rate);

  const terms = el('div', 'terms');
  const chart = chartElement();
  terms.append(chart);

  const result = el('div', 'savings-result nowrap');
  const balance = el('span', 'm-body');
  const income = el('span', 'm-body');
  result.append(balance, income);

  const actions = el('div', 'actions');
  const withdraw = button('btn t-label', 'Снять', () => openSavingsForm('withdraw'));
  const deposit = button('btn btn--dark t-label', 'Пополнить', () => openSavingsForm('deposit'));
  actions.append(withdraw, deposit);

  box.append(rateBox, terms, result, actions);

  ui.updaters.push(() => {
    const bankBalance = game.portfolio.bankBalance;
    const earned = bankBalance - bankNetDeposits();
    rate.textContent = percent(currentPrice(game.tickers.bank), false);
    // График — ставка банка за последние 30 дней; цвет — по изменению ставки за день
    drawChart(chart, priceSeries(game.tickers.bank));
    balance.textContent = money(bankBalance);
    income.textContent = money(earned, true);
    income.className = `m-body ${trendClass(Math.round(earned))}`;
    withdraw.disabled = bankBalance <= 0;
    deposit.disabled = game.portfolio.cash <= 0;
  });
  return box;
}

function renderSavingsForm(mode) {
  const isDeposit = mode === 'deposit';
  const box = el('div', 'instrument');

  const head = el('div', 'savings-head');
  const balance = el('span', 'm-metric');
  head.append(el('span', 'm-control', 'Счёт'), balance);

  const form = el('div', 'savings-form');
  const input = el('input', 'amount-input m-body');
  input.inputMode = 'decimal';
  input.placeholder = '0';

  const available = () => (isDeposit ? game.portfolio.cash : game.portfolio.bankBalance);
  const confirm = () => submitSavings(mode, input.value);

  const row = el('div', 'savings-form__row');
  row.append(
    button('t-label', 'Отмена', closeSavingsForm),
    button('m-control', 'MAX', () => {
      input.value = formatPrice(Math.floor(available() * 100) / 100).replaceAll(NBSP, ' ');
      input.focus();
    })
  );

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') confirm();
    if (event.key === 'Escape') closeSavingsForm();
  });

  form.append(
    el('span', 't-caption savings-form__caption', isDeposit ? 'Пополнение счёта' : 'Снятие со счёта'),
    row,
    input,
    button('btn-confirm-small t-label', 'Подтвердить', confirm)
  );

  box.append(head, el('div', 'savings-spacer'), form);
  ui.updaters.push(() => { balance.textContent = money(game.portfolio.bankBalance); });
  requestAnimationFrame(() => input.focus());
  return box;
}

function openSavingsForm(mode) {
  ui.savingsForm = mode;
  renderField();
  refresh();
}

function closeSavingsForm() {
  ui.savingsForm = null;
  renderField();
  refresh();
}

function submitSavings(mode, raw) {
  const amount = Number(String(raw).replace(/[\s ]/g, '').replace(',', '.'));
  if (!(amount > 0)) {
    toast('Введите сумму больше нуля', 'error');
    return;
  }
  try {
    if (mode === 'deposit') engine.openBank(game, amount);
    else engine.withdrawBank(game, amount);
  } catch (error) {
    toast(error.message, 'error');
    return;
  }
  toast(`${mode === 'deposit' ? 'Счёт пополнен' : 'Со счёта снято'}: ${money(amount)}`, 'success');
  closeSavingsForm();
  void save();
}

// --- Инструмент ---

function renderInstrument(slot) {
  const ticker = game.tickers[slot.role];
  const isInactive = slot.inactive || !ticker;
  const box = el('div', `instrument${isInactive ? ' is-inactive' : ''}`);

  const head = el('div');
  const quote = el('div', 'quote');
  const price = el('span', 'm-price', '—');
  const change = el('span', 'm-control flat');
  const defaultBadge = el('span', 'default-badge t-label', 'Дефолт');
  defaultBadge.hidden = true;
  quote.append(price, defaultBadge, change);
  head.append(el('div', 't-label', slot.name), quote);

  const terms = el('div', 'terms');
  const chart = chartElement();
  terms.append(chart);

  const ownership = el('div', 'ownership');
  const holdings = el('div');
  const units = el('span', 'm-control', formatUnits(0, slot.unit));
  holdings.append(el('span', 't-caption', 'У вас'), units);

  const metric = el('div', 'metric');
  const metricValue = el('span', 'm-body', money(0));
  const metricSwitch = button('metric-switch', undefined, () => {
    ui.metricMode[ticker] = ui.metricMode[ticker] === 'profit' ? 'value' : 'profit';
    refresh();
  });
  metricSwitch.innerHTML = '<img src="assets/swap.svg" alt="">';
  metric.append(metricValue, metricSwitch);
  ownership.append(holdings, metric);

  const trade = el('div', 'trade');
  const qty = el('div', 'qty m-caption');
  for (const amount of QUANTITIES) {
    qty.append(button('', amount, () => {
      ui.qty[ticker] = amount;
      refresh();
    }));
  }

  const actions = el('div', 'actions');
  const sell = button('btn t-label', 'Продать', () => tradeAsset(slot, 'sell'));
  const buy = button('btn btn--dark t-label', 'Купить', () => tradeAsset(slot, 'buy'));
  actions.append(sell, buy);
  trade.append(qty, actions);

  box.append(head, terms, ownership, trade);

  if (isInactive) {
    for (const btn of box.querySelectorAll('button')) btn.disabled = true;
    return box;
  }

  ui.updaters.push(() => {
    const current = currentPrice(ticker);
    const delta = dailyChange(ticker);

    // Полный дефолт отключает инструмент: плашка вместо цены, вместо стоимости — итоговый результат
    const defaulted = engine.isDefaulted(ticker, game.date);
    box.classList.toggle('is-defaulted', defaulted);
    price.hidden = defaulted;
    defaultBadge.hidden = !defaulted;
    if (defaulted) {
      const entry = game.portfolio.assetValues[ticker];
      const loss = entry ? entry.value + entry.withdrawn - entry.invested : 0;
      change.textContent = '';
      drawChart(chart, priceSeries(ticker), false);
      units.textContent = formatUnits(0, slot.unit);
      metricValue.textContent = money(loss, true);
      metricValue.className = `m-body ${trendClass(Math.round(loss))}`;
      for (const btn of box.querySelectorAll('button')) btn.disabled = true;
      return;
    }

    price.textContent = current > 0 ? `${formatPrice(current)}${NBSP}₽` : '—';
    change.textContent = current > 0 ? changePercent(delta) : '';
    change.className = `m-control ${trendClass(delta)}`;
    drawChart(chart, priceSeries(ticker), delta >= 0);

    const held = Number(game.portfolio.assets[ticker]) || 0;
    const entry = game.portfolio.assetValues[ticker];
    const value = held * current;
    const profit = entry ? entry.value + entry.withdrawn - entry.invested : 0;
    const showProfit = ui.metricMode[ticker] === 'profit';

    units.textContent = formatUnits(held, slot.unit);
    metricValue.textContent = showProfit ? money(profit, true) : money(value);
    metricValue.className = `m-body ${showProfit ? trendClass(Math.round(profit)) : ''}`;
    metricSwitch.dataset.hint = showProfit ? 'Показать стоимость' : 'Показать результат';

    const selected = ui.qty[ticker] || QUANTITIES[0];
    for (const btn of qty.children) btn.classList.toggle('is-active', btn.textContent === selected);

    sell.disabled = held <= 0;
    buy.disabled = !(current > 0) || game.portfolio.cash < current;
  });
  return box;
}

function tradeAsset(slot, action) {
  const ticker = game.tickers[slot.role];
  const current = currentPrice(ticker);
  const held = Number(game.portfolio.assets[ticker]) || 0;
  const selected = ui.qty[ticker] || QUANTITIES[0];
  const isBuy = action === 'buy';

  let amount = Number(selected);
  if (selected === 'MAX') amount = isBuy ? Math.floor(game.portfolio.cash / current) : held;

  if (isBuy && (amount <= 0 || amount * current > game.portfolio.cash)) {
    toast(`Недостаточно средств: нужно ${money(Math.max(amount, 1) * current)}`, 'error');
    return;
  }
  if (!isBuy && amount > held) {
    toast(`У вас только ${formatUnits(held, slot.unit)}`, 'error');
    return;
  }

  try {
    if (isBuy) engine.buyAsset(game, ticker, amount);
    else engine.sellAsset(game, ticker, amount);
  } catch (error) {
    toast(error.message, 'error');
    return;
  }

  toast(`${isBuy ? 'Куплено' : 'Продано'}: ${slot.name}, ${formatUnits(amount, slot.unit)}`, 'success');
  refresh();
  void save();
}

// ===== Обучение =====

function renderBlock(block) {
  const box = el('section', `section${block.example ? ' section--example' : ''}`);
  box.append(el('h2', 't-heading', block.h));
  if (block.sub) box.append(el('h3', 't-label', block.sub));
  for (const paragraph of block.text || []) box.append(el('p', '', paragraph));
  for (const [label, text] of block.points || []) {
    const point = el('div', 'point');
    point.append(el('span', 't-label', label), el('p', '', text));
    box.append(point);
  }
  return box;
}

// unlocking — ключ категории, которая откроется после прохождения обучения
function openLesson(key, unlocking = ui.lesson?.unlocking ?? null) {
  const lesson = lessons[key];
  ui.lesson = { key, unlocking };

  $('learn-title').textContent = lesson.title;
  const risk = $('learn-risk');
  risk.textContent = riskNames[lesson.risk];
  risk.className = `risk t-label risk--${lesson.risk}`;

  const tabs = $('learn-tabs');
  tabs.innerHTML = '';
  tabs.hidden = !lesson.tabs;
  for (const [tabKey, label] of lessonTabs[lesson.tabs] || []) {
    tabs.append(button(tabKey === key ? 'is-active' : '', label, () => openLesson(tabKey)));
  }

  const columns = el('div', 'learn__columns');
  for (const side of ['left', 'right']) {
    if (side === 'right') columns.append(el('span', 'vsep'));
    const column = el('div', 'learn__column');
    lesson[side].forEach((block) => column.append(renderBlock(block)));
    columns.append(column);
  }
  const body = $('learn-body');
  body.innerHTML = '';
  body.scrollTop = 0;
  body.append(columns);

  $('learn').hidden = false;
  document.body.classList.add('is-learning');
  setPaused('lesson', true);
}

function closeLesson() {
  if (!ui.lesson) return;
  const { unlocking } = ui.lesson;
  ui.lesson = null;

  $('learn').hidden = true;
  document.body.classList.remove('is-learning');
  setPaused('lesson', false);

  if (unlocking && game.cards[unlocking] === 'unlock') {
    game.cards[unlocking] = 'active';
    renderField();
    refresh();
    void save();
  }
}

// ===== Модальное окно (Life Event / Modal) =====

let onModalConfirm = null;

function showModal({ type, typeClass, icon, title, amount, amountClass, text, buttonText, onConfirm }) {
  $('modal-type').textContent = type;
  $('modal-type').className = `t-label ${typeClass}`;
  $('modal-icon').textContent = icon;
  $('modal-title').textContent = title;
  $('modal-amount').textContent = amount;
  $('modal-amount').className = `life-event__amount ${amountClass}`;
  $('modal-text').textContent = text;
  $('modal-confirm').textContent = buttonText;
  onModalConfirm = onConfirm;
  $('modal').hidden = false;
  setPaused('modal', true);
}

function closeModal() {
  $('modal').hidden = true;
  const callback = onModalConfirm;
  onModalConfirm = null;
  setPaused('modal', false);
  callback?.();
}

function showLifeEvent(event) {
  const isIncome = event.amount > 0;
  showModal({
    type: isIncome ? 'Неожиданный доход' : 'Непредвиденный расход',
    typeClass: isIncome ? 'up' : 'down',
    icon: event.icon,
    title: event.title,
    amount: money(event.amount, true),
    amountClass: isIncome ? 'up' : 'down',
    text: event.text,
    buttonText: event.buttonText || 'Понятно!',
    onConfirm: () => {
      engine.changeCash(game, event.amount);
      game.pendingEvent = null;
      refresh();
      void save();
    }
  });
}

function finishGame() {
  game.finished = true;
  setPaused('finished', true);
  renderFinal();
  document.body.classList.add('is-final');
  $('final').scrollTop = 0;
}

// ===== Итоги года =====

// Цвета групп в полосе «Структура активов»: счёт, облигации, ПИФы, акции, валюта, золото, свободные деньги
const GROUP_COLORS = ['#252925', '#3A4238', '#8E9788', '#AEB8A8', '#DDE4D7', '#D9F477', '#EDF1E7'];

// Строки отчёта в порядке легенды: стоимость на конец игры и денежный результат за весь период
function finalRows() {
  const { portfolio } = game;
  const rows = [{
    role: 'savings',
    title: 'Накопительный счёт',
    short: 'Накопительный',
    group: 0,
    value: portfolio.bankBalance,
    invested: sumHistory('BANK_OPEN'),
    result: portfolio.bankBalance - bankNetDeposits()
  }];

  const groups = { bonds: 1, funds: 2, stocks: 3, currency: 4, gold: 5 };
  for (const [key, group] of Object.entries(groups)) {
    for (const slot of CATEGORIES[key].slots) {
      const entry = portfolio.assetValues[game.tickers[slot.role]];
      rows.push({
        role: slot.role,
        title: slot.title || slot.name,
        short: slot.short || slot.title || slot.name,
        group,
        value: entry?.value || 0,
        invested: entry?.invested || 0,
        result: entry ? entry.value + entry.withdrawn - entry.invested : 0
      });
    }
  }

  rows.push({ role: 'cash', title: 'Свободные деньги', group: 6, value: portfolio.cash, result: null });
  return rows;
}

function renderFinal() {
  const total = capital();
  const profit = total - contributions();
  const events = sumHistory('CASH_CHANGE');

  $('final-capital').textContent = money(total);
  $('final-profit').textContent = money(profit, true);
  $('final-profit').className = `summary__profit ${trendClass(Math.round(profit))}`;
  $('final-wages').textContent = money(START_CASH + sumHistory('SALARY'));
  $('final-events').textContent = money(events, true);
  $('final-events').className = `m-metric ${Math.round(events) < 0 ? 'down' : ''}`;
  $('final-rank').classList.toggle('is-hidden', game.mode !== 'multi');

  const rows = finalRows();
  renderComposition(rows, total);
  renderLegend(rows, total);
  renderResults(rows);
  renderHistory();
}

function renderComposition(rows, total) {
  const box = $('final-composition');
  box.innerHTML = '';
  const byGroup = GROUP_COLORS.map((_, group) => rows.filter((r) => r.group === group).reduce((s, r) => s + r.value, 0));
  byGroup.forEach((value, group) => {
    if (value <= 0 || total <= 0) return;
    const segment = el('span');
    segment.style.flex = `${value / total} 1 0`;
    segment.style.background = GROUP_COLORS[group];
    segment.title = `${money(value)} · ${percent((value / total) * 100, false)}`;
    box.append(segment);
  });
}

// Легенда в три колонки, порядок по строкам: i-й элемент уходит в колонку i % 3
function renderLegend(rows, total) {
  const box = $('final-legend');
  box.innerHTML = '';
  const columns = [0, 1, 2].map(() => el('div', 'legend__column'));
  rows.forEach((row, i) => {
    const item = el('div', 'legend__item');
    const marker = el('span', 'marker');
    marker.style.background = GROUP_COLORS[row.group];
    item.append(
      marker,
      el('span', '', row.title),
      el('span', `legend__value m-control ${Math.round(row.value) < 0 ? 'down' : ''}`, money(row.value)),
      el('span', 'legend__share m-caption', percent(total > 0 ? (row.value / total) * 100 : 0, false))
    );
    columns[i % 3].append(item);
  });
  columns.forEach((column, i) => {
    if (i > 0) box.append(el('span', 'vsep'));
    box.append(column);
  });
}

// Два рейтинга инструментов: в рублях и в % от вложенного
function renderResults(rows) {
  const used = rows.filter((r) => r.result !== null && Math.round(r.result) !== 0);
  renderResultColumns('final-gains', 'final-losses', used.map((r) => ({ ...r, score: r.result })), (v) => money(v, true));

  const withPercent = used
    .map((r) => ({ ...r, score: r.invested > 0 ? (r.result / r.invested) * 100 : null }))
    .filter((r) => r.score !== null);
  renderResultColumns('final-gains-pct', 'final-losses-pct', withPercent, (v) => percent(v));
}

// Прибыльные — по убыванию, убыточные — по убыванию модуля; ширина бара — доля от максимального модуля.
// Выбросы обрезаем: шкала не больше 3 медиан, бары длиннее — во всю ширину (значение пишется как есть).
function resultScale(list) {
  const values = list.map((r) => Math.abs(r.score)).sort((a, b) => a - b);
  if (!values.length) return 1;
  const median = values[Math.floor(values.length / 2)];
  return Math.max(Number.EPSILON, Math.min(values[values.length - 1], median * 3));
}

function renderResultColumns(gainsId, lossesId, list, format) {
  const scale = resultScale(list);
  const fill = (id, items) => {
    const box = $(id);
    box.innerHTML = '';
    for (const row of items) {
      const line = el('div', 'result');
      const track = el('div', 'result__track');
      const bar = el('span', 'result__bar');
      bar.style.width = `${Math.min(1, Math.abs(row.score) / scale) * 100}%`;
      bar.style.background = row.score > 0 ? 'var(--up)' : 'var(--down)';
      track.append(bar);
      line.append(
        el('span', 'result__name', row.short),
        track,
        el('span', `result__value m-body ${trendClass(row.score)}`, format(row.score))
      );
      box.append(line);
    }
  };
  fill(gainsId, list.filter((r) => r.score > 0).sort((a, b) => b.score - a.score));
  fill(lossesId, list.filter((r) => r.score < 0).sort((a, b) => a.score - b.score));
}

// Реальные инструменты партии: название, тикер, изменение за игровой год и график по неделям
function renderHistory() {
  $('final-period').textContent = `Исторический период — ${game.year} год`;
  const grid = $('final-history');
  grid.innerHTML = '';

  const start = prices.getDay(new Date(game.year, 8, 1));
  const end = prices.getDay(new Date(game.year + 1, 7, 31));
  const weekly = (history) => history.slice(start, end + 1).filter((v, i, list) => v > 0 && (i % 7 === 0 || i === list.length - 1));

  const cards = [{ role: 'bank', title: 'Накопительный счёт', ticker: game.tickers.bank, isRate: true }];
  for (const key of ['bonds', 'funds', 'stocks', 'currency', 'gold']) {
    for (const slot of CATEGORIES[key].slots) {
      const ticker = game.tickers[slot.role];
      if (!ticker || slot.inactive) continue;
      cards.push({ role: slot.role, title: game.titles[slot.role] || ticker, slotName: slot.title || slot.name, ticker });
    }
  }

  for (const card of cards) {
    const series = weekly(prices.getHistory(card.ticker));
    const first = series[0] || 0;
    const last = series[series.length - 1] || 0;

    const box = el('article', 'history-card raised');
    const head = el('div', 'history-card__head');
    const identity = el('div', 'history-card__identity');
    identity.append(
      el('h3', 't-heading', card.title),
      el('span', 'm-caption', card.slotName ? `${card.slotName} · ${card.ticker}` : card.ticker)
    );

    const metric = el('div', 'history-card__metric');
    if (card.isRate) {
      const delta = last - first;
      metric.append(
        el('span', 'm-metric', `${delta > 0 ? '+' : delta < 0 ? '−' : ''}${Math.abs(delta).toFixed(1).replace('.', ',')}${NBSP}п.п.`),
        el('span', 't-caption', 'ставка'),
        el('span', 't-caption', `${percent(first, false)} → ${percent(last, false)}`)
      );
    } else {
      const change = first > 0 ? ((last - first) / first) * 100 : 0;
      metric.append(
        el('span', `m-metric ${trendClass(Math.round(change * 10))}`, first > 0 ? percent(change) : '—'),
        el('span', 't-caption', 'цена за период')
      );
    }
    head.append(identity, metric);

    const chart = chartElement();
    drawChart(chart, series, card.isRate ? 'neutral' : last >= first);
    box.append(head, chart);
    grid.append(box);
  }
}

// ===== Запуск =====

function renderAll() {
  document.documentElement.style.setProperty('--day-ms', `${game.dayMs || TEMPLATES.training.dayMs}ms`);
  const player = game.player || 'Игрок';
  $('player-name').textContent = player;
  $('rating').classList.toggle('is-hidden', game.mode !== 'multi');
  $('player-initial').textContent = player[0].toUpperCase();
  renderField();
  renderMonth();
  refresh();
  void initNews();
}

// После окончания игры — новая партия с выбора режима (имя уже известно)
async function restart() {
  closeLessonSilently();
  await storage.deleteGame(GAME_ID);
  ui.savingsForm = null;
  setPaused('finished', false);
  document.body.classList.remove('is-final');
  game = null;
  $('field').innerHTML = '';
  $('month-days').innerHTML = '';
  $('news').innerHTML = '';
  ui.news = [];
  showEntry(playerName() ? 'mode' : 'start');
}

// ===== Вступительные экраны =====

const ENTRY_PAGES_WITH_NAME = ['mode', 'solo', 'multi'];
let selectedTemplate = 'training';

function playerName() {
  try {
    return localStorage.getItem(PLAYER_KEY) || '';
  } catch {
    return '';
  }
}

function showEntry(page) {
  document.body.classList.add('is-entry');
  setPaused('entry', true);
  for (const node of document.querySelectorAll('.entry__page')) {
    node.classList.toggle('is-active', node.dataset.page === page);
  }
  $('entry-meta').textContent = ENTRY_PAGES_WITH_NAME.includes(page) && playerName() ? playerName() : 'Финансовая игра';

  if (page === 'name') {
    const input = $('name-input');
    input.value = playerName();
    $('name-submit').disabled = !input.value.trim();
    requestAnimationFrame(() => input.focus());
  }
  if (page === 'solo') renderTemplates();
}

function hideEntry() {
  document.body.classList.remove('is-entry');
  setPaused('entry', false);
}

function renderTemplates() {
  for (const card of $('templates').children) {
    const isSelected = card.dataset.template === selectedTemplate;
    card.classList.toggle('is-selected', isSelected);
    card.querySelector('.choice__action').textContent = isSelected ? 'Выбрано' : 'Выбрать →';
  }
}

async function startNewGame() {
  const button = $('start-game');
  button.disabled = true;
  try {
    await createGame(selectedTemplate, playerName() || 'Игрок');
  } catch (error) {
    console.error('Не удалось создать игру:', error);
    toast('Не удалось загрузить данные игры', 'error');
    return;
  } finally {
    button.disabled = false;
  }
  hideEntry();
  renderAll();
}

function bindEntry() {
  for (const node of document.querySelectorAll('[data-go]')) {
    node.addEventListener('click', () => showEntry(node.dataset.go));
  }

  const input = $('name-input');
  input.addEventListener('input', () => { $('name-submit').disabled = !input.value.trim(); });
  $('name-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    try {
      localStorage.setItem(PLAYER_KEY, name);
    } catch (error) {
      console.warn('Не удалось сохранить имя игрока:', error);
    }
    showEntry('mode');
  });

  $('templates').addEventListener('click', (event) => {
    const card = event.target.closest('[data-template]');
    if (!card) return;
    selectedTemplate = card.dataset.template;
    renderTemplates();
  });

  $('start-game').addEventListener('click', () => void startNewGame());
}

function closeLessonSilently() {
  ui.lesson = null;
  $('learn').hidden = true;
  document.body.classList.remove('is-learning');
  setPaused('lesson', false);
}

function bindStaticControls() {
  bindEntry();

  $('month-days').addEventListener('animationend', (event) => {
    if (event.animationName === 'day-fill') void advanceDay();
  });

  $('capital-switch').addEventListener('click', (event) => {
    const mode = event.target.closest('button')?.dataset.mode;
    if (!mode) return;
    ui.capitalMode = mode;
    renderHeader();
  });

  $('learn-close').addEventListener('click', closeLesson);
  $('modal-confirm').addEventListener('click', closeModal);
  $('final-restart').addEventListener('click', () => void restart());

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('learn').hidden) closeLesson();
  });

  document.addEventListener('visibilitychange', () => setPaused('hidden', document.hidden));
}

// Сохранённая партия продолжается сразу, иначе — вступительные экраны
async function init() {
  bindStaticControls();
  let loaded = false;
  try {
    loaded = await loadGame();
  } catch (error) {
    console.error('Не удалось загрузить сохранение:', error);
  }
  if (!loaded) {
    showEntry('start');
    return;
  }

  renderAll();
  if (game.finished) finishGame();
  else if (game.pendingEvent) showLifeEvent(game.pendingEvent);
}

// ===== Консоль =====
// setCardState('bonds', 'locked') | setCardState('all', 'unlock') | cardStates()
// game.pause() | game.resume() | game.nextDay() | game.finish() | game.restart()
// Полный список с описанием — в README.md

// Мгновенное завершение: итоги по текущему портфелю, незакрытое жизненное событие отменяется
function finishNow() {
  if (!game) {
    console.warn('Игра ещё не начата');
    return;
  }
  if (game.finished) return;
  closeLessonSilently();
  $('modal').hidden = true;
  onModalConfirm = null;
  setPaused('modal', false);
  game.pendingEvent = null;
  finishGame();
  void save();
}

function setCardState(key, cardState) {
  if (!game) {
    console.warn('Игра ещё не начата');
    return;
  }
  if (!CARD_STATES.includes(cardState)) {
    console.warn(`Неизвестное состояние: ${cardState}. Доступны: ${CARD_STATES.join(', ')}`);
    return;
  }
  const keys = key === 'all' ? Object.keys(CATEGORIES) : [key];
  for (const k of keys) {
    if (!CATEGORIES[k]) {
      console.warn(`Неизвестная карточка: ${k}. Доступны: all, ${Object.keys(CATEGORIES).join(', ')}`);
      return;
    }
    game.cards[k] = cardState;
  }
  renderField();
  refresh();
  void save();
  return cardStates();
}

function cardStates() {
  return { ...game.cards };
}

Object.assign(window, {
  setCardState,
  cardStates,
  game: {
    data: () => game,
    engine,
    prices: () => prices,
    pause: () => setPaused('console', true),
    resume: () => setPaused('console', false),
    nextDay: () => {
      const paused = new Set(ui.pause);
      ui.pause.clear();
      return advanceDay().finally(() => paused.forEach((reason) => ui.pause.add(reason)));
    },
    finish: finishNow,
    restart
  }
});

init();
