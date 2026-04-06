(function () {
  const DB_NAME = 'lab6_docs_db';
  const STORE_NAME = 'documents';
  const API_URL = 'http://localhost:3000/api/compare';

  const state = {
    tab: 'upload',
    dragOver: false,
    docs: [],
    status: '',
    statusType: '',
    selectedFile: null,
    vkFileUrl: '',
    student: {
      fullName: '',
      course: '',
      faculty: '',
      specialization: '',
      group: '',
    },
  };

  function qs(sel) {
    return document.querySelector(sel);
  }

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function getAllDocs() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async function addDoc(doc) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.objectStore(STORE_NAME).add(doc);
    });
  }

  function toBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function base64ToBlob(dataUrl, mimeType) {
    const split = String(dataUrl || '').split(',');
    const b64 = split.length > 1 ? split[1] : '';
    const bytes = atob(b64);
    const arr = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 1) arr[i] = bytes.charCodeAt(i);
    return new Blob([arr], { type: mimeType || 'application/octet-stream' });
  }

  function isDoc(fileName) {
    const lower = String(fileName || '').toLowerCase();
    return lower.endsWith('.doc') || lower.endsWith('.docx');
  }

  function escapeHtml(text) {
    return String(text || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function validateStudent() {
    const required = [
      ['fullName', 'Ф.И.О.'],
      ['course', 'Курс'],
      ['faculty', 'Факультет'],
      ['specialization', 'Направление подготовки'],
      ['group', 'Группа'],
    ];
    for (const [key, label] of required) {
      if (!String(state.student[key] || '').trim()) {
        return `Заполни поле: ${label}`;
      }
    }
    return '';
  }

  function setStatus(text, type) {
    state.status = text;
    state.statusType = type;
    render();
  }

  async function fetchVkFileIfExists() {
    const params = new URLSearchParams(window.location.search);
    const fileUrl = params.get('fileUrl');
    if (!fileUrl) return null;
    const res = await fetch(fileUrl, { credentials: 'include' });
    if (!res.ok) throw new Error(`Не удалось загрузить файл из VK: ${res.status}`);
    const blob = await res.blob();
    const urlName = fileUrl.split('/').pop() || 'vk-file.docx';
    const cleanName = decodeURIComponent(urlName.split('?')[0]);
    return new File([blob], cleanName, { type: blob.type || 'application/octet-stream' });
  }

  async function compareAndSave(file) {
    const previous = await getAllDocs();
    const form = new FormData();
    form.append('current', file, file.name);
    form.append('fullName', state.student.fullName);
    form.append('course', state.student.course);
    form.append('faculty', state.student.faculty);
    form.append('specialization', state.student.specialization);
    form.append('group', state.student.group);

    previous.forEach((doc) => {
      const blob = base64ToBlob(doc.contentBase64, doc.type);
      const prevFile = new File([blob], doc.name, { type: doc.type });
      form.append('previous', prevFile, prevFile.name);
    });

    const res = await fetch(API_URL, { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data && data.details ? data.details : 'Ошибка сравнения на сервере');

    const base64 = await toBase64(file);
    const newDoc = {
      name: file.name,
      type: file.type || 'application/octet-stream',
      size: file.size,
      lastModified: file.lastModified,
      createdAt: new Date().toISOString(),
      student: { ...state.student },
      comparisons: data.comparisons || [],
      drive: data.drive || null,
      contentBase64: base64,
    };
    await addDoc(newDoc);
    state.docs = await getAllDocs();
    state.tab = 'list';
    setStatus(`Проверено: ${file.name}`, 'ok');
  }

  function renderDocsHtml() {
    const docs = [...state.docs].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (!docs.length) return '<div class="help">Пока нет загруженных документов.</div>';

    return `<ul class="doc-list">${docs
      .map((doc) => {
        const cmp = doc.comparisons && doc.comparisons.length
          ? `<div><strong>Результаты сравнения:</strong><ul class="cmp-list">${doc.comparisons
              .map((c) => `<li>${c.name} — ${c.similarity}%</li>`)
              .join('')}</ul></div>`
          : '<div class="help">Сравнений пока нет (первый документ).</div>';
        const driveInfo = doc.drive
          ? doc.drive.uploaded
            ? doc.drive.mode === 'local-fallback'
              ? `<div class="help">Google Drive: недоступен, сохранено локально (${escapeHtml(
                  doc.drive.folderPath || 'server/reports'
                )}).</div>`
              : '<div class="help">Google Drive: файл и отчёт загружены.</div>'
            : `<div class="help">Google Drive: ${escapeHtml(doc.drive.message || 'не загружено')}</div>`
          : '';
        const studentInfo = doc.student
          ? `<div class="doc-meta">Студент: ${escapeHtml(doc.student.fullName || '')}, группа: ${escapeHtml(
              doc.student.group || ''
            )}</div>`
          : '';
        return `<li class="doc-card"><h4>${doc.name}</h4><div class="doc-meta">Размер: ${Math.round(
          doc.size / 1024
        )} KB, добавлен: ${new Date(doc.createdAt).toLocaleString()}</div>${studentInfo}${cmp}${driveInfo}</li>`;
      })
      .join('')}</ul>`;
  }

  function bindEvents() {
    qs('#tab-upload').onclick = () => {
      state.tab = 'upload';
      render();
    };
    qs('#tab-list').onclick = () => {
      state.tab = 'list';
      render();
    };

    const dropzone = qs('#dropzone');
    if (dropzone) {
      dropzone.ondragover = (e) => {
        e.preventDefault();
        state.dragOver = true;
        dropzone.classList.add('drag-over');
      };
      dropzone.ondragleave = () => {
        state.dragOver = false;
        dropzone.classList.remove('drag-over');
      };
      dropzone.ondrop = (e) => {
        e.preventDefault();
        state.dragOver = false;
        dropzone.classList.remove('drag-over');
        const file = e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files[0] : null;
        if (!file) return;
        if (!isDoc(file.name)) return setStatus('Можно загружать только .doc/.docx', 'err');
        state.selectedFile = file;
        setStatus(`Выбран файл: ${file.name}`, 'ok');
      };
    }

    const input = qs('#file-input');
    if (input) {
      input.onchange = (e) => {
        const file = e.target.files && e.target.files[0] ? e.target.files[0] : null;
        if (!file) return;
        if (!isDoc(file.name)) return setStatus('Можно загружать только .doc/.docx', 'err');
        state.selectedFile = file;
        setStatus(`Выбран файл: ${file.name}`, 'ok');
      };
    }

    ['fullName', 'course', 'faculty', 'specialization', 'group'].forEach((key) => {
      const el = qs(`#student-${key}`);
      if (!el) return;
      el.oninput = (e) => {
        state.student[key] = String(e.target.value || '');
      };
    });

    const uploadBtn = qs('#upload-btn');
    if (uploadBtn) {
      uploadBtn.onclick = async () => {
        const studentError = validateStudent();
        if (studentError) return setStatus(studentError, 'err');

        try {
          setStatus('Проверка на сервере...', 'ok');
          let fileToProcess = state.selectedFile;
          if (!fileToProcess && state.vkFileUrl) {
            fileToProcess = await fetchVkFileIfExists();
          }
          if (!fileToProcess) return setStatus('Сначала выбери файл', 'err');

          await compareAndSave(fileToProcess);
          state.selectedFile = null;
          render();
        } catch (err) {
          setStatus(err && err.message ? err.message : 'Не удалось обработать файл', 'err');
        }
      };
    }
  }

  function render() {
    const app = qs('#app');
    if (!app) return;
    const statusHtml = state.status
      ? `<div class="status ${state.statusType === 'err' ? 'err' : 'ok'}">${state.status}</div>`
      : '';

    app.innerHTML = `
      <div>
        <div class="tabs">
          <button id="tab-upload" class="tab-btn ${state.tab === 'upload' ? 'active' : ''}">Загрузка документов</button>
          <button id="tab-list" class="tab-btn ${state.tab === 'list' ? 'active' : ''}">Список документов</button>
        </div>
        ${
          state.tab === 'upload'
            ? `<section>
                <div id="dropzone" class="dropzone ${state.dragOver ? 'drag-over' : ''}">
                  <strong>Перетащите .doc/.docx сюда</strong>
                  <div class="help">или выберите файл вручную</div>
                  <div class="row" style="justify-content:center">
                    <input id="file-input" type="file" accept=".doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" />
                  </div>
                </div>
                <div class="row">
                  <button id="upload-btn" class="btn">Проверить</button>
                </div>
                <div class="row" style="display:block">
                  <input id="student-fullName" placeholder="Ф.И.О." value="${escapeHtml(state.student.fullName)}" style="width:100%;padding:7px;margin-top:8px;border:1px solid #cbd5e1;border-radius:8px;" />
                  <input id="student-course" placeholder="Курс" value="${escapeHtml(state.student.course)}" style="width:100%;padding:7px;margin-top:8px;border:1px solid #cbd5e1;border-radius:8px;" />
                  <input id="student-faculty" placeholder="Факультет" value="${escapeHtml(state.student.faculty)}" style="width:100%;padding:7px;margin-top:8px;border:1px solid #cbd5e1;border-radius:8px;" />
                  <input id="student-specialization" placeholder="Направление подготовки" value="${escapeHtml(state.student.specialization)}" style="width:100%;padding:7px;margin-top:8px;border:1px solid #cbd5e1;border-radius:8px;" />
                  <input id="student-group" placeholder="Группа" value="${escapeHtml(state.student.group)}" style="width:100%;padding:7px;margin-top:8px;border:1px solid #cbd5e1;border-radius:8px;" />
                </div>
                ${
                  state.vkFileUrl
                    ? `<div class="help">Режим VK: будет загружен файл по ссылке из кнопки "проверить".</div>`
                    : ''
                }
                ${statusHtml}
              </section>`
            : `<section>${renderDocsHtml()}${statusHtml}</section>`
        }
      </div>
    `;
    bindEvents();
  }

  async function init() {
    try {
      state.docs = await getAllDocs();
      state.vkFileUrl = new URLSearchParams(window.location.search).get('fileUrl') || '';
      render();
      if (window.location.pathname.endsWith('/panel.html') && state.vkFileUrl) {
        setStatus('Режим VK: заполни данные студента и нажми "Проверить"', 'ok');
      }
    } catch (err) {
      state.status = err && err.message ? err.message : 'Ошибка инициализации расширения';
      state.statusType = 'err';
      render();
    }
  }

  init();
})();
