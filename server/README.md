# Сервер мультиплеера

Хранит комнаты, отсчитывает игровые дни и считает портфели всех игроков. Сайт на GitHub Pages только показывает результат и отправляет заявки.

Нужен Node.js 20 или новее. Серверу нужен весь репозиторий: он использует `core/`, `prices/` и `aliases.js`.

## Запуск на своём компьютере

```
cd server
npm install
npm start
```

В другом терминале, из корня репозитория:

```
python -m http.server 8000
```

Откройте [http://localhost:8000](http://localhost:8000). На `localhost` игра сама подключается к `ws://localhost:8080`.

Второго игрока запускайте в окне инкогнито или в другом браузере: вкладки одного браузера делят `localStorage` и будут считаться одним игроком.

Чтобы не ждать партию целиком, ускорьте дни (в PowerShell):

```
$env:DAY_MS = '200'; npm start
```

## Настройки

| Переменная | По умолчанию | Что задаёт |
|---|---|---|
| `PORT` | `8080` | Порт сервера |
| `HOST` | `127.0.0.1` | Адрес; снаружи сервер доступен только через Caddy |
| `ALLOWED_ORIGINS` | пусто (любой сайт) | Сайты, с которых можно подключаться, через запятую |
| `DAY_MS` | из шаблона | Длина игрового дня в мс, только для проверки |

## Запуск на VPS

Инструкция для Ubuntu или Debian. Понадобятся VPS и домен, A-запись которого указывает на IP сервера. Дальше в примерах домен `kopilka.example.ru`.

1. Установите Node.js 20+ и [Caddy](https://caddyserver.com/docs/install), затем скачайте код:

   ```
   sudo git clone https://github.com/DaniilParshukov/kopilka.git /opt/kopilka
   cd /opt/kopilka/server
   sudo npm ci --omit=dev
   ```

2. Создайте службу `/etc/systemd/system/kopilka.service`:

   ```ini
   [Unit]
   Description=Kopilka multiplayer server
   After=network.target

   [Service]
   WorkingDirectory=/opt/kopilka/server
   ExecStart=/usr/bin/node index.js
   Environment=ALLOWED_ORIGINS=https://daniilparshukov.github.io
   Restart=always
   DynamicUser=yes

   [Install]
   WantedBy=multi-user.target
   ```

   ```
   sudo systemctl enable --now kopilka
   ```

3. Добавьте домен в `/etc/caddy/Caddyfile`. Сертификат HTTPS Caddy получит сам:

   ```
   kopilka.example.ru {
       reverse_proxy 127.0.0.1:8080
   }
   ```

   ```
   sudo systemctl reload caddy
   ```

4. Проверьте сервер: `curl https://kopilka.example.ru/health` должен ответить `ok`.

5. В `multiplayer.js` укажите адрес и опубликуйте сайт:

   ```js
   const PRODUCTION_SERVER_URL = 'wss://kopilka.example.ru';
   ```

## Обновление

```
cd /opt/kopilka && sudo git pull
cd server && sudo npm ci --omit=dev
sudo systemctl restart kopilka
```

- **Перезапуск завершает все партии.** Комнаты хранятся в памяти, поэтому обновляйте сервер, когда никто не играет.
- **Сайт и сервер обновляйте вместе**, особенно `prices/data.json`. Цены в браузере показываются из файла сайта, а считаются на сервере: при разных версиях игрок увидит одну цену, а купит по другой.
