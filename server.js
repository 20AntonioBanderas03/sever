const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const XLSX = require('xlsx');

const app = express();

// ✅ Используем PORT из окружения (Render ожидает 10000)
const PORT = process.env.PORT || 10000;

// ✅ Настройки
const SCHEDULE_PAGE_URL = 'https://www.rsatu.ru/students/raspisanie-zanyatiy/';
const TARGET_LINK_TEXT = 'Расписание занятий';

// 🔽 ПРЯМАЯ ССЫЛКА НА EXCEL (если парсинг не сработает)
// Замени на актуальную, если знаешь. Пример:
const FALLBACK_EXCEL_URL = 'https://www.rsatu.ru/upload/files/raspisanie.xlsx';

// 🔽 ГЛОБАЛЬНЫЙ КЕШ (чтобы не парсить каждый раз)
let cachedSchedule = null;
let lastUpdated = null;

// ✅ Middleware
app.use(cors());
app.use(express.json());

// ✅ Главная страница — для проверки
app.get('/', (req, res) => {
  res.send(`
    <h1>📚 Сервер расписания РГАТУ</h1>
    <p><a href="/api/schedule">GET /api/schedule</a> — получить всё расписание</p>
    <p>Кеш: ${cachedSchedule ? 'включен' : 'ожидает загрузки'}</p>
    <p>Последнее обновление: ${lastUpdated || 'не было'}</p>
  `);
});

// ✅ API: получение всего расписания
app.get('/api/schedule', async (req, res) => {
  if (cachedSchedule) {
    console.log('✅ Отдаём расписание из кеша');
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

    console.log(`✅ Успешно загружено: ${schedule.length} строк`);
    res.json({
      success: true,
      schedule,
      lastUpdated,
      fromCache: false
    });
  } catch (err) {
    console.error('❌ Ошибка загрузки:', err.message);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ✅ Функция загрузки расписания с ретраями
async function fetchFullSchedule() {
  const MAX_RETRIES = 3;
  const TIMEOUT = 45000; // 45 секунд

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`🔍 Попытка ${attempt}: парсинг страницы РГАТУ...`);
      
      let htmlUrl = SCHEDULE_PAGE_URL;
      let excelUrl = null;

      // 🔎 Пытаемся найти ссылку на Excel
      try {
        const response = await axios.get(htmlUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Ru) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'ru-RU,ru;q=0.9',
            'Referer': 'https://www.yandex.ru/',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Connection': 'keep-alive'
          },
          timeout: TIMEOUT,
          maxRedirects: 10
        });

        const $ = cheerio.load(response.data);

        $('a').each((i, el) => {
          const href = $(el).attr('href');
          if (href && (href.includes('.xlsx') || href.includes('.xls'))) {
            try {
              excelUrl = new URL(href, SCHEDULE_PAGE_URL).href;
              return false; // break
            } catch (e) {
              console.warn('❌ Некорректная ссылка:', href);
            }
          }
        });
      } catch (parseErr) {
        console.warn(`⚠️ Не удалось распарсить HTML (попытка ${attempt}):`, parseErr.message);
      }

      // 🔽 Если не нашли — используем fallback
      if (!excelUrl) {
        console.warn('⚠️ Ссылка не найдена, используем fallback...');
        excelUrl = FALLBACK_EXCEL_URL;
      }

      console.log('📥 Скачивание Excel-файла:', excelUrl);
      const fileRes = await axios.get(excelUrl, {
        responseType: 'arraybuffer',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Ru) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': SCHEDULE_PAGE_URL
        },
        timeout: 60000 // больше времени на скачивание
      });

      // 🔁 Чтение Excel
      const workbook = XLSX.read(fileRes.data, { type: 'buffer' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

      const result = [];

      for (let rowIdx = 1; rowIdx < jsonData.length; rowIdx++) {
        const row = jsonData[rowIdx] || [];
        const week = (row[0] ? String(row[0]).trim() : "") || findLastValue(jsonData, 0, rowIdx);
        const day = (row[1] ? String(row[1]).trim() : "") || findLastValue(jsonData, 1, rowIdx);
        const number = (row[2] ? String(row[2]).trim() : "") || findLastValue(jsonData, 2, rowIdx);

        // Собираем все группы (столбцы D и далее)
        for (let colIdx = 3; colIdx < row.length; colIdx++) {
          const subject = row[colIdx] ? String(row[colIdx]).trim() : "";
          if (subject && subject.length > 1 && !subject.includes("undefined")) {
            result.push({
              week,
              day,
              number,
              subject,
              group: extractGroupFromSubject(subject)
            });
          }
        }
      }

      return result;
    } catch (err) {
      console.error(`❌ Попытка ${attempt} не удалась:`, err.message);

      if (attempt === MAX_RETRIES) {
        throw new Error(`Не удалось загрузить расписание после ${MAX_RETRIES} попыток: ${err.message}`);
      }

      // Пауза перед следующей попыткой: 3, 6, 9 сек
      await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
    }
  }
}

// 🔧 Вспомогательные функции

function findLastValue(data, col, fromRow) {
  for (let i = fromRow - 1; i >= 0; i--) {
    if (data[i]?.[col]) return String(data[i][col]).trim();
  }
  return "";
}

function extractGroupFromSubject(text) {
  const match = text.match(/[А-Я]{2,4}-\d{2,3}/); // Например: ИПБ-24, ТМ-23
  return match ? match[0].toUpperCase() : "unknown";
}

// ✅ Запуск сервера
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`🌐 Доступен по: https://sever-on8d.onrender.com`);
});