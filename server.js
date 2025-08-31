const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const pipeline = promisify(require('stream').pipeline);

// Папка для загрузки файлов
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Путь к актуальному файлу
const CURRENT_SCHEDULE_PATH = path.join(UPLOAD_DIR, 'current-schedule.xlsx');

// ✅ Эндпоинт: загрузка Excel
app.post('/api/upload-schedule', async (req, res) => {
  try {
    if (!req.headers['content-type']?.includes('multipart/form-data')) {
      return res.status(400).json({ error: 'Ожидается multipart/form-data' });
    }

    // Очень упрощённый парсер multipart (только для одного файла)
    const boundary = req.headers['content-type'].split('boundary=')[1];
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
        const headers = part.slice(0, headerEnd);
        const content = part.slice(headerEnd + 4); // +4 = \r\n\r\n

        const filenameMatch = headers.toString().match(/filename="(.+?)"/);
        filename = filenameMatch ? filenameMatch[1] : 'schedule.xlsx';

        // Убираем последний --\r\n
        const cleanContent = content.slice(0, content.lastIndexOf('\r\n'));
        fileBuffer = cleanContent;
        break;
      }
    }

    if (!fileBuffer) {
      return res.status(400).json({ error: 'Файл не найден в запросе' });
    }

    // Сохраняем как текущее расписание
    await fs.promises.writeFile(CURRENT_SCHEDULE_PATH, fileBuffer);

    // Очищаем кеш
    cachedSchedule = null;

    res.json({
      success: true,
      message: 'Файл успешно загружен',
      filename,
      size: fileBuffer.length
    });
  } catch (err) {
    console.error('❌ Ошибка загрузки:', err);
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// ✅ Модифицируем fetchFullSchedule — читать сначала локальный файл
async function fetchFullSchedule() {
  // 🔍 Сначала проверяем, есть ли загруженный файл
  try {
    await fs.promises.access(CURRENT_SCHEDULE_PATH);
    const buffer = await fs.promises.readFile(CURRENT_SCHEDULE_PATH);
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    // ... (остальной код обработки Excel)
    return parseWorkbook(workbook); // вынесем в отдельную функцию
  } catch (err) {
    console.log('⚠️ Локальный файл не найден, парсим с сайта...');
  }

  // Если нет — парсим с сайта (как раньше)
  // ... (старый код с axios и fallback)
}