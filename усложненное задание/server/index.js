const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { Readable } = require('stream');
const mammoth = require('mammoth');
const WordExtractor = require('word-extractor');
const { google } = require('googleapis');
require('dotenv').config({ path: path.join(__dirname, '.env') });

function normalizeProxyEnv() {
  const keys = ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY'];
  for (const key of keys) {
    const val = process.env[key];
    if (!val) continue;
    const raw = String(val).trim();
    if (!raw) continue;
    if (/^https?:\/\//i.test(raw)) continue;
    process.env[key] = `http://${raw}`;
  }
}

normalizeProxyEnv();

const app = express();
const extractor = new WordExtractor();
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const REPORTS_DIR = path.join(__dirname, 'reports');
if (!fsSync.existsSync(UPLOAD_DIR)) {
  fsSync.mkdirSync(UPLOAD_DIR, { recursive: true });
}
if (!fsSync.existsSync(REPORTS_DIR)) {
  fsSync.mkdirSync(REPORTS_DIR, { recursive: true });
}
const upload = multer({ dest: UPLOAD_DIR });

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SHINGLE_SIZE = 3;
const GOOGLE_SERVICE_ACCOUNT_PATH = String(process.env.GOOGLE_SERVICE_ACCOUNT_PATH || '')
  .replace(/^\uFEFF/, '')
  .trim();
const GOOGLE_DRIVE_ROOT_FOLDER_ID = String(process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || '')
  .replace(/^\uFEFF/, '')
  .trim();

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildShingles(text, size = SHINGLE_SIZE) {
  const words = normalizeText(text).split(' ').filter(Boolean);
  const set = new Set();

  if (words.length < size) {
    if (words.length > 0) set.add(words.join(' '));
    return set;
  }

  for (let i = 0; i <= words.length - size; i += 1) {
    set.add(words.slice(i, i + size).join(' '));
  }
  return set;
}

function jaccardSimilarity(setA, setB) {
  if (!setA.size && !setB.size) return 100;
  if (!setA.size || !setB.size) return 0;

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  if (!union) return 0;
  return Number(((intersection / union) * 100).toFixed(2));
}

function decodeUploadedName(name) {
  const raw = String(name || '');
  if (!raw) return '';
  try {
    // Browser multipart filenames are often interpreted as latin1 by default.
    return Buffer.from(raw, 'latin1').toString('utf8');
  } catch (_) {
    return raw;
  }
}

function cleanStudentField(value) {
  return String(value || '').trim();
}

function getStudentInfo(body) {
  return {
    fullName: cleanStudentField(body.fullName),
    course: cleanStudentField(body.course),
    faculty: cleanStudentField(body.faculty),
    specialization: cleanStudentField(body.specialization),
    group: cleanStudentField(body.group),
  };
}

function validateStudentInfo(student) {
  const required = ['fullName', 'course', 'faculty', 'specialization', 'group'];
  const missing = required.filter((k) => !student[k]);
  return {
    ok: missing.length === 0,
    missing,
  };
}

function buildReportText(student, currentFileName, comparisons) {
  const lines = [
    'Отчёт о проверке курсовой работы',
    '',
    `Ф.И.О.: ${student.fullName}`,
    `Курс: ${student.course}`,
    `Факультет: ${student.faculty}`,
    `Направление подготовки: ${student.specialization}`,
    `Группа: ${student.group}`,
    '',
    `Проверяемый файл: ${currentFileName}`,
    '',
    'Результаты сравнения:',
  ];

  if (!comparisons.length) {
    lines.push('Первый документ в базе (сравнений нет).');
  } else {
    comparisons.forEach((cmp, idx) => {
      lines.push(`${idx + 1}. ${cmp.name} — ${cmp.similarity}%`);
    });
  }
  return lines.join('\n');
}

function safePathName(name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'unknown';
}

async function saveLocalFallback({ currentFile, currentFileName, student, comparisons }) {
  const studentDir = path.join(REPORTS_DIR, safePathName(student.fullName));
  await fs.mkdir(studentDir, { recursive: true });

  const timeTag = new Date().toISOString().replace(/[:.]/g, '-');
  const sourceExt = path.extname(currentFileName) || '.docx';
  const fileBase = safePathName(path.parse(currentFileName).name);

  const localFileName = `${timeTag}-${fileBase}${sourceExt}`;
  const localReportName = `${timeTag}-${fileBase}-report.txt`;

  const localFilePath = path.join(studentDir, localFileName);
  const localReportPath = path.join(studentDir, localReportName);

  await fs.copyFile(currentFile.path, localFilePath);
  await fs.writeFile(localReportPath, buildReportText(student, currentFileName, comparisons), 'utf8');

  return {
    uploaded: true,
    mode: 'local-fallback',
    folderPath: studentDir,
    filePath: localFilePath,
    reportPath: localReportPath,
  };
}

async function getDriveClient() {
  if (!GOOGLE_SERVICE_ACCOUNT_PATH) {
    return null;
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_SERVICE_ACCOUNT_PATH,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  const authClient = await auth.getClient();
  return google.drive({ version: 'v3', auth: authClient });
}

async function ensureStudentFolder(drive, studentName) {
  const parentQuery = GOOGLE_DRIVE_ROOT_FOLDER_ID
    ? ` and '${GOOGLE_DRIVE_ROOT_FOLDER_ID}' in parents`
    : '';
  const q =
    `mimeType='application/vnd.google-apps.folder' and name='${studentName.replace(/'/g, "\\'")}' and trashed=false` +
    parentQuery;

  const found = await drive.files.list({
    q,
    fields: 'files(id,name)',
    pageSize: 1,
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
  });

  if (found.data.files && found.data.files.length) {
    return found.data.files[0].id;
  }

  const metadata = {
    name: studentName,
    mimeType: 'application/vnd.google-apps.folder',
  };
  if (GOOGLE_DRIVE_ROOT_FOLDER_ID) {
    metadata.parents = [GOOGLE_DRIVE_ROOT_FOLDER_ID];
  }

  const created = await drive.files.create({
    requestBody: metadata,
    fields: 'id',
    supportsAllDrives: true,
  });
  return created.data.id;
}

async function uploadToDrive({ currentFile, currentFileName, student, comparisons }) {
  const drive = await getDriveClient();
  if (!drive) {
    return { uploaded: false, message: 'Google Drive не настроен (нет GOOGLE_SERVICE_ACCOUNT_PATH)' };
  }

  const folderId = await ensureStudentFolder(drive, student.fullName);

  const uploadedFile = await drive.files.create({
    requestBody: {
      name: currentFileName,
      parents: [folderId],
    },
    media: {
      mimeType: currentFile.mimetype || 'application/octet-stream',
      body: fsSync.createReadStream(currentFile.path),
    },
    fields: 'id,name',
    supportsAllDrives: true,
  });

  const reportText = buildReportText(student, currentFileName, comparisons);
  const reportName = `${path.parse(currentFileName).name}-report.txt`;

  const uploadedReport = await drive.files.create({
    requestBody: {
      name: reportName,
      parents: [folderId],
    },
    media: {
      mimeType: 'text/plain',
      body: Readable.from([reportText]),
    },
    fields: 'id,name',
    supportsAllDrives: true,
  });

  return {
    uploaded: true,
    folderId,
    fileId: uploadedFile.data.id,
    reportId: uploadedReport.data.id,
  };
}

async function extractTextFromFile(file) {
  const originalName = String(file.originalname || '').toLowerCase();
  const mimeType = String(file.mimetype || '').toLowerCase();
  const isDocx =
    originalName.endsWith('.docx') ||
    mimeType.includes('officedocument.wordprocessingml.document');
  const isDoc = originalName.endsWith('.doc') || mimeType.includes('msword');

  if (isDocx) {
    const result = await mammoth.extractRawText({ path: file.path });
    return result.value || '';
  }

  if (isDoc) {
    try {
      const doc = await extractor.extract(file.path);
      return doc.getBody() || '';
    } catch (_) {
      // Fallback for broken legacy doc files.
    }
  }

  const asText = await fs.readFile(file.path, 'utf8');
  return asText || '';
}

async function safeUnlink(path) {
  try {
    await fs.unlink(path);
  } catch (_) {
    // Ignore cleanup errors.
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/compare', upload.any(), async (req, res) => {
  const files = Array.isArray(req.files) ? req.files : [];

  try {
    const currentFile = files.find((f) => f.fieldname === 'current');
    const previousFiles = files.filter((f) => f.fieldname === 'previous');

    if (!currentFile) {
      return res.status(400).json({ error: 'Missing current file' });
    }

    const currentText = await extractTextFromFile(currentFile);
    const currentShingles = buildShingles(currentText);
    const student = getStudentInfo(req.body || {});
    const studentValidation = validateStudentInfo(student);
    if (!studentValidation.ok) {
      return res.status(400).json({
        error: 'Missing student fields',
        details: `Не заполнены поля: ${studentValidation.missing.join(', ')}`,
      });
    }

    const comparisons = [];
    for (const prev of previousFiles) {
      const previousText = await extractTextFromFile(prev);
      const previousShingles = buildShingles(previousText);
      comparisons.push({
        name: decodeUploadedName(prev.originalname),
        similarity: jaccardSimilarity(currentShingles, previousShingles),
      });
    }

    comparisons.sort((a, b) => b.similarity - a.similarity);
    const currentFileName = decodeUploadedName(currentFile.originalname);
    let driveResult = null;
    try {
      driveResult = await uploadToDrive({
        currentFile,
        currentFileName,
        student,
        comparisons,
      });
    } catch (driveError) {
      driveResult = {
        uploaded: false,
        message: driveError && driveError.message ? driveError.message : 'Google Drive upload failed',
      };
    }

    if (!driveResult || !driveResult.uploaded) {
      const local = await saveLocalFallback({
        currentFile,
        currentFileName,
        student,
        comparisons,
      });
      driveResult = {
        ...local,
        message: `Google Drive недоступен, данные сохранены локально. ${
          driveResult && driveResult.message ? driveResult.message : ''
        }`.trim(),
      };
    }

    return res.json({
      fileName: currentFileName,
      student,
      comparisons,
      drive: driveResult,
    });
  } catch (err) {
    return res.status(500).json({
      error: 'Compare failed',
      details: err && err.message ? err.message : 'Unknown server error',
    });
  } finally {
    await Promise.all(files.map((f) => safeUnlink(f.path)));
  }
});

app.listen(PORT, () => {
  console.log(`Lab6 server started on http://localhost:${PORT}`);
});
