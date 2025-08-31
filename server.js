const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const XLSX = require('xlsx');

const app = express();

// ✅ Используем PORT из Render
const PORT = process.env.PORT || 10000;


// 🔽 ГЛОБАЛЬНЫЙ КЕШ
let cachedSchedule = null;
let lastUpdated = null;

// ✅ Middleware
app.use(cors());
app.use(express.json());

// ✅ Гарантируем, что сервер слушает 0.0.0.0 (требование Render)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`🌐 Доступ: https://sever-on8d.onrender.com`);
});

// ✅ Главная страница
app.get('/', (req, res) => {
  res.send(`
    <h1>📚 Сервер расписания РГАТУ</h1>
    <p><a href="/api/schedule">GET /api/schedule</a> — получить всё расписание</p>
    <p>Кеш: ${cachedSchedule ? 'включён' : 'ожидает загрузки'}</p>
  `);
});

// ✅ API: получение расписания
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

// ✅ Функция с полной подделкой
async function fetchFullSchedule() {
  const MAX_RETRIES = 3;
  const TIMEOUT = 45000; // 45 сек

  // 🇷🇺 Список доверенных российских IP (Мегафон, МТС, Билайн)
  const RUSSIAN_IPS = [
    '46.226.160.240',  // Мегафон
    '95.108.200.1',    // МТС
    '178.154.240.1',   // Beeline
    '176.195.100.100', // Rostelecom
    '93.186.200.1'     // Вымпелком
  ];

  // Выбираем случайный российский IP
  const fakeIp = RUSSIAN_IPS[Math.floor(Math.random() * RUSSIAN_IPS.length)];

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`🔍 Попытка ${attempt}: запрос с поддельным IP ${fakeIp}`);

      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Ru) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'ru-RU,ru;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Referer': 'https://www.yandex.ru/',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',

        // 🔥 Поддельные заголовки — имитация российского клиента
        'X-Forwarded-For': fakeIp,
        'X-Real-IP': fakeIp,
        'CF-Connecting-IP': fakeIp, // если думает, что за Cloudflare
        'True-Client-IP': fakeIp
      };

      let htmlUrl = 'https://www.rsatu.ru/students/raspisanie-zanyatiy/';
      let excelUrl = null;

      // 🔎 Парсим HTML
      try {
        const response = await axios.get(htmlUrl, {
          headers,
          timeout: TIMEOUT
        });

        const $ = cheerio.load(response.data);
        $('a').each((i, el) => {
          const href = $(el).attr('href');
          if (href && (href.includes('.xlsx') || href.includes('.xls'))) {
            try {
              excelUrl = new URL(href, htmlUrl).href;
              return false; // break
            } catch (e) {
              console.warn('❌ Невалидная ссылка:', href);
            }
          }
        });
      } catch (err) {
        console.warn(`⚠️ Не удалось распарсить HTML:`, err.message);
      }

      // 🔽 Если не нашли — используем fallback
      if (!excelUrl) {
        console.warn('⚠️ Ссылка не найдена...');
      }

      console.log('📥 Скачивание Excel:', excelUrl);
      const fileRes = await axios.get(excelUrl, {
        responseType: 'arraybuffer',
        headers: {
          ...headers,
          'Referer': htmlUrl
        },
        timeout: 60000
      });

      const workbook = XLSX.read(fileRes.data, { type: 'buffer' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

      const result = [];

      for (let rowIdx = 1; rowIdx < jsonData.length; rowIdx++) {
        const row = jsonData[rowIdx] || [];
        const week = (row[0] ? String(row[0]).trim() : "") || findLast(jsonData, 0, rowIdx);
        const day = (row[1] ? String(row[1]).trim() : "") || findLast(jsonData, 1, rowIdx);
        const number = (row[2] ? String(row[2]).trim() : "") || findLast(jsonData, 2, rowIdx);

        for (let colIdx = 3; colIdx < row.length; colIdx++) {
          const subject = row[colIdx] ? String(row[colIdx]).trim() : "";
          if (subject && !subject.includes("undefined") && subject.length > 1) {
            result.push({
              week, day, number, subject,
              group: extractGroup(subject)
            });
          }
        }
      }

      return result;
    } catch (err) {
      console.error(`❌ Попытка ${attempt} не удалась:`, err.message);
      if (attempt === MAX_RETRIES) throw err;

      // Пауза: 3, 6, 9 сек
      await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
    }
  }
}

// 🔧 Вспомогательные функции
function findLast(data, col, from) {
  for (let i = from - 1; i >= 0; i--) if (data[i]?.[col]) return data[i][col].toString().trim();
  return "";
}

function extractGroup(text) {
  const match = text.match(/[А-Я]{2,4}-\d{2,3}/);
  return match ? match[0] : "unknown";
}