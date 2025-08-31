// Импорты
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

// Создаём приложение
const app = express();

// Порт
const PORT = process.env.PORT || 10000;

// Папка для загрузок
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const CURRENT_SCHEDULE_PATH = path.join(UPLOAD_DIR, 'current-schedule.xlsx');

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Middleware
app.use(cors());
app.use(express.json());

// Глобальный кеш
let cachedSchedule = null;
let lastUpdated = null;

// =============== ЭНДПОИНТЫ ===============

// Главная страница
app.get('/', (req, res) => {
  res.send(`
    <h1>📚 Сервер расписания РГАТУ</h1>
    <p><a href="/api/schedule">GET /api/schedule</a> — получить расписание</p>
    <p><a href="/api/upload-schedule">POST /api/upload-schedule</a> — загрузить Excel</p>
    <p>Кеш: ${cachedSchedule ? 'включён' : 'ожидает'}</p>
  `);
});

// Загрузка файла
app.post('/api/upload-schedule', async (req, res) => {
  try {
    if (!req.headers['content-type']?.includes('multipart/form-data')) {
      return res.status(400).json({ error: 'Ожидается multipart/form-data' });
    }

    const boundary = req.headers['content-type'].split('boundary=')[1];
    if (!boundary) {
      return res.status(400).json({ error: 'Не найден boundary' });
    }

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const body = Buffer.concat(chunks);
    const parts = body.split(Buffer.from(`--${boundary}`));

    let fileBuffer = null;
    let filename = '';

    for (const part of parts) {
      if (part.includes('filename="')) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;

        const headers = part.slice(0, headerEnd).toString();
        const content = part.slice(headerEnd + 4); // \r\n\r\n
        const cleanContent = content.slice(0, -2); // Убираем \r\n в конце

        const filenameMatch = headers.match(/filename="(.+?)"/);
        filename = filenameMatch ? filenameMatch[1] : 'schedule.xlsx';
        fileBuffer = cleanContent;
        break;
      }
    }

    if (!fileBuffer) {
      return res.status(400).json({ error: 'Файл не найден в запросе' });
    }

    await fs.promises.writeFile(CURRENT_SCHEDULE_PATH, fileBuffer);
    cachedSchedule = null; // Сброс кеша

    res.json({
      success: true,
      message: 'Файл успешно загружен',
      filename,
      size: fileBuffer.length
    });
  } catch (err) {
    console.error('❌ Ошибка загрузки:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Получение расписания
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

// =============== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ===============

function findLast(data, col, from) {
  for (let i = from - 1; i >= 0; i--) {
    if (data[i]?.[col]) return data[i][col].toString().trim();
  }
  return "";
}

function extractGroup(text) {
  const match = text.match(/[А-Я]{2,4}-\d{2,3}/);
  return match ? match[0] : "unknown";
}

function parseWorkbook(workbook) {
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
}

// =============== ЗАГРУЗКА РАСПИСАНИЯ ===============

async function fetchFullSchedule() {
  const MAX_RETRIES = 3;
  const TIMEOUT = 45000;
  const FALLBACK_EXCEL_URL = 'https://www.rsatu.ru/upload/files/raspisanie.xlsx';
  const SCHEDULE_PAGE_URL = 'https://www.rsatu.ru/students/raspisanie-zanyatiy/';

  // 1. Проверяем, есть ли загруженный файл
  try {
    await fs.promises.access(CURRENT_SCHEDULE_PATH);
    console.log('✅ Используем локальный файл');
    const buffer = await fs.promises.readFile(CURRENT_SCHEDULE_PATH);
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    return parseWorkbook(workbook);
  } catch (err) {
    console.log('⚠️ Локальный файл не найден, парсим с сайта...');
  }

  // 2. Подбор российского IP
  const RUSSIAN_IPS = [
    '46.226.160.240', '95.108.200.1', '178.154.240.1', '176.195.100.100'
  ];
  const fakeIp = RUSSIAN_IPS[Math.floor(Math.random() * RUSSIAN_IPS.length)];

  const headers = {
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
    'connection': 'keep-alive',
    'x-forwarded-for': fakeIp,
    'x-real-ip': fakeIp,
    'true-client-ip': fakeIp,
    'cf-connecting-ip': fakeIp
  };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`🔍 Попытка ${attempt} с IP ${fakeIp}`);

      let excelUrl = null;

      // Парсим HTML
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
              return false;
            } catch (e) {}
          }
        });
      } catch (err) {
        console.warn('⚠️ Не удалось распарсить HTML:', err.message);
      }

      if (!excelUrl) {
        console.warn('⚠️ Ссылка не найдена → используем fallback');
        excelUrl = FALLBACK_EXCEL_URL;
      }

      console.log('📥 Скачивание Excel:', excelUrl);
      const fileRes = await axios.get(excelUrl, {
        responseType: 'arraybuffer',
        headers: { ...headers, 'referer': SCHEDULE_PAGE_URL },
        timeout: 60000
      });

      const workbook = XLSX.read(fileRes.data, { type: 'buffer' });
      return parseWorkbook(workbook);
    } catch (err) {
      console.error(`❌ Попытка ${attempt} не удалась:`, err.message);
      if (attempt === MAX_RETRIES) throw err;
      await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
    }
  }
}

// =============== ЗАПУСК СЕРВЕРА ===============

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`🌐 Доступен по: https://sever-on8d.onrender.com`);
});