const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const cron = require('node-cron');

const app = express();

// ✅ Исправление 1: Динамический PORT
const PORT = process.env.PORT || 5000;

// ✅ Исправление 2: Убраны пробелы в URL
const BASE_URL = 'https://www.rsatu.ru';
const SCHEDULE_PAGE_URL = 'https://www.rsatu.ru/students/raspisanie-zanyatiy/';
const TARGET_LINK_TEXT = 'Расписание занятий';

// ❌ Убираем сохранение в ./downloads — Render не сохранит файлы
// const DOWNLOAD_DIR = './downloads';
// if (!fs.existsSync(DOWNLOAD_DIR)) {
//   fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
// }

app.use(cors());
app.use(express.json());

// ✅ Исправление 3: Простой маршрут для проверки
app.get('/', (req, res) => {
  res.send(`
    <h1>🚀 Сервер расписания РГАТУ</h1>
    <p>Готов к работе. Используй <code>POST /api/schedule</code></p>
  `);
});

// === ПАРСИНГ ССЫЛКИ ===
async function findScheduleLink() {
  try {
    const response = await axios.get(SCHEDULE_PAGE_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const $ = cheerio.load(response.data);
    const links = [];

    $('a').each((i, el) => {
      const text = $(el).text().trim();
      const href = $(el).attr('href');
      if (!href) return;

      // Правильный fullUrl
      let fullUrl;
      try {
        fullUrl = new URL(href, SCHEDULE_PAGE_URL).href;
      } catch (err) {
        return; // пропускаем битые ссылки
      }

      if (
        text.includes(TARGET_LINK_TEXT) ||
        text.toLowerCase().includes('расписание') ||
        href.includes('.xlsx')
      ) {
        links.push({ text, href, fullUrl });
      }
    });

    if (links.length === 0) throw new Error('Ссылка на расписание не найдена');

    // Приоритет: .xlsx
    const excelLink = links.find(l => l.fullUrl.includes('.xlsx'));
    return (excelLink || links[0]).fullUrl;
  } catch (err) {
    console.error('❌ Парсинг ссылки:', err.message);
    throw err;
  }
}

// === СКАЧИВАНИЕ И ОБРАБОТКА В ПАМЯТИ (без сохранения на диск) ===
async function fetchAndParseExcel(url, targetGroup) {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': SCHEDULE_PAGE_URL
      }
    });

    // ✅ Читаем Excel из памяти (без fs!)
    const workbook = XLSX.read(response.data, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

    let groupColIndex = -1;

    // Поиск колонки с группой
    for (let rowIdx = 0; rowIdx < Math.min(data.length, 20); rowIdx++) {
      const row = data[rowIdx] || [];
      for (let colIdx = 3; colIdx < row.length; colIdx++) {
        const cell = String(row[colIdx]).trim();
        if (cell.toUpperCase() === targetGroup.toUpperCase()) {
          groupColIndex = colIdx;
          break;
        }
      }
      if (groupColIndex !== -1) break;
    }

    if (groupColIndex === -1) {
      throw new Error(`Группа "${targetGroup}" не найдена`);
    }

    const result = [];

    for (let rowIdx = 1; rowIdx < data.length; rowIdx++) {
      const row = data[rowIdx] || [];
      const week = (row[0] ? String(row[0]).trim() : "") || findLastValue(data, 0, rowIdx);
      const day = (row[1] ? String(row[1]).trim() : "") || findLastValue(data, 1, rowIdx);
      const number = (row[2] ? String(row[2]).trim() : "") || findLastValue(data, 2, rowIdx);
      const subject = row[groupColIndex] ? String(row[groupColIndex]).trim() : "";

      if (subject && (week || day)) {
        result.push({ week, day, number, subject });
      }
    }

    if (result.length === 0) {
      throw new Error(`Расписание для "${targetGroup}" найдено, но предметы не обнаружены`);
    }

    return result;
  } catch (err) {
    console.error("❌ Ошибка обработки Excel:", err.message);
    throw err;
  }
}

// Вспомогательная функция: найти последнее непустое значение выше
function findLastValue(data, col, fromRow) {
  for (let i = fromRow - 1; i >= 0; i--) {
    if (data[i]?.[col]) return String(data[i][col]).trim();
  }
  return "";
}

// === API ===
app.post('/api/schedule', async (req, res) => {
  const { group } = req.body;

  if (!group || !group.trim()) {
    return res.status(400).json({ success: false, error: 'Не указана группа' });
  }

  try {
    const link = await findScheduleLink();
    const schedule = await fetchAndParseExcel(link, group.trim());

    res.json({
      success: true,
      schedule,
      lastUpdated: new Date().toISOString(),
      source: link
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ✅ Исправление 4: Cron — можно оставить, но знай: на бесплатном Render может "спать"
// cron.schedule('0 */6 * * *', async () => {
//   console.log('⏰ Проверка обновлений...');
//   try {
//     const link = await findScheduleLink();
//     console.log(`✅ Актуальная ссылка: ${link}`);
//   } catch (err) {
//     console.error('❌ Ошибка:', err.message);
//   }
// });

// ✅ Запуск сервера
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});