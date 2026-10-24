function serializeForStorage(value) {
    if (value instanceof Date) {
        return { __type: 'date', value: value.toISOString() };
    }

    if (Array.isArray(value)) {
        return value.map((item) => serializeForStorage(item));
    }

    if (value && typeof value === 'object') {
        const result = {};
        for (const [key, item] of Object.entries(value)) {
            result[key] = serializeForStorage(item);
        }
        return result;
    }

    return value;
}

function hydrateFromStorage(value) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) {
        const temp = new Date(value);
        if (!Number.isNaN(temp.getTime())) {
            return temp;
        }
    }

    if (value && typeof value === 'object' && value.__type === 'date') {
        return new Date(value.value);
    }

    if (Array.isArray(value)) {
        return value.map((item) => hydrateFromStorage(item));
    }

    if (value && typeof value === 'object') {
        const result = {};
        for (const [key, item] of Object.entries(value)) {
            result[key] = hydrateFromStorage(item);
        }
        return result;
    }

    return value;
}

export class LocalStorageAdapter {
    /**
     * Сохранить игру в localStorage
     */
    async saveGame(gameId, data) {
        try {
            const serialized = JSON.stringify(serializeForStorage(data));
            localStorage.setItem(`game_${gameId}`, serialized);
        } catch (error) {
            console.error('❌ Ошибка сохранения:', error);
            throw error;
        }
    }

    /**
     * Загрузить игру из localStorage
     */
    async loadGame(gameId) {
        try {
            const raw = localStorage.getItem(`game_${gameId}`);
            if (!raw) {
                console.log(`ℹ️ Игра ${gameId} не найдена`);
                return null;
            }
            const data = hydrateFromStorage(JSON.parse(raw));
            console.log(`✅ Игра ${gameId} загружена`);
            return data;
        } catch (error) {
            console.error('❌ Ошибка загрузки:', error);
            throw error;
        }
    }

    /**
     * Удалить игру
     */
    async deleteGame(gameId) {
        localStorage.removeItem(`game_${gameId}`);
        console.log(`🗑️ Игра ${gameId} удалена`);
    }
}