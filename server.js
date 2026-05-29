const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR || path.join(ROOT, 'uploads'));
const DATA_FILE = path.join(DATA_DIR, 'site.json');
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'love2026';
const COOKIE_NAME = 'couple_sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

const DEFAULT_DATA = {
  site: {
    title: '我们的甜甜小屋',
    subtitle: '把相爱过的每一天，写成可以翻阅的回忆。',
    announcement: '这里可以放照片、写日志、记录纪念日。公开页面任何人都能看，编辑和上传需要管理员登录。',
    startDate: '2024-02-14'
  },
  moments: []
};

const sessions = new Map();
let saveChain = Promise.resolve();
let httpServer = null;

async function ensureStorage() {
  await fsp.mkdir(PUBLIC_DIR, { recursive: true });
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(UPLOADS_DIR, { recursive: true });
  try {
    await fsp.access(DATA_FILE);
  } catch {
    await fsp.writeFile(DATA_FILE, JSON.stringify(DEFAULT_DATA, null, 2), 'utf8');
  }
}

async function loadData() {
  try {
    const raw = await fsp.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      site: { ...DEFAULT_DATA.site, ...(parsed.site || {}) },
      moments: Array.isArray(parsed.moments) ? parsed.moments : []
    };
  } catch {
    return structuredClone(DEFAULT_DATA);
  }
}

function saveData(nextData) {
  const payload = JSON.stringify(nextData, null, 2);
  saveChain = saveChain.then(() => fsp.writeFile(DATA_FILE, payload, 'utf8'));
  return saveChain;
}

function send(res, statusCode, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body);
  res.writeHead(statusCode, {
    'Content-Type': isBuffer ? 'application/octet-stream' : 'text/html; charset=utf-8',
    ...headers
  });
  res.end(body);
}

function sendJson(res, statusCode, data, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers
  });
  res.end(JSON.stringify(data));
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function parseCookies(cookieHeader = '') {
  return cookieHeader.split(';').reduce((acc, part) => {
    const index = part.indexOf('=');
    if (index === -1) return acc;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

function getSession(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const sid = cookies[COOKIE_NAME];
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(sid);
    return null;
  }
  return { sid, ...session };
}

function requireAuth(req, res) {
  const session = getSession(req);
  if (!session) {
    sendJson(res, 401, { error: 'not_authenticated' });
    return null;
  }
  return session;
}

function cleanupSessions() {
  const now = Date.now();
  for (const [sid, session] of sessions.entries()) {
    if (session.expiresAt <= now) sessions.delete(sid);
  }
}

function readRequestBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  const raw = await readRequestBody(req, limit);
  if (!raw.length) return {};
  return JSON.parse(raw.toString('utf8'));
}

function safeFilename() {
  return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
}

async function saveDataUrlImage(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(String(dataUrl || '').trim());
  if (!match) {
    throw new Error('invalid_image_data');
  }
  const mimeType = match[1];
  const ext = MIME_TO_EXT[mimeType];
  if (!ext) {
    throw new Error('unsupported_image_type');
  }
  const buffer = Buffer.from(match[2], 'base64');
  const filename = `${safeFilename()}.${ext}`;
  const filePath = path.join(UPLOADS_DIR, filename);
  await fsp.writeFile(filePath, buffer);
  return `/uploads/${filename}`;
}

async function deleteImageIfLocal(imageUrl) {
  if (!imageUrl || !imageUrl.startsWith('/uploads/')) return;
  const filePath = path.join(UPLOADS_DIR, path.basename(imageUrl));
  try {
    await fsp.unlink(filePath);
  } catch {
    // Ignore missing files.
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDate(dateValue) {
  if (!dateValue) return '';
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return dateValue;
  return date.toISOString().slice(0, 10);
}

function computeDaysTogether(startDate) {
  if (!startDate) return 0;
  const start = new Date(`${startDate}T00:00:00`);
  if (Number.isNaN(start.getTime())) return 0;
  const today = new Date();
  const utcStart = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const utcToday = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.max(0, Math.floor((utcToday - utcStart) / 86400000));
}

function publicPageHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>情侣网页</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body class="public-page">
  <div class="bg-glow bg-glow-a"></div>
  <div class="bg-glow bg-glow-b"></div>
  <header class="topbar">
    <a class="brand" href="/">我们的甜甜小屋</a>
    <a class="ghost-link" href="/admin">管理员入口</a>
  </header>

  <main class="shell">
    <section class="hero card">
      <div class="hero-copy">
        <p class="eyebrow">甜一点 · 公开可看</p>
        <h1 id="siteTitle">我们的甜甜小屋</h1>
        <p class="hero-text" id="siteSubtitle">把相爱过的每一天，写成可以翻阅的回忆。</p>
        <div class="hero-stats">
          <div class="stat">
            <span class="stat-label">在一起</span>
            <strong id="daysTogether">0 天</strong>
          </div>
          <div class="stat">
            <span class="stat-label">公开日志</span>
            <strong id="momentCount">0 篇</strong>
          </div>
        </div>
      </div>
      <div class="hero-note">
        <div class="note-card">
          <span class="sparkle">♥</span>
          <p id="announcement">这里可以放照片、写日志、记录纪念日。</p>
        </div>
      </div>
    </section>

    <section class="section card">
      <div class="section-head">
        <div>
          <p class="eyebrow">照片墙</p>
          <h2>一起拍下来的光</h2>
        </div>
      </div>
      <div id="photoWall" class="photo-wall"></div>
    </section>

    <section class="section card">
      <div class="section-head">
        <div>
          <p class="eyebrow">恋爱日志</p>
          <h2>把小事写成故事</h2>
        </div>
      </div>
      <div id="timeline" class="timeline"></div>
    </section>
  </main>

  <div id="detailModal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="detailTitle">
    <button id="closeModal" class="modal-close" aria-label="关闭">×</button>
    <div class="modal-card card">
      <div id="detailImageWrap" class="detail-image-wrap hidden">
        <img id="detailImage" alt="" />
      </div>
      <p id="detailDate" class="detail-date"></p>
      <h3 id="detailTitle"></h3>
      <p id="detailMood" class="detail-mood"></p>
      <p id="detailContent" class="detail-content"></p>
    </div>
  </div>

  <script src="/app.js"></script>
</body>
</html>`;
}

function adminPageHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>管理员 - 情侣网页</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body class="admin-page">
  <div class="bg-glow bg-glow-a"></div>
  <div class="bg-glow bg-glow-b"></div>
  <header class="topbar">
    <a class="brand" href="/">返回首页</a>
    <button id="logoutBtn" class="ghost-link" type="button">退出登录</button>
  </header>

  <main class="shell admin-shell">
    <section class="card admin-card" id="loginCard">
      <p class="eyebrow">管理员登录</p>
      <h1>进入编辑小屋</h1>
      <p class="helper-text">公开页面任何人都能看，只有这里可以上传照片和修改日志。</p>
      <form id="loginForm" class="stack-form">
        <label class="field">
          <span>管理员密码</span>
          <input id="passwordInput" type="password" placeholder="输入密码" required />
        </label>
        <button class="primary-btn" type="submit">登录</button>
      </form>
    </section>

    <section class="hidden" id="dashboard">
      <section class="card admin-card">
        <div class="section-head">
          <div>
            <p class="eyebrow">小屋设置</p>
            <h2>修改首页文字</h2>
          </div>
        </div>
        <form id="siteForm" class="stack-form two-col">
          <label class="field">
            <span>网页标题</span>
            <input name="title" required />
          </label>
          <label class="field">
            <span>纪念日</span>
            <input name="startDate" type="date" required />
          </label>
          <label class="field full">
            <span>副标题</span>
            <input name="subtitle" required />
          </label>
          <label class="field full">
            <span>公告</span>
            <textarea name="announcement" rows="3" required></textarea>
          </label>
          <button class="primary-btn" type="submit">保存首页设置</button>
        </form>
      </section>

      <section class="card admin-card">
        <div class="section-head">
          <div>
            <p class="eyebrow">照片和日志</p>
            <h2 id="formTitle">新增一条回忆</h2>
          </div>
          <button id="cancelEditBtn" class="ghost-btn hidden" type="button">取消编辑</button>
        </div>
        <form id="momentForm" class="stack-form">
          <input type="hidden" id="momentId" />
          <div class="two-col">
            <label class="field">
              <span>标题</span>
              <input id="momentTitle" required maxlength="80" />
            </label>
            <label class="field">
              <span>日期</span>
              <input id="momentDate" type="date" required />
            </label>
          </div>
          <label class="field">
            <span>氛围标签</span>
            <input id="momentMood" placeholder="比如：下雨天、见面、晚饭后..." maxlength="40" />
          </label>
          <label class="field">
            <span>内容</span>
            <textarea id="momentContent" rows="6" required maxlength="5000"></textarea>
          </label>
          <label class="field">
            <span>照片</span>
            <input id="momentImage" type="file" accept="image/*" />
          </label>
          <div id="imagePreview" class="image-preview hidden"></div>
          <div class="button-row">
            <button class="primary-btn" type="submit" id="submitMomentBtn">发布回忆</button>
          </div>
        </form>
      </section>

      <section class="card admin-card">
        <div class="section-head">
          <div>
            <p class="eyebrow">已发布内容</p>
            <h2>快速修改或删除</h2>
          </div>
        </div>
        <div id="adminList" class="admin-list"></div>
      </section>
    </section>
  </main>

  <script src="/admin.js"></script>
</body>
</html>`;
}

function stylesCss() {
  return `
:root {
  --bg: #fff6f8;
  --card: rgba(255, 255, 255, 0.78);
  --card-strong: #fff;
  --text: #5c3342;
  --muted: #8f6775;
  --line: rgba(188, 127, 149, 0.18);
  --shadow: 0 18px 50px rgba(196, 120, 146, 0.18);
  --shadow-soft: 0 10px 30px rgba(196, 120, 146, 0.12);
  --accent: #e86a92;
  --accent-2: #ff94b3;
  --accent-3: #ffd1dc;
  --accent-dark: #cb4f78;
  --success: #ce6c8a;
}

* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  color: var(--text);
  background:
    radial-gradient(circle at top left, rgba(255, 195, 214, 0.56), transparent 36%),
    radial-gradient(circle at top right, rgba(255, 228, 238, 0.9), transparent 28%),
    linear-gradient(180deg, #fff9fb 0%, #fff4f7 100%);
  font-family: "Palatino Linotype", "Book Antiqua", "Georgia", serif;
}

body::before {
  content: "";
  position: fixed;
  inset: 0;
  pointer-events: none;
  opacity: 0.3;
  background-image: radial-gradient(rgba(232, 106, 146, 0.12) 1px, transparent 1px);
  background-size: 24px 24px;
}

a { color: inherit; text-decoration: none; }
button, input, textarea { font: inherit; }

.bg-glow {
  position: fixed;
  width: 360px;
  height: 360px;
  border-radius: 50%;
  filter: blur(30px);
  opacity: 0.55;
  pointer-events: none;
  z-index: 0;
}
.bg-glow-a { top: -100px; left: -120px; background: rgba(255, 158, 186, 0.35); }
.bg-glow-b { bottom: -120px; right: -80px; background: rgba(255, 214, 225, 0.65); }

.topbar, .shell { position: relative; z-index: 1; }
.topbar {
  max-width: 1200px;
  margin: 0 auto;
  padding: 24px 20px 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.brand {
  font-size: 1.1rem;
  letter-spacing: 0.04em;
  color: var(--accent-dark);
  font-weight: 700;
}

.ghost-link, .ghost-btn {
  border: 1px solid rgba(232, 106, 146, 0.22);
  color: var(--accent-dark);
  background: rgba(255, 255, 255, 0.72);
  padding: 10px 16px;
  border-radius: 999px;
  box-shadow: var(--shadow-soft);
  cursor: pointer;
}

.shell {
  max-width: 1200px;
  margin: 0 auto;
  padding: 16px 20px 56px;
  display: grid;
  gap: 24px;
}

.card {
  background: var(--card);
  border: 1px solid rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(12px);
  box-shadow: var(--shadow);
  border-radius: 28px;
}

.hero {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) minmax(280px, 0.8fr);
  gap: 22px;
  padding: 28px;
  overflow: hidden;
}

.eyebrow {
  margin: 0 0 10px;
  text-transform: uppercase;
  letter-spacing: 0.18em;
  font-size: 0.75rem;
  color: var(--accent-dark);
}

h1, h2, h3, p { margin-top: 0; }
h1 {
  font-size: clamp(2.3rem, 4vw, 4.7rem);
  line-height: 0.95;
  margin-bottom: 12px;
}
h2 {
  font-size: clamp(1.25rem, 2vw, 2rem);
  margin-bottom: 0;
}

.hero-text {
  max-width: 50ch;
  font-size: 1.08rem;
  line-height: 1.8;
  color: var(--muted);
}

.hero-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 20px;
}

.stat {
  min-width: 150px;
  padding: 16px 18px;
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.78);
  border: 1px solid rgba(232, 106, 146, 0.16);
  box-shadow: var(--shadow-soft);
}
.stat-label {
  display: block;
  font-size: 0.78rem;
  color: var(--muted);
  margin-bottom: 8px;
}
.stat strong {
  font-size: 1.45rem;
  color: var(--accent-dark);
}

.hero-note {
  display: flex;
  align-items: stretch;
}
.note-card {
  width: 100%;
  padding: 24px;
  border-radius: 24px;
  background: linear-gradient(180deg, rgba(255, 241, 246, 0.88), rgba(255, 255, 255, 0.98));
  border: 1px dashed rgba(232, 106, 146, 0.22);
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 18px;
}
.sparkle {
  width: 52px;
  height: 52px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: linear-gradient(135deg, #ff9fb9, #ffcfde);
  color: white;
  font-size: 1.5rem;
  box-shadow: 0 10px 24px rgba(232, 106, 146, 0.28);
}

.section {
  padding: 24px;
}
.section-head {
  display: flex;
  align-items: end;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 20px;
}

.photo-wall {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 16px;
}

.photo-card {
  position: relative;
  min-height: 240px;
  border-radius: 24px;
  overflow: hidden;
  background: linear-gradient(160deg, #ffd9e5, #fff);
  box-shadow: var(--shadow-soft);
  border: 1px solid rgba(232, 106, 146, 0.12);
  cursor: pointer;
  transform: translateY(0);
  transition: transform 180ms ease, box-shadow 180ms ease;
}
.photo-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 18px 32px rgba(196, 120, 146, 0.2);
}
.photo-card img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.photo-fallback {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: flex-end;
  padding: 18px;
  background: linear-gradient(180deg, rgba(255, 175, 197, 0.14), rgba(255, 255, 255, 0.9));
}
.photo-fallback span {
  display: inline-block;
  padding: 8px 12px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.76);
  color: var(--accent-dark);
  font-weight: 700;
}
.photo-meta {
  position: absolute;
  left: 14px;
  right: 14px;
  bottom: 14px;
  padding: 14px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.82);
  backdrop-filter: blur(10px);
}
.photo-meta .date {
  display: block;
  font-size: 0.75rem;
  color: var(--muted);
  margin-bottom: 4px;
}
.photo-meta .title {
  font-size: 1rem;
  font-weight: 700;
  color: var(--text);
}

.timeline {
  display: grid;
  gap: 14px;
}

.timeline-item {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 16px;
  padding: 18px;
  border-radius: 22px;
  background: rgba(255, 255, 255, 0.82);
  border: 1px solid rgba(232, 106, 146, 0.12);
  box-shadow: var(--shadow-soft);
  cursor: pointer;
  transition: transform 180ms ease;
}
.timeline-item:hover { transform: translateY(-3px); }
.timeline-date {
  font-weight: 700;
  color: var(--accent-dark);
}
.timeline-body h3 {
  margin-bottom: 8px;
  font-size: 1.08rem;
}
.timeline-body p {
  margin-bottom: 10px;
  line-height: 1.75;
  color: var(--muted);
}
.mood-pill {
  display: inline-flex;
  padding: 6px 12px;
  border-radius: 999px;
  background: rgba(232, 106, 146, 0.1);
  color: var(--accent-dark);
  font-size: 0.78rem;
}

.empty-state {
  padding: 20px;
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.72);
  border: 1px dashed rgba(232, 106, 146, 0.18);
  color: var(--muted);
}

.modal {
  position: fixed;
  inset: 0;
  background: rgba(61, 26, 40, 0.28);
  display: grid;
  place-items: center;
  padding: 20px;
  z-index: 20;
}
.modal.hidden { display: none; }
.modal-card {
  width: min(720px, 100%);
  padding: 24px;
  position: relative;
}
.modal-close {
  position: fixed;
  top: 18px;
  right: 18px;
  width: 46px;
  height: 46px;
  border: 0;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.92);
  color: var(--accent-dark);
  font-size: 1.6rem;
  cursor: pointer;
  box-shadow: var(--shadow-soft);
}
.detail-image-wrap {
  margin-bottom: 18px;
  border-radius: 20px;
  overflow: hidden;
}
.detail-image-wrap img {
  display: block;
  width: 100%;
  max-height: 420px;
  object-fit: cover;
}
.detail-date {
  color: var(--accent-dark);
  margin-bottom: 8px;
  font-size: 0.82rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.detail-mood {
  display: inline-flex;
  padding: 6px 12px;
  border-radius: 999px;
  background: rgba(232, 106, 146, 0.1);
  color: var(--accent-dark);
}
.detail-content {
  margin-top: 16px;
  line-height: 1.9;
  white-space: pre-wrap;
  color: var(--muted);
}

.admin-shell {
  max-width: 960px;
}
.admin-card {
  padding: 24px;
}
.stack-form {
  display: grid;
  gap: 16px;
}
.two-col {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.field {
  display: grid;
  gap: 8px;
}
.field span {
  font-weight: 700;
  color: var(--accent-dark);
}
.field input,
.field textarea {
  width: 100%;
  border: 1px solid rgba(232, 106, 146, 0.18);
  background: rgba(255, 255, 255, 0.9);
  padding: 14px 16px;
  border-radius: 18px;
  color: var(--text);
  outline: none;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.85);
}
.field textarea { resize: vertical; }
.field input:focus,
.field textarea:focus {
  border-color: rgba(232, 106, 146, 0.45);
  box-shadow: 0 0 0 4px rgba(232, 106, 146, 0.08);
}
.field.full { grid-column: 1 / -1; }
.helper-text {
  color: var(--muted);
  line-height: 1.8;
}
.primary-btn {
  justify-self: start;
  border: 0;
  border-radius: 999px;
  padding: 13px 20px;
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: #fff;
  font-weight: 700;
  box-shadow: 0 12px 28px rgba(232, 106, 146, 0.26);
  cursor: pointer;
}
.button-row { display: flex; gap: 12px; flex-wrap: wrap; }

.image-preview {
  display: grid;
  gap: 10px;
  padding: 14px;
  border-radius: 20px;
  border: 1px dashed rgba(232, 106, 146, 0.22);
  background: rgba(255, 255, 255, 0.72);
}
.image-preview img {
  max-width: 100%;
  border-radius: 16px;
  display: block;
}

.admin-list {
  display: grid;
  gap: 14px;
}
.admin-item {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr) auto;
  gap: 16px;
  align-items: center;
  padding: 16px;
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.82);
  border: 1px solid rgba(232, 106, 146, 0.12);
}
.admin-thumb {
  width: 110px;
  height: 84px;
  border-radius: 16px;
  overflow: hidden;
  background: linear-gradient(160deg, #ffd9e5, #fff);
}
.admin-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.admin-item h3 {
  margin-bottom: 6px;
}
.admin-actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.mini-btn {
  border: 1px solid rgba(232, 106, 146, 0.2);
  background: rgba(255, 255, 255, 0.9);
  color: var(--accent-dark);
  border-radius: 999px;
  padding: 9px 14px;
  cursor: pointer;
}
.danger-btn {
  border-color: rgba(196, 76, 110, 0.18);
  color: #c1436b;
}

.hidden { display: none !important; }

@media (max-width: 920px) {
  .hero, .admin-item, .timeline-item { grid-template-columns: 1fr; }
  .two-col { grid-template-columns: 1fr; }
  .admin-actions { justify-content: flex-start; }
  .topbar { padding-top: 18px; }
}

@media (max-width: 640px) {
  .shell { padding-inline: 14px; }
  .section, .hero, .admin-card { padding: 18px; }
  h1 { font-size: 2.3rem; }
  .photo-wall { grid-template-columns: 1fr 1fr; }
  .timeline-item { gap: 10px; }
}
`;
}

function appJs() {
  return `
const state = {
  site: null,
  moments: []
};

const siteTitle = document.getElementById('siteTitle');
const siteSubtitle = document.getElementById('siteSubtitle');
const announcement = document.getElementById('announcement');
const daysTogether = document.getElementById('daysTogether');
const momentCount = document.getElementById('momentCount');
const photoWall = document.getElementById('photoWall');
const timeline = document.getElementById('timeline');
const modal = document.getElementById('detailModal');
const closeModal = document.getElementById('closeModal');
const detailImageWrap = document.getElementById('detailImageWrap');
const detailImage = document.getElementById('detailImage');
const detailDate = document.getElementById('detailDate');
const detailTitle = document.getElementById('detailTitle');
const detailMood = document.getElementById('detailMood');
const detailContent = document.getElementById('detailContent');

function formatDate(value) {
  if (!value) return '';
  return value;
}

function calcDays(startDate) {
  if (!startDate) return 0;
  const start = new Date(startDate + 'T00:00:00');
  const today = new Date();
  const utcStart = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const utcToday = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.max(0, Math.floor((utcToday - utcStart) / 86400000));
}

function escapeText(value) {
  const div = document.createElement('div');
  div.textContent = value == null ? '' : String(value);
  return div.innerHTML;
}

function excerpt(value, size = 120) {
  const text = String(value || '').replace(/\\s+/g, ' ').trim();
  return text.length > size ? text.slice(0, size) + '…' : text;
}

function openModal(moment) {
  if (moment.imageUrl) {
    detailImageWrap.classList.remove('hidden');
    detailImage.src = moment.imageUrl;
    detailImage.alt = moment.title || '照片';
  } else {
    detailImageWrap.classList.add('hidden');
    detailImage.removeAttribute('src');
  }
  detailDate.textContent = moment.date || '';
  detailTitle.textContent = moment.title || '';
  detailMood.textContent = moment.mood || '';
  detailMood.classList.toggle('hidden', !moment.mood);
  detailContent.textContent = moment.content || '';
  modal.classList.remove('hidden');
}

function closeDetail() {
  modal.classList.add('hidden');
}

function renderPublic() {
  const { site, moments } = state;
  if (!site) return;

  siteTitle.textContent = site.title || '我们的甜甜小屋';
  siteSubtitle.textContent = site.subtitle || '';
  announcement.textContent = site.announcement || '';
  daysTogether.textContent = \`\${calcDays(site.startDate)} 天\`;
  momentCount.textContent = \`\${moments.length} 篇\`;

  const photoItems = moments.filter((item) => item.imageUrl).slice(0, 8);
  if (photoItems.length === 0) {
    photoWall.innerHTML = '<div class="empty-state">还没有上传照片，等你来填满这面墙。</div>';
  } else {
    photoWall.innerHTML = photoItems.map((moment) => \`
      <article class="photo-card" data-id="\${moment.id}">
        <img src="\${moment.imageUrl}" alt="\${escapeText(moment.title || '照片')}" />
        <div class="photo-meta">
          <span class="date">\${escapeText(moment.date || '')}</span>
          <span class="title">\${escapeText(moment.title || '')}</span>
        </div>
      </article>
    \`).join('');
  }

  if (moments.length === 0) {
    timeline.innerHTML = '<div class="empty-state">还没有写过日志。第一篇可以从“我们第一次见面”开始。</div>';
  } else {
    timeline.innerHTML = moments.map((moment) => \`
      <article class="timeline-item" data-id="\${moment.id}">
        <div class="timeline-date">\${escapeText(formatDate(moment.date || ''))}</div>
        <div class="timeline-body">
          <h3>\${escapeText(moment.title || '')}</h3>
          <p>\${escapeText(excerpt(moment.content || ''))}</p>
          \${moment.mood ? \`<span class="mood-pill">\${escapeText(moment.mood)}</span>\` : ''}
        </div>
      </article>
    \`).join('');
  }
}

async function boot() {
  const res = await fetch('/api/site');
  const data = await res.json();
  state.site = data.site || {};
  state.moments = Array.isArray(data.moments) ? data.moments : [];
  state.moments.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  renderPublic();
}

photoWall.addEventListener('click', (event) => {
  const card = event.target.closest('[data-id]');
  if (!card) return;
  const moment = state.moments.find((item) => item.id === card.dataset.id);
  if (moment) openModal(moment);
});

timeline.addEventListener('click', (event) => {
  const row = event.target.closest('[data-id]');
  if (!row) return;
  const moment = state.moments.find((item) => item.id === row.dataset.id);
  if (moment) openModal(moment);
});

closeModal.addEventListener('click', closeDetail);
modal.addEventListener('click', (event) => {
  if (event.target === modal) closeDetail();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDetail();
});

boot().catch((error) => {
  console.error(error);
  photoWall.innerHTML = '<div class="empty-state">页面加载失败，请刷新一下。</div>';
  timeline.innerHTML = '<div class="empty-state">页面加载失败，请刷新一下。</div>';
});
`;
}

function adminJs() {
  return `
const loginCard = document.getElementById('loginCard');
const dashboard = document.getElementById('dashboard');
const loginForm = document.getElementById('loginForm');
const passwordInput = document.getElementById('passwordInput');
const logoutBtn = document.getElementById('logoutBtn');
const siteForm = document.getElementById('siteForm');
const momentForm = document.getElementById('momentForm');
const momentId = document.getElementById('momentId');
const momentTitle = document.getElementById('momentTitle');
const momentDate = document.getElementById('momentDate');
const momentMood = document.getElementById('momentMood');
const momentContent = document.getElementById('momentContent');
const momentImage = document.getElementById('momentImage');
const imagePreview = document.getElementById('imagePreview');
const adminList = document.getElementById('adminList');
const formTitle = document.getElementById('formTitle');
const submitMomentBtn = document.getElementById('submitMomentBtn');
const cancelEditBtn = document.getElementById('cancelEditBtn');

let state = {
  me: false,
  site: null,
  moments: []
};

function getFormData(form) {
  return new FormData(form);
}

async function loadMe() {
  const res = await fetch('/api/me');
  const data = await res.json();
  state.me = !!data.authenticated;
  loginCard.classList.toggle('hidden', state.me);
  dashboard.classList.toggle('hidden', !state.me);
}

async function loadData() {
  const res = await fetch('/api/site');
  const data = await res.json();
  state.site = data.site || {};
  state.moments = Array.isArray(data.moments) ? data.moments : [];
  state.moments.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function fillSiteForm() {
  if (!state.site) return;
  siteForm.elements.title.value = state.site.title || '';
  siteForm.elements.subtitle.value = state.site.subtitle || '';
  siteForm.elements.announcement.value = state.site.announcement || '';
  siteForm.elements.startDate.value = state.site.startDate || '';
}

function resetMomentForm() {
  momentId.value = '';
  momentTitle.value = '';
  momentDate.value = '';
  momentMood.value = '';
  momentContent.value = '';
  momentImage.value = '';
  imagePreview.innerHTML = '';
  imagePreview.classList.add('hidden');
  formTitle.textContent = '新增一条回忆';
  submitMomentBtn.textContent = '发布回忆';
  cancelEditBtn.classList.add('hidden');
}

function showPreview(src, label) {
  imagePreview.innerHTML = \`<div><strong>\${label}</strong></div><img src="\${src}" alt="\${label}" />\`;
  imagePreview.classList.remove('hidden');
}

function renderList() {
  if (state.moments.length === 0) {
    adminList.innerHTML = '<div class="empty-state">还没有发布任何内容。</div>';
    return;
  }
  adminList.innerHTML = state.moments.map((moment) => \`
    <article class="admin-item">
      <div class="admin-thumb">
        \${moment.imageUrl ? \`<img src="\${moment.imageUrl}" alt="\${moment.title || '照片'}" />\` : ''}
      </div>
      <div>
        <h3>\${moment.title || ''}</h3>
        <p class="helper-text">\${moment.date || ''}\${moment.mood ? ' · ' + moment.mood : ''}</p>
        <p class="helper-text">\${(moment.content || '').slice(0, 120)}\${(moment.content || '').length > 120 ? '…' : ''}</p>
      </div>
      <div class="admin-actions">
        <button type="button" class="mini-btn" data-edit="\${moment.id}">编辑</button>
        <button type="button" class="mini-btn danger-btn" data-delete="\${moment.id}">删除</button>
      </div>
    </article>
  \`).join('');
}

async function login(password) {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error === 'invalid_password' ? '密码不对哦' : '登录失败');
    return false;
  }
  return true;
}

async function saveSite(event) {
  event.preventDefault();
  const payload = {
    title: siteForm.elements.title.value.trim(),
    subtitle: siteForm.elements.subtitle.value.trim(),
    announcement: siteForm.elements.announcement.value.trim(),
    startDate: siteForm.elements.startDate.value
  };
  const res = await fetch('/api/site', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    alert('保存失败');
    return;
  }
  await loadData();
  fillSiteForm();
  alert('首页设置已保存');
}

async function fileToDataUrl(file) {
  if (!file) return '';
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

async function saveMoment(event) {
  event.preventDefault();
  const payload = {
    title: momentTitle.value.trim(),
    date: momentDate.value,
    mood: momentMood.value.trim(),
    content: momentContent.value.trim()
  };
  const file = momentImage.files && momentImage.files[0];
  if (file) {
    payload.imageData = await fileToDataUrl(file);
  }

  const editing = !!momentId.value;
  const url = editing ? \`/api/moments/\${momentId.value}\` : '/api/moments';
  const method = editing ? 'PUT' : 'POST';
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) {
    alert(data.error || '保存失败');
    return;
  }
  await loadData();
  renderList();
  resetMomentForm();
  momentForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function startEdit(id) {
  const moment = state.moments.find((item) => item.id === id);
  if (!moment) return;
  momentId.value = moment.id;
  momentTitle.value = moment.title || '';
  momentDate.value = moment.date || '';
  momentMood.value = moment.mood || '';
  momentContent.value = moment.content || '';
  momentImage.value = '';
  if (moment.imageUrl) {
    showPreview(moment.imageUrl, '当前照片');
  } else {
    imagePreview.innerHTML = '';
    imagePreview.classList.add('hidden');
  }
  formTitle.textContent = '编辑这条回忆';
  submitMomentBtn.textContent = '保存修改';
  cancelEditBtn.classList.remove('hidden');
  momentForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function deleteMoment(id) {
  if (!confirm('确定要删除这一条回忆吗？')) return;
  const res = await fetch(\`/api/moments/\${id}\`, { method: 'DELETE' });
  if (!res.ok) {
    alert('删除失败');
    return;
  }
  await loadData();
  renderList();
  resetMomentForm();
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const ok = await login(passwordInput.value);
  if (ok) {
    passwordInput.value = '';
    await boot();
  }
});

logoutBtn.addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  await boot();
});

siteForm.addEventListener('submit', saveSite);
momentForm.addEventListener('submit', saveMoment);
cancelEditBtn.addEventListener('click', resetMomentForm);
momentImage.addEventListener('change', () => {
  const file = momentImage.files && momentImage.files[0];
  if (!file) {
    if (!momentId.value) {
      imagePreview.innerHTML = '';
      imagePreview.classList.add('hidden');
    }
    return;
  }
  const reader = new FileReader();
  reader.onload = () => showPreview(String(reader.result || ''), '新选照片预览');
  reader.readAsDataURL(file);
});

adminList.addEventListener('click', (event) => {
  const editBtn = event.target.closest('[data-edit]');
  const deleteBtn = event.target.closest('[data-delete]');
  if (editBtn) startEdit(editBtn.dataset.edit);
  if (deleteBtn) deleteMoment(deleteBtn.dataset.delete);
});

async function boot() {
  await loadMe();
  if (!state.me) return;
  await loadData();
  fillSiteForm();
  renderList();
  resetMomentForm();
}

boot().catch((error) => {
  console.error(error);
  alert('页面加载失败');
});
`;
}

async function getData() {
  return loadData();
}

function sortMoments(moments) {
  return moments.slice().sort((a, b) => {
    const dateCompare = String(b.date || '').localeCompare(String(a.date || ''));
    if (dateCompare !== 0) return dateCompare;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });
}

async function handleApi(req, res, url) {
  const method = req.method || 'GET';
  const data = await getData();

  if (method === 'GET' && url.pathname === '/api/site') {
    sendJson(res, 200, { site: data.site, moments: sortMoments(data.moments) });
    return true;
  }

  if (method === 'GET' && url.pathname === '/api/me') {
    sendJson(res, 200, { authenticated: !!getSession(req) });
    return true;
  }

  if (method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (method === 'POST' && url.pathname === '/api/login') {
    const body = await readJson(req, 1024 * 1024);
    if (body.password !== ADMIN_PASSWORD) {
      sendJson(res, 401, { error: 'invalid_password' });
      return true;
    }
    const sid = crypto.randomBytes(24).toString('hex');
    sessions.set(sid, { expiresAt: Date.now() + SESSION_TTL_MS });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `${COOKIE_NAME}=${encodeURIComponent(sid)}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_MS / 1000}; SameSite=Lax`
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (method === 'POST' && url.pathname === '/api/logout') {
    const cookies = parseCookies(req.headers.cookie || '');
    const sid = cookies[COOKIE_NAME];
    if (sid) sessions.delete(sid);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `${COOKIE_NAME}=; Path=/; Max-Age=0; SameSite=Lax`
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  if (method === 'PUT' && url.pathname === '/api/site') {
    if (!requireAuth(req, res)) return true;
    const body = await readJson(req, 2 * 1024 * 1024);
    data.site = {
      ...data.site,
      title: String(body.title || '').trim(),
      subtitle: String(body.subtitle || '').trim(),
      announcement: String(body.announcement || '').trim(),
      startDate: String(body.startDate || '').trim()
    };
    await saveData(data);
    sendJson(res, 200, { ok: true, site: data.site });
    return true;
  }

  if (method === 'POST' && url.pathname === '/api/moments') {
    if (!requireAuth(req, res)) return true;
    const body = await readJson(req, 8 * 1024 * 1024);
    if (!body.title || !body.date || !body.content) {
      sendJson(res, 400, { error: 'missing_fields' });
      return true;
    }
    const imageUrl = body.imageData ? await saveDataUrlImage(body.imageData) : '';
    const now = new Date().toISOString();
    const moment = {
      id: crypto.randomUUID(),
      title: String(body.title).trim(),
      date: String(body.date).trim(),
      mood: String(body.mood || '').trim(),
      content: String(body.content).trim(),
      imageUrl,
      createdAt: now,
      updatedAt: now
    };
    data.moments.push(moment);
    data.moments = sortMoments(data.moments);
    await saveData(data);
    sendJson(res, 201, { ok: true, moment });
    return true;
  }

  if (method === 'PUT' && url.pathname.startsWith('/api/moments/')) {
    if (!requireAuth(req, res)) return true;
    const id = url.pathname.split('/').pop();
    const index = data.moments.findIndex((item) => item.id === id);
    if (index === -1) {
      sendJson(res, 404, { error: 'not_found' });
      return true;
    }
    const body = await readJson(req, 8 * 1024 * 1024);
    const existing = data.moments[index];
    let imageUrl = existing.imageUrl;
    if (body.imageData) {
      const nextImageUrl = await saveDataUrlImage(body.imageData);
      await deleteImageIfLocal(existing.imageUrl);
      imageUrl = nextImageUrl;
    }
    data.moments[index] = {
      ...existing,
      title: body.title != null ? String(body.title).trim() : existing.title,
      date: body.date != null ? String(body.date).trim() : existing.date,
      mood: body.mood != null ? String(body.mood).trim() : existing.mood,
      content: body.content != null ? String(body.content).trim() : existing.content,
      imageUrl,
      updatedAt: new Date().toISOString()
    };
    data.moments = sortMoments(data.moments);
    await saveData(data);
    sendJson(res, 200, { ok: true, moment: data.moments.find((item) => item.id === id) });
    return true;
  }

  if (method === 'DELETE' && url.pathname.startsWith('/api/moments/')) {
    if (!requireAuth(req, res)) return true;
    const id = url.pathname.split('/').pop();
    const index = data.moments.findIndex((item) => item.id === id);
    if (index === -1) {
      sendJson(res, 404, { error: 'not_found' });
      return true;
    }
    const [removed] = data.moments.splice(index, 1);
    await deleteImageIfLocal(removed.imageUrl);
    await saveData(data);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

async function serveStatic(req, res, url) {
  if (url.pathname === '/') {
    send(res, 200, publicPageHtml(), { 'Content-Type': 'text/html; charset=utf-8' });
    return true;
  }
  if (url.pathname === '/admin') {
    send(res, 200, adminPageHtml(), { 'Content-Type': 'text/html; charset=utf-8' });
    return true;
  }
  if (url.pathname === '/styles.css') {
    send(res, 200, stylesCss(), { 'Content-Type': 'text/css; charset=utf-8' });
    return true;
  }
  if (url.pathname === '/app.js') {
    send(res, 200, appJs(), { 'Content-Type': 'application/javascript; charset=utf-8' });
    return true;
  }
  if (url.pathname === '/admin.js') {
    send(res, 200, adminJs(), { 'Content-Type': 'application/javascript; charset=utf-8' });
    return true;
  }
  if (url.pathname.startsWith('/uploads/')) {
    const filePath = path.join(UPLOADS_DIR, path.basename(url.pathname));
    try {
      await fsp.access(filePath);
      const stream = fs.createReadStream(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const contentType = ext === '.jpg' || ext === '.jpeg'
        ? 'image/jpeg'
        : ext === '.png'
          ? 'image/png'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.gif'
              ? 'image/gif'
              : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      stream.on('error', () => {
        if (!res.headersSent) {
          send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
        } else {
          res.destroy();
        }
      });
      stream.pipe(res);
    } catch {
      send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    return true;
  }
  return false;
}

async function main() {
  await ensureStorage();
  httpServer = http.createServer(async (req, res) => {
    cleanupSessions();
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (await handleApi(req, res, url)) return;
      if (await serveStatic(req, res, url)) return;
      send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    } catch (error) {
      console.error(error);
      sendJson(res, 500, { error: 'internal_error' });
    }
  });

  httpServer.listen(PORT, () => {
    console.log(`Couple site running on port ${PORT}`);
  });
}

function shutdown(signal) {
  if (!httpServer) {
    process.exit(0);
    return;
  }
  httpServer.close(() => {
    console.log(`Received ${signal}, shutting down cleanly`);
    process.exit(0);
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
