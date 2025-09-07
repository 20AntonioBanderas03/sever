// Импорты
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

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
    <p><a href="/schedule-ui">GET /schedule-ui</a> — расписание UI</p>
    <p><a href="/api/upload-schedule">POST /api/upload-schedule</a> — загрузить Excel-файл</p>
    <p><a href="/load-schedule">/load-schedule</a> — загрузить расписание по ссылке</p>
    <p>Кеш: ${cachedSchedule ? 'включён' : 'ожидает'}</p>
    <p>Последнее обновление: ${lastUpdated || 'никогда'}</p>
  `);
});

// Страница загрузки расписания по ссылке
app.get('/load-schedule', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="ru">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Загрузка расписания</title>
        <style>
            body { font-family: Arial, sans-serif; padding: 40px; background: #f5f5f5; }
            .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
            h1 { color: #2c3e50; }
            input[type="url"] { width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #ccc; border-radius: 5px; }
            button { padding: 10px 20px; background: #3498db; color: white; border: none; border-radius: 5px; cursor: pointer; font-size: 16px; }
            button:hover { background: #2980b9; }
            .message { margin-top: 20px; padding: 10px; border-radius: 5px; }
            .success { background: #d4edda; color: #155724; }
            .error { background: #f8d7da; color: #721c24; }
            .accordion {
                background: #eee;
                padding: 15px;
                border-radius: 5px;
                cursor: pointer;
                margin-top: 30px;
                font-weight: bold;
            }
            .iframe-container {
                display: none;
                margin-top: 20px;
                border: 1px solid #ddd;
                border-radius: 5px;
                overflow: hidden;
            }
            .iframe-container iframe {
                width: 100%;
                height: 600px;
                border: none;
            }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>📥 Загрузить расписание по ссылке</h1>
            <form id="scheduleForm">
                <label for="url">Ссылка на Excel-файл (.xlsx):</label><br>
                <input type="url" id="url" name="url" placeholder="https://example.com/raspisanie.xlsx" required><br>
                <button type="submit">Обновить расписание</button>
            </form>
            <div id="result"></div>

            <div class="accordion" id="accordion">🔽 Нажмите, чтобы открыть официальную страницу расписания</div>
            <div class="iframe-container" id="iframeContainer">
                <iframe src="https://www.rsatu.ru/students/raspisanie-zanyatiy/"></iframe>
            </div>
        </div>

        <script>
            document.getElementById('scheduleForm').addEventListener('submit', async (e) => {
                e.preventDefault();
                const url = document.getElementById('url').value;
                const resultDiv = document.getElementById('result');
                resultDiv.innerHTML = '<p>⏳ Загрузка...</p>';
                resultDiv.className = '';

                try {
                    const response = await fetch('/api/load-schedule-url', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ url })
                    });

                    const data = await response.json();
                    if (data.success) {
                        resultDiv.innerHTML = '<p class="message success">✅ Расписание успешно загружено!</p>';
                    } else {
                        resultDiv.innerHTML = '<p class="message error">❌ Ошибка: ' + data.error + '</p>';
                    }
                } catch (err) {
                    resultDiv.innerHTML = '<p class="message error">❌ Ошибка сети: ' + err.message + '</p>';
                }
            });

            // Аккордеон
            const accordion = document.getElementById('accordion');
            const iframeContainer = document.getElementById('iframeContainer');
            accordion.addEventListener('click', () => {
                if (iframeContainer.style.display === 'block') {
                    iframeContainer.style.display = 'none';
                    accordion.textContent = '🔽 Нажмите, чтобы открыть официальную страницу расписания';
                } else {
                    iframeContainer.style.display = 'block';
                    accordion.textContent = '🔼 Скрыть официальную страницу';
                }
            });
        </script>
    </body>
    </html>
  `);
});

// Загрузка расписания по URL
app.post('/api/load-schedule-url', async (req, res) => {
  const { url } = req.body;

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, error: 'Требуется поле "url"' });
  }

  try {
    console.log(`📥 Скачивание расписания с: ${url}`);

    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 60000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0 Safari/537.36'
      }
    });

    if (response.status !== 200) {
      throw new Error(`HTTP ${response.status}: Не удалось скачать файл`);
    }

    // Сохраняем файл
    await fs.promises.writeFile(CURRENT_SCHEDULE_PATH, response.data);
    cachedSchedule = null; // Сбрасываем кеш
    lastUpdated = null;

    console.log('✅ Файл успешно сохранён');

    res.json({
      success: true,
      message: 'Расписание успешно загружено по ссылке',
      size: response.data.length
    });
  } catch (err) {
    console.error('❌ Ошибка загрузки по ссылке:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Загрузка файла через multipart/form-data
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
    // Проверяем, есть ли локальный файл
    await fs.promises.access(CURRENT_SCHEDULE_PATH);
    const buffer = await fs.promises.readFile(CURRENT_SCHEDULE_PATH);
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const schedule = parseWorkbook(workbook);

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
      error: 'Расписание ещё не загружено. Загрузите файл через /load-schedule или /api/upload-schedule'
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

// ✅ НОВАЯ ФУНКЦИЯ ПАРСИНГА — БЕРЁМ ГРУППУ ИЗ ЗАГОЛОВКА СТОЛБЦА
function parseWorkbook(workbook) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const jsonData = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

  if (jsonData.length < 2) {
    return [];
  }

  // ✅ Первая строка — заголовки групп
  const headers = jsonData[0] || [];
  const result = [];

  // Начинаем с 2-й строки (индекс 1), т.к. 0 — заголовки
  for (let rowIdx = 1; rowIdx < jsonData.length; rowIdx++) {
    const row = jsonData[rowIdx] || [];
    const week = (row[0] ? String(row[0]).trim() : "") || findLast(jsonData, 0, rowIdx);
    const day = (row[1] ? String(row[1]).trim() : "") || findLast(jsonData, 1, rowIdx);
    const number = (row[2] ? String(row[2]).trim() : "") || findLast(jsonData, 2, rowIdx);

    // ✅ Проходим по столбцам, начиная с 3-го (индекс 3)
    for (let colIdx = 3; colIdx < row.length; colIdx++) {
      const subject = row[colIdx] ? String(row[colIdx]).trim() : "";
      if (subject && subject.length > 1 && !subject.includes("undefined")) {
        // ✅ Берём название группы из ЗАГОЛОВКА столбца, а не из текста
        const group = headers[colIdx] ? String(headers[colIdx]).trim() : "unknown";
        result.push({
          week,
          day,
          number,
          subject,
          group // ✅ Группа из заголовка!
        });
      }
    }
  }

  return result;
}

// 🖥️ Возвращает готовую HTML-страницу интерфейса расписания
app.get('/schedule-ui', (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>📚 Расписание РГАТУ</title>
  <!-- Tailwind CSS через CDN -->
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; }
  </style>
</head>
<body class="flex flex-col min-h-screen bg-gray-50 text-gray-800">
  <div class="max-w-5xl w-full mx-auto flex flex-col flex-grow">

    <!-- Заголовок -->
    <div class="text-center mb-8 mt-8">
      <h1 class="text-3xl font-semibold text-gray-900">📚 Расписание РГАТУ</h1>
    </div>

    <!-- Форма поиска -->
    <div class="bg-white rounded-2xl shadow-lg border border-gray-200 p-6 mb-8">
      <form id="searchForm" class="flex flex-col sm:flex-row gap-3">
        <input
          type="text"
          id="groupInput"
          placeholder="Введите точное название группы (например: ИПБ-24-1)"
          class="flex-grow px-5 py-3 border border-gray-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400 text-gray-700 placeholder-gray-400 text-sm"
        />
        <button
          type="submit"
          id="submitButton"
          class="px-6 py-3 bg-black hover:bg-gray-800 disabled:bg-gray-400 text-white font-medium rounded-xl transition-all duration-200 transform hover:scale-102 shadow-sm"
        >
          Загрузка...
        </button>
      </form>
      <p id="errorMessage" class="text-red-500 text-sm mt-3 text-center hidden"></p>
    </div>

    <!-- Таблица результатов -->
    <div id="resultsContainer" class="hidden">
      <div class="bg-white rounded-2xl shadow overflow-hidden border border-gray-200 mb-8">
        <div class="overflow-x-auto">
          <table class="w-full">
            <thead class="bg-gray-50 text-gray-600 text-sm uppercase tracking-wide">
              <tr>
                <th class="px-6 py-4 text-center font-semibold">Неделя</th>
                <th class="px-6 py-4 font-semibold">День</th>
                <th class="px-6 py-4 text-center font-semibold">ПАРА</th>
                <th class="px-6 py-4 font-semibold">Предмет</th>
              </tr>
            </thead>
            <tbody id="scheduleTableBody" class="divide-y divide-gray-100"></tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Сообщение "ничего не найдено" -->
    <div id="emptyMessage" class="text-center text-gray-500 italic mb-8 hidden">
      Расписание появится после поиска...
    </div>

    <!-- ⬇️ Футер — прижат к низу и по центру -->
    <footer class="mt-auto text-center text-gray-400 text-xs py-4">
      © <span id="currentYear"></span> РГАТУ
    </footer>
  </div>

  <script>
    // Устанавливаем текущий год в футере
    document.getElementById('currentYear').textContent = new Date().getFullYear();

    // DOM элементы
    const form = document.getElementById('searchForm');
    const groupInput = document.getElementById('groupInput');
    const submitButton = document.getElementById('submitButton');
    const errorMessage = document.getElementById('errorMessage');
    const resultsContainer = document.getElementById('resultsContainer');
    const scheduleTableBody = document.getElementById('scheduleTableBody');
    const emptyMessage = document.getElementById('emptyMessage');

    let allData = null;

    // 🚀 Загружаем расписание при загрузке страницы
    window.addEventListener('DOMContentLoaded', async () => {
      try {
        const response = await fetch('/api/schedule'); // ← Относительный путь!
        const json = await response.json();

        if (!json.success) throw new Error(json.error);

        allData = json.schedule;
        submitButton.textContent = 'Показать';
        submitButton.disabled = false;
      } catch (err) {
        showError('Не удалось загрузить расписание с сервера');
        submitButton.textContent = 'Повторить';
        submitButton.disabled = false;
      }
    });

    // 🔍 Обработка поиска
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const trimmedGroup = groupInput.value.trim();

      if (!trimmedGroup) return;

      hideError();
      scheduleTableBody.innerHTML = '';
      resultsContainer.classList.add('hidden');
      emptyMessage.classList.add('hidden');

      if (!allData) {
        showError('Расписание ещё не загружено');
        return;
      }

      // ✅ Фильтруем ТОЛЬКО по полному совпадению поля group
      const filtered = allData.filter(
        (item) => item.group?.trim().toUpperCase() === trimmedGroup.toUpperCase()
      );

      if (filtered.length === 0) {
        showError(\`Группа "\${trimmedGroup}" не найдена в расписании\`);
      } else {
        renderSchedule(filtered);
        resultsContainer.classList.remove('hidden');
      }
    });

    // 🖼️ Рендерим таблицу
    function renderSchedule(schedule) {
      scheduleTableBody.innerHTML = schedule.map((item, index) => {
        const isEvenWeek = item.week?.includes("Чётная");
        const isOddWeek = item.week?.includes("Нечётная");

        let rowClass = "border-b bg-white hover:bg-gray-50";
        if (isEvenWeek) rowClass = "border-b bg-blue-50 hover:bg-blue-100";
        if (isOddWeek) rowClass = "border-b bg-purple-50 hover:bg-purple-100";

        return \`
          <tr class="\${rowClass}">
            <td class="px-6 py-4 text-center text-gray-700 text-sm font-medium align-middle">\${escapeHtml(item.week || '')}</td>
            <td class="px-6 py-4 text-gray-800 font-medium align-middle">\${escapeHtml(item.day || '')}</td>
            <td class="px-6 py-4 text-center text-black font-semibold align-middle">\${escapeHtml(item.number || '')}</td>
            <td class="px-6 py-4 text-gray-900 align-middle">\${escapeHtml(item.subject || '')}</td>
          </tr>
        \`;
      }).join('');
    }

    // 🛡️ Экранирование HTML для безопасности
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // ❗ Показ ошибки
    function showError(message) {
      errorMessage.textContent = message;
      errorMessage.classList.remove('hidden');
    }

    // ✅ Скрыть ошибку
    function hideError() {
      errorMessage.classList.add('hidden');
    }
  </script>
</body>
</html>
  `.replace(/`/g, "\\`"); // ← ЭТО КЛЮЧЕВОЕ ИСПРАВЛЕНИЕ!

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});


// =============== ЗАПУСК СЕРВЕРА ===============

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
});