const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const XLSX = require('xlsx');

const app = express();

// ✅ Порт и кеширование
const PORT = process.env.PORT || 10000;
let cachedSchedule = null;
let lastUpdated = null;

// ✅ Middleware
app.use(cors());
app.use(express.json());

// ✅ Слушаем 0.0.0.0 — обязательно для Render
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});

// ✅ Главная страница
app.get('/', (req, res) => {
  res.send(`
    <h1>📚 Сервер расписания РГАТУ</h1>
    <p>GET <a href="/api/schedule">/api/schedule</a> — получить всё расписание</p>
  `);
});

// ✅ API
app.get('/api/schedule', async (req, res) => {
  if (cachedSchedule) {
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

// ✅ Функция с ПОЛНОЙ имитацией реального запроса
async function fetchFullSchedule() {
  const MAX_RETRIES = 3;
  const TIMEOUT = 45000;

  // 🔥 Реальные заголовки с сайта РГАТУ (из твоего лога)
  const REAL_HEADERS = {
    'accept': '*/*',
    'accept-encoding': 'gzip, deflate, br, zstd',
    'accept-language': 'ru,en;q=0.9,en-GB;q=0.8,en-US;q=0.7',
    'origin': 'https://www.rsatu.ru',
    'referer': 'https://www.rsatu.ru/',
    'sec-ch-ua': '"Not;A=Brand";v="99", "Microsoft Edge";v="139", "Chromium";v="139"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'no-cors',
    'sec-fetch-site': 'cross-site',
    'sec-fetch-storage-access': 'active',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0',
    'priority': 'u=4, i',

    // 🔽 Дополним для полной легитимности
    'connection': 'keep-alive',
    'upgrade-insecure-requests': '1',
    'cache-control': 'no-cache',
  };

  // 🇷🇺 Поддельный российский IP (из твоего лога — yandex)
  const RUSSIAN_IPS = [
    '46.226.160.240', '95.108.200.1', '178.154.240.1', '176.195.100.100'
  ];
  const fakeIp = RUSSIAN_IPS[Math.floor(Math.random() * RUSSIAN_IPS.length)];

  // 🔽 Добавим поддельные заголовки
  const headers = {
    ...REAL_HEADERS,
    'x-forwarded-for': fakeIp,
    'x-real-ip': fakeIp,
    'true-client-ip': fakeIp,
    'cf-connecting-ip': fakeIp,
  };

  const FALLBACK_EXCEL_URL = 'https://www.rsatu.ru/upload/files/raspisanie.xlsx';
  const SCHEDULE_PAGE_URL = 'https://www.rsatu.ru/students/raspisanie-zanyatiy/';

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`🔍 Попытка ${attempt} с IP ${fakeIp}`);

      // 🔎 Парсим HTML
      let excelUrl = null;
      try {
        const response = await axios.get(SCHEDULE_PAGE_URL, {
          headers,
          timeout: TIMEOUT
        });

        const $ = cheerio.load(response.data);
        $('a').each((i, el) => {
          const href = $(el).attr('href');
          if (href && (href.includes('.xlsx') || href.includes('.xls'))) {
            try {
              excelUrl = new URL(href, SCHEDULE_PAGE_URL).href;
              return false; // break
            } catch (e) {
              console.warn('❌ Невалидная ссылка:', href);
            }
          }
        });
      } catch (err) {
        console.warn(`⚠️ Не удалось распарсить HTML:`, err.message);
      }

      if (!excelUrl) {
        console.warn('⚠️ Ссылка не найдена → используем fallback');
        excelUrl = FALLBACK_EXCEL_URL;
      }

      console.log('📥 Скачивание Excel:', excelUrl);
      const fileRes = await axios.get(excelUrl, {
        responseType: 'arraybuffer',
        headers: {
          ...headers,
          'referer': SCHEDULE_PAGE_URL,
          'accept': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, */*'
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
          if (subject && subject.length > 1 && !subject.includes("undefined")) {
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
      await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
    }
  }
}

// 🔧 Вспомогательные
function findLast(data, col, from) {
  for (let i = from - 1; i >= 0; i--) if (data[i]?.[col]) return data[i][col].toString().trim();
  return "";
}

function extractGroup(text) {
  const match = text.match(/[А-Я]{2,4}-\d{2,3}/);
  return match ? match[0] : "unknown";
}