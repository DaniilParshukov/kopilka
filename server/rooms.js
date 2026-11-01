// Комнаты мультиплеера. Портфели считает только сервер: браузер присылает заявки и показывает результат.
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { GameEngine } from '../core/GameEngine.js';
import { LocalPrices } from '../prices/LocalPrices.js';
import {
  CATEGORIES, LOBBY_MAX_PLAYERS, MONTHS_TOTAL, ROOM_CODE_LENGTH, TEMPLATES,
  categoryIsOpen, categoryOfTicker, initialCards, monthIndex, newPortfolio,
  parseTickerRows, pickTickers, tickerDisplayName
} from '../core/setup.js';

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих 0/O и 1/I
const NAME_MAX_LENGTH = 20;
const DISCONNECT_GRACE_MS = 30 * 1000;  // столько ждём вернувшегося игрока, прежде чем убрать его из лобби
const ROOM_IDLE_MS = 15 * 60 * 1000;    // комната без подключённых игроков удаляется
const ROOM_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const MAX_ROOMS = 500;

// Цены и тикеры всех игровых лет: читаются один раз при запуске
export class Catalog {
  constructor() {
    const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
    this.allData = JSON.parse(read('../prices/data.json'));
    this.rowsByYear = parseTickerRows(read('../prices/tickers.csv'));
    this.pricesByYear = new Map();
    this.years = Object.keys(this.rowsByYear).filter((year) => this.allData[this.rangeOf(year)]);
  }

  rangeOf(year) {
    return `${year}-08-01_${Number(year) + 1}-08-31`;
  }

  // Та же логика цен, что и в браузере, но без загрузки через fetch
  pricesOf(year) {
    if (!this.pricesByYear.has(year)) {
      const prices = new LocalPrices(year);
      prices.processYearRange(this.allData[this.rangeOf(year)]);
      prices.isLoaded = true;
      this.pricesByYear.set(year, prices);
    }
    return this.pricesByYear.get(year);
  }
}

function cleanName(name) {
  const clean = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX_LENGTH);
  return clean || 'Игрок';
}

function isValidToken(token) {
  return typeof token === 'string' && token.length >= 8 && token.length <= 64;
}

class Room {
  constructor(code, catalog, { dayMs, onEmpty }) {
    this.code = code;
    this.catalog = catalog;
    this.dayMsOverride = dayMs;
    this.onEmpty = onEmpty;
    this.createdAt = Date.now();
    this.idleSince = Date.now();
    this.phase = 'lobby';   // lobby | playing | finished
    this.template = 'training';
    this.players = new Map();   // token -> игрок
    this.hostId = null;
    this.nextPlayerId = 1;
    this.paused = false;
    this.timer = null;
    this.notices = [];
  }

  // ===== Участники =====

  addPlayer(token, name) {
    let unique = cleanName(name);
    const names = new Set([...this.players.values()].map((p) => p.name));
    for (let i = 2; names.has(unique); i++) unique = `${cleanName(name).slice(0, NAME_MAX_LENGTH - 3)} ${i}`;

    const player = { id: this.nextPlayerId++, token, name: unique, ready: false, conn: null, graceTimer: null };
    this.players.set(token, player);
    if (this.hostId === null) this.hostId = player.id;
    return player;
  }

  connectedPlayers() {
    return [...this.players.values()].filter((p) => p.conn);
  }

  attach(player, conn) {
    clearTimeout(player.graceTimer);
    player.graceTimer = null;
    if (player.conn && player.conn !== conn) {
      player.conn.room = null;
      player.conn.player = null;
      player.conn.close();
    }
    player.conn = conn;
    conn.room = this;
    conn.player = player;
    this.idleSince = null;
  }

  // Обрыв связи: в лобби игрок уходит не сразу, в партии остаётся всегда и может вернуться
  disconnect(player) {
    player.conn = null;
    if (!this.connectedPlayers().length) this.idleSince = Date.now();
    if (this.phase === 'finished') return;

    player.graceTimer = setTimeout(() => {
      player.graceTimer = null;
      if (player.conn) return;
      if (this.phase === 'lobby') this.removePlayer(player);
      else if (player.id === this.hostId) this.passHost();
    }, DISCONNECT_GRACE_MS);
  }

  removePlayer(player) {
    clearTimeout(player.graceTimer);
    this.players.delete(player.token);
    if (!this.players.size) {
      this.onEmpty(this);
      return;
    }
    if (player.id === this.hostId) this.passHost();
    if (this.phase === 'lobby') this.broadcastLobby();
  }

  passHost() {
    const next = this.connectedPlayers()[0] || [...this.players.values()][0];
    if (!next) return;
    this.hostId = next.id;
    if (this.phase === 'playing') this.broadcastPaused();
  }

  leave(player) {
    if (this.phase === 'lobby') {
      player.conn = null;
      if (!this.connectedPlayers().length) this.idleSince = Date.now();
      this.removePlayer(player);
      return;
    }
    // Из партии игрок не исчезает: его результат остаётся в рейтинге
    this.disconnect(player);
  }

  // ===== Рассылка =====

  send(player, message) {
    player.conn?.send(message);
  }

  sendLobby(player) {
    this.send(player, {
      type: 'lobby',
      code: this.code,
      template: this.template,
      selfId: player.id,
      hostId: this.hostId,
      players: [...this.players.values()].map(({ id, name, ready }) => ({ id, name, ready }))
    });
  }

  broadcastLobby() {
    for (const player of this.players.values()) this.sendLobby(player);
  }

  broadcastPaused() {
    for (const player of this.players.values()) {
      this.send(player, { type: 'paused', paused: this.paused, isHost: player.id === this.hostId });
    }
  }

  newHistory(player) {
    const fresh = player.data.history.slice(player.historySent);
    player.historySent = player.data.history.length;
    return fresh;
  }

  sendSnapshot(player) {
    if (this.phase === 'lobby') {
      this.sendLobby(player);
      return;
    }
    player.historySent = player.data.history.length;
    this.send(player, {
      type: 'game',
      code: this.code,
      year: this.year,
      template: this.template,
      dayMs: this.dayMs,
      day: this.day,
      name: player.name,
      tickers: this.tickers,
      titles: this.titles,
      portfolio: player.data.portfolio,
      history: player.data.history,
      cards: player.cards,
      paused: this.paused,
      finished: this.phase === 'finished',
      rank: player.rank,
      playersTotal: this.players.size,
      isHost: player.id === this.hostId
    });
  }

  // ===== Партия =====

  start() {
    const years = this.catalog.years;
    const year = years[randomInt(years.length)];
    const prices = this.catalog.pricesOf(year);
    const template = TEMPLATES[this.template];
    const { tickers, titles } = pickTickers(this.catalog.rowsByYear[year], prices);

    this.year = Number(year);
    this.tickers = tickers;
    this.titles = titles;
    this.dayMs = this.dayMsOverride || template.dayMs;
    this.day = 0;
    this.engine = new GameEngine(null, prices, {
      notify: (message, kind) => this.notices.push({ message, kind }),
      nameOf: (ticker) => tickerDisplayName(tickers, ticker)
    });

    // Одинаковый план жизненных событий на всю партию: условия у всех равные
    const date = new Date(this.year, 8, 1);
    const plan = this.engine.planLifeEvents({ year: this.year, lifeEvents: template.lifeEvents, date });
    for (const player of this.players.values()) {
      player.cards = initialCards(template);
      player.historySent = 0;
      player.data = {
        year: this.year,
        date: new Date(date),
        lifeEvents: template.lifeEvents,
        portfolio: newPortfolio(),
        history: [],
        monthlyEvents: {},
        pendingEvent: null,
        _lifeEventPlan: plan
      };
    }

    this.phase = 'playing';
    this.updateRanks();
    for (const player of this.players.values()) this.sendSnapshot(player);
    this.scheduleDay(this.dayMs);
  }

  scheduleDay(ms) {
    this.dayStartedAt = Date.now();
    this.dayLeftMs = ms;
    this.timer = setTimeout(() => {
      try {
        this.nextDay();
      } catch (error) {
        // Ошибка одной партии не должна останавливать сервер с остальными комнатами
        console.error(`Ошибка партии в комнате ${this.code}:`, error);
        this.scheduleDay(this.dayMs);
      }
    }, ms);
  }

  setPaused(paused) {
    if (this.phase !== 'playing' || this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      clearTimeout(this.timer);
      this.dayLeftMs = Math.max(0, this.dayLeftMs - (Date.now() - this.dayStartedAt));
    } else {
      this.scheduleDay(this.dayLeftMs);
    }
    this.broadcastPaused();
  }

  updateRanks() {
    const ranked = [...this.players.values()].sort((a, b) => (
      this.engine.getTotalValue(b.data.portfolio) - this.engine.getTotalValue(a.data.portfolio)
    ));
    ranked.forEach((player, i) => { player.rank = i + 1; });
  }

  nextDay() {
    this.day += 1;
    const updates = new Map();
    for (const player of this.players.values()) {
      this.notices = [];
      const events = [];
      this.engine.nextDay(player.data);
      // Событие применяется сразу: время не ждёт, пока игрок закроет окно
      if (player.data.pendingEvent) {
        events.push(player.data.pendingEvent);
        this.engine.changeCash(player.data, player.data.pendingEvent.amount);
        player.data.pendingEvent = null;
      }
      updates.set(player, { notices: this.notices, events });
    }
    this.notices = [];

    const first = this.players.values().next().value;
    const finished = monthIndex(first.data.date, this.year) >= MONTHS_TOTAL;
    if (finished) this.phase = 'finished';
    this.updateRanks();

    for (const [player, update] of updates) {
      this.send(player, {
        type: 'tick',
        day: this.day,
        portfolio: player.data.portfolio,
        history: this.newHistory(player),
        ...update,
        rank: player.rank,
        playersTotal: this.players.size,
        finished
      });
    }
    if (!finished) this.scheduleDay(this.dayMs);
  }

  openCard(player, key) {
    const category = CATEGORIES[key];
    if (!category || !categoryIsOpen(category, player.data.date, this.year)) return;
    player.cards[key] = 'active';
  }

  // Заявка игрока: проверки здесь и в движке, браузеру нельзя верить ни в чём
  runAction(player, { kind, ticker, amount }) {
    const { data } = player;
    const isTrade = kind === 'buy' || kind === 'sell';
    if (!isTrade && kind !== 'deposit' && kind !== 'withdraw') throw new Error('Неизвестная заявка');

    const categoryKey = isTrade ? categoryOfTicker(this.tickers, ticker) : 'savings';
    if (!categoryKey) throw new Error('Этого инструмента нет в партии');
    if (player.cards[categoryKey] !== 'active') throw new Error('Категория ещё не открыта');

    if (!isTrade) {
      const sum = Number(amount);
      if (!Number.isFinite(sum)) throw new Error('Некорректная сумма');
      if (kind === 'deposit') this.engine.openBank(data, sum);
      else this.engine.withdrawBank(data, sum);
      return sum;
    }

    let quantity = Number(amount);
    if (amount === 'MAX') {
      if (kind === 'sell') {
        quantity = Number(data.portfolio.assets[ticker]) || 0;
      } else {
        const price = Number(this.engine.prices.getPrice(ticker, data.date));
        // При нулевой цене актив ещё не торгуется: заявку на 1 лот движок отклонит с понятным текстом
        quantity = price > 0 ? Math.floor(data.portfolio.cash / price) : 1;
      }
    }
    if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('Недостаточно средств или лотов');
    if (kind === 'buy') this.engine.buyAsset(data, ticker, quantity);
    else this.engine.sellAsset(data, ticker, quantity);
    return quantity;
  }

  // ===== Сообщения =====

  handle(player, message) {
    const isHost = player.id === this.hostId;
    switch (message.type) {
      case 'leave':
        this.leave(player);
        player.conn = null;
        return { left: true };
      case 'ready':
        if (this.phase !== 'lobby') return null;
        player.ready = Boolean(message.ready);
        this.broadcastLobby();
        return null;
      case 'template':
        if (this.phase !== 'lobby' || !isHost || !Object.hasOwn(TEMPLATES, message.template)) return null;
        this.template = message.template;
        this.broadcastLobby();
        return null;
      case 'start':
        if (this.phase !== 'lobby' || !isHost) return null;
        if ([...this.players.values()].some((p) => !p.ready)) {
          this.send(player, { type: 'error', message: 'Не все участники готовы' });
          return null;
        }
        this.start();
        return null;
      case 'pause':
        if (isHost) this.setPaused(Boolean(message.paused));
        return null;
      case 'card':
        if (this.phase === 'playing') this.openCard(player, message.key);
        return null;
      case 'action':
        this.handleAction(player, message);
        return null;
      default:
        return null;
    }
  }

  handleAction(player, message) {
    const reply = { type: 'result', id: message.id, kind: message.kind };
    if (this.phase !== 'playing') {
      this.send(player, { ...reply, ok: false, error: 'Партия не идёт' });
      return;
    }
    try {
      const amount = this.runAction(player, message);
      this.send(player, { ...reply, ok: true, amount, portfolio: player.data.portfolio, history: this.newHistory(player) });
    } catch (error) {
      this.send(player, { ...reply, ok: false, error: error.message });
    }
  }

  destroy() {
    clearTimeout(this.timer);
    for (const player of this.players.values()) {
      clearTimeout(player.graceTimer);
      if (player.conn) {
        player.conn.send({ type: 'error', fatal: true, message: 'Комната закрыта' });
        player.conn.room = null;
        player.conn.player = null;
      }
    }
  }
}

export class RoomManager {
  constructor(catalog, { dayMs } = {}) {
    this.catalog = catalog;
    this.dayMs = dayMs;
    this.rooms = new Map();
    this.sweepTimer = setInterval(() => this.sweep(), 60 * 1000);
    this.sweepTimer.unref();
  }

  createCode() {
    for (;;) {
      const code = Array.from({ length: ROOM_CODE_LENGTH }, () => ROOM_CODE_CHARS[randomInt(ROOM_CODE_CHARS.length)]).join('');
      if (!this.rooms.has(code)) return code;
    }
  }

  deleteRoom(room) {
    room.destroy();
    this.rooms.delete(room.code);
  }

  sweep() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      const idle = room.idleSince !== null && now - room.idleSince > ROOM_IDLE_MS;
      if (idle || now - room.createdAt > ROOM_MAX_AGE_MS) this.deleteRoom(room);
    }
  }

  fail(conn, message) {
    conn.send({ type: 'error', fatal: true, message });
  }

  create(conn, { name, token }) {
    if (!isValidToken(token)) return this.fail(conn, 'Некорректный запрос');
    if (this.rooms.size >= MAX_ROOMS) return this.fail(conn, 'Сервер перегружен, попробуй позже');
    const room = new Room(this.createCode(), this.catalog, { dayMs: this.dayMs, onEmpty: (r) => this.deleteRoom(r) });
    this.rooms.set(room.code, room);
    room.attach(room.addPlayer(token, name), conn);
    room.broadcastLobby();
    return undefined;
  }

  join(conn, { code, name, token }) {
    if (!isValidToken(token)) return this.fail(conn, 'Некорректный запрос');
    const room = this.rooms.get(String(code ?? '').trim().toUpperCase());
    if (!room) return this.fail(conn, 'Комната не найдена');

    // Вернуться может только тот, кто уже был в комнате: токен знает лишь его браузер
    let player = room.players.get(token);
    if (!player) {
      if (room.phase !== 'lobby') return this.fail(conn, 'Игра уже началась');
      if (room.players.size >= LOBBY_MAX_PLAYERS) return this.fail(conn, 'Комната заполнена');
      player = room.addPlayer(token, name);
    }
    room.attach(player, conn);
    if (room.phase === 'lobby') room.broadcastLobby();
    else room.sendSnapshot(player);
    return undefined;
  }

  handle(conn, message) {
    if (message?.type === 'create' || message?.type === 'join') {
      if (conn.room) this.disconnect(conn);
      if (message.type === 'create') this.create(conn, message);
      else this.join(conn, message);
      return;
    }
    if (!conn.room) {
      conn.send({ type: 'error', message: 'Сначала нужно войти в комнату' });
      return;
    }
    const outcome = conn.room.handle(conn.player, message);
    if (outcome?.left) {
      conn.room = null;
      conn.player = null;
    }
  }

  disconnect(conn) {
    if (conn.room && conn.player?.conn === conn) conn.room.disconnect(conn.player);
    conn.room = null;
    conn.player = null;
  }
}
