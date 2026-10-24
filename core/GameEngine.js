const DEBT_DAILY_RATE = 0.02;

export class GameEngine {
    /**
     * @param {IStorage} storage - Хранилище
     * @param {IPrices} prices - Источник цен
     * @param {Object} [options]
     * @param {(message: string, type?: string) => void} [options.notify] - Показ уведомлений игроку
     * @param {(ticker: string) => string} [options.nameOf] - Отображаемое имя тикера (реальные названия скрыты до конца игры)
     */
    constructor(storage, prices, { notify, nameOf } = {}) {
        this.storage = storage;
        this.prices = prices;
        this.notify = notify || (() => {});
        this.nameOf = nameOf || ((ticker) => ticker);
        this.goodEvents = [
            {
                icon: '🎁',
                title: 'Бабушка подарила лотерейный билет, по которому пришел выигрыш!',
                text: 'Неожиданный доход пополнил ваш бюджет.',
                amount: 5000
            },
            {
                icon: '🏆',
                title: 'За прошлый месяц компания выплатила премию по результатам работы.',
                text: 'Премия увеличила твои свободные средства.',
                amount: 10000
            },
            {
                icon: '🎂',
                title: 'Тетушка прислала перевод на день рождения в этом году подарок пришел неожиданно.',
                text: 'Подарок поступил в твой бюджет.',
                amount: 3000
            },
            {
                icon: '💸',
                title: 'Друг проспорил торт, но ты попросил отдать выигрыш деньгами.',
                text: 'Спор принес небольшой денежный бонус.',
                amount: 1000
            },
            {
                icon: '🔧',
                title: 'Помог разобрать старый сарай на даче и сдал получившийся металлолом.',
                text: 'Неожиданный заработок пополнил бюджет.',
                amount: 30000
            },
            {
                icon: '🏅',
                title: 'За победу в конкурсе по финансовой грамотности тебе выплатили приз.',
                text: 'Знания о финансах принесли денежную награду.',
                amount: 10000
            },
            {
                icon: '🎮',
                title: 'Ты случайно попал на промоакцию игровой приставки и выиграл денежный приз.',
                text: 'Удача принесла дополнительные деньги.',
                amount: 2000
            },
            {
                icon: '📷',
                title: 'На концерте фотографу понадобилась твоя камера Canon PowerShot.',
                text: 'За аренду камеры тебе заплатили.',
                amount: 5000
            },
            {
                icon: '📸',
                title: 'Твоя фотография о дикой природе получила первый приз на фотовыставке.',
                text: 'Творческая работа принесла денежный приз.',
                amount: 10000
            },
            {
                icon: '💳',
                title: 'Банк начислил кэшбек за прошедший месяц по твоим покупкам.',
                text: 'Кэшбек вернулся на твой счет.',
                amount: 2500
            },
            {
                icon: '🧥',
                title: 'В кармане зимнего пуховика нашлась забытая купюра.',
                text: 'Приятная находка увеличила бюджет.',
                amount: 2000
            },
            {
                icon: '🎧',
                title: 'На день рождения подарили двое одинаковых наушников. Одни удалось продать на Авито.',
                text: 'Продажа ненужного подарка принесла деньги',
                amount: 7600
            },
            {
                icon: '✍️',
                title: 'На концерте удалось получить два автографа. Один продан в соцсетях.',
                text: 'Редкий сувенир оказался востребованным.',
                amount: 20000
            },
            {
                icon: '💼',
                title: 'Начальник поручил подготовить презентацию по проекту и выписал премию.',
                text: 'Дополнительная работа принесла премию.',
                amount: 3000
            },
            {
                icon: '🐱',
                title: 'Твой кот получил приз зрительских симпатий на выставке котов.',
                text: 'К премии добавились 2 кг корма для кота.',
                amount: 5000
            }
        ];

        this.badEvents = [
            {
                icon: '🛡️',
                title: 'Нужно срочно оформить страховку от укуса клеща.',
                text: 'Деньги списаны из бюджета.',
                amount: -1000
            },
            {
                icon: '🩻',
                title: 'На пробежке ты поскользнулся. Нужно срочно сделать рентген без медицинской страховки.',
                text: 'Срочная диагностика потребовала расходов.',
                amount: -1500
            },
            {
                icon: '💊',
                title: 'Бабушке срочно нужно привезти лекарство, которое выписал терапевт.',
                text: 'Лекарство пришлось купить за свои деньги.',
                amount: -1200
            },
            {
                icon: '🐾',
                title: 'Коту не хватает витаминов. Ветеринар назначил таблетки с таурином.',
                text: 'Покупка назначенных ветеринаром таблеток.',
                amount: -500
            },
            {
                icon: '🐱',
                title: 'Кот испортил диван. Срочно нужно постричь ему когти.',
                text: 'Незапланированный уход за питомцем.',
                amount: -1000
            },
            {
                icon: '🚦',
                title: 'За переход дороги вне зоны пешеходного перехода сотрудник ГИБДД выписал штраф.',
                text: 'Штраф уменьшил свободные средства.',
                amount: -1000
            },
            {
                icon: '🎁',
                title: 'У подруги день рождения. Нужно срочно купить подарок.',
                text: 'Праздничный подарок немного уменьшил твой бюджет.',
                amount: -3000
            },
            {
                icon: '💍',
                title: 'Идешь к друзьям на свадьбу. Нужно подготовить подарок.',
                text: 'Подарок на свадьбу заметно уменьшил бюджет.',
                amount: -10000
            },
            {
                icon: '🏠',
                title: 'Ты живешь у друга месяц на время ремонта. Нужно оплатить коммунальные расходы.',
                text: 'Коммунальные платежи пришлось взять на себя.',
                amount: -2500
            },
            {
                icon: '💳',
                title: 'Ты забыл отказаться от платной подписки и в этом месяце списались деньги.',
                text: 'Неожиданное списание уменьшило бюджет.',
                amount: -1600
            },
            {
                icon: '☔',
                title: 'Весь день идет дождь, а зонта нет. Рядом только магазин.',
                text: 'Пришлось срочно купить зонт.',
                amount: -6500
            },
            {
                icon: '⚡',
                title: 'Во время грозы молния вывела из строя зарядное устройство от ноутбука.',
                text: 'Электронику пришлось срочно заменить.',
                amount: -6500
            },
            {
                icon: '♨️',
                title: 'Опаздываешь на поезд. Успеть можно только на такси.',
                text: 'Срочная поездка добавила расход.',
                amount: -4000
            },
            {
                icon: '🚕',
                title: 'Опаздываешь на поезд. Успеть можно только на такси.',
                text: 'Срочная поездка добавила расход.',
                amount: -500
            },
            {
                icon: '📱',
                title: 'Телефон упал в воду и перестал работать. Придется покупать новый Android.',
                text: 'Поломка телефона стала крупной незапланированной тратой.',
                amount: -15000
            }
        ];
    }

    /**
     * Долг (отрицательные свободные деньги) растёт на 2% в день — сложный процент
     */
    applyDebtInterest(portfolio) {
        const cash = Number(portfolio?.cash) || 0;
        if (cash < 0) {
            portfolio.cash = cash * (1 + DEBT_DAILY_RATE);
        }
    }

    /**
     * Начислить проценты по депозитам
     */
    applyBankInterest(portfolio, date) {
        if (!portfolio || !this.prices || typeof this.prices.getPrice !== 'function') {
            return;
        }

        const safeDate = date instanceof Date ? new Date(date) : new Date(String(date));
        if (Number.isNaN(safeDate.getTime())) {
            return;
        }

        const currentBalance = Number(portfolio.bankBalance) || 0;
        const rawRate = Number(this.prices.getPrice('BANK', safeDate));
        if (!Number.isFinite(rawRate) || rawRate <= 0) {
            return;
        }

        const bankRate = currentBalance < 0 ? rawRate * 2 : rawRate;
        const dailyRate = bankRate / 365;
        portfolio.bankBalance = currentBalance + (currentBalance * dailyRate / 100);
    }

    applyAssetDatePayments(gameData) {
        const portfolio = gameData?.portfolio;
        const date = gameData?.date;

        if (!portfolio || !portfolio.assets || !date || !this.prices || typeof this.prices.getValueByDate !== 'function') {
            return;
        }

        for (const [ticker, quantity] of Object.entries(portfolio.assets)) {
            let val = this.prices.getValueByDate(ticker, date);
            let payoutValue = Number(val[0]) || 0;
            const amount = payoutValue * Number(quantity);
            const name = this.nameOf(ticker);
            if (val[1] === -1) {
                if (payoutValue === 0) {
                    this.notify(`Технический дефолт ${name}, выплата не состоялась`, 'error');
                    continue;
                } else {
                    this.notify(`Технический дефолт ${name}, ${Math.round(amount)} ₽ выплачено с задержкой`, 'error');
                }
            } else if (val[1] === -2) {
                this.notify(`Дефолт ${name}, вложения обнулены`, 'error');
                delete portfolio.assets[ticker];
                const entry = this.ensureAssetValuesEntry(portfolio, ticker);
                entry.quantity = 0;
                entry.value = 0;
                continue;
            }

            if (!Number.isFinite(payoutValue) || payoutValue < 0) {
                console.error(`Неверное значение выплаты для тикера ${ticker} на дату ${date.toISOString()}: ${payoutValue}`);
                continue;
            }

            if (amount <= 0) {
                continue;
            }

            portfolio.cash += amount;
            this.ensureAssetValuesEntry(portfolio, ticker).withdrawn += amount;

            if (val[1] === 0) {
                this.notify(`${name} выплачивает ${Math.round(amount)} ₽`, 'success');
            }
            gameData.history.push({
                type: 'ASSET_PAYOUT',
                ticker,
                quantity,
                payoutValue,
                amount,
                date: new Date(date)
            });
        }
    }

    /**
     * Гарантирует наличие записи в portfolio.assetValues для тикера
     */
    ensureAssetValuesEntry(portfolio, ticker) {
        if (!portfolio) return null;
        portfolio.assetValues = portfolio.assetValues || {};
        if (!portfolio.assetValues[ticker]) {
            portfolio.assetValues[ticker] = {
                quantity: 0,
                price: 0,
                value: 0,
                invested: 0,
                withdrawn: 0,
                yield: 0.0
            };
        }
        return portfolio.assetValues[ticker];
    }

    /**
     * Переоценить активы по текущим ценам
     */
    revaluateAssets(portfolio, date) {
        const safeDate = date instanceof Date ? new Date(date) : new Date(String(date));
        if (Number.isNaN(safeDate.getTime())) {
            return;
        }

        // Проданные целиком активы удалены из assets, но их запись в assetValues нужно обнулить
        const tickers = new Set([...Object.keys(portfolio.assets || {}), ...Object.keys(portfolio.assetValues || {})]);
        for (const ticker of tickers) {
            const quantity = portfolio.assets?.[ticker];
            const price = Number(this.prices.getPrice(ticker, safeDate));
            const entry = this.ensureAssetValuesEntry(portfolio, ticker);

            entry.quantity = Number(quantity) || 0;
            entry.price = price;
            entry.value = entry.quantity * price;

            const invested = Number(entry.invested) || 0;
            entry.yield = invested <= 0 ? 0 : ((entry.value + entry.withdrawn - invested) / invested) * 100;
        }
    }

    /**
     * Рассчитать общую стоимость портфеля
     */
    getTotalValue(portfolio) {
        if (!portfolio) return 0;

        let total = Number(portfolio.cash) || 0;
        total += Number(portfolio.bankBalance) || 0;
        for (const [ticker, data] of Object.entries(portfolio.assetValues || {})) {
            total += Number(data?.value) || 0;
        }
        return total;
    }


    nextDay(gameData) {
        const safeDate = gameData.date instanceof Date ? new Date(gameData.date) : new Date(String(gameData.date));
        if (Number.isNaN(safeDate.getTime())) {
            throw new Error('Некорректная дата игры для перехода на следующий день');
        }
        safeDate.setDate(safeDate.getDate() + 1);
        gameData.date = safeDate;

        this.applyDebtInterest(gameData.portfolio);
        this.applyBankInterest(gameData.portfolio, gameData.date);
        this.applyAssetDatePayments(gameData);
        this.checkSpeshialEvents(gameData);
        this.revaluateAssets(gameData.portfolio, gameData.date);

        if (!gameData.monthlyEvents) {
            gameData.monthlyEvents = {};
        }

        this.checkSalary(gameData);
        gameData.pendingEvent = this.checkLifeEvents(gameData);
    }

    openBank(gameData, amount) {
        const numericAmount = Number(amount) || 0;
        if (numericAmount <= 0) {
            throw new Error('Сумма пополнения должна быть положительной');
        }
        if ((Number(gameData.portfolio.cash) || 0) < numericAmount) {
            throw new Error(`Недостаточно средств. Нужно: ${numericAmount}, есть: ${Number(gameData.portfolio.cash) || 0}`);
        }
        gameData.portfolio.cash -= numericAmount;
        gameData.portfolio.bankBalance = (Number(gameData.portfolio.bankBalance) || 0) + numericAmount;

        gameData.history.push({
            type: 'BANK_OPEN',
            amount: numericAmount,
            date: new Date(gameData.date)
        });
    }

    withdrawBank(gameData, amount) {
        const numericAmount = Number(amount) || 0;
        if (numericAmount <= 0) {
            throw new Error('Сумма снятия должна быть положительной');
        }
        if ((Number(gameData.portfolio.bankBalance) || 0) < numericAmount) {
            throw new Error(`Недостаточно средств на счёте. Есть: ${Number(gameData.portfolio.bankBalance) || 0}`);
        }
        gameData.portfolio.bankBalance -= numericAmount;
        gameData.portfolio.cash += numericAmount;
        gameData.history.push({
            type: 'BANK_WITHDRAW',
            amount: numericAmount,
            date: new Date(gameData.date)
        });
    }

    /**
     * Полный дефолт уже наступил: после него инструмент отключён
     */
    isDefaulted(ticker, date) {
        const defaultDate = this.prices?.getDefaultDate?.(ticker);
        if (!defaultDate) return false;
        const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        return defaultDate <= day;
    }

    buyAsset(gameData, ticker, amount) {
        const safeAmount = Number(amount) || 0;
        if (safeAmount <= 0) {
            throw new Error('Количество должно быть положительным');
        }

        const date = new Date(gameData.date);
        if (Number.isNaN(date.getTime())) {
            throw new Error('Некорректная дата игры');
        }

        if (this.isDefaulted(ticker, date)) {
            throw new Error(`${this.nameOf(ticker)}: дефолт, торги недоступны`);
        }

        const price = Number(this.prices.getPrice(ticker, date));
        if (!(price > 0)) {
            throw new Error(`${this.nameOf(ticker)} пока не торгуется`);
        }
        const cost = price * safeAmount;

        if ((Number(gameData.portfolio.cash) || 0) < cost) {
            throw new Error(`Недостаточно средств. Нужно: ${cost}, есть: ${Number(gameData.portfolio.cash) || 0}`);
        }

        gameData.portfolio.cash -= cost;

        if (!gameData.portfolio.assets[ticker]) {
            gameData.portfolio.assets[ticker] = 0;
        }
        gameData.portfolio.assets[ticker] += safeAmount;

        this.ensureAssetValuesEntry(gameData.portfolio, ticker).invested += cost;

        gameData.history.push({
            type: 'BUY',
            ticker,
            amount: safeAmount,
            price,
            total: cost,
            date: new Date(date)
        });
        
        this.revaluateAssets(gameData.portfolio, date);

        return gameData;
    }

    sellAsset(gameData, ticker, amount) {
        const safeAmount = Number(amount) || 0;
        if (safeAmount <= 0) {
            throw new Error('Количество должно быть положительным');
        }

        const date = gameData.date instanceof Date ? new Date(gameData.date) : new Date(String(gameData.date));
        if (Number.isNaN(date.getTime())) {
            throw new Error('Некорректная дата игры');
        }

        const price = Number(this.prices.getPrice(ticker, date));
        const revenue = price * safeAmount;
        
        if (!gameData.portfolio.assets[ticker]) {
            throw new Error(`У вас нет актива ${this.nameOf(ticker)}`);
        }

        if ((Number(gameData.portfolio.assets[ticker]) || 0) < safeAmount) {
            throw new Error(`У вас только ${Number(gameData.portfolio.assets[ticker]) || 0} ед. ${this.nameOf(ticker)}`);
        }
        
        gameData.portfolio.assets[ticker] -= safeAmount;
        
        if (gameData.portfolio.assets[ticker] === 0) {
            delete gameData.portfolio.assets[ticker];
        }
        
        gameData.portfolio.cash += revenue;

        this.ensureAssetValuesEntry(gameData.portfolio, ticker).withdrawn += revenue;
        
        gameData.history.push({
            type: 'SELL',
            ticker,
            amount: safeAmount,
            price,
            total: revenue,
            date: new Date(date)
        });
        
        this.revaluateAssets(gameData.portfolio, date);
        
        return gameData;
    }

    checkSalary(gameData) {
        const day = gameData.date.getDate();
        if (day === 10 || day === 25) {
            const amount = 10000;
            gameData.portfolio.cash += amount;
            gameData.history.push({
                type: 'SALARY',
                amount,
                date: new Date(gameData.date)
            });
            this.notify(`${day === 10 ? 'Аванс' : 'Зарплата'}: +${amount} ₽`, 'success');
        }
    }

    checkSpeshialEvents(gameData) {
        if (!gameData || !gameData.portfolio || !gameData.date) {
            return;
        }

        const date = gameData.date instanceof Date ? new Date(gameData.date) : new Date(String(gameData.date));
        if (Number.isNaN(date.getTime())) {
            return;
        }

        const day = date.getDate();
        const month = date.getMonth();
        const year = date.getFullYear();

        // Даты из примечаний tickers.csv (в этот день в data.json уже цена после сплита).
        // month — индекс месяца Date: 0 = январь.
        const splitRules = [
            { ticker: 'VTBR', day: 15, month: 6, year: 2024, ratio: 1 / 5000 }, // 2024-07-15
            { ticker: 'GMKN', day: 8, month: 3, year: 2024, ratio: 100 },       // 2024-04-08
            { ticker: 'TRNFP', day: 21, month: 1, year: 2024, ratio: 100 },     // 2024-02-21
            { ticker: 'PLZL', day: 27, month: 2, year: 2025, ratio: 10 }        // 2025-03-27
        ];

        for (const rule of splitRules) {
            if (day !== rule.day || month !== rule.month || year !== rule.year) continue;

            const ticker = rule.ticker;
            const portfolio = gameData.portfolio;
            const quantity = Number(portfolio.assets[ticker]);
            if (!Number.isFinite(quantity) || quantity <= 0) continue;

            const price = Number(this.prices?.getPrice?.(ticker, date) || 0);
            // price — уже новая цена, старая = price × ratio. Дробный остаток после округления
            // количества вниз возвращается деньгами.
            const oldValue = quantity * price * rule.ratio;
            const updatedQuantity = Math.floor(quantity * rule.ratio);

            portfolio.assets[ticker] = updatedQuantity;
            const entry = this.ensureAssetValuesEntry(portfolio, ticker);
            entry.quantity = updatedQuantity;
            entry.price = price;
            entry.value = updatedQuantity * price;

            const deltaValue = oldValue - (updatedQuantity * price);
            portfolio.cash += deltaValue;

            this.notify(`Сплит ${this.nameOf(ticker)}: ${rule.ratio >= 1 ? `${rule.ratio}x` : `1/${1 / rule.ratio}`}`, 'error');
        }
    }

    getRandomEventDay() {
        let eventDay;
        do {
            eventDay = Math.floor(Math.random() * 28) + 3;
        } while (eventDay === 10 || eventDay === 25 || eventDay === 15 || eventDay === 20);
        return eventDay;
    }

    /**
     * Проверить жизненные ситуации
     */
    createRandomEvent() {
        const isGood = Math.random() < 0.5;

        const eventPool = isGood ? this.goodEvents : this.badEvents;
        const randomIndex = Math.floor(Math.random() * eventPool.length);
        const selectedEvent = eventPool[randomIndex];

        return {
            type: 'event',
            icon: selectedEvent.icon,
            title: selectedEvent.title,
            text: selectedEvent.text,
            amount: selectedEvent.amount,
            buttonText: isGood ? `ОТЛИЧНО!` : 'ПОНЯТНО!',
            testMode: true
        };
    }

    /**
     * Расписание жизненных событий на игровой год (с 1 сентября года gameData.year).
     * lifeEvents: 'normal' — по одному событию в марте–августе, 'high' — каждый месяц.
     * Хороших и плохих событий поровну, порядок случайный.
     */
    planLifeEvents(gameData) {
        const year = Number(gameData.year) || gameData.date.getFullYear();
        const months = gameData.lifeEvents === 'high'
            ? Array.from({ length: 12 }, (_, i) => new Date(year, 8 + i, 1))
            : Array.from({ length: 6 }, (_, i) => new Date(year + 1, 2 + i, 1));

        const types = months.map((_, i) => (i % 2 === 0 ? 'good' : 'bad'));
        for (let i = types.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [types[i], types[j]] = [types[j], types[i]];
        }

        return months.map((month, i) => {
            const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
            const day = Math.min(this.getRandomEventDay(), daysInMonth);
            return { date: new Date(month.getFullYear(), month.getMonth(), day), type: types[i] };
        });
    }

    checkLifeEvents(gameData) {
        if (!gameData._lifeEventPlan) {
            gameData._lifeEventPlan = this.planLifeEvents(gameData);
        }

        const today = gameData.date;
        const eventInfo = gameData._lifeEventPlan.find(({ date }) => (
            date.getFullYear() === today.getFullYear()
            && date.getMonth() === today.getMonth()
            && date.getDate() === today.getDate()
        ));

        if (eventInfo) {
            const isGood = eventInfo.type === 'good';


            // Выбираем случайное событие из соответствующего списка
            const eventPool = isGood ? this.goodEvents : this.badEvents;
            const randomIndex = Math.floor(Math.random() * eventPool.length);
            const selectedEvent = eventPool[randomIndex];

            return {
                type: 'event',
                icon: selectedEvent.icon,
                title: selectedEvent.title,
                text: selectedEvent.text,
                amount: selectedEvent.amount,
                buttonText: isGood ? `ОТЛИЧНО!` : 'ПОНЯТНО!',
            };
        }

        return null;
    }

    changeCash(gameData, amount) {
        const numericAmount = Number(amount) || 0;
        gameData.portfolio.cash += numericAmount;
        gameData.history.push({
            type: 'CASH_CHANGE',
            amount: numericAmount,
            day: new Date(gameData.date)
        });
        return gameData;
    }
}