// Новостная сводка из prices/news.csv.
// Реальные названия компаний скрываются псевдонимами карточек («Акция 1»): игрок узнаёт,
// во что вкладывался, только в итогах. Новости о компаниях, которых нет в партии, не показываются.

const NEWS_URL = 'prices/news.csv';

// Как компания называется в колонке «Акция / рынок» и как упоминается в тексте новости (с падежами)
const COMPANIES = {
  MGNT: { subjects: ['Магнит'], mentions: [/Магнит[а-яё]*/g] },
  SBER: { subjects: ['Сбер'], mentions: [/Сбер(?:банк)?[а-яё]*/g] },
  GMKN: { subjects: ['Норникель'], mentions: [/Норникел[ья][а-яё]*/g, /в Норильске/g] },
  ROSN: { subjects: ['Роснефть'], mentions: [/Роснефт[ьи][а-яё]*/g, /Rosneft Trading/g] },
  PIKK: { subjects: ['ПИК'], mentions: [/ПИК(?![А-Яа-яЁё])/g] },
  GAZP: { subjects: ['Газпром'], mentions: [/Газпром[а-яё]*/g] },
  PLZL: { subjects: ['Полюс'], mentions: [/Полюс[а-яё]*/g, /Polyus Gold/g] },
  SNGSP: { subjects: ['Сургутнефтегаз-П'], mentions: [/Сургутнефтегаз[а-яё]*/g] },
  VTBR: { subjects: ['ВТБ'], mentions: [/ВТБ/g] },
  LSRG: { subjects: ['ЛСР'], mentions: [/ЛСР/g] },
  AFKS: { subjects: ['АФК Система'], mentions: [/АФК Систем[а-яё]*/g] },
  TRNFP: { subjects: ['Транснефть'], mentions: [/Транснефт[ьи][а-яё]*/g] },
  MOEX: { subjects: ['Московская биржа'], mentions: [/Московск[а-яё]+ бирж[а-яё]*/g, /Мосбиржа/g, /ММВБ и РТС/g] },
  YDEX: { subjects: ['Яндекс'], mentions: [/Яндекс[а-яё]*(?:\.[А-Яа-яЁё]+)?/g, /Yandex N\.V\./g] },
  DSKY: { subjects: ['Детский мир'], mentions: [/(?:ПАО )?Детск[а-яё]+ мир[а-яё]*/g] },
  X5: { subjects: ['X5'], mentions: [/X5/g, /Х5/g] },
  OZON: { subjects: ['Ozon'], mentions: [/Ozon/g] }
};

const SUBJECT_TICKER = Object.fromEntries(
  Object.entries(COMPANIES).flatMap(([ticker, { subjects }]) => subjects.map((s) => [s, ticker]))
);

// Минимальный разбор CSV с «;» и кавычками
function parseCsv(text, delimiter = ';') {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows;
}

let cache = null;

async function loadAllNews() {
  if (!cache) {
    cache = fetch(NEWS_URL)
      .then((response) => {
        if (!response.ok) throw new Error(`Не удалось загрузить ${NEWS_URL}`);
        return response.text();
      })
      .then((text) => parseCsv(text)
        .filter((r) => /^\d{4}$/.test(r[0]) && r[2] && r[4])
        .map(([year, , date, subject, text]) => ({ year: Number(year), date, subject: subject.trim(), text: text.trim() })));
  }
  return cache;
}

/**
 * Новости игрового года с псевдонимами вместо названий компаний партии.
 * @param {number} year - год начала партии
 * @param {Object.<string, string>} aliases - тикер → псевдоним карточки, например { SBER: 'Акция 2' }
 * @returns {Promise<Array<{date: string, title: string, text: string}>>} по возрастанию даты
 */
export async function loadNews(year, aliases) {
  const all = await loadAllNews();
  const result = [];

  for (const item of all.filter((n) => n.year === year)) {
    // «Сбер / ВТБ», «ПИК и ЛСР» — несколько компаний; рыночные темы в SUBJECT_TICKER не входят
    const parts = item.subject.split(/\s+\/\s+|\s+и\s+/);
    const tickers = parts.map((part) => SUBJECT_TICKER[part]);
    const isCompanyNews = tickers.every(Boolean);
    if (isCompanyNews && !tickers.some((t) => aliases[t])) continue;

    let text = item.text;
    for (const [ticker, alias] of Object.entries(aliases)) {
      for (const pattern of COMPANIES[ticker]?.mentions || []) {
        text = text.replace(pattern, `«${alias}»`);
      }
    }

    const title = isCompanyNews
      ? parts.map((part, i) => aliases[tickers[i]] || part).join(' / ')
      : item.subject;

    result.push({ date: item.date, title, text });
  }

  return result.sort((a, b) => a.date.localeCompare(b.date));
}
