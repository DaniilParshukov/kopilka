"""Собирает prices/data.json из выгрузок в data/raw. Исходные файлы не меняет.

    python scripts/build_prices.py          проверить и записать
    python scripts/build_prices.py --check  только проверить

Нужны pandas и openpyxl. При любой ошибке в данных файл не перезаписывается.

Раскладка data/raw:
    <диапазон>/<группа>/[подгруппа/]XLSX/<файл>.xlsx
Индексы лежат в группе «Индекс»; в игру идёт только MCFTR, остальные (IMOEX) пропускаются.
Парные CSV не читаются: в них нет заливки ячеек, которой в облигациях отмечены дефолты.
"""
import csv
import datetime as dt
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

import pandas as pd
from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / 'data' / 'raw'
OUTPUT = ROOT / 'prices' / 'data.json'
TICKERS = ROOT / 'prices' / 'tickers.csv'

RANGE = re.compile(r'\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}')
INDEX_GROUP = 'Индекс'
INDEX_TICKER = 'MCFTR'

# Заливка столбца coupon_payment_rub: дефолты; остальные цвета — обычные выплаты
TECHNICAL_DEFAULT = 'F4B183'
DEFAULT = 'FFC7CE'
PLAIN_FILLS = {None, 'E2F0D9', 'FFF2CC'}

# Погашение внутри окна, которого в выгрузке не видно: цена идёт дальше, как будто бумага осталась.
# В этот день выплата получает статус 1 (бумага уходит из портфеля), а цена с этого дня равна 0.
REDEMPTIONS = {
    ('2022-08-01_2023-08-31', 'RU000A103WX4'): '2023-05-26',  # Гарант-Инвест-002P-04
}

# Убраны из игры: файлы в выгрузке есть, но не читаются (выкуп и делистинг Детского мира не реализованы)
EXCLUDED = {
    ('2023-08-01_2024-08-31', 'DSKY'),
    ('2024-08-01_2025-08-31', 'DSKY'),
}

# Столбец цены по названию группы
PRICE_COLUMN = {
    'Акции': 'close',
    'Фьючи аналог': 'close',
    'Облигации': 'open_dirty_value_rub',
    'Фонды': 'unit_price',
    'Валюта': 'usd_rub_rate',
    'Ставка': 'bank_deposit_rate_pct',
    INDEX_GROUP: 'close',
}
# Цена до первых торгов может быть пустой только у этих групп
LATE_START = {'Облигации', 'Фонды'}
# Золото хранится вместе с пустым date_value, как и акции
WITH_PAYOUTS = {'Акции', 'Облигации', 'Фьючи аналог'}

errors = []


def fail(where, message):
    errors.append(f'{where}: {message}')


def ticker_of(stem):
    # BOND_<название>_<ISIN>, остальные — <тикер>_<что угодно>
    return stem.rsplit('_', 1)[1] if stem.startswith('BOND_') else stem.split('_')[0]


def numeric(frame, column, where):
    values = pd.to_numeric(frame[column], errors='coerce')
    broken = frame[column].notna() & values.isna()
    if broken.any():
        fail(where, f'{column}: не числа, например {frame[column][broken].iloc[0]!r}')
    return values


def check_dates(frame, range_name, where):
    start, end = (dt.date.fromisoformat(part) for part in range_name.split('_'))
    expected = pd.date_range(start, end, freq='D')
    dates = pd.to_datetime(frame['date'], errors='coerce')
    if len(dates) != len(expected) or not (dates.values == expected.values).all():
        fail(where, f'даты должны идти подряд с {start} по {end}, строк {len(dates)}, нужно {len(expected)}')


def price_list(frame, group, where):
    column = PRICE_COLUMN[group]
    values = numeric(frame, column, where)
    if (values < 0).any():
        fail(where, f'{column}: отрицательная цена')
    trading = values.fillna(0) > 0
    if not trading.any():
        fail(where, f'{column}: нет ни одной цены')
        return []
    first = trading.idxmax()
    if not trading[first:].all():
        fail(where, f'{column}: дыра в ценах с {frame["date"][(~trading[first:]).idxmax()].date()}')
    if first > 0 and group not in LATE_START and group != 'Ставка':
        fail(where, f'{column}: нет цен до {frame["date"][first].date()}')
    # Игра читает 0 как «ещё не торгуется»
    return [0.0 if pd.isna(value) else value for value in frame[column].tolist()]


def fill_colors(path):
    """Цвет заливки coupon_payment_rub по номеру строки данных."""
    book = load_workbook(path, data_only=True)
    sheet = book.active
    header = [cell.value for cell in sheet[1]]
    column = header.index('coupon_payment_rub') + 1
    colors = {}
    for row in range(2, sheet.max_row + 1):
        fill = sheet.cell(row=row, column=column).fill
        colors[row - 2] = str(fill.fgColor.rgb)[-6:].upper() if fill.patternType == 'solid' else None
    book.close()
    return colors


def bond_payouts(frame, path, where):
    coupons = numeric(frame, 'coupon_payment_rub', where).fillna(0)
    amortization = numeric(frame, 'amortization_rub', where).fillna(0)
    colors = fill_colors(path)
    payouts = []
    for i in frame.index:
        total = float(coupons[i]) + float(amortization[i])
        color = colors.get(i)
        day = frame['date'][i].strftime('%Y-%m-%d')
        if color not in PLAIN_FILLS and color not in (TECHNICAL_DEFAULT, DEFAULT):
            fail(where, f'{day}: неизвестная заливка #{color}')
        if color == DEFAULT and total != 0:
            fail(where, f'{day}: дефолт (#{DEFAULT}) не может идти с выплатой {total}')
        status = -1 if color == TECHNICAL_DEFAULT else -2 if color == DEFAULT else 0
        if status or total:
            payouts.append({'date': day, 'value': total, 'status': status})
    return payouts


def stock_payouts(frame, where):
    dividends = numeric(frame, 'dividend_rub', where).fillna(0)
    if (dividends < 0).any():
        fail(where, 'dividend_rub: отрицательный дивиденд')
    return [
        {'date': frame['date'][i].strftime('%Y-%m-%d'), 'value': float(dividends[i]), 'status': 0}
        for i in frame.index[dividends != 0]
    ]


def read_instrument(path, group, range_name, where):
    frame = pd.read_excel(path)
    required = {'date', PRICE_COLUMN[group]}
    required |= {'Акции': {'dividend_rub'}, 'Облигации': {'coupon_payment_rub', 'amortization_rub'}}.get(group, set())
    missing = required - set(frame.columns)
    if missing:
        fail(where, f'нет столбцов {sorted(missing)}')
        return None

    check_dates(frame, range_name, where)
    item = {'price': price_list(frame, group, where)}
    if group == 'Акции':
        item['date_value'] = stock_payouts(frame, where)
    elif group == 'Облигации':
        item['date_value'] = bond_payouts(frame, path, where)
    elif group in WITH_PAYOUTS:
        item['date_value'] = []
    return item


def collect():
    """Все инструменты: {диапазон: {тикер: данные}}."""
    data = defaultdict(dict)

    def add(range_name, ticker, item, where):
        if ticker in data[range_name]:
            fail(where, 'тикер встречается дважды')
        elif item:
            data[range_name][ticker] = item

    for folder in sorted(p for p in RAW.iterdir() if p.is_dir() and RANGE.fullmatch(p.name)):
        for path in sorted(folder.rglob('*.xlsx')):
            group = path.relative_to(folder).parts[0]
            where = f'{folder.name[:4]} {path.name}'
            if group not in PRICE_COLUMN:
                fail(where, f'неизвестная группа «{group}»')
                continue
            ticker = ticker_of(path.stem)
            if (folder.name, ticker) in EXCLUDED or group == INDEX_GROUP and ticker != INDEX_TICKER:
                continue
            add(folder.name, ticker, read_instrument(path, group, folder.name, where), where)
    return data


def apply_redemptions(data):
    for (range_name, ticker), day in REDEMPTIONS.items():
        item = data.get(range_name, {}).get(ticker)
        where = f'{range_name[:4]} {ticker}'
        payout = next((p for p in item['date_value'] if p['date'] == day), None) if item else None
        if not payout or payout['status'] != 0:
            fail(where, f'погашение {day}: в этот день нет обычной выплаты')
            continue
        payout['status'] = 1
        start = dt.date.fromisoformat(range_name.split('_')[0])
        offset = (dt.date.fromisoformat(day) - start).days
        item['price'][offset:] = [0.0] * (len(item['price']) - offset)


def compare_with_tickers(data):
    """tickers.csv должен совпадать с файлами. Для акций файла может не быть: игра их пропускает."""
    with open(TICKERS, encoding='utf-8', newline='') as source:
        rows = [row for row in csv.DictReader(source) if row['Год']]
    by_year = defaultdict(list)
    for row in rows:
        by_year[row['Год']].append(row)

    warnings = []
    for range_name, instruments in data.items():
        year = range_name[:4]
        listed = {row['Тикер']: row for row in by_year[year]}
        if INDEX_TICKER not in instruments:
            fail(range_name, f'нет индекса {INDEX_TICKER}')
        for ticker in sorted(set(instruments) - set(listed) - {INDEX_TICKER}):
            fail(range_name, f'{ticker} есть в файлах, но нет в tickers.csv')
        for ticker, row in listed.items():
            if ticker in instruments:
                continue
            # Облигации и служебные строки обязательны, акции (н/п без префикса Фонд) — нет
            is_stock = row['Дефолт'] == 'н/п' and not row['Название'].startswith('Фонд') and ticker not in ('BANK', 'USD', 'GLDRUB')
            if is_stock:
                warnings.append(f'{year}: {ticker} есть в tickers.csv, файла нет')
            else:
                fail(range_name, f'{ticker} есть в tickers.csv, но нет файла')
        for ticker, row in listed.items():
            payouts = instruments.get(ticker, {}).get('date_value', [])
            has_default = any(p['status'] < 0 for p in payouts)
            if row['Дефолт'] in '+-' and (row['Дефолт'] == '+') != has_default:
                fail(range_name, f'{ticker}: в tickers.csv Дефолт «{row["Дефолт"]}», в данных дефолт {"есть" if has_default else "нет"}')
    return warnings


def write(data):
    # Как и раньше: отступ 2 и CRLF. Сначала во временный файл, чтобы сбой не испортил data.json
    temporary = OUTPUT.with_suffix('.json.tmp')
    with open(temporary, 'w', encoding='utf-8', newline='\r\n') as target:
        json.dump(data, target, ensure_ascii=False, indent=2, allow_nan=False)
    os.replace(temporary, OUTPUT)


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    collected = collect()
    apply_redemptions(collected)
    data = {name: dict(sorted(collected[name].items())) for name in sorted(collected)}
    warnings = compare_with_tickers(data)

    for warning in warnings:
        print(f'Внимание: {warning}')
    if errors:
        print(f'\nОшибок: {len(errors)}, {OUTPUT.name} не изменён:')
        for error in errors:
            print(f'  {error}')
        return 1

    total = sum(len(instruments) for instruments in data.values())
    print(f'Проверено: {len(data)} диапазонов, {total} инструментов, предупреждений {len(warnings)}')
    if '--check' not in sys.argv:
        write(data)
        print(f'Записано: {OUTPUT}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
