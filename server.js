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
  const MAX_RETRIES = 3;
  const TIMEOUT = 30000; // 30 секунд

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`🔍 Парсинг страницы РГАТУ... Попытка ${attempt}`);

      const { data } = await axios.get(SCHEDULE_PAGE_URL, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
          'Referer': 'https://www.rsatu.ru/',
          'Connection': 'keep-alive',
        },
        timeout: TIMEOUT,
        // ⚠️ Важно: если Render блокирует внешние DNS, может помочь
        // httpAgent: new (require('http').Agent)({ keepAlive: true })
      });

      const $ = cheerio.load(data);
      let excelUrl = null;

      $('a').each((i, el) => {
        const href = $(el).attr('href');
        if (href && (href.includes('.xlsx') || href.includes('.xls'))) {
          try {
            excelUrl = new URL(href, SCHEDULE_PAGE_URL).href;
            return false; // break
          } catch (e) {
            console.warn('Invalid URL:', href);
          }
        }
      });

      if (!excelUrl) {
        throw new Error('Ссылка на Excel не найдена на странице');
      }

      console.log('📥 Скачивание Excel-файла...');
      const fileRes = await axios.get(excelUrl, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': SCHEDULE_PAGE_URL
        },
        timeout: 45000 // больше времени на скачивание
      });

      const workbook = XLSX.read(fileRes.data, { type: 'buffer' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

      const result = [];

      for (let rowIdx = 1; rowIdx < jsonData.length; rowIdx++) {
        const row = jsonData[rowIdx] || [];
        const week = row[0]?.toString().trim() || findLast(jsonData, 0, rowIdx);
        const day = row[1]?.toString().trim() || findLast(jsonData, 1, rowIdx);
        const number = row[2]?.toString().trim() || findLast(jsonData, 2, rowIdx);

        for (let colIdx = 3; colIdx < row.length; colIdx++) {
          const subject = row[colIdx]?.toString().trim();
          if (subject && subject.length > 1 && !subject.includes("undefined")) {
            result.push({
              week, day, number, subject,
              group: extractGroupName(subject)
            });
          }
        }
      }

      console.log(`✅ Успешно загружено: ${result.length} строк`);
      return result;

    } catch (err) {
      console.error(`❌ Попытка ${attempt} не удалась:`, err.message);

      if (attempt === MAX_RETRIES) {
        throw new Error(`Не удалось загрузить расписание после ${MAX_RETRIES} попыток: ${err.message}`);
      }

      // Пауза перед повторной попыткой
      await new Promise(resolve => setTimeout(resolve, 3000 * attempt)); // 3, 6, 9 сек
    }
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