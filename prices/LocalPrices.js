export class LocalPrices {
    constructor(year, dataUrl = './prices/data.json') {
        this.year = year;
        this.prices = {};
        this.dateValue = {};
        this.dataUrl = dataUrl;
        this.isLoaded = false;
        this.allData = null;
        this.availableRanges = [];
    }

    // Приватный метод инициализации (вызывается только из фабричного метода)
    async #init(year) {
        try {
            let yearRange = year + "-08-01_" + String(parseInt(year) + 1) + "-08-31";
            console.log(`Загрузка данных для диапазона: ${yearRange}`);
            const response = await fetch(this.dataUrl);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            this.allData = await response.json();
            this.availableRanges = Object.keys(this.allData);
            
            if (this.availableRanges.length === 0) {
                throw new Error('Нет доступных данных');
            }

            if (!this.availableRanges.includes(yearRange)) {
                throw new Error(`Диапазон ${yearRange} не найден`);
            }

            this.processYearRange(this.allData[yearRange]);
            this.isLoaded = true;
            
            return this;
        } catch (error) {
            console.error('Ошибка загрузки данных из JSON:', error);
            this.isLoaded = false;
            throw error;
        }
    }

    getDay(date) {
        const safeDate = date instanceof Date ? new Date(date) : (date ? new Date(String(date)) : new Date(this.year, 7, 1));
        if (Number.isNaN(safeDate.getTime())) {
            throw new Error(`Некорректная дата для тикера: ${date}`);
        }
        return Math.round((safeDate - new Date(this.year, 7, 1)) / 86400000);
    }

    // Статический фабричный метод
    static async create(year, dataUrl = './prices/data.json') {
        const instance = new LocalPrices(year, dataUrl);
        await instance.#init(year);
        return instance;
    }

    processYearRange(yearData) {
        this.prices = {};
        this.dateValue = {};
        
        for (const [ticker, tickerData] of Object.entries(yearData)) {
            if (tickerData.price && Array.isArray(tickerData.price)) {
                this.prices[ticker] = tickerData.price;
            }
            
            if (tickerData.date_value && Array.isArray(tickerData.date_value)) {
                const map = new Map();
                for (const trio of tickerData.date_value) {
                    if (trio && trio.date) {
                        map.set(trio.date, [trio.value, trio.status]);
                    }
                }
                this.dateValue[ticker] = map;
            } else {
                this.dateValue[ticker] = new Map();
            }
        }
    }

    getPrice(ticker, date) {
        const normalizedDate = date instanceof Date ? new Date(date) : (date ? new Date(String(date)) : new Date(this.year, 8, 1));
        if (Number.isNaN(normalizedDate.getTime())) {
            throw new Error(`Некорректная дата для тикера: ${ticker}: ${date}`);
        }

        const day = this.getDay(normalizedDate);
        if (!this.isLoaded) {
            throw new Error('Данные еще не загружены. Дождитесь загрузки.');
        }
        
        if (!this.prices[ticker]) {
            throw new Error(`Неизвестный тикер: ${ticker}, доступные тикеры: ${Object.keys(this.prices).join(', ')}`);
        }
        
        const dayIndex = Math.min(day, this.prices[ticker].length - 1);
        return this.prices[ticker][dayIndex];
    }

    getHistory(ticker) {
        if (!this.isLoaded) {
            throw new Error('Данные еще не загружены. Дождитесь загрузки.');
        }
        return this.prices[ticker] || [];
    }

    /**
     * Дата полного дефолта (status -2) в формате YYYY-MM-DD или null
     */
    getDefaultDate(ticker) {
        let first = null;
        for (const [date, [, status]] of this.dateValue[ticker] || []) {
            if (status === -2 && (!first || date < first)) first = date;
        }
        return first;
    }

    getValueByDate(ticker, date) {
        if (!this.isLoaded) {
            throw new Error('Данные еще не загружены. Дождитесь загрузки.');
        }

        const map = this.dateValue[ticker];
        if (!map) throw new Error(`Неизвестный тикер: ${ticker}, доступные тикеры: ${Object.keys(this.dateValue).join(', ')}`);

        const safeDate = date instanceof Date ? new Date(date) : new Date(String(date));
        if (Number.isNaN(safeDate.getTime())) {
            return 0;
        }

        const key = this.formatDate(safeDate);
        return map.has(key) ? map.get(key) : [0, 0];
    }

    formatDate(date) {
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    }

    getAvailableYearRanges() {
        return this.availableRanges;
    }

    async setYearRange(yearRange) {
        if (!this.availableRanges.includes(yearRange)) {
            throw new Error(`Диапазон ${yearRange} не найден`);
        }
        
        this.yearRange = yearRange;
        this.processYearRange(this.allData[yearRange]);
        this.isLoaded = true;
    }
}