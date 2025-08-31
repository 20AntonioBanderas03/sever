const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const cron = require('node-cron');

const app = express();
const PORT = 5000;

// Настройки
const BASE_URL = 'https://www.rsatu.ru';
const SCHEDULE_PAGE_URL = 'https://www.rsatu.ru/students/raspisanie-zanyatiy/';
const DOWNLOAD_DIR = './downloads';
const TARGET_LINK_TEXT = 'Расписание занятий';

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json());
app.use('/schedules', express.static(DOWNLOAD_DIR)); // Статика: можно посмотреть файлы

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

      const fullUrl = new URL(href, SCHEDULE_PAGE_URL).href;
      if (text.includes(TARGET_LINK_TEXT) || text.toLowerCase().includes('расписание') || href.includes('.xlsx')) {
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

// === СКАЧИВАНИЕ ФАЙЛА ===
async function downloadFile(url) {
  try {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });

    const filename = path.basename(new URL(url).pathname) || 'schedule.xlsx';
    const filePath = path.join(DOWNLOAD_DIR, filename);

    fs.writeFileSync(filePath, response.data);
    console.log(`✅ Файл сохранён: ${filePath}`);
    return filePath;
  } catch (err) {
    console.error('❌ Ошибка загрузки:', err.message);
    throw err;
  }
}

// === ЧТЕНИЕ И ОБРАБОТКА EXCEL ===
function extractGroupSchedule(filePath, targetGroup) {
  try {
    const workbook = XLSX.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" }); // defval: "" — чтобы не было undefined

    let groupColIndex = -1;

    // 🔍 Поиск колонки с группой (ищем в первой части таблицы)
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
      throw new Error(`Группа "${targetGroup}" не найдена в файле`);
    }

    const result = [];

    // 🔁 Проходим по ВСЕМ строкам, начиная с 1 (пропускаем шапку, если есть)
    for (let rowIdx = 1; rowIdx < data.length; rowIdx++) {
      const row = data[rowIdx] || [];
      
      const weekCell = row[0] ? String(row[0]).trim() : "";
      const dayCell = row[1] ? String(row[1]).trim() : "";
      const numberCell = row[2] ? String(row[2]).trim() : "";
      const subjectCell = row[groupColIndex] ? String(row[groupColIndex]).trim() : "";

      // ✅ Пропускаем, если и предмета нет, и нет данных для привязки
      if (!subjectCell) continue;

      // 🟡 Пытаемся сохранить контекст: если week/day/number пустые — ищем выше
      let week = weekCell;
      let day = dayCell;
      let number = numberCell;

      // Если текущая строка не содержит день/неделю/номер — ищем последнее непустое значение выше
      if (!week) {
        for (let i = rowIdx - 1; i >= 0; i--) {
          const w = data[i]?.[0];
          if (w) {
            week = String(w).trim();
            break;
          }
        }
      }
      if (!day) {
        for (let i = rowIdx - 1; i >= 0; i--) {
          const d = data[i]?.[1];
          if (d) {
            day = String(d).trim();
            break;
          }
        }
      }
      if (!number) {
        for (let i = rowIdx - 1; i >= 0; i--) {
          const n = data[i]?.[2];
          if (n) {
            number = String(n).trim();
            break;
          }
        }
      }

      // ✅ Только если есть предмет и хотя бы день — добавляем
      if (subjectCell && (day || week)) {
        result.push({
          week: week || "—",
          day: day || "—",
          number: number || "—",
          subject: subjectCell,
        });
      }
    }

    if (result.length === 0) {
      throw new Error(`Расписание для группы "${targetGroup}" найдено, но предметы не обнаружены`);
    }

    return result;
  } catch (err) {
    console.error("❌ Ошибка при обработке Excel:", err.message);
    throw err;
  }
}

// === API ===
app.post('/api/schedule', async (req, res) => {
  const { group } = req.body;

  if (!group) {
    return res.status(400).json({ error: 'Не указана группа' });
  }

  try {
    const link = await findScheduleLink();
    const filePath = await downloadFile(link);
    const schedule = await extractGroupSchedule(filePath, group.trim());

    // Отправляем JSON
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

// === Автообновление каждые 6 часов ===
cron.schedule('0 */6 * * *', async () => {
  console.log('⏰ Автообновление расписания...');
  try {
    const link = await findScheduleLink();
    const filePath = await downloadFile(link);
    console.log(`✅ Автообновление: скачано ${path.basename(filePath)}`);
  } catch (err) {
    console.error('❌ Ошибка автообновления:', err.message);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
});