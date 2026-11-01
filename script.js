import { GameEngine } from './core/GameEngine.js';
import { LocalStorageAdapter } from './core/LocalStorageAdapter.js';
import { LocalPrices } from './prices/LocalPrices.js';
import { lessons, lessonTabs, riskNames } from './lessons.js';
import { introSteps } from './intro.js';
import { loadNews } from './news.js';
import { MultiplayerClient, multiplayerUrl } from './multiplayer.js';
import {
  CATEGORIES, LOBBY_MAX_PLAYERS, MONTHS_TOTAL, ROOM_CODE_LENGTH, START_CASH, TEMPLATES,
  categoryIsOpen, initialCards, monthIndex as gameMonthIndex, newPortfolio, parseTickerRows,
  pickTickers, playerReport, slotName, tickerDisplayName
} from './core/setup.js';

// ===== Настройки =====

const GAME_ID = 'player';       // одно сохранение на браузер
const PLAYER_KEY = 'copilka-player-name';
const ROOM_KEY = 'copilka-room';  // { code, token } текущей комнаты мультиплеера
const SALARY_DAYS = [[10, 'Аванс'], [25, 'Зарплата']];
const MONTH_NAMES = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const CHART_DAYS = 30;          // окно мини-графиков и изменения цены
const MARKET_INDEX = 'MCFTR';   // индекс Мосбиржи полной доходности: только для сравнения, в tickers.csv его нет
const QUANTITIES = ['1', '25', '50', 'MAX'];
const CARD_STATES = ['active', 'locked', 'unlock'];
// В мультиплеере время идёт у всех одинаково: эти причины его не останавливают
const LOCAL_PAUSES = ['lesson', 'modal', 'hidden'];

// Ряды игрового поля
const LAYOUT = [
  ['savings', 'bonds'],
  ['funds', 'currency', 'gold'],
  ['stocks']
];

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
  pause: new Set(),     // причины паузы: lesson, modal, hidden, console, finished, intro
  intro: null,          // { step, waiting } — идёт вводное обучение
  introStatus: null,    // мультиплеер: { ready, total } — сколько игроков его закончили
  updaters: [],         // обновление значений карточек без перестройки DOM
  news: [],             // новости игрового года (с псевдонимами), по возрастанию даты
  newsShown: 0,         // сколько новостей уже выведено в ленту
  eventQueue: []        // мультиплеер: жизненные события, которые игрок ещё не видел
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

function instrumentName(slot) {
  return slotName(game.tickers, slot);
}

function tickerName(ticker) {
  return tickerDisplayName(game?.tickers, ticker);
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
  return parseTickerRows(await response.text());
}

// ===== Игра =====

function isMulti() {
  return game?.mode === 'multi';
}

function monthIndex(date = game.date) {
  return gameMonthIndex(date, game.year);
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

// Возвращает true, если какая-то карточка стала доступна
function updateCardAvailability() {
  let changed = false;
  for (const [key, category] of Object.entries(CATEGORIES)) {
    if (categoryIsOpen(category, game.date, game.year) && game.cards[key] === 'locked') {
      game.cards[key] = 'unlock';
      changed = true;
    }
  }
  return changed;
}

async function save() {
  // Партию мультиплеера хранит сервер; одиночное сохранение она не затирает
  if (isMulti()) return;
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
    portfolio: newPortfolio(),
    history: [],
    monthlyEvents: {},
    pendingEvent: null,
    ...pickTickers(byYear[year], prices),
    cards: initialCards(template),
    introPending: template.intro,
    finished: false
  };
  updateCardAvailability();
  await save();
}

async function loadGame() {
  const saved = await storage.loadGame(GAME_ID);
  if (!saved?.tickers || !saved.year || !saved.cards) return false;
  prices = await LocalPrices.create(String(saved.year));
  // Выпуск из сохранения мог быть заменён в новых данных: такую партию продолжить нельзя
  const held = [...Object.values(saved.tickers), ...Object.keys(saved.portfolio?.assets || {})];
  if (held.some((ticker) => !prices.getHistory(ticker).length)) return false;
  game = saved;
  engine.prices = prices;
  await addMissingStock();
  return true;
}

// В старых сохранениях акций три: добираем четвёртую, которой ещё нет в партии
async function addMissingStock() {
  if (game.tickers.stock4) return;
  const byYear = await loadTickerRows();
  const { tickers, titles } = pickTickers(byYear[game.year], prices);
  const held = Object.values(game.tickers);
  const role = ['stock1', 'stock2', 'stock3', 'stock4'].find((r) => tickers[r] && !held.includes(tickers[r]));
  if (!role) return;
  game.tickers.stock4 = tickers[role];
  game.titles.stock4 = titles[role];
}

async function advanceDay() {
  // В мультиплеере дни приходят с сервера (applyTick)
  if (!game || game.finished || isMulti() || ui.pause.size) return;

  engine.nextDay(game);

  if (monthIndex() >= MONTHS_TOTAL) {
    finishGame();
  } else if (updateCardAvailability()) {
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
    if (ticker) aliases[ticker] = instrumentName(slot);
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
  if (paused && isMulti() && LOCAL_PAUSES.includes(reason)) return;
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
  const date = lastShownDate();
  const year = date.getFullYear();
  const month = date.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = game.finished ? daysInMonth + 1 : date.getDate();

  renderMonthTitle();

  const days = $('month-days');
  days.innerHTML = '';
  for (let d = 1; d <= daysInMonth; d++) {
    const state = d < today ? ' is-done' : d === today ? ' is-current' : '';
    days.append(el('span', `month__day${state}`));
  }
  renderPaydays($('month-paydays'), daysInMonth);
}

function lastShownDate() {
  return game.finished ? new Date(game.year + 1, 7, 31) : game.date;
}

function renderPaydays(box, daysInMonth) {
  box.innerHTML = '';
  for (const [day, label] of SALARY_DAYS) {
    const mark = el('span', 'payday', label);
    mark.style.left = `${((day - 0.5) / daysInMonth) * 100}%`;
    box.append(mark);
  }
}

function renderMonthTitle() {
  const date = lastShownDate();
  const status = ui.pause.has('connection') ? ' · нет связи' : ui.pause.has('server') ? ' · пауза' : '';
  $('month-title').textContent = `${date.getDate()} ${MONTH_NAMES[date.getMonth()]} (${monthIndex(date) + 1}/${MONTHS_TOTAL})${status}`;
}

// ===== Карточки =====

function refresh() {
  renderHeader();
  renderMarket();
  ui.updaters.forEach((update) => update());
}

// Индекс Мосбиржи: как у инструментов — окно графика CHART_DAYS, процент и цвет по изменению за день
function renderMarket() {
  const delta = dailyChange(MARKET_INDEX);
  $('market-change').textContent = changePercent(delta);
  $('market-change').className = `m-metric ${trendClass(delta)}`;
  drawChart($('market-chart'), priceSeries(MARKET_INDEX), delta >= 0);
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
  if (isMulti()) {
    void submitMultiSavings(mode, amount);
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
  const isInactive = !ticker;
  const box = el('div', `instrument${isInactive ? ' is-inactive' : ''}`);

  const head = el('div');
  const quote = el('div', 'quote');
  const price = el('span', 'm-price', '—');
  const change = el('span', 'm-control flat');
  const defaultBadge = el('span', 'default-badge t-label', 'Дефолт');
  defaultBadge.hidden = true;
  quote.append(price, defaultBadge, change);
  head.append(el('div', 't-label', instrumentName(slot)), quote);

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

  if (isMulti()) {
    void tradeMulti(slot, action, selected === 'MAX' ? 'MAX' : amount);
    return;
  }

  try {
    if (isBuy) engine.buyAsset(game, ticker, amount);
    else engine.sellAsset(game, ticker, amount);
  } catch (error) {
    toast(error.message, 'error');
    return;
  }

  toast(`${isBuy ? 'Куплено' : 'Продано'}: ${instrumentName(slot)},${formatUnits(amount, slot.unit)}`, 'success');
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

function lessonColumns(lesson) {
  const columns = el('div', 'learn__columns');
  for (const side of ['left', 'right']) {
    if (side === 'right') columns.append(el('span', 'vsep'));
    const column = el('div', 'learn__column');
    lesson[side].forEach((block) => column.append(renderBlock(block)));
    columns.append(column);
  }
  return columns;
}

// unlocking — ключ категории, которая откроется после прохождения обучения
function openLesson(key, unlocking = ui.lesson?.unlocking ?? null) {
  const lesson = lessons[key];
  ui.lesson = { key, unlocking };

  $('learn-title').textContent = lesson.title;
  $('learn-subtitle').textContent = lesson.subtitle;
  const risk = $('learn-risk');
  risk.textContent = riskNames[lesson.risk];
  risk.className = `risk t-label risk--${lesson.risk}`;

  const tabs = $('learn-tabs');
  tabs.innerHTML = '';
  tabs.hidden = !lesson.tabs;
  for (const [tabKey, label] of lessonTabs[lesson.tabs] || []) {
    tabs.append(button(tabKey === key ? 'is-active' : '', label, () => openLesson(tabKey)));
  }

  const body = $('learn-body');
  body.innerHTML = '';
  body.scrollTop = 0;
  body.append(lessonColumns(lesson));

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
    if (isMulti()) net?.send({ type: 'card', key: unlocking });
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
      // В мультиплеере сервер уже применил событие: окно только сообщает о нём
      if (isMulti()) {
        showNextLifeEvent();
        return;
      }
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
  updateCompactSummary();
}

// Компактная сводка показывается под шапкой, когда большая полностью ушла под неё
function updateCompactSummary() {
  const passed = $('final-summary').getBoundingClientRect().bottom <= $('final-header').getBoundingClientRect().bottom;
  $('final-compact').classList.toggle('is-visible', passed);
}

// ===== Итоги года =====

// Цвета групп в полосе «Структура активов»: счёт, облигации, ПИФы, акции, валюта, золото, свободные деньги
const GROUP_COLORS = ['#252925', '#3A4238', '#8E9788', '#AEB8A8', '#DDE4D7', '#D9F477', '#EDF1E7'];

// Если бы все поступления (старт, зарплаты, жизненные события) в день получения шли в индекс:
// его стоимость на конец игры и доходность относительно этих поступлений, как у «Заработано на инвестициях»
function marketBenchmark() {
  const indexPrice = (date) => Number(prices.getPrice(MARKET_INDEX, date)) || 0;
  const inflows = game.history.filter((h) => h.type === 'SALARY' || h.type === 'CASH_CHANGE');
  let units = START_CASH / indexPrice(new Date(game.year, 8, 1));
  // У жизненных событий (CASH_CHANGE) дата лежит в поле day
  for (const h of inflows) units += (Number(h.amount) || 0) / indexPrice(new Date(h.date ?? h.day));

  const value = units * indexPrice(game.date);
  const invested = contributions();
  return { value, change: invested > 0 ? ((value - invested) / invested) * 100 : 0 };
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
  $('final-rank').classList.toggle('is-hidden', !isMulti());
  $('final-rank-place').textContent = isMulti() ? `${game.rank}-е место` : '—';
  $('final-rank-total').textContent = isMulti() ? `из ${game.playersTotal} ${plural(game.playersTotal, ['участника', 'участников', 'участников'])}` : 'из —';

  $('final-compact-capital').textContent = money(total);
  $('final-compact-profit').textContent = money(profit, true);
  $('final-compact-profit').className = `m-metric ${trendClass(Math.round(profit))}`;
  $('final-compact-rank').hidden = !isMulti();
  $('final-compact-place').textContent = isMulti() ? `${game.rank}-е из ${game.playersTotal}` : '';

  const market = marketBenchmark();
  $('final-market').textContent = `${money(market.value)} (${percent(market.change)})`;
  const marketTrend = trendClass(Math.round(market.change * 10));
  $('final-market').className = `m-metric ${marketTrend === 'up' ? 'summary__accent' : marketTrend === 'down' ? 'down' : ''}`;

  const { rows } = playerReport(game.portfolio, game.history, game.tickers);
  renderComposition($('final-composition'), rows, total);
  renderLegend(rows, total);
  renderResults(rows);
  renderLeaderboard();
  renderHistory();
}

function renderComposition(box, rows, total) {
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
  renderResultColumns($('final-gains'), $('final-losses'), used.map((r) => ({ ...r, score: r.result })), (v) => money(v, true));

  const withPercent = used
    .map((r) => ({ ...r, score: r.invested > 0 ? (r.result / r.invested) * 100 : null }))
    .filter((r) => r.score !== null);
  renderResultColumns($('final-gains-pct'), $('final-losses-pct'), withPercent, (v) => percent(v));
}

// Прибыльные — по убыванию, убыточные — по убыванию модуля; ширина бара — доля от максимального модуля.
// Выбросы обрезаем: шкала не больше 3 медиан, бары длиннее — во всю ширину (значение пишется как есть).
function resultScale(list) {
  const values = list.map((r) => Math.abs(r.score)).sort((a, b) => a - b);
  if (!values.length) return 1;
  const median = values[Math.floor(values.length / 2)];
  return Math.max(Number.EPSILON, Math.min(values[values.length - 1], median * 3));
}

function renderResultColumns(gainsBox, lossesBox, list, format) {
  const scale = resultScale(list);
  const fill = (box, items) => {
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
  const losses = list.filter((r) => r.score < 0).sort((a, b) => a.score - b.score);
  fill(gainsBox, list.filter((r) => r.score > 0).sort((a, b) => b.score - a.score));
  fill(lossesBox, losses);
  // Без убытков левая колонка занимает всю ширину
  lossesBox.hidden = !losses.length;
  lossesBox.previousElementSibling.hidden = !losses.length;
}

// ===== Итоговый рейтинг =====
// Приходит с сервера в конце партии: те же строки отчёта для каждого участника

function renderLeaderboard() {
  const players = isMulti() ? game.leaderboard : null;
  $('final-leaderboard').hidden = !players;
  if (!players) return;
  $('final-leaderboard-count').textContent = `${players.length} ${plural(players.length, ['участник', 'участника', 'участников'])}`;
  $('final-leaderboard-rows').replaceChildren(...players.map((player) => leaderRow(player, player.id === game.selfId)));
}

function leaderRow(player, isSelf) {
  const item = el('div', 'leader');
  const identity = el('span', 'leader__player');
  if (isSelf) identity.append(el('span', 'lobby__self'));
  identity.append(el('span', 'leader__name', isSelf ? `${player.name} · Ты` : player.name));

  let details = null;
  const head = button('leader__head leader__grid', undefined, () => {
    details ??= item.appendChild(leaderDetails(player));
    const isOpen = item.classList.toggle('is-open');
    details.hidden = !isOpen;
    head.setAttribute('aria-expanded', String(isOpen));
  });
  head.setAttribute('aria-expanded', 'false');
  head.append(
    el('span', 'm-body', String(player.rank)),
    identity,
    el('span', 'm-body leader__number', money(player.capital)),
    el('span', `m-body leader__number ${trendClass(Math.round(player.profit))}`, money(player.profit, true)),
    el('span', 'leader__chevron')
  );
  item.append(head);
  return item;
}

function leaderMetric(label, value, className = '') {
  const box = el('div', 'leader__metric');
  box.append(el('span', 'summary__small entry__muted', label), el('span', `m-metric ${className}`, value));
  return box;
}

function leaderDetails({ capital, profit, rows }) {
  const box = el('div', 'leader__details');
  const metrics = el('div', 'leader__metrics');
  metrics.append(
    leaderMetric('Итоговый капитал', money(capital)),
    leaderMetric('Заработано на инвестициях', money(profit, true), trendClass(Math.round(profit)))
  );

  const analysis = el('div', 'leader__analysis');
  const composition = el('div', 'composition composition--small');
  renderComposition(composition, rows, capital);

  const table = el('div', 'leader__table');
  const header = el('div', 'leader__table-row t-label entry__muted');
  header.append(el('span', 'leader__table-title', 'Инструмент'), el('span', 'leader__number', 'В портфеле'), el('span', 'leader__number', 'Доля'), el('span', 'leader__number', 'Результат за игру'));
  table.append(header);
  for (const row of rows) {
    const line = el('div', 'leader__table-row leader__table-row--line');
    const marker = el('span', 'marker');
    marker.style.background = GROUP_COLORS[row.group];
    const result = row.result === null
      ? el('span', 'm-body leader__number flat', '—')
      : el('span', `m-body leader__number ${trendClass(Math.round(row.result))}`, money(row.result, true));
    line.append(
      marker,
      el('span', 'summary__small', row.title),
      el('span', `m-body leader__number ${Math.round(row.value) < 0 ? 'down' : ''}`, money(row.value)),
      el('span', 'm-body leader__number flat', percent(capital > 0 ? (row.value / capital) * 100 : 0, false)),
      result
    );
    table.append(line);
  }

  analysis.append(el('h3', 't-heading', 'Портфель и результаты'), composition, table);
  box.append(metrics, el('div', 'report__rule'), analysis);
  return box;
}

// Реальные инструменты партии: название, тикер, изменение за игровой год и график по неделям
function renderHistory() {
  $('final-period').textContent = `Исторический период — ${game.year} год`;
  const grid = $('final-history');
  grid.innerHTML = '';

  const start = prices.getDay(new Date(game.year, 8, 1));
  const end = prices.getDay(new Date(game.year + 1, 7, 31));
  const weekly = (history) => history.slice(start, end + 1).filter((v, i, list) => v > 0 && (i % 7 === 0 || i === list.length - 1));

  const cards = [
    { title: 'Индекс Московской биржи', slotName: 'Полная доходность', ticker: MARKET_INDEX, wide: true },
    { role: 'bank', title: 'Накопительный счёт', ticker: game.tickers.bank, isRate: true }
  ];
  for (const key of ['bonds', 'funds', 'stocks', 'currency', 'gold']) {
    for (const slot of CATEGORIES[key].slots) {
      const ticker = game.tickers[slot.role];
      if (!ticker) continue;
      cards.push({ role: slot.role, title: game.titles[slot.role] || ticker, slotName: slot.title || instrumentName(slot), ticker });
    }
  }

  for (const card of cards) {
    const series = weekly(prices.getHistory(card.ticker));
    const first = series[0] || 0;
    const last = series[series.length - 1] || 0;

    const box = el('article', `history-card raised${card.wide ? ' history-card--wide' : ''}`);
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

// ===== Вводное обучение =====
// Шесть шагов перед первым днём партии: время стоит. В мультиплеере первый день наступает,
// когда обучение закончили все (решает сервер); до этого закончившие видят экран ожидания.

function openIntro() {
  ui.intro ??= { step: 0, waiting: false };
  document.body.classList.add('is-intro');
  $('intro').hidden = false;
  setPaused('intro', true);
  renderIntro();
  renderRating();
}

function closeIntro() {
  if (!ui.intro) return;
  ui.intro = null;
  document.body.classList.remove('is-intro');
  $('intro').hidden = true;
  setPaused('intro', false);
  renderRating();
}

function completeIntro() {
  if (isMulti()) {
    ui.intro.waiting = true;
    renderIntro();
    net?.send({ type: 'intro-done' });
    return;
  }
  game.introPending = false;
  closeIntro();
  void save();
}

function introGo(delta) {
  ui.intro.step += delta;
  renderIntro();
}

function applyIntro({ ready, total, started, done }) {
  if (!isMulti()) return;
  if (started) {
    closeIntro();
    return;
  }
  ui.introStatus = { ready, total };
  if (!ui.intro) openIntro();
  if (done) ui.intro.waiting = true;
  // Заявка могла потеряться при обрыве связи
  if (done === false && ui.intro.waiting) net?.send({ type: 'intro-done' });
  if (ui.intro.waiting) renderIntro();
}

function renderIntro() {
  const box = $('intro');
  box.classList.toggle('intro--waiting', ui.intro.waiting);
  box.replaceChildren(...(ui.intro.waiting ? introWaiting() : introStep(ui.intro.step)));
}

function introWaiting() {
  const { ready, total } = ui.introStatus || { ready: 0, total: 1 };
  const bar = el('div', 'intro__progress');
  const fill = el('span');
  fill.style.width = `${total > 0 ? (ready / total) * 100 : 0}%`;
  bar.append(fill);
  return [
    el('span', 't-label', 'ВВОДНОЕ ОБУЧЕНИЕ ЗАВЕРШЕНО'),
    el('h1', 'entry__title', 'Ожидаем остальных игроков'),
    el('p', '', 'Игра начнётся, когда все завершат обучение'),
    el('span', 'm-value', `Готовы ${ready} из ${total}`),
    el('p', '', `Ещё проходят обучение: ${total - ready}`),
    bar
  ];
}

function introStep(index) {
  const step = introSteps[index];
  const isLast = index === introSteps.length - 1;

  const head = el('div', 'intro__head');
  head.append(el('span', 't-label', `ВВОДНОЕ ОБУЧЕНИЕ · ${index + 1} / ${introSteps.length}`), el('h1', 'entry__title', step.title));

  const text = el('div', 'intro__text');
  text.append(el('p', 't-heading', step.lead), el('div', 'report__rule'), el('p', '', step.note));

  const body = el('div', 'intro__body');
  body.append(text, ...INTRO_DEMOS[step.demo](step));

  const back = button('btn-back t-label intro__back', 'Назад', () => introGo(-1));
  back.disabled = index === 0;
  const nav = el('div', 'intro__nav');
  nav.append(
    back,
    button('btn-back t-label intro__skip', 'Пропустить обучение', completeIntro),
    button('btn-primary t-label intro__next', isLast ? 'Начать игру' : 'Далее', () => (isLast ? completeIntro() : introGo(1)))
  );
  return [head, body, nav];
}

// Примеры интерфейса только показываются: inert отключает их кнопки
function introStage(extraClass = '') {
  const stage = el('div', `intro__stage ${extraClass}`);
  stage.inert = true;
  return stage;
}

function demoCategory(title, ...content) {
  const box = el('section', 'category raised');
  const head = el('div', 'category__title t-label');
  head.append(el('span', '', title), el('span', 'help m-control intro__help', '?'));
  const body = el('div', 'category__body');
  body.append(...content);
  box.append(head, body);
  return box;
}

function demoActions(leftLabel, rightLabel) {
  const actions = el('div', 'actions');
  actions.append(button('btn t-label', leftLabel), button('btn btn--dark t-label', rightLabel));
  return actions;
}

function demoChart(series, up) {
  const terms = el('div', 'terms');
  const chart = chartElement();
  drawChart(chart, series, up);
  terms.append(chart);
  return terms;
}

function demoInstrument({ name, price, change, trend, series, units, value }) {
  const box = el('div', 'instrument');
  const head = el('div');
  const quote = el('div', 'quote');
  quote.append(el('span', 'm-price', price), el('span', `m-control ${trend}`, change));
  head.append(el('div', 't-label', name), quote);

  const ownership = el('div', 'ownership');
  const holdings = el('div');
  holdings.append(el('span', 't-caption', 'У вас'), el('span', 'm-control', units));
  const metric = el('div', 'metric');
  const swap = el('span', 'metric-switch');
  swap.innerHTML = '<img src="assets/swap.svg" alt="">';
  metric.append(el('span', 'm-body', value), swap);
  ownership.append(holdings, metric);

  const trade = el('div', 'trade');
  const qty = el('div', 'qty m-caption');
  for (const amount of QUANTITIES) qty.append(button(amount === '25' ? 'is-active' : '', amount));
  trade.append(qty, demoActions('Продать', 'Купить'));

  box.append(head, demoChart(series, trend === 'up'), ownership, trade);
  return box;
}

function withSeparators(items) {
  return items.flatMap((item, i) => (i > 0 ? [el('span', 'vsep'), item] : [item]));
}

const INTRO_DEMOS = {
  time({ caption }) {
    const stage = introStage();
    const card = el('div', 'intro-dark intro-month');
    const month = el('div', 'month');
    const days = el('div', 'month__days');
    for (let d = 1; d <= 30; d++) days.append(el('span', `month__day${d === 1 ? ' is-done' : ''}`));
    const paydays = el('div', 'month__paydays t-caption');
    renderPaydays(paydays, 30);
    month.append(el('span', 'm-control month__title', '1 сентября (1/12)'), days, paydays);
    card.append(month);
    const column = el('div', 'intro__column');
    column.append(card, el('p', 't-heading', caption));
    stage.append(column);
    return [stage];
  },

  capital({ caption }) {
    const stage = introStage();
    const card = el('div', 'intro-dark intro-capital');
    const free = el('div', 'free-money');
    free.append(el('span', 't-caption', 'Свободные деньги'), el('span', 'm-value nowrap', money(START_CASH)));
    const capitalBox = el('div', 'capital');
    const modes = el('div', 'switch t-caption');
    modes.append(button('is-active', 'Капитал'), button('', 'Прибыль'));
    capitalBox.append(modes, el('span', 'm-metric nowrap', money(START_CASH)));
    card.append(free, capitalBox);

    const savings = el('div', 'instrument');
    const rate = el('div');
    rate.append(el('span', 't-caption flat', 'Ставка'), el('div', 'm-metric', '12,0% годовых'));
    const result = el('div', 'savings-result nowrap');
    result.append(el('span', 'm-body', '34 620 ₽'), el('span', 'm-body up', '+173 ₽'));
    savings.append(rate, demoChart([8, 9, 8.5, 10, 9.8, 11, 10.5, 12, 12.6, 11.8, 13.2], true), result, demoActions('Снять', 'Пополнить'));
    const category = demoCategory('Накопительный счёт', savings);
    category.classList.add('intro-savings');

    const column = el('div', 'intro__column');
    column.append(card, el('p', 't-heading', caption), category);
    stage.append(column);
    return [stage];
  },

  invest({ funds, stocks }) {
    const stage = introStage();
    const fundsCard = demoCategory('ПИФы', ...withSeparators(funds.map(demoInstrument)));
    fundsCard.classList.add('intro-funds');
    const stocksCard = demoCategory('Акции', ...withSeparators(stocks.map(demoInstrument)));
    stocksCard.classList.add('intro-stocks');
    stage.append(fundsCard, stocksCard);
    return [stage];
  },

  lesson({ lesson: key, caption }) {
    const lesson = lessons[key];
    const stage = introStage();

    const card = el('article', 'learn raised');
    const titleRow = el('div', 'learn__title-row');
    titleRow.append(el('h2', 'learn__title', lesson.title), el('span', `risk t-label risk--${lesson.risk}`, riskNames[lesson.risk]));
    const heading = el('div');
    heading.append(titleRow, el('p', 'learn__subtitle', lesson.subtitle));
    const tabs = el('div', 'switch t-caption');
    for (const [tabKey, label] of lessonTabs[lesson.tabs]) tabs.append(button(tabKey === key ? 'is-active' : '', label));
    const head = el('div', 'learn__head');
    head.append(heading, tabs);
    const body = el('div', 'learn__body');
    body.append(lessonColumns(lesson));
    const footer = el('div', 'learn__footer');
    const close = el('button', 'btn-accent t-label', 'К торгам');
    footer.append(el('span', 't-caption', 'Обучение'), close);
    card.append(head, body, footer);

    const preview = el('div', 'intro-lesson');
    preview.append(card);
    const hint = el('p', 'intro-hint');
    hint.append(el('span', 'help m-control intro__help', '?'), el('span', '', caption));
    const column = el('div', 'intro__column');
    column.append(preview, hint);
    stage.append(column);
    return [stage];
  },

  news({ news, event }) {
    const newsStage = introStage('intro__stage--news');
    const list = el('div', 'news');
    list.append(el('h2', 't-heading', 'Новости'));
    for (const [order, title, text] of news) {
      const article = el('article', 'news__item');
      article.append(el('span', 'm-caption', order), el('h3', 't-label', title), el('p', '', text));
      list.append(article);
    }
    newsStage.append(list);

    const eventStage = introStage();
    const card = el('div', 'life-event raised');
    card.append(
      el('span', 't-label up', event.type),
      el('span', 'life-event__icon', event.icon),
      el('h2', 't-heading', event.title),
      el('span', 'life-event__amount up', event.amount),
      el('p', 'life-event__text', event.text),
      el('button', 'btn-confirm t-label', event.button)
    );
    eventStage.append(card);
    return [newsStage, eventStage];
  },

  results({ summary, results, leaders, leadersTotal }) {
    const preview = el('div', 'intro-results');
    preview.inert = true;

    const item = (label, value, className, small = true) => {
      const box = el('div', `summary__item${small ? ' summary__item--small' : ''}`);
      box.append(el('span', small ? 'summary__small' : '', label), el('span', className, value));
      return box;
    };
    const card = el('div', 'summary');
    const primary = el('div', 'summary__primary');
    const rank = item('Твоё место в рейтинге', summary.rank, 'm-value summary__accent');
    rank.append(el('span', 'summary__small summary__faded', summary.total));
    primary.append(
      item('Итоговый портфель', summary.capital, 'summary__capital', false),
      item('Заработано на инвестициях', summary.profit, 'summary__profit up', false),
      rank
    );
    const sources = el('div', 'summary__sources');
    sources.append(
      item('Авансы и зарплаты за игру', summary.wages, 'm-metric'),
      item('Жизненные ситуации', summary.events, 'm-metric down'),
      item('Доходность рынка: индекс Московской биржи', summary.market, 'm-metric summary__accent')
    );
    card.append(primary, el('div', 'summary__rule'), sources);

    const columns = el('div', 'results');
    const gains = el('div', 'results__column');
    const losses = el('div', 'results__column');
    columns.append(gains, el('span', 'vsep'), losses);
    renderResultColumns(gains, losses, results.map(([short, score]) => ({ short, score })), (v) => money(v, true));

    const board = el('div', 'leaderboard');
    const heading = el('div', 'leaderboard__heading');
    heading.append(el('h2', 't-heading', 'Итоговый рейтинг'), el('span', 'm-caption entry__muted', `${leadersTotal} участников`));
    board.append(heading, el('p', 'summary__small entry__muted', 'По итоговому капиталу · Нажми на строку, чтобы изучить результат участника'));
    const table = el('div', 'leaderboard__table');
    table.append(leaderboardColumns(), ...leaders.map((player) => leaderRow(player, false)));
    board.append(table);

    preview.append(card, columns, board);
    return [el('span', 'vsep intro__rule'), preview];
  }
};

function leaderboardColumns() {
  const columns = el('div', 'leader__grid leader__columns t-caption entry__muted');
  columns.append(el('span', '', 'Место'), el('span', '', 'Игрок'), el('span', 'leader__number', 'Итоговый капитал'), el('span', 'leader__number', 'Заработано на инвестициях'), el('span'));
  return columns;
}

// ===== Запуск =====

function renderAll() {
  document.documentElement.style.setProperty('--day-ms', `${game.dayMs || TEMPLATES.training.dayMs}ms`);
  const player = game.player || 'Игрок';
  $('player-name').textContent = player;
  $('rating').classList.toggle('is-hidden', !isMulti());
  $('player-initial').textContent = player[0].toUpperCase();
  renderRating();
  renderField();
  renderMonth();
  refresh();
  void initNews();
}

// После окончания игры — новая партия с выбора режима (имя уже известно)
async function restart() {
  closeLessonSilently();
  closeIntro();
  if (isMulti()) leaveMultiplayer();
  else await storage.deleteGame(GAME_ID);
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

const ENTRY_PAGES_WITH_NAME = ['mode', 'solo', 'multi', 'lobby'];
let selectedTemplate = 'training';
let lobby = null;   // { code, template, players: [{ name, ready, isHost, isSelf }] }
let net = null;     // соединение с сервером мультиплеера
const room = { code: null, token: null, resolveResume: null, inviteCode: null };
let serverQueue = Promise.resolve();

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
    // По приглашению возвращаться некуда: после имени игрок сразу попадает в лобби
    $('name-back').hidden = Boolean(room.inviteCode);
    requestAnimationFrame(() => input.focus());
  }
  if (page === 'solo') renderTemplates();
  if (page === 'multi') renderMultiPage();
  if (page === 'lobby') renderLobby();
}

function hideEntry() {
  document.body.classList.remove('is-entry');
  setPaused('entry', false);
}

// Спрашивает, продолжать ли сохранённую партию; ответ — true/false
function askResume(name, text) {
  $('resume-title').textContent = `Восстановить игру под ником «${name}»?`;
  $('resume-text').textContent = text;
  showEntry('resume');
  return new Promise((resolve) => {
    const answer = (value) => () => {
      $('resume-yes').onclick = null;
      $('resume-no').onclick = null;
      resolve(value);
    };
    $('resume-yes').onclick = answer(true);
    $('resume-no').onclick = answer(false);
  });
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
  if (game.introPending) openIntro();
}

// ===== Соединение с сервером =====
// Портфель, дни и рейтинг считает сервер: браузер отправляет заявки и показывает то, что пришло.

function savedRoom() {
  try {
    const saved = JSON.parse(localStorage.getItem(ROOM_KEY));
    return saved?.code && saved?.token ? saved : null;
  } catch {
    return null;
  }
}

function saveRoom() {
  try {
    localStorage.setItem(ROOM_KEY, JSON.stringify({ code: room.code, token: room.token }));
  } catch (error) {
    console.warn('Не удалось запомнить комнату:', error);
  }
}

function forgetRoom() {
  room.code = null;
  room.token = null;
  try {
    localStorage.removeItem(ROOM_KEY);
  } catch (error) {
    console.warn('Не удалось забыть комнату:', error);
  }
}

function randomToken() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

function setConnecting(isConnecting) {
  $('create-room').disabled = isConnecting;
  $('name-submit').disabled = isConnecting || !$('name-input').value.trim();
  renderMultiPage(isConnecting);
}

function forgetInvite() {
  if (!room.inviteCode) return;
  room.inviteCode = null;
  history.replaceState(null, '', location.pathname);
}

function closeConnection() {
  net?.close();
  net = null;
}

// Без кода комнаты сервер создаёт новую, с кодом — впускает или возвращает игрока с этим токеном
function connectToServer() {
  closeConnection();
  const url = multiplayerUrl();
  if (!url) {
    toast('Сервер мультиплеера пока не подключён', 'error');
    settleResume(false);
    return false;
  }
  setConnecting(true);
  net = new MultiplayerClient(url, {
    hello: () => {
      const base = { name: playerName() || 'Игрок', token: room.token };
      return room.code ? { ...base, type: 'join', code: room.code } : { ...base, type: 'create' };
    },
    onMessage: (message) => {
      serverQueue = serverQueue.then(() => handleServerMessage(message)).catch((error) => {
        console.error('Ошибка обработки сообщения сервера:', error);
      });
    },
    onFailed: () => {
      net = null;
      setConnecting(false);
      toast('Не удалось подключиться к серверу', 'error');
      settleResume(false);
    },
    onLost: () => {
      setPaused('connection', true);
      if (game) renderMonthTitle();
      toast('Нет связи с сервером, переподключаемся…', 'error');
    },
    onRestored: () => {
      setPaused('connection', false);
      if (game) renderMonthTitle();
    }
  });
  return true;
}

function settleResume(isResumed) {
  const resolve = room.resolveResume;
  room.resolveResume = null;
  resolve?.(isResumed);
}

// Возврат в комнату после перезагрузки страницы
function resumeRoom({ code, token }) {
  room.code = code;
  room.token = token;
  return new Promise((resolve) => {
    room.resolveResume = resolve;
    connectToServer();
  });
}

function createRoom() {
  forgetRoom();
  room.token = randomToken();
  connectToServer();
}

function joinRoom() {
  const code = $('room-input').value.trim().toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) return;
  const saved = savedRoom();
  room.code = code;
  room.token = saved?.code === code ? saved.token : randomToken();
  connectToServer();
}

function leaveMultiplayer() {
  net?.send({ type: 'leave' });
  closeConnection();
  forgetRoom();
  lobby = null;
  ui.eventQueue = [];
  setPaused('server', false);
  setPaused('connection', false);
}

async function handleServerMessage(message) {
  if (message.type === 'lobby') {
    enterLobby(message);
  } else if (message.type === 'game') {
    await enterMultiGame(message);
  } else if (message.type === 'tick') {
    applyTick(message);
  } else if (message.type === 'intro') {
    applyIntro(message);
  } else if (message.type === 'paused') {
    applyPaused(message);
  } else if (message.type === 'error') {
    await handleServerError(message);
  }
}

async function handleServerError({ message, fatal }) {
  toast(message, 'error');
  if (!fatal) return;
  // Комнаты больше нет или войти нельзя: возвращаемся на экран мультиплеера
  const isResuming = Boolean(room.resolveResume);
  const wasPlaying = isMulti();
  closeConnection();
  forgetRoom();
  lobby = null;
  setConnecting(false);
  setPaused('connection', false);
  if (isResuming) {
    settleResume(false);
  } else if (wasPlaying) {
    await restart();
  } else {
    // По этому приглашению войти нельзя: дальше обычный экран мультиплеера с кодом в поле
    forgetInvite();
    showEntry('multi');
  }
}

function roomEntered(code) {
  room.code = code;
  saveRoom();
  setConnecting(false);
  forgetInvite();
  settleResume(true);
}

function enterLobby({ code, template, selfId, hostId, players }) {
  lobby = {
    code,
    template,
    players: players.map(({ id, name, ready }) => ({ name, ready, isHost: id === hostId, isSelf: id === selfId }))
  };
  roomEntered(code);
  showEntry('lobby');
}

async function enterMultiGame(snapshot) {
  const { code, year, template, dayMs, day, name, tickers, titles, portfolio, history, cards, paused, finished, rank, playersTotal, isHost, intro, selfId, leaderboard } = snapshot;
  if (!prices || prices.year !== String(year)) prices = await LocalPrices.create(String(year));
  engine.prices = prices;
  lobby = null;

  game = {
    year,
    date: new Date(year, 8, 1 + day),
    player: name,
    mode: 'multi',
    template,
    dayMs,
    portfolio,
    history,
    tickers,
    titles,
    cards,
    finished: false,
    rank,
    playersTotal,
    isHost,
    selfId,
    leaderboard
  };
  LOCAL_PAUSES.forEach((reason) => setPaused(reason, false));
  updateCardAvailability();
  roomEntered(code);
  hideEntry();
  setPaused('server', paused);
  renderAll();
  if (finished) finishMultiGame();
  else applyIntro(intro);
}

function applyTick({ day, portfolio, history, notices, events, rank, playersTotal, finished, selfId, leaderboard }) {
  if (!isMulti() || game.finished) return;
  closeIntro();
  game.selfId = selfId;
  game.leaderboard = leaderboard;
  game.date = new Date(game.year, 8, 1 + day);
  game.portfolio = portfolio;
  game.history.push(...history);
  game.rank = rank;
  game.playersTotal = playersTotal;

  for (const { message, kind } of notices) toast(message, kind);
  ui.eventQueue.push(...events);
  if (finished) {
    finishMultiGame();
    return;
  }
  if (updateCardAvailability()) renderField();
  renderMonth();
  renderRating();
  refresh();
  renderNews();
  if ($('modal').hidden) showNextLifeEvent();
}

function applyPaused({ paused, isHost }) {
  if (!isMulti()) return;
  const changed = ui.pause.has('server') !== paused;
  game.isHost = isHost;
  setPaused('server', paused);
  renderRating();
  renderMonthTitle();
  if (changed) toast(paused ? 'Организатор поставил игру на паузу' : 'Игра продолжается');
}

function finishMultiGame() {
  closeLessonSilently();
  closeIntro();
  $('modal').hidden = true;
  onModalConfirm = null;
  ui.eventQueue = [];
  setPaused('server', false);
  finishGame();
  renderMonth();
  closeConnection();
  forgetRoom();
}

function showNextLifeEvent() {
  const event = ui.eventQueue.shift();
  if (event) showLifeEvent(event);
}

function renderRating() {
  if (!isMulti()) return;
  $('rating-value').textContent = `#${game.rank} / ${game.playersTotal}`;
  const pause = $('host-pause');
  // До первого дня ставить на паузу нечего
  pause.hidden = !game.isHost || Boolean(ui.intro);
  pause.textContent = ui.pause.has('server') ? 'Продолжить' : 'Пауза';
}

function applyActionResult({ portfolio, history }) {
  game.portfolio = portfolio;
  game.history.push(...history);
}

async function tradeMulti(slot, action, amount) {
  const isBuy = action === 'buy';
  const result = await net.request({ type: 'action', kind: action, ticker: game.tickers[slot.role], amount });
  if (!isMulti()) return;
  if (!result.ok) {
    toast(result.error, 'error');
    return;
  }
  applyActionResult(result);
  toast(`${isBuy ? 'Куплено' : 'Продано'}: ${instrumentName(slot)},${formatUnits(result.amount, slot.unit)}`, 'success');
  refresh();
}

async function submitMultiSavings(mode, amount) {
  const result = await net.request({ type: 'action', kind: mode === 'deposit' ? 'deposit' : 'withdraw', amount });
  if (!isMulti()) return;
  if (!result.ok) {
    toast(result.error, 'error');
    return;
  }
  applyActionResult(result);
  toast(`${mode === 'deposit' ? 'Счёт пополнен' : 'Со счёта снято'}: ${money(result.amount)}`, 'success');
  closeSavingsForm();
}

// ===== Лобби =====
// Экран рисуется целиком из объекта lobby, который присылает сервер

function renderMultiPage(isConnecting = false) {
  const input = $('room-input');
  $('join-room').disabled = isConnecting || input.value.trim().length !== ROOM_CODE_LENGTH;
}

function leaveRoom() {
  leaveMultiplayer();
  setConnecting(false);
  showEntry('multi');
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message, 'success');
  } catch (error) {
    console.warn('Не удалось скопировать:', error);
    toast('Не удалось скопировать', 'error');
  }
}

function lobbyPlayerRow({ name, ready, isHost, isSelf }) {
  const row = el('div', 'lobby__player');
  if (isSelf) row.append(el('span', 'lobby__self'));
  row.append(el('span', 'lobby__name', name));
  if (isHost) row.append(el('span', 't-caption lobby__role', 'Организатор'));
  row.append(el('span', `t-label lobby__status${ready ? ' is-ready' : ''}`, ready ? 'Готов' : 'Не готов'));
  return row;
}

// Участники заполняют три колонки сверху вниз, свой игрок — первым
function renderLobbyPlayers(players) {
  const box = $('lobby-players');
  box.innerHTML = '';
  const members = players.filter((p) => !p.isHost).sort((a, b) => b.isSelf - a.isSelf);
  if (!members.length) return;

  const columns = 3;
  let start = 0;
  for (let i = 0; i < columns; i++) {
    const size = Math.ceil((members.length - start) / (columns - i));
    const column = el('div', 'lobby__column');
    column.append(...members.slice(start, start + size).map(lobbyPlayerRow));
    start += size;
    if (i > 0) box.append(el('span', 'vsep'));
    box.append(column);
  }
}

function renderLobby() {
  const { code, template, players } = lobby;
  const self = players.find((p) => p.isSelf);
  const host = players.find((p) => p.isHost);
  const readyCount = players.filter((p) => p.ready).length;
  const allReady = readyCount === players.length;
  const { facts } = TEMPLATES[template];

  $('lobby-code').textContent = code;
  $('lobby-count').textContent = `${players.length} из ${LOBBY_MAX_PLAYERS}`;
  $('lobby-host').replaceChildren(lobbyPlayerRow(host));
  renderLobbyPlayers(players);

  $('lobby-templates').hidden = !self.isHost;
  for (const button of $('lobby-templates').children) {
    button.classList.toggle('is-selected', button.dataset.template === template);
  }
  $('lobby-template').textContent = facts.title;
  $('lobby-day').textContent = facts.day;
  $('lobby-categories').textContent = facts.categories;
  $('lobby-events').textContent = facts.events;

  $('lobby-ready-count').textContent = `Готовы ${readyCount} из ${players.length}`;
  const ready = $('lobby-ready');
  ready.textContent = `Готов · ${readyCount}/${players.length}`;
  ready.className = `t-label ${self.ready ? 'btn-back' : 'btn-primary'}`;
  $('lobby-start').hidden = !self.isHost;
  $('lobby-start').disabled = !allReady;
}

function bindLobby() {
  $('create-room').addEventListener('click', createRoom);
  $('join-room').addEventListener('click', joinRoom);
  $('room-input').addEventListener('input', () => renderMultiPage());
  $('room-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') joinRoom();
  });
  $('lobby-leave').addEventListener('click', leaveRoom);
  $('lobby-copy-code').addEventListener('click', () => void copyText(lobby.code, 'Код комнаты скопирован'));
  $('lobby-copy-link').addEventListener('click', () => {
    void copyText(`${location.origin}${location.pathname}?room=${lobby.code}`, 'Ссылка скопирована');
  });
  $('lobby-templates').addEventListener('click', (event) => {
    const button = event.target.closest('[data-template]');
    if (button) net?.send({ type: 'template', template: button.dataset.template });
  });
  $('lobby-ready').addEventListener('click', () => {
    net?.send({ type: 'ready', ready: !lobby.players.find((p) => p.isSelf).ready });
  });
  $('lobby-start').addEventListener('click', () => net?.send({ type: 'start' }));
  $('host-pause').addEventListener('click', () => {
    net?.send({ type: 'pause', paused: !ui.pause.has('server') });
  });
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
    if (room.inviteCode) joinRoom();
    else showEntry('mode');
  });

  $('templates').addEventListener('click', (event) => {
    const card = event.target.closest('[data-template]');
    if (!card) return;
    selectedTemplate = card.dataset.template;
    renderTemplates();
  });

  $('start-game').addEventListener('click', () => void startNewGame());
  bindLobby();
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
  $('final').addEventListener('scroll', updateCompactSummary, { passive: true });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('learn').hidden) closeLesson();
  });

  document.addEventListener('visibilitychange', () => setPaused('hidden', document.hidden));
}

// Ссылка-приглашение: код уже подставлен, игрок называет имя и сразу входит в лобби
function readInvite() {
  const code = new URLSearchParams(location.search).get('room')?.trim().toUpperCase();
  if (code?.length !== ROOM_CODE_LENGTH) return;
  room.inviteCode = code;
  $('room-input').value = code;
}

// Сначала — комната мультиплеера, затем приглашение и сохранённая партия, иначе — вступительные экраны
async function init() {
  bindStaticControls();
  readInvite();
  const saved = savedRoom();
  if (saved && (!room.inviteCode || saved.code === room.inviteCode)) {
    const resume = await askResume(playerName() || 'Игрок', `Ты в комнате ${saved.code}. Если отказаться, ты выйдешь из неё. В уже начатую партию вернуться будет нельзя.`);
    if (resume) {
      if (await resumeRoom(saved)) return;
      room.code = null;
    } else {
      forgetRoom();
    }
  }
  if (room.inviteCode) {
    showEntry('name');
    return;
  }

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

  const resume = await askResume(game.player || 'Игрок', 'Если отказаться, сохранение будет удалено.');
  if (!resume) {
    await storage.deleteGame(GAME_ID);
    game = null;
    showEntry('start');
    return;
  }

  hideEntry();
  renderAll();
  if (game.finished) finishGame();
  else if (game.introPending) openIntro();
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
  closeIntro();
  game.introPending = false;
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

// В мультиплеере игрой управляет сервер: команды, меняющие ход партии, недоступны
function soloOnly(command) {
  return (...args) => {
    if (isMulti()) {
      console.warn('В мультиплеере эта команда недоступна');
      return undefined;
    }
    return command(...args);
  };
}

Object.assign(window, {
  setCardState: soloOnly(setCardState),
  cardStates,
  game: {
    data: () => game,
    engine,
    prices: () => prices,
    pause: soloOnly(() => setPaused('console', true)),
    resume: soloOnly(() => setPaused('console', false)),
    nextDay: soloOnly(() => {
      const paused = new Set(ui.pause);
      ui.pause.clear();
      return advanceDay().finally(() => paused.forEach((reason) => ui.pause.add(reason)));
    }),
    finish: soloOnly(finishNow),
    restart
  }
});

init();
