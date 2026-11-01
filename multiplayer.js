// Соединение браузера с сервером мультиплеера. Логика игры здесь не живёт — только доставка сообщений.

// Адрес сервера на GitHub Pages, например 'wss://kopilka.example.ru'. Пока пусто — мультиплеер там недоступен.
const PRODUCTION_SERVER_URL = '';
const LOCAL_SERVER_PORT = 8080;
const CONNECT_TIMEOUT_MS = 5000;
const RECONNECT_MAX_DELAY_MS = 10000;

export function multiplayerUrl() {
  const { hostname } = location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return `ws://${hostname}:${LOCAL_SERVER_PORT}`;
  return PRODUCTION_SERVER_URL;
}

export class MultiplayerClient {
  /**
   * @param {string} url
   * @param {Object} handlers
   * @param {() => Object} handlers.hello - Первое сообщение после каждого подключения
   * @param {(message: Object) => void} handlers.onMessage
   * @param {() => void} handlers.onFailed - Самое первое подключение не удалось
   * @param {() => void} handlers.onLost - Связь пропала, идут попытки восстановить её
   * @param {() => void} handlers.onRestored - Связь восстановлена
   */
  constructor(url, handlers) {
    this.url = url;
    this.handlers = handlers;
    this.socket = null;
    this.closed = false;
    this.everConnected = false;
    this.attempts = 0;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.open();
  }

  open() {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    const timeout = setTimeout(() => socket.close(), CONNECT_TIMEOUT_MS);

    socket.addEventListener('open', () => {
      clearTimeout(timeout);
      const restored = this.everConnected;
      this.everConnected = true;
      this.attempts = 0;
      this.send(this.handlers.hello());
      if (restored) this.handlers.onRestored();
    });

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'result') {
        this.pending.get(message.id)?.(message);
        this.pending.delete(message.id);
      } else {
        this.handlers.onMessage(message);
      }
    });

    socket.addEventListener('close', () => {
      clearTimeout(timeout);
      if (this.closed || this.socket !== socket) return;
      this.failPending();
      if (!this.everConnected) {
        this.closed = true;
        this.handlers.onFailed();
        return;
      }
      if (this.attempts === 0) this.handlers.onLost();
      const delay = Math.min(RECONNECT_MAX_DELAY_MS, 1000 * 2 ** this.attempts);
      this.attempts += 1;
      setTimeout(() => {
        if (!this.closed) this.open();
      }, delay);
    });
  }

  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  send(message) {
    if (this.connected) this.socket.send(JSON.stringify(message));
  }

  // Заявка с ответом сервера: при потере связи ответ приходит как отказ
  request(message) {
    if (!this.connected) return Promise.resolve({ ok: false, error: 'Нет связи с сервером' });
    const id = this.nextRequestId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.send({ ...message, id });
    });
  }

  failPending() {
    for (const resolve of this.pending.values()) resolve({ ok: false, error: 'Нет связи с сервером' });
    this.pending.clear();
  }

  close() {
    this.closed = true;
    this.failPending();
    this.socket?.close();
  }
}
