const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const XLSX = require('xlsx');

const app = express();

// ✅ Используем PORT из окружения
const PORT = process.env.PORT || 10000;

// ✅ Парсим JSON (на будущее)
app.use(cors());
app.use(express.json());

// 🔽 ГЛОБАЛЬНЫЙ КЕШ
let cachedSchedule = null;
let lastUpdated = null;

// ✅ Функция загрузки и обработки Excel
async function fetchFullSchedule() {
  const SCHEDULE_PAGE_URL = 'https://www.rsatu.ru/students/raspisanie-zanyatiy/';
  const TARGET_LINK_TEXT = 'Расписание занятий';

  try {
    console.log('🔍 Парсинг страницы РГАТУ...');
    const { data } = await axios.get(SCHEDULE_PAGE_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' },
      timeout: 15000
    });

    const $ = cheerio.load(data);
    let excelUrl = null;

    $('a').each((i, el) => {
      const href = $(el).attr('href');
      if (href && (href.includes('.xlsx') || href.includes('.xls'))) {
        excelUrl = new URL(href, SCHEDULE_PAGE_URL).href;
        return false; // break
      }
    });

    if (!excelUrl) throw new Error('Ссылка на Excel не найдена');

    console.log('📥 Скачивание Excel...');
    const fileRes = await axios.get(excelUrl, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' }
    });

    const workbook = XLSX.read(fileRes.data, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

    const result = [];

    // 🔁 Проход по всем строкам
    for (let rowIdx = 1; rowIdx < jsonData.length; rowIdx++) {
      const row = jsonData[rowIdx] || [];
      const week = row[0]?.toString().trim() || findLast(data, 0, rowIdx);
      const day = row[1]?.toString().trim() || findLast(data, 1, rowIdx);
      const number = row[2]?.toString().trim() || findLast(data, 2, rowIdx);

      // Собираем все группы (столбцы D+)
      for (let colIdx = 3; colIdx < row.length; colIdx++) {
        const subject = row[colIdx]?.toString().trim();
        if (subject && subject.length > 1 && !subject.includes("undefined")) {
          result.push({
            week, day, number, subject,
            group: extractGroupName(subject) // попробуем вытащить группу из строки
          });
        }
      }
    }

    return result;
  } catch (err) {
    console.error('❌ Ошибка загрузки:', err.message);
    throw err;
  }
}

// Вспомогательные функции
function findLast(data, col, from) {
  for (let i = from - 1; i >= 0; i--) if (data[i]?.[col]) return data[i][col].toString().trim();
  return "";
}

function extractGroupName(cell) {
  // Простой пример: если есть "ИПБ-24", возвращаем
  const match = cell.match(/[А-Я]{2,4}-\d{2,3}/);
  return match ? match[0] : "unknown";
}

// ✅ Единый GET-эндпоинт
app.get('/api/schedule', async (req, res) => {
  if (cachedSchedule) {
    console.log('✅ Отдаём из кеша');
    return res.json({
      success: true,
      schedule: cachedSchedule,
      lastUpdated,
      fromCache: true
    });
  }

  try {
    const schedule = await fetchFullSchedule();
    cachedSchedule = schedule;
    lastUpdated = new Date().toISOString();

    console.log('✅ Новые данные загружены');
    res.json({
      success: true,
      schedule,
      lastUpdated,
      fromCache: false
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ✅ Для проверки
app.get('/', (req, res) => {
  res.send(`
    <h1>📚 Сервер расписания РГАТУ</h1>
    <p>GET <a href="/api/schedule">/api/schedule</a> — получить всё расписание</p>
    <p>Кеш: ${cachedSchedule ? 'да' : 'нет'}</p>
  `);
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});