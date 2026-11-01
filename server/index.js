// Сервер мультиплеера: WebSocket поверх HTTP. Настройки — через переменные окружения, см. server/README.md
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { Catalog, RoomManager } from './rooms.js';

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const DAY_MS = Number(process.env.DAY_MS) || undefined;   // только для проверки: ускоренные игровые дни
const INTRO_MS = Number(process.env.INTRO_MS) || undefined; // только для проверки: сколько ждать вводное обучение
const MAX_MESSAGES_PER_SECOND = 30;
const HEARTBEAT_MS = 30 * 1000;

const manager = new RoomManager(new Catalog(), { dayMs: DAY_MS, introMs: INTRO_MS });

const http = createServer((request, response) => {
  response.writeHead(request.url === '/health' ? 200 : 404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(request.url === '/health' ? 'ok' : 'КОПИЛКА: сервер мультиплеера');
});

const wss = new WebSocketServer({
  server: http,
  maxPayload: 4 * 1024,
  verifyClient: ({ origin }) => !ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin)
});

wss.on('connection', (socket) => {
  const conn = {
    room: null,
    player: null,
    send(message) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    },
    close() {
      socket.close();
    }
  };

  socket.isAlive = true;
  socket.on('pong', () => { socket.isAlive = true; });

  let windowStart = Date.now();
  let messagesInWindow = 0;

  socket.on('message', (raw) => {
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      messagesInWindow = 0;
    }
    if (++messagesInWindow > MAX_MESSAGES_PER_SECOND) return;

    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;

    try {
      manager.handle(conn, message);
    } catch (error) {
      console.error('Ошибка обработки сообщения:', error);
      conn.send({ type: 'error', message: 'Ошибка на сервере' });
    }
  });

  socket.on('close', () => manager.disconnect(conn));
  socket.on('error', (error) => console.warn('Ошибка соединения:', error.message));
});

// Обрыв без закрытия соединения заметен только по неответу на ping
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, HEARTBEAT_MS);
heartbeat.unref();

if (!ALLOWED_ORIGINS.length) console.warn('ALLOWED_ORIGINS не задан: подключаться можно с любого сайта');

http.listen(PORT, HOST, () => console.log(`Сервер мультиплеера слушает ${HOST}:${PORT}`));
