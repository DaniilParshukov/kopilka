// Правила партии, общие для браузера и сервера мультиплеера. Здесь не должно быть обращений к DOM.
import { STOCK_ALIASES } from '../aliases.js';

export const START_CASH = 10000;
export const MONTHS_TOTAL = 12;
export const LOBBY_MAX_PLAYERS = 30;
export const ROOM_CODE_LENGTH = 6;

// Шаблоны игры (экран «Выбери шаблон игры» и лобби); facts — подписи для лобби
export const TEMPLATES = {
  training: {
    dayMs: 4000, openAll: false, lifeEvents: 'normal',
    facts: { title: 'Учебная', day: '4 секунды', categories: 'Постепенно, по игровым месяцам', events: 'Обычная частота' }
  },
  advanced: {
    dayMs: 3000, openAll: true, lifeEvents: 'high',
    facts: { title: 'Продвинутая', day: '3 секунды', categories: 'Все открыты с начала', events: 'Повышенная частота' }
  }
};

// opensAt — игровой месяц, с которого категорию можно открыть; opensDay — число этого месяца (по умолчанию 1-е).
// slots — инструменты карточки; role связывает слот с тикером в game.tickers.
// Название слота акции берётся из STOCK_ALIASES по тикеру партии (см. slotName).
export const CATEGORIES = {
  savings: { title: 'Накопительный счёт', lesson: 'savings', opensAt: 1 },
  bonds: {
    title: 'Облигации', lesson: 'ofz', opensAt: 1, opensDay: 15,
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
      { role: 'stock1', name: 'Акция', unit: 'шт.' },
      { role: 'stock2', name: 'Акция', unit: 'шт.' },
      { role: 'stock3', name: 'Акция', unit: 'шт.' },
      { role: 'stock4', name: 'Акция', unit: 'шт.' }
    ]
  },
  currency: {
    title: 'Валюта', lesson: 'currency', opensAt: 5,
    slots: [{ role: 'usd', name: 'Доллар / USD', unit: '$' }]
  },
  gold: {
    title: 'Золото', lesson: 'gold', opensAt: 6,
    slots: [{ role: 'gold', name: '1 лот = 1 г', unit: 'г', title: 'Золото' }]
  }
};

export function slotName(tickers, slot) {
  return STOCK_ALIASES[tickers[slot.role]] || slot.name;
}

export function tickerDisplayName(tickers, ticker) {
  for (const category of Object.values(CATEGORIES)) {
    for (const slot of category.slots || []) {
      if (tickers?.[slot.role] === ticker) return slotName(tickers, slot);
    }
  }
  return ticker;
}

// Ключ категории, в которой этот тикер торгуется в партии, или null
export function categoryOfTicker(tickers, ticker) {
  for (const [key, category] of Object.entries(CATEGORIES)) {
    if ((category.slots || []).some((slot) => tickers[slot.role] === ticker)) return key;
  }
  return null;
}

export function monthIndex(date, year) {
  return (date.getFullYear() - year) * 12 + date.getMonth() - 8;
}

export function categoryIsOpen(category, date, year) {
  const month = monthIndex(date, year) + 1;
  return category.opensAt < month || (category.opensAt === month && (category.opensDay || 1) <= date.getDate());
}

export function initialCards(template) {
  return Object.fromEntries(Object.keys(CATEGORIES).map((key) => [key, template.openAll ? 'active' : 'locked']));
}

export function newPortfolio() {
  return { cash: START_CASH, bankBalance: 0, assets: {}, assetValues: {} };
}

export function parseTickerRows(text) {
  const byYear = {};
  for (const line of text.split(/\r?\n/)) {
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
export function pickTickers(rows, prices) {
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
    stock1: stocks[0], stock2: stocks[1], stock3: stocks[2], stock4: stocks[3],
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
