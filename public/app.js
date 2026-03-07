// Debounce helper
function debounce(func, ms) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), ms);
  };
}

// Show toast notification
function showToast(msg, type='info') {
  const el = document.createElement('div');
  el.style.cssText = `position:fixed;top:16px;right:16px;background:${type==='error'?'#dc2626':'#10b981'};color:white;padding:12px 20px;border-radius:8px;z-index:10000;animation:slideUp 0.3s ease;font-size:14px`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// Loading spinner
function setLoading(el, loading) {
  if (loading) {
    el.style.opacity = '0.6';
    el.style.pointerEvents = 'none';
  } else {
    el.style.opacity = '1';
    el.style.pointerEvents = 'auto';
  }
}

// Theme toggle
function initThemeToggle() {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  
  const isDark = localStorage.getItem('theme') !== 'light';
  if (!isDark) document.body.classList.add('light-mode');
  updateThemeButton();
  
  btn.addEventListener('click', toggleTheme);
}

function toggleTheme() {
  const btn = document.getElementById('themeToggle');
  const isDark = !document.body.classList.contains('light-mode');
  
  document.body.classList.toggle('light-mode');
  localStorage.setItem('theme', isDark ? 'light' : 'dark');
  updateThemeButton();
}

function updateThemeButton() {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  const isDark = !document.body.classList.contains('light-mode');
  btn.textContent = isDark ? 'Light' : 'Dark';
  setButtonIconWithText(btn, isDark ? 'light' : 'dark');
}

// Search functionality
async function handleSearch(query) {
  const resultsBox = document.getElementById('searchResults');
  if (!resultsBox) return;
  
  if (!query || query.length < 2) {
    resultsBox.classList.remove('active');
    return;
  }
  
  const { results, error } = await api(`/api/search?q=${encodeURIComponent(query)}`);
  if (error || !results) return;
  
  if (results.length === 0) {
    resultsBox.innerHTML = '<div class="search-result" style="cursor:default">No results found</div>';
  } else {
    resultsBox.innerHTML = '';
    results.forEach(r => {
      const el = document.createElement('div');
      el.className = 'search-result';
      el.innerHTML = `<img src="${r.profile_picture || 'data:image/svg+xml,<svg></svg>'}" loading="lazy" />
        <div class="search-result-text">
          <div class="search-result-name">${r.type === 'user' ? (r.name || r.username) : (r.name || r.username)}</div>
          <div class="search-result-type">${r.type === 'user' ? '@' + r.username : 'Post'}</div>
        </div>`;
      
      el.addEventListener('click', () => {
        if (r.type === 'user') {
          location.href = `/user-profile.html?id=${encodeURIComponent(r.id)}`;
        } else {
          // Show post in feed
          showToast('Showing post by ' + (r.name || r.username));
        }
        document.getElementById('searchInput').value = '';
        resultsBox.classList.remove('active');
      });
      
      resultsBox.appendChild(el);
    });
  }
  
  resultsBox.classList.add('active');
}

const debouncedSearch = debounce(handleSearch, 300);
let selectedPostImageDataUrl = null;
let selectedStoryImageDataUrl = null;
let selectedClanPostImageDataUrl = null;
let selectedGroupId = null;
let selectedGroupRole = null;
let cachedMe = null;
let storyGroups = [];
let activeStoryGroupIndex = -1;
let activeStoryIndex = 0;
let storyAutoAdvanceTimeout = null;
let storyProgressInterval = null;
let postMode = null;
let currentSavedListFilter = 'General';
let clanLoungeInterval = null;
const STORY_VIEW_DURATION_MS = 30000;

async function api(path, method='GET', data) {
  const opts = { method, headers: {}, cache: 'no-store' };
  if (data) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(data); }
  try {
    const res = await fetch(path, opts);
    const raw = await res.text();
    let json = null;
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch (parseErr) {
      return { error: `Invalid server response (HTTP ${res.status})`, raw };
    }
    if (!res.ok && !json.error) json.error = `HTTP ${res.status}`;
    return json;
  } catch (e) {
    console.error('API error:', e);
    return { error: e.message };
  }
}

function toTimestamp(value) {
  const normalizeEpoch = (n) => {
    if (!Number.isFinite(n)) return null;
    // Treat 10-digit unix time as seconds.
    if (n > 0 && n < 1e12) return n * 1000;
    return n;
  };
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return normalizeEpoch(value);
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      return normalizeEpoch(n);
    }
    const parsed = Date.parse(s);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (value instanceof Date) {
    const n = value.getTime();
    return Number.isNaN(n) ? null : n;
  }
  return null;
}

function formatDateTime(value, fallback = 'Invalid date') {
  const ts = toTimestamp(value);
  if (ts === null) return fallback;
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? fallback : d.toLocaleString();
}

function formatGenderLabel(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw === 'prefer_not_to_say') return 'Prefer not to say';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function formatReminder(reminderAt) {
  if (!reminderAt) return '';
  const reminderDate = new Date(Number(reminderAt));
  if (Number.isNaN(reminderDate.getTime())) return '';
  const now = Date.now();
  const status = Number(reminderAt) < now ? 'due' : 'upcoming';
  return `${status.toUpperCase()} - ${reminderDate.toLocaleString()}`;
}

function parseQuizOptions(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((v) => String(v || '').trim()).filter(Boolean);
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((v) => String(v || '').trim()).filter(Boolean) : [];
  } catch (e) {
    return [];
  }
}

function isPublicHomePage() {
  return window.location.pathname === '/' || window.location.pathname.endsWith('/index.html');
}

async function resolveHomePath() {
  if (cachedMe && cachedMe.id) return '/dashboard';
  const meRes = await api('/api/me');
  return meRes && meRes.user ? '/dashboard' : '/';
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getDefaultAvatarDataUri(gender) {
  const g = String(gender || '').toLowerCase();
  const bg = g === 'female' ? '%23f472b6' : (g === 'male' ? '%233b82f6' : '%2306b6d4');
  const label = g === 'female' ? 'F' : (g === 'male' ? 'M' : 'U');
  return `data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='128' height='128'><rect width='100%25' height='100%25' fill='${bg}'/><text x='50%25' y='54%25' font-size='56' text-anchor='middle' fill='white' font-family='Arial' dominant-baseline='middle'>${label}</text></svg>`;
}

function getProfilePictureUrl(userLike) {
  if (userLike && userLike.profile_picture) return userLike.profile_picture;
  return getDefaultAvatarDataUri(userLike ? userLike.gender : '');
}

function getActionIconName(actionKey) {
  const iconMap = {
    like: 'lucide:heart',
    comment: 'lucide:message-circle',
    share: 'lucide:share-2',
    close: 'lucide:x',
    delete: 'lucide:trash-2',
    attach: 'lucide:paperclip',
    verify: 'lucide:badge-check',
    block: 'lucide:user-x',
    unblock: 'lucide:user-check',
    save: 'lucide:bookmark',
    send: 'lucide:send',
    chat: 'lucide:message-square',
    home: 'lucide:house',
    logout: 'lucide:log-out',
    search: 'lucide:search',
    settings: 'lucide:settings',
    admin: 'lucide:shield',
    add: 'lucide:plus',
    post: 'lucide:square-pen',
    clan: 'lucide:users',
    approve: 'lucide:check',
    reject: 'lucide:x',
    connect: 'lucide:user-plus',
    follow: 'lucide:user-plus',
    unfollow: 'lucide:user-minus',
    open: 'lucide:external-link',
    manage: 'lucide:sliders-horizontal',
    join: 'lucide:door-open',
    minimize: 'lucide:minus',
    dark: 'lucide:moon',
    light: 'lucide:sun',
    list: 'lucide:list'
  };
  return iconMap[actionKey] || '';
}

function getActionKeyFromLabel(label) {
  const normalized = String(label || '').trim().toLowerCase();
  if (!normalized) return '';
  if (normalized.startsWith('like') || normalized.startsWith('unlike')) return 'like';
  if (normalized.startsWith('comment')) return 'comment';
  if (normalized.startsWith('share')) return 'share';
  if (normalized.startsWith('close')) return 'close';
  if (normalized.startsWith('delete')) return 'delete';
  if (normalized.startsWith('attach')) return 'attach';
  if (normalized.startsWith('verify')) return 'verify';
  if (normalized.startsWith('unblock')) return 'unblock';
  if (normalized.startsWith('block')) return 'block';
  if (normalized.startsWith('save') || normalized.startsWith('saved')) return 'save';
  if (normalized.startsWith('send')) return 'send';
  if (normalized.startsWith('chat')) return 'chat';
  if (normalized.startsWith('home')) return 'home';
  if (normalized.startsWith('logout')) return 'logout';
  if (normalized.startsWith('search')) return 'search';
  if (normalized.startsWith('settings')) return 'settings';
  if (normalized.startsWith('open admin') || normalized.startsWith('admin')) return 'admin';
  if (normalized.startsWith('add')) return 'add';
  if (normalized.startsWith('post')) return 'post';
  if (normalized.includes('clan')) return 'clan';
  if (normalized.startsWith('approve')) return 'approve';
  if (normalized.startsWith('reject')) return 'reject';
  if (normalized.startsWith('connect')) return 'connect';
  if (normalized.startsWith('follow')) return 'follow';
  if (normalized.startsWith('unfollow')) return 'unfollow';
  if (normalized.startsWith('open')) return 'open';
  if (normalized.startsWith('manage')) return 'manage';
  if (normalized.startsWith('join')) return 'join';
  if (normalized.startsWith('minimize')) return 'minimize';
  if (normalized.startsWith('dark')) return 'dark';
  if (normalized.startsWith('light')) return 'light';
  if (normalized.includes('list')) return 'list';
  return '';
}

function extractCountFromLabel(label) {
  const match = String(label || '').match(/\((\d+)\)\s*$/);
  if (!match) return null;
  return Number(match[1]);
}

function setActionButtonLabel(btn, label, forcedActionKey = '') {
  if (!btn) return;
  const actionKey = forcedActionKey || getActionKeyFromLabel(label);
  const iconName = getActionIconName(actionKey);
  if (!iconName) {
    btn.textContent = label;
    return;
  }
  const count = extractCountFromLabel(label);
  const countMarkup = Number.isFinite(count) ? `<span class="btn-count">${count}</span>` : '';
  btn.innerHTML = `<span class="btn-iconify iconify" data-icon="${iconName}" aria-hidden="true"></span>${countMarkup}`;
  btn.classList.add('icon-only-btn');
  btn.setAttribute('aria-label', String(label || actionKey));
  btn.setAttribute('title', String(label || actionKey));
}

function setButtonIconWithText(btn, iconKey) {
  if (!btn) return;
  const iconName = getActionIconName(iconKey);
  if (!iconName) return;
  if (btn.querySelector('.btn-iconify')) return;
  const label = btn.textContent ? btn.textContent.trim() : '';
  if (!label) return;
  btn.innerHTML = `<span class="btn-iconify iconify" data-icon="${iconName}" aria-hidden="true"></span><span class="btn-label">${escapeHtml(label)}</span>`;
}

function applyIconifyAudit() {
  document.querySelectorAll('button.btn, a.btn').forEach((el) => {
    if (el.classList.contains('icon-only-btn')) return;
    const label = (el.textContent || '').trim();
    if (!label) return;
    const key = getActionKeyFromLabel(label);
    if (!key) return;
    setButtonIconWithText(el, key);
  });
}

function createActionButton(label, onClick, className = 'btn secondary tiny-btn') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  setActionButtonLabel(btn, label);
  if (typeof onClick === 'function') btn.addEventListener('click', onClick);
  return btn;
}

function updateFileNameChip(inputEl) {
  if (!inputEl || !inputEl.id) return;
  const nameEl = document.getElementById(`${inputEl.id}Name`);
  if (!nameEl) return;
  const fileName = inputEl.files && inputEl.files[0] ? inputEl.files[0].name : 'No file selected';
  nameEl.textContent = fileName;
}

function initFileUploadControls() {
  document.querySelectorAll('.file-upload-trigger').forEach((btn) => {
    const targetId = btn.getAttribute('data-file-trigger');
    const inputEl = targetId ? document.getElementById(targetId) : null;
    if (!inputEl) return;
    setActionButtonLabel(btn, 'Attach', 'attach');
    btn.addEventListener('click', () => inputEl.click());
    inputEl.addEventListener('change', () => updateFileNameChip(inputEl));
    updateFileNameChip(inputEl);
  });
}

function initStaticActionIcons() {
  const byId = [
    ['closeStoryViewerBtn', 'Close', 'close'],
    ['storyShareBtn', 'Share', 'share'],
    ['storyDeleteBtn', 'Delete', 'delete'],
    ['chatCloseBtn', 'Close', 'close']
  ];
  byId.forEach(([id, label, key]) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    setActionButtonLabel(btn, label, key);
  });
}

function showQuizResultPopup(isCorrect, correctText) {
  const popup = document.createElement('div');
  popup.className = `quiz-popup ${isCorrect ? 'quiz-popup-correct' : 'quiz-popup-wrong'}`;
  popup.innerHTML = isCorrect
    ? `<div class="quiz-popup-title">Celebration!</div><div>You picked the correct answer.</div>`
    : `<div class="quiz-popup-title">Better luck next time</div><div>Correct answer: ${escapeHtml(correctText)}</div>`;
  document.body.appendChild(popup);
  setTimeout(() => popup.classList.add('show'), 10);
  setTimeout(() => {
    popup.classList.remove('show');
    setTimeout(() => popup.remove(), 220);
  }, 1800);
}

function renderQuizBlock(post) {
  const quizQuestion = String(post.quiz_question || '').trim();
  const quizOptions = parseQuizOptions(post.quiz_options);
  if (!quizQuestion || quizOptions.length < 2) return null;

  const correctIndex = Number(post.quiz_correct_index);
  const hasCorrectAnswer = !Number.isNaN(correctIndex) && correctIndex >= 0 && correctIndex < quizOptions.length;
  if (!hasCorrectAnswer) return null;
  if (Number(post.my_quiz_attempted) > 0) return null;

  const quizWrap = document.createElement('div');
  quizWrap.className = 'quiz-box';
  const qEl = document.createElement('div');
  qEl.className = 'quiz-question';
  qEl.textContent = `Quiz: ${quizQuestion}`;
  quizWrap.appendChild(qEl);

  const optionsWrap = document.createElement('div');
  optionsWrap.className = 'quiz-options interactive';
  const name = `quiz-${post.id}`;
  quizOptions.forEach((opt, idx) => {
    const optionId = `${name}-opt-${idx}`;
    const row = document.createElement('label');
    row.className = 'quiz-option-row';
    row.setAttribute('for', optionId);

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.id = optionId;
    input.value = String(idx);

    const text = document.createElement('span');
    text.textContent = opt;
    row.appendChild(input);
    row.appendChild(text);
    row.addEventListener('click', async () => {
      const alreadyAnswered = quizWrap.dataset.answered === '1';
      if (alreadyAnswered) return;
      input.checked = true;
      const response = await api(`/api/post/${post.id}/quiz-attempt`, 'POST', { selectedIndex: idx });
      if (response.error) {
        showToast(response.error, 'error');
        return;
      }
      const isCorrect = Boolean(response.isCorrect);
      feedback.textContent = isCorrect ? 'Correct answer.' : `Incorrect. Correct answer: ${response.correctAnswer || quizOptions[correctIndex]}`;
      feedback.classList.remove('quiz-correct', 'quiz-incorrect');
      feedback.classList.add(isCorrect ? 'quiz-correct' : 'quiz-incorrect');
      quizWrap.dataset.answered = '1';
      optionsWrap.querySelectorAll('input').forEach((optionInput) => {
        optionInput.disabled = true;
      });
      showQuizResultPopup(isCorrect, response.correctAnswer || quizOptions[correctIndex]);
    });
    optionsWrap.appendChild(row);
  });
  quizWrap.appendChild(optionsWrap);
  const feedback = document.createElement('div');
  feedback.className = 'quiz-answer';
  feedback.textContent = '';
  quizWrap.appendChild(feedback);
  return quizWrap;
}

function setPostMode(nextMode) {
  postMode = nextMode;
  const modeButtons = [
    { id: 'postModeReminder', mode: 'reminder' },
    { id: 'postModeQuiz', mode: 'quiz' }
  ];
  modeButtons.forEach((item) => {
    const btn = document.getElementById(item.id);
    if (!btn) return;
    btn.classList.toggle('active', item.mode === postMode);
  });
  const reminderFields = document.getElementById('reminderModeFields');
  const quizFields = document.getElementById('quizModeFields');
  if (reminderFields) reminderFields.classList.toggle('hidden', postMode !== 'reminder');
  if (quizFields) quizFields.classList.toggle('hidden', postMode !== 'quiz');
  if (postMode !== 'reminder') {
    const reminderAtInput = document.getElementById('postReminderAt');
    const reminderNoteInput = document.getElementById('postReminderNote');
    if (reminderAtInput) reminderAtInput.value = '';
    if (reminderNoteInput) reminderNoteInput.value = '';
  }
  if (postMode !== 'quiz') {
    const quizQuestionInput = document.getElementById('quizQuestion');
    const quizCorrectIndexInput = document.getElementById('quizCorrectIndex');
    const quizOptionEls = Array.from(document.querySelectorAll('.quiz-option'));
    if (quizQuestionInput) quizQuestionInput.value = '';
    if (quizCorrectIndexInput) quizCorrectIndexInput.value = '';
    quizOptionEls.forEach((el) => { el.value = ''; });
  }
}

function initPostModeSwitcher() {
  const reminderBtn = document.getElementById('postModeReminder');
  const quizBtn = document.getElementById('postModeQuiz');
  if (!reminderBtn || !quizBtn) return;
  reminderBtn.addEventListener('click', () => setPostMode(postMode === 'reminder' ? null : 'reminder'));
  quizBtn.addEventListener('click', () => setPostMode(postMode === 'quiz' ? null : 'quiz'));
  setPostMode(null);
}

async function toggleLike(postId, btn) {
  setLoading(btn, true);
  const res = await api(`/api/post/${postId}/like`, 'POST');
  setLoading(btn, false);
  if (res && res.success) {
    setActionButtonLabel(btn, `${res.liked ? 'Unlike' : 'Like'} (${res.count || 0})`, 'like');
  } else {
    showToast(res.error || 'Unable to like post', 'error');
  }
}

async function toggleSave(postId, btn) {
  const isCurrentlySaved = String(btn && btn.textContent ? btn.textContent : '').trim().toLowerCase().startsWith('saved');
  let listName = 'General';
  if (!isCurrentlySaved) {
    const picked = await promptSaveListSelection();
    if (!picked) return;
    listName = picked;
  }
  setLoading(btn, true);
  const res = await api(`/api/post/${postId}/save`, 'POST', { listName });
  setLoading(btn, false);
  if (res && res.success) {
    btn.textContent = `${res.saved ? 'Saved' : 'Save'} (${res.count || 0})`;
    if (res.saved && res.listName) showToast(`Saved to "${res.listName}"`);
    if (document.getElementById('savedPostsBox')) loadSavedPosts();
  } else {
    showToast(res.error || 'Unable to save post', 'error');
  }
}

async function promptSaveListSelection() {
  const res = await api('/api/saved-lists');
  const lists = Array.isArray(res && res.lists ? res.lists : []) ? res.lists : [];
  const names = lists.map((l) => String(l.name || '').trim()).filter(Boolean);
  if (!names.includes('General')) names.unshift('General');
  const hint = names.length ? `Existing: ${names.join(', ')}` : 'Default list: General';
  const input = window.prompt(`Save to which list?\n${hint}\nYou can type a new list name too.`, currentSavedListFilter || 'General');
  if (input === null) return null;
  const chosen = input.trim();
  if (!chosen) return 'General';
  currentSavedListFilter = chosen;
  return chosen;
}

async function sharePost(postId, btn) {
  setLoading(btn, true);
  const res = await api(`/api/post/${postId}/share`, 'POST', {});
  setLoading(btn, false);
  if (res && res.success) {
    setActionButtonLabel(btn, `Shared (${res.count || 0})`, 'share');
    showToast(`Shared to ${res.sharedTo || 0} connection(s)`);
  } else {
    showToast(res.error || 'Unable to share post', 'error');
  }
}

async function deletePost(postId, postEl, btn) {
  const ok = window.confirm('Delete this post and all related activity?');
  if (!ok) return;
  setLoading(btn, true);
  const res = await api(`/api/post/${postId}`, 'DELETE');
  setLoading(btn, false);
  if (res && res.success) {
    if (postEl) postEl.remove();
    showToast('Post deleted');
  } else {
    showToast(res.error || 'Unable to delete post', 'error');
  }
}

async function deleteComment(postId, commentId, mountEl, meId, postOwnerId, btn) {
  const ok = window.confirm('Delete this comment?');
  if (!ok) return;
  setLoading(btn, true);
  const res = await api(`/api/post/${postId}/comment/${commentId}`, 'DELETE');
  setLoading(btn, false);
  if (res && res.success) {
    await loadComments(postId, mountEl, meId, postOwnerId);
    showToast('Comment deleted');
  } else {
    showToast(res.error || 'Unable to delete comment', 'error');
  }
}

async function loadComments(postId, mountEl, meId = null, postOwnerId = null) {
  mountEl.innerHTML = '<div class="muted">Loading comments...</div>';
  const res = await api(`/api/post/${postId}/comments`);
  if (res.error) {
    mountEl.innerHTML = '<div class="muted">Unable to load comments</div>';
    return;
  }
  if (!res.comments || !res.comments.length) {
    mountEl.innerHTML = '<div class="muted">No comments yet</div>';
    return;
  }
  mountEl.innerHTML = '';
  const comments = Array.isArray(res.comments) ? res.comments : [];
  const byParent = new Map();
  comments.forEach((c) => {
    const parentKey = c.parent_comment_id ? Number(c.parent_comment_id) : 0;
    if (!byParent.has(parentKey)) byParent.set(parentKey, []);
    byParent.get(parentKey).push(c);
  });

  function renderBranch(parentId, depth = 0) {
    const children = byParent.get(parentId) || [];
    children.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'comment-item';
      row.style.marginLeft = `${Math.min(depth, 3) * 18}px`;
      const mentionPrefix = c.mention_username ? `<span class="mention-tag">@${escapeHtml(c.mention_username)}</span> ` : '';
      row.innerHTML = `<div class="meta">${escapeHtml(c.name || c.username)} - ${formatDateTime(c.created_at)}</div><div>${mentionPrefix}${escapeHtml(c.content)}</div>`;

      const actions = document.createElement('div');
      actions.className = 'post-actions';
      if (meId) {
        const replyBtn = createActionButton('Reply', () => {}, 'btn tiny-btn');
        replyBtn.addEventListener('click', () => {
          if (row.querySelector('.reply-composer')) return;
          const composer = document.createElement('div');
          composer.className = 'comment-composer reply-composer';
          const input = document.createElement('input');
          input.type = 'text';
          input.maxLength = 700;
          input.placeholder = `Reply to @${c.username || c.name || 'user'}...`;
          const sendBtn = createActionButton('Reply', () => {}, 'btn primary tiny-btn');
          const closeBtn = createActionButton('Cancel', () => composer.remove(), 'btn secondary tiny-btn');
          sendBtn.addEventListener('click', () => postComment(postId, input, mountEl, meId, postOwnerId, {
            parentCommentId: c.id,
            mentionUserId: c.user_id
          }));
          composer.appendChild(input);
          composer.appendChild(sendBtn);
          composer.appendChild(closeBtn);
          row.appendChild(composer);
          input.focus();
        });
        actions.appendChild(replyBtn);
      }
      const canDelete = meId && (Number(c.user_id) === Number(meId) || Number(postOwnerId) === Number(meId));
      if (canDelete) {
        const delBtn = createActionButton('Delete', () => {}, 'btn secondary tiny-btn');
        delBtn.addEventListener('click', () => deleteComment(postId, c.id, mountEl, meId, postOwnerId, delBtn));
        actions.appendChild(delBtn);
      }
      if (actions.children.length) row.appendChild(actions);
      mountEl.appendChild(row);
      renderBranch(Number(c.id), depth + 1);
    });
  }

  renderBranch(0, 0);
}

async function postComment(postId, inputEl, commentsMount, meId = null, postOwnerId = null, reply = null) {
  const content = inputEl.value.trim();
  if (!content) return;
  const payload = { content };
  if (reply && reply.parentCommentId) payload.parentCommentId = Number(reply.parentCommentId);
  if (reply && reply.mentionUserId) payload.mentionUserId = Number(reply.mentionUserId);
  const res = await api(`/api/post/${postId}/comment`, 'POST', payload);
  if (res && res.success) {
    inputEl.value = '';
    loadComments(postId, commentsMount, meId, postOwnerId);
    showToast(reply ? 'Reply added' : 'Comment added');
  } else {
    showToast(res.error || 'Unable to add comment', 'error');
  }
}

// load feed
async function loadFeed() {
  const box = document.getElementById('feed');
  if (!box) return;
  box.innerHTML = '<div class="muted center" style="padding:40px">Loading posts...</div>';
  const meRes = await api('/api/me');
  const me = meRes.user || null;
  cachedMe = me;
  window.__me = me;
  if (isPublicHomePage() && !me) {
    const feedCard = box.closest('.card');
    if (feedCard) feedCard.classList.add('hidden');
    return;
  }
  const { posts, error } = await api('/api/feed');
  if (error) { 
    if (isPublicHomePage()) {
      const feedCard = box.closest('.card');
      if (feedCard) feedCard.classList.add('hidden');
      return;
    }
    box.innerHTML = '<div class="muted" style="padding:20px;text-align:center">Unable to load posts</div>'; 
    return;
  }
  if (!posts || posts.length===0) { 
    box.innerHTML = '<div class="muted" style="padding:40px;text-align:center">No posts yet. Be the first to share!</div>'; 
    return;
  }
  box.innerHTML = '';
  const meId = me ? me.id : null;
  posts.forEach(p => {
    const el = document.createElement('div'); el.className='post';
    const head = document.createElement('div');
    head.className = 'post-head';
    const pic = document.createElement('img');
    pic.className = 'post-avatar';
    pic.src = p.profile_picture || 'data:image/svg+xml,<svg></svg>';
    pic.loading='lazy';
    pic.onerror=()=>{pic.style.display='none'};
    const meta = document.createElement('div'); meta.className='meta';
    const date = formatDateTime(p.created_at);
    meta.textContent = `${p.name || p.username} - ${date}`;
    head.appendChild(pic);
    head.appendChild(meta);
    el.appendChild(head);

    if (p.content) {
      const content = document.createElement('div');
      content.textContent = p.content;
      el.appendChild(content);
    }

    if (p.image) {
      const postImage = document.createElement('img');
      postImage.className = 'post-image';
      postImage.src = p.image;
      postImage.alt = 'Post attachment';
      postImage.loading = 'lazy';
      el.appendChild(postImage);
    }

    if (p.reminder_at || p.reminder_note) {
      const reminder = document.createElement('div');
      reminder.className = 'reminder-chip';
      const reminderStatus = formatReminder(p.reminder_at);
      reminder.innerHTML = `<strong>Reminder</strong>${reminderStatus ? `: ${escapeHtml(reminderStatus)}` : ''}${p.reminder_note ? ` - ${escapeHtml(p.reminder_note)}` : ''}`;
      el.appendChild(reminder);
    }

    const quizBlock = renderQuizBlock(p);
    if (quizBlock) el.appendChild(quizBlock);

    const actionsRow = document.createElement('div');
    actionsRow.className = 'post-actions';
    if (meId) {
      const likeBtn = createActionButton(`${Number(p.my_liked) ? 'Unlike' : 'Like'} (${p.like_count || 0})`, () => {});
      likeBtn.addEventListener('click', () => toggleLike(p.id, likeBtn));
      const saveBtn = createActionButton(`${Number(p.my_saved) ? 'Saved' : 'Save'} (${p.save_count || 0})`, () => {});
      saveBtn.addEventListener('click', () => toggleSave(p.id, saveBtn));
      const shareBtn = createActionButton(`Share (${p.share_count || 0})`, () => {});
      shareBtn.addEventListener('click', () => sharePost(p.id, shareBtn));
      const commentsToggleBtn = createActionButton(`Comments (${p.comment_count || 0})`, async () => {
        commentsWrap.classList.toggle('hidden');
        if (!commentsWrap.classList.contains('hidden')) await loadComments(p.id, commentsList, meId, p.user_id);
      });
      actionsRow.appendChild(likeBtn);
      actionsRow.appendChild(commentsToggleBtn);
      actionsRow.appendChild(saveBtn);
      actionsRow.appendChild(shareBtn);
      if (Number(p.user_id) === Number(meId)) {
        const deleteBtn = createActionButton('Delete', () => {}, 'btn secondary tiny-btn');
        deleteBtn.addEventListener('click', () => deletePost(p.id, el, deleteBtn));
        actionsRow.appendChild(deleteBtn);
      }
    }

    // show connect button if not self
    if (meId && p.user_id && Number(p.user_id) !== Number(meId)) {
      const connect = createActionButton('Connect', null, 'btn tiny-btn');
      connect.addEventListener('click', async () => {
        setLoading(connect, true);
        const r = await api('/api/connect/request','POST',{to:p.user_id});
        setLoading(connect, false);
        if (r && r.success) {
          connect.textContent='Requested';
          connect.disabled=true;
          showToast('Connection request sent!');
        } else {
          showToast(r.error||'Unable to send request', 'error');
        }
      });
      actionsRow.appendChild(connect);
    }
    if (actionsRow.children.length) el.appendChild(actionsRow);

    const commentsWrap = document.createElement('div');
    commentsWrap.className = 'comments-wrap hidden';
    const commentsList = document.createElement('div');
    commentsList.className = 'comments-list';
    commentsWrap.appendChild(commentsList);
    if (meId) {
      const composer = document.createElement('div');
      composer.className = 'comment-composer';
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 700;
      input.placeholder = 'Write a comment...';
      const sendBtn = createActionButton('Add', () => {}, 'btn primary tiny-btn');
      sendBtn.addEventListener('click', () => postComment(p.id, input, commentsList, meId, p.user_id));
      input.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter') {
          evt.preventDefault();
          postComment(p.id, input, commentsList, meId, p.user_id);
        }
      });
      composer.appendChild(input);
      composer.appendChild(sendBtn);
      commentsWrap.appendChild(composer);
    }
    el.appendChild(commentsWrap);
    box.appendChild(el);
  });
}

async function loadAdminUsers() {
  const title = document.getElementById('adminUsersTitle');
  const box = document.getElementById('adminUsers');
  if (!box) return;
  const qEl = document.getElementById('adminUsersSearch');
  const q = qEl ? qEl.value.trim() : '';
  const res = await api(`/api/admin/users?q=${encodeURIComponent(q)}`);
  if (res.error) {
    box.innerHTML = '<div class="muted">Admin access required.</div>';
    return;
  }
  const users = Array.isArray(res.users) ? res.users : [];
  const userById = new Map(users.map((u) => [Number(u.id), u]));
  if (title) title.textContent = `Registered Users (${res.totalUsers || users.length || 0})`;
  if (!users.length) {
    box.innerHTML = '<div class="muted">No registered users found.</div>';
    return;
  }
  const rows = users.map((u) => {
    const email = u.email || (String(u.username || '').includes('@') ? u.username : 'Not provided');
    const name = escapeHtml(u.name || u.username || 'Unknown');
    const lastLogin = u.last_login ? formatDateTime(u.last_login, 'Never') : 'Never';
    const xp = Number(u.xp) || 0;
    const totalConnections = Number(u.total_connections) || 0;
    return `<tr data-user-id="${u.id}">
      <td>${name}</td>
      <td>${escapeHtml(email)}</td>
      <td>${Number(u.email_verified) ? 'Verified' : 'Not Verified'}</td>
      <td>
        <select class="admin-role-select">
          <option value="user" ${u.role === 'user' ? 'selected' : ''}>user</option>
          <option value="moderator" ${u.role === 'moderator' ? 'selected' : ''}>moderator</option>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin</option>
        </select>
      </td>
      <td>${xp}</td>
      <td>${escapeHtml(lastLogin)}</td>
      <td>${totalConnections}</td>
      <td>${Number(u.email_verified) ? '<span class="muted">Done</span>' : '<button class="btn tiny-btn admin-verify-btn" type="button"></button>'}</td>
      <td><button class="btn secondary tiny-btn admin-block-btn" data-blocked="${Number(u.account_blocked) ? 1 : 0}" type="button"></button></td>
      <td><button class="btn secondary tiny-btn admin-delete-btn" type="button"></button></td>
    </tr>`;
  }).join('');
  box.innerHTML = `<div class="admin-users-table-wrap">
    <table class="admin-users-table">
      <thead>
        <tr>
          <th>User</th>
          <th>Email</th>
          <th>Verification</th>
          <th>Role</th>
          <th>XP</th>
          <th>Last Login</th>
          <th>Total Connections</th>
          <th>Approval</th>
          <th>Block</th>
          <th>Delete</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
  box.querySelectorAll('tr[data-user-id]').forEach((row) => {
    const select = row.querySelector('.admin-role-select');
    if (select) {
      select.addEventListener('change', async () => {
        const userId = Number(row.getAttribute('data-user-id'));
        const role = select.value;
        const res = await api(`/api/admin/users/${userId}/role`, 'POST', { role });
        if (res && res.success) showToast('Role updated');
        else showToast(res.error || 'Unable to update role', 'error');
      });
    }
    const verifyBtn = row.querySelector('.admin-verify-btn');
    if (verifyBtn) {
      setActionButtonLabel(verifyBtn, 'Verify', 'verify');
      verifyBtn.addEventListener('click', async () => {
        verifyBtn.disabled = true;
        const userId = Number(row.getAttribute('data-user-id'));
        const verifyRes = await api(`/api/admin/users/${userId}/verify-email`, 'POST', {});
        if (verifyRes && verifyRes.success) {
          showToast('User verified');
          loadAdminUsers();
        } else {
          verifyBtn.disabled = false;
          showToast(verifyRes.error || 'Unable to verify user', 'error');
        }
      });
    }
    const blockBtn = row.querySelector('.admin-block-btn');
    if (blockBtn) {
      const isBlockedOnRender = blockBtn.getAttribute('data-blocked') === '1';
      setActionButtonLabel(blockBtn, isBlockedOnRender ? 'Unblock' : 'Block', isBlockedOnRender ? 'unblock' : 'block');
      blockBtn.addEventListener('click', async () => {
        blockBtn.disabled = true;
        const userId = Number(row.getAttribute('data-user-id'));
        const currentlyBlocked = blockBtn.getAttribute('data-blocked') === '1';
        const shouldBlock = !currentlyBlocked;
        const blockRes = await api(`/api/admin/users/${userId}/block`, 'POST', { blocked: shouldBlock });
        if (blockRes && blockRes.success) {
          showToast(shouldBlock ? 'User blocked' : 'User unblocked');
          loadAdminUsers();
        } else {
          blockBtn.disabled = false;
          showToast(blockRes.error || 'Unable to update block status', 'error');
        }
      });
    }
    const deleteBtn = row.querySelector('.admin-delete-btn');
    if (deleteBtn) {
      setActionButtonLabel(deleteBtn, 'Delete', 'delete');
      deleteBtn.addEventListener('click', async () => {
        const userId = Number(row.getAttribute('data-user-id'));
        const target = userById.get(userId) || {};
        const label = target.username || target.email || `ID ${userId}`;
        const confirmed = window.confirm(`Delete user "${label}" permanently? This removes profile and related data.`);
        if (!confirmed) return;
        deleteBtn.disabled = true;
        const deleteRes = await api(`/api/admin/users/${userId}`, 'DELETE');
        if (deleteRes && deleteRes.success) {
          showToast('User deleted');
          loadAdminUsers();
        } else {
          deleteBtn.disabled = false;
          showToast(deleteRes.error || 'Unable to delete user', 'error');
        }
      });
    }
  });
}

async function loadAdminReports() {
  const box = document.getElementById('adminReports');
  if (!box) return;
  const qEl = document.getElementById('adminReportsSearch');
  const q = qEl ? qEl.value.trim() : '';
  const statusEl = document.getElementById('adminReportsStatus');
  const status = statusEl ? statusEl.value.trim() : '';
  const res = await api(`/api/admin/reports/all?q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}`);
  if (res.error) {
    box.innerHTML = '<div class="muted">Unable to load reports.</div>';
    return;
  }
  const reports = Array.isArray(res.reports) ? res.reports : [];
  if (!reports.length) {
    box.innerHTML = '<div class="muted">No reports found.</div>';
    return;
  }
  const rows = reports.map((r) => `<tr data-report-id="${r.id}">
      <td>${escapeHtml(r.report_type || 'user')}</td>
      <td>${r.id}</td>
      <td>${escapeHtml(r.reporter_username || String(r.reporter_id || ''))}</td>
      <td>${escapeHtml(r.target_name || String(r.target_id || r.clan_id || ''))}</td>
      <td>${escapeHtml(r.category || '')}</td>
      <td>${escapeHtml(r.details || '')}</td>
      <td>${formatDateTime(r.created_at)}</td>
      <td>${escapeHtml(r.status || 'open')}</td>
    </tr>`).join('');
  box.innerHTML = `<div class="admin-users-table-wrap">
    <table class="admin-users-table">
      <thead>
        <tr>
          <th>Type</th>
          <th>ID</th>
          <th>Reporter</th>
          <th>Target</th>
          <th>Category</th>
          <th>Details</th>
          <th>Created</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

async function loadAdminClans() {
  const box = document.getElementById('adminClans');
  if (!box) return;
  const qEl = document.getElementById('adminClansSearch');
  const q = qEl ? qEl.value.trim() : '';
  const sortEl = document.getElementById('adminClansSort');
  const sort = sortEl ? sortEl.value.trim() : 'members_desc';
  const res = await api(`/api/admin/clans?q=${encodeURIComponent(q)}&sort=${encodeURIComponent(sort)}`);
  if (res.error) {
    box.innerHTML = '<div class="muted">Unable to load clans.</div>';
    return;
  }
  const clans = Array.isArray(res.clans) ? res.clans : [];
  if (!clans.length) {
    box.innerHTML = '<div class="muted">No clans found.</div>';
    return;
  }
  const rows = clans.map((c) => `<tr>
      <td><a href="/clan.html?id=${encodeURIComponent(c.id)}">${escapeHtml(c.name || '')}</a></td>
      <td>${Number(c.total_members) || 0}</td>
      <td>${formatDateTime(c.last_active, 'Never')}</td>
      <td>${Number(c.open_reports) || 0}</td>
      <td>L${Number(c.clan_level) || 1}</td>
      <td>${Number(c.clan_xp) || 0}</td>
      <td>${Number(c.is_private) ? 'Private' : 'Public'}</td>
    </tr>`).join('');
  box.innerHTML = `<div class="admin-users-table-wrap">
    <table class="admin-users-table">
      <thead>
        <tr>
          <th>Clan</th>
          <th>Members</th>
          <th>Last Active</th>
          <th>Open Reports</th>
          <th>Level</th>
          <th>XP</th>
          <th>Privacy</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function initAdminTabs() {
  const tabBtns = Array.from(document.querySelectorAll('.admin-tab-btn'));
  if (!tabBtns.length) return;
  const sections = {
    users: 'adminTabUsers',
    clans: 'adminTabClans',
    reports: 'adminTabReports'
  };
  const activate = (tab) => {
    tabBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
    Object.keys(sections).forEach((key) => {
      const panel = document.getElementById(sections[key]);
      if (!panel) return;
      panel.classList.toggle('hidden', key !== tab);
    });
  };
  tabBtns.forEach((btn) => btn.addEventListener('click', () => activate(btn.dataset.tab || 'users')));
  activate('users');
}

async function handleStoryImageSelection(e) {
  const file = e.target.files[0];
  if (!file) {
    selectedStoryImageDataUrl = null;
    updateFileNameChip(e.target);
    const preview = document.getElementById('storyImagePreview');
    if (preview) {
      preview.classList.add('hidden');
      preview.innerHTML = '';
    }
    return;
  }
  if (!file.type.startsWith('image/')) {
    showToast('Please choose a valid story image', 'error');
    e.target.value = '';
    updateFileNameChip(e.target);
    selectedStoryImageDataUrl = null;
    return;
  }
  if (file.size > 4 * 1024 * 1024) {
    showToast('Story image must be below 4MB', 'error');
    e.target.value = '';
    updateFileNameChip(e.target);
    selectedStoryImageDataUrl = null;
    return;
  }
  const reader = new FileReader();
  reader.onload = (evt) => {
    selectedStoryImageDataUrl = evt.target.result;
    const preview = document.getElementById('storyImagePreview');
    if (preview) {
      preview.classList.remove('hidden');
      preview.innerHTML = `<img src="${selectedStoryImageDataUrl}" alt="Story preview" loading="lazy" />`;
    }
  };
  reader.onerror = () => showToast('Unable to read story image', 'error');
  reader.readAsDataURL(file);
}

async function loadStories() {
  const box = document.getElementById('storiesBar');
  if (!box) return;
  box.innerHTML = '<div class="muted">Loading stories...</div>';
  const res = await api('/api/stories');
  if (res.error) {
    box.innerHTML = '<div class="muted">Unable to load stories</div>';
    return;
  }
  if (!res.stories || !res.stories.length) {
    storyGroups = [];
    box.innerHTML = '';
    if (cachedMe) {
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'stories-bar-item is-self is-add';
      addBtn.innerHTML = `<span class="stories-avatar-wrap">
        <img class="stories-avatar" src="${cachedMe.profile_picture || 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E'}" alt="Your story" loading="lazy" />
      </span>
      <span class="stories-name">Your Story</span>`;
      addBtn.addEventListener('click', () => {
        const storyForm = document.getElementById('storyForm');
        const storyComposerToggle = document.getElementById('storyComposerToggle');
        if (!storyForm) return;
        storyForm.classList.remove('hidden');
        if (storyComposerToggle) storyComposerToggle.textContent = 'Close';
        const contentInput = document.getElementById('storyContent');
        if (contentInput) contentInput.focus();
      });
      box.appendChild(addBtn);
    } else {
      box.innerHTML = '<div class="muted">No active stories yet.</div>';
    }
    return;
  }
  const byUser = new Map();
  const stories = Array.isArray(res.stories) ? res.stories : [];
  stories.forEach((s) => {
    const key = Number(s.user_id) || String(s.user_id);
    if (!byUser.has(key)) {
      byUser.set(key, {
        userId: Number(s.user_id) || null,
        username: s.username || '',
        name: s.name || '',
        profile_picture: s.profile_picture || '',
        stories: []
      });
    }
    byUser.get(key).stories.push({
      ...s,
      likes_count: Number(s.likes_count) || 0,
      replies_count: Number(s.replies_count) || 0,
      shares_count: Number(s.shares_count) || 0,
      liked_by_me: Boolean(s.liked_by_me)
    });
  });
  storyGroups = Array.from(byUser.values()).map((g) => ({
    ...g,
    stories: g.stories.sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))
  })).sort((a, b) => Number(b.stories[0]?.created_at || 0) - Number(a.stories[0]?.created_at || 0));
  if (cachedMe && cachedMe.id) {
    const meId = Number(cachedMe.id);
    storyGroups.sort((a, b) => {
      if (Number(a.userId) === meId) return -1;
      if (Number(b.userId) === meId) return 1;
      return Number(b.stories[0]?.created_at || 0) - Number(a.stories[0]?.created_at || 0);
    });
  }
  box.innerHTML = '';
  const hasSelfStory = cachedMe && storyGroups.some((g) => Number(g.userId) === Number(cachedMe.id));
  if (cachedMe && !hasSelfStory) {
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'stories-bar-item is-self is-add';
    addBtn.innerHTML = `<span class="stories-avatar-wrap">
      <img class="stories-avatar" src="${cachedMe.profile_picture || 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E'}" alt="Your story" loading="lazy" />
    </span>
    <span class="stories-name">Your Story</span>`;
    addBtn.addEventListener('click', () => {
      const storyForm = document.getElementById('storyForm');
      const storyComposerToggle = document.getElementById('storyComposerToggle');
      if (!storyForm) return;
      storyForm.classList.remove('hidden');
      if (storyComposerToggle) storyComposerToggle.textContent = 'Close';
      const contentInput = document.getElementById('storyContent');
      if (contentInput) contentInput.focus();
    });
    box.appendChild(addBtn);
  }
  storyGroups.forEach((group, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    const isSelf = cachedMe && Number(group.userId) === Number(cachedMe.id);
    btn.className = `stories-bar-item${isSelf ? ' is-self' : ''}`;
    const avatar = group.profile_picture || 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E';
    const displayName = isSelf ? 'Your Story' : (group.name || group.username || 'User');
    btn.innerHTML = `<span class="stories-avatar-wrap">
      <img class="stories-avatar" src="${avatar}" alt="${escapeHtml(displayName)}" loading="lazy" />
    </span>
    <span class="stories-name">${escapeHtml(displayName)}</span>`;
    btn.addEventListener('click', () => openStoryViewer(idx, 0));
    box.appendChild(btn);
  });
}

function getActiveStory() {
  const group = storyGroups[activeStoryGroupIndex];
  if (!group || !Array.isArray(group.stories) || !group.stories.length) return null;
  if (activeStoryIndex < 0 || activeStoryIndex >= group.stories.length) return null;
  return group.stories[activeStoryIndex];
}

function updateStoryStats(story) {
  const likesEl = document.getElementById('storyLikesCount');
  const repliesEl = document.getElementById('storyRepliesCount');
  const sharesEl = document.getElementById('storySharesCount');
  const likeBtn = document.getElementById('storyLikeBtn');
  if (likesEl) likesEl.textContent = `${Number(story.likes_count) || 0} likes`;
  if (repliesEl) repliesEl.textContent = `${Number(story.replies_count) || 0} replies`;
  if (sharesEl) sharesEl.textContent = `${Number(story.shares_count) || 0} shares`;
  if (likeBtn) setActionButtonLabel(likeBtn, story.liked_by_me ? 'Unlike' : 'Like', 'like');
}

function clearStoryTimers() {
  if (storyAutoAdvanceTimeout) {
    clearTimeout(storyAutoAdvanceTimeout);
    storyAutoAdvanceTimeout = null;
  }
  if (storyProgressInterval) {
    clearInterval(storyProgressInterval);
    storyProgressInterval = null;
  }
}

function goToNextStory() {
  const group = storyGroups[activeStoryGroupIndex];
  if (!group || !Array.isArray(group.stories)) return closeStoryViewer();
  if (activeStoryIndex < group.stories.length - 1) {
    activeStoryIndex += 1;
    renderStoryViewer();
    return;
  }
  if (activeStoryGroupIndex < storyGroups.length - 1) {
    activeStoryGroupIndex += 1;
    activeStoryIndex = 0;
    renderStoryViewer();
    return;
  }
  closeStoryViewer();
}

function goToPrevStory() {
  const group = storyGroups[activeStoryGroupIndex];
  if (!group || !Array.isArray(group.stories)) return closeStoryViewer();
  if (activeStoryIndex > 0) {
    activeStoryIndex -= 1;
    renderStoryViewer();
    return;
  }
  if (activeStoryGroupIndex > 0) {
    activeStoryGroupIndex -= 1;
    const prevGroup = storyGroups[activeStoryGroupIndex];
    activeStoryIndex = Math.max(0, (prevGroup && prevGroup.stories ? prevGroup.stories.length : 1) - 1);
    renderStoryViewer();
  }
}

function startStoryTimer() {
  clearStoryTimers();
  const progressEl = document.getElementById('storyViewerProgress');
  const startedAt = Date.now();
  if (progressEl) progressEl.style.width = '0%';
  storyProgressInterval = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    const pct = Math.max(0, Math.min(100, (elapsed / STORY_VIEW_DURATION_MS) * 100));
    if (progressEl) progressEl.style.width = `${pct}%`;
  }, 120);
  storyAutoAdvanceTimeout = setTimeout(() => {
    clearStoryTimers();
    goToNextStory();
  }, STORY_VIEW_DURATION_MS);
}

function renderStoryViewer() {
  const modal = document.getElementById('storyViewerModal');
  const avatar = document.getElementById('storyViewerAvatar');
  const title = document.getElementById('storyViewerTitle');
  const meta = document.getElementById('storyViewerMeta');
  const image = document.getElementById('storyViewerImage');
  const text = document.getElementById('storyViewerText');
  const deleteBtn = document.getElementById('storyDeleteBtn');
  const prevBtn = document.getElementById('storyViewerPrevBtn');
  const nextBtn = document.getElementById('storyViewerNextBtn');
  if (!modal || !avatar || !title || !meta || !image || !text || !prevBtn || !nextBtn) return;
  const group = storyGroups[activeStoryGroupIndex];
  if (!group || !Array.isArray(group.stories) || !group.stories.length) {
    closeStoryViewer();
    return;
  }
  if (activeStoryIndex < 0) activeStoryIndex = 0;
  if (activeStoryIndex >= group.stories.length) activeStoryIndex = group.stories.length - 1;
  const story = group.stories[activeStoryIndex];
  const isSelf = cachedMe && Number(group.userId) === Number(cachedMe.id);
  const name = isSelf ? 'Your Story' : (group.name || group.username || 'Story');
  avatar.src = group.profile_picture || 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E';
  title.textContent = name;
  meta.textContent = formatDateTime(story.created_at, '');
  if (story.image) {
    image.src = story.image;
    image.classList.remove('hidden');
  } else {
    image.src = '';
    image.classList.add('hidden');
  }
  text.textContent = story.content || '';
  updateStoryStats(story);
  const canDelete = cachedMe && Number(story.user_id) === Number(cachedMe.id);
  if (deleteBtn) deleteBtn.classList.toggle('hidden', !canDelete);
  prevBtn.disabled = activeStoryGroupIndex <= 0 && activeStoryIndex <= 0;
  nextBtn.disabled = activeStoryGroupIndex >= storyGroups.length - 1 && activeStoryIndex >= group.stories.length - 1;
  startStoryTimer();
}

function openStoryViewer(groupIndex, storyIndex = 0) {
  const modal = document.getElementById('storyViewerModal');
  if (!modal) return;
  activeStoryGroupIndex = Number(groupIndex);
  activeStoryIndex = Number(storyIndex) || 0;
  renderStoryViewer();
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function closeStoryViewer() {
  const modal = document.getElementById('storyViewerModal');
  if (!modal) return;
  clearStoryTimers();
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

async function toggleStoryLike() {
  const story = getActiveStory();
  if (!story) return;
  const res = await api(`/api/stories/${story.id}/like`, 'POST', {});
  if (res.error) {
    if (res.raw) console.error('Story like raw response:', res.raw);
    return showToast(res.error || 'Unable to update like', 'error');
  }
  story.liked_by_me = Boolean(res.liked);
  story.likes_count = Number(res.count) || 0;
  updateStoryStats(story);
}

async function shareActiveStory() {
  const story = getActiveStory();
  if (!story) return;
  const res = await api(`/api/stories/${story.id}/share`, 'POST', {});
  if (res.error) return showToast(res.error || 'Unable to share story', 'error');
  story.shares_count = Number(res.count) || 0;
  updateStoryStats(story);
  const shareText = `Check this story on Mednecta: ${res.shareUrl || location.href}`;
  try {
    if (navigator.share) {
      await navigator.share({ text: shareText, url: res.shareUrl || location.href });
    } else if (navigator.clipboard) {
      await navigator.clipboard.writeText(res.shareUrl || location.href);
      showToast('Story link copied');
    } else {
      showToast('Story shared');
    }
  } catch (e) {
    showToast('Share cancelled');
  }
}

async function deleteActiveStory() {
  const story = getActiveStory();
  if (!story) return;
  const ok = window.confirm('Delete this story permanently?');
  if (!ok) return;
  const res = await api(`/api/stories/${story.id}`, 'DELETE');
  if (res.error) return showToast(res.error || 'Unable to delete story', 'error');
  showToast('Story deleted');
  closeStoryViewer();
  await loadStories();
}

async function submitStoryReply(e) {
  e.preventDefault();
  const story = getActiveStory();
  if (!story) return;
  const input = document.getElementById('storyReplyInput');
  const content = input ? input.value.trim() : '';
  if (!content) return;
  const res = await api(`/api/stories/${story.id}/reply`, 'POST', { content });
  if (res.error) return showToast(res.error || 'Unable to send reply', 'error');
  if (input) input.value = '';
  story.replies_count = Number(res.count) || story.replies_count || 0;
  updateStoryStats(story);
  showToast('Reply sent to story owner');
}

async function handleStorySubmit(e) {
  e.preventDefault();
  const form = e.target;
  const contentEl = document.getElementById('storyContent');
  const imageEl = document.getElementById('storyImage');
  const content = contentEl ? contentEl.value.trim() : '';
  if (!content && !selectedStoryImageDataUrl) {
    showToast('Add text or image for your story', 'error');
    return;
  }
  const btn = form.querySelector('button[type="submit"]');
  setLoading(form, true);
  if (btn) btn.textContent = 'Posting...';
  const res = await api('/api/stories', 'POST', { content, image: selectedStoryImageDataUrl });
  setLoading(form, false);
  if (btn) btn.textContent = 'Post Story (24h)';
  if (res && res.success) {
    if (contentEl) contentEl.value = '';
    if (imageEl) {
      imageEl.value = '';
      updateFileNameChip(imageEl);
    }
    const preview = document.getElementById('storyImagePreview');
    if (preview) {
      preview.classList.add('hidden');
      preview.innerHTML = '';
    }
    selectedStoryImageDataUrl = null;
    showToast('Story posted');
    const storyForm = document.getElementById('storyForm');
    const storyComposerToggle = document.getElementById('storyComposerToggle');
    if (storyForm) storyForm.classList.add('hidden');
    if (storyComposerToggle) storyComposerToggle.textContent = 'Add Story';
    loadStories();
  } else {
    showToast(res.error || 'Unable to post story', 'error');
  }
}

async function loadProfileEditor() {
  const form = document.getElementById('profileEditForm');
  if (!form) return;
  const res = await api('/api/profile');
  if (res.error || !res.user) {
    showToast(res.error || 'Unable to load profile', 'error');
    return;
  }
  const nameEl = document.getElementById('profileEditName');
  const nicknameEl = document.getElementById('profileEditNickname');
  const emailEl = document.getElementById('profileEditEmail');
  const genderEl = document.getElementById('profileEditGender');
  const dobEl = document.getElementById('profileEditDob');
  const placeFromEl = document.getElementById('profileEditPlaceFrom');
  const statusDescriptionEl = document.getElementById('profileEditStatusDescription');
  const achievementsEl = document.getElementById('profileEditAchievements');
  const privacyShowOnlineEl = document.getElementById('privacyShowOnline');
  const privacyDiscoverabilityEl = document.getElementById('privacyDiscoverability');
  const privacyInSuggestionsEl = document.getElementById('privacyInSuggestions');
  const privacyRequestPolicyEl = document.getElementById('privacyRequestPolicy');
  const instituteEl = document.getElementById('profileEditInstitute');
  const programTypeEl = document.getElementById('profileEditProgramType');
  const degreeEl = document.getElementById('profileEditDegree');
  const yearEl = document.getElementById('profileEditAcademicYear');
  const specialityEl = document.getElementById('profileEditSpeciality');
  const bioEl = document.getElementById('profileEditBio');
  if (nameEl) nameEl.value = res.user.name || '';
  if (nicknameEl) nicknameEl.value = res.user.nickname || '';
  if (emailEl) emailEl.value = res.user.email || '';
  if (genderEl) genderEl.value = res.user.gender || '';
  if (dobEl) dobEl.value = res.user.date_of_birth || '';
  if (placeFromEl) placeFromEl.value = res.user.place_from || '';
  if (statusDescriptionEl) statusDescriptionEl.value = res.user.status_description || '';
  if (achievementsEl) achievementsEl.value = res.user.achievements || '';
  if (privacyShowOnlineEl) privacyShowOnlineEl.value = res.user.privacy_show_online || 'connections';
  if (privacyDiscoverabilityEl) privacyDiscoverabilityEl.value = res.user.privacy_discoverability || 'everyone';
  if (privacyInSuggestionsEl) privacyInSuggestionsEl.value = res.user.privacy_in_suggestions || 'everyone';
  if (privacyRequestPolicyEl) privacyRequestPolicyEl.value = res.user.privacy_request_policy || 'everyone';
  if (instituteEl) instituteEl.value = res.user.institute || '';
  if (programTypeEl) programTypeEl.value = res.user.program_type || '';
  if (degreeEl) degreeEl.value = res.user.degree || '';
  if (yearEl) yearEl.value = res.user.academic_year || '';
  if (specialityEl) specialityEl.value = res.user.speciality || '';
  if (bioEl) bioEl.value = res.user.bio || '';
}

async function handleProfileEditSubmit(e) {
  e.preventDefault();
  const form = e.target;
  const nameEl = document.getElementById('profileEditName');
  const nicknameEl = document.getElementById('profileEditNickname');
  const emailEl = document.getElementById('profileEditEmail');
  const genderEl = document.getElementById('profileEditGender');
  const dobEl = document.getElementById('profileEditDob');
  const placeFromEl = document.getElementById('profileEditPlaceFrom');
  const statusDescriptionEl = document.getElementById('profileEditStatusDescription');
  const achievementsEl = document.getElementById('profileEditAchievements');
  const privacyShowOnlineEl = document.getElementById('privacyShowOnline');
  const privacyDiscoverabilityEl = document.getElementById('privacyDiscoverability');
  const privacyInSuggestionsEl = document.getElementById('privacyInSuggestions');
  const privacyRequestPolicyEl = document.getElementById('privacyRequestPolicy');
  const instituteEl = document.getElementById('profileEditInstitute');
  const programTypeEl = document.getElementById('profileEditProgramType');
  const degreeEl = document.getElementById('profileEditDegree');
  const yearEl = document.getElementById('profileEditAcademicYear');
  const specialityEl = document.getElementById('profileEditSpeciality');
  const bioEl = document.getElementById('profileEditBio');
  const name = nameEl ? nameEl.value.trim() : '';
  const nickname = nicknameEl ? nicknameEl.value.trim() : '';
  const email = emailEl ? emailEl.value.trim() : '';
  const gender = genderEl ? genderEl.value.trim() : '';
  const dateOfBirth = dobEl ? dobEl.value.trim() : '';
  const placeFrom = placeFromEl ? placeFromEl.value.trim() : '';
  const statusDescription = statusDescriptionEl ? statusDescriptionEl.value.trim() : '';
  const achievements = achievementsEl ? achievementsEl.value.trim() : '';
  const privacyShowOnline = privacyShowOnlineEl ? privacyShowOnlineEl.value.trim() : 'connections';
  const privacyDiscoverability = privacyDiscoverabilityEl ? privacyDiscoverabilityEl.value.trim() : 'everyone';
  const privacyInSuggestions = privacyInSuggestionsEl ? privacyInSuggestionsEl.value.trim() : 'everyone';
  const privacyRequestPolicy = privacyRequestPolicyEl ? privacyRequestPolicyEl.value.trim() : 'everyone';
  const institute = instituteEl ? instituteEl.value.trim() : '';
  const programType = programTypeEl ? programTypeEl.value.trim() : '';
  const degree = degreeEl ? degreeEl.value.trim() : '';
  const academicYear = yearEl ? yearEl.value.trim() : '';
  const speciality = specialityEl ? specialityEl.value.trim() : '';
  const bio = bioEl ? bioEl.value.trim() : '';
  const btn = form.querySelector('button[type="submit"]');
  setLoading(form, true);
  if (btn) btn.textContent = 'Saving...';
  const res = await api('/api/profile', 'POST', { name, nickname, email, gender, dateOfBirth, statusDescription, achievements, placeFrom, privacyShowOnline, privacyDiscoverability, privacyInSuggestions, privacyRequestPolicy, bio, institute, programType, degree, academicYear, speciality });
  setLoading(form, false);
  if (btn) btn.textContent = 'Save Changes';
  if (res && res.success) {
    showToast('Profile updated');
  } else {
    showToast(res.error || 'Unable to update profile', 'error');
  }
}

async function loadSavedLists() {
  const selectEl = document.getElementById('savedListSelect');
  if (!selectEl) return;
  const res = await api('/api/saved-lists');
  if (res.error) {
    selectEl.innerHTML = '<option value="General">General</option>';
    return;
  }
  const lists = Array.isArray(res.lists) ? res.lists : [];
  if (!lists.length) lists.push({ name: 'General', post_count: 0 });
  selectEl.innerHTML = lists.map((l) => {
    const name = String(l.name || 'General');
    const cnt = Number(l.post_count) || 0;
    return `<option value="${escapeHtml(name)}">${escapeHtml(name)} (${cnt})</option>`;
  }).join('');
  if ([...selectEl.options].some((opt) => opt.value === currentSavedListFilter)) {
    selectEl.value = currentSavedListFilter;
  } else {
    currentSavedListFilter = selectEl.value || 'General';
  }
  selectEl.onchange = () => {
    currentSavedListFilter = selectEl.value || 'General';
    loadSavedPosts();
  };
}

async function createSavedList() {
  const input = document.getElementById('newSavedListName');
  const name = input ? input.value.trim() : '';
  if (!name) {
    showToast('Enter list name', 'error');
    return;
  }
  const res = await api('/api/saved-lists', 'POST', { name });
  if (res && res.success) {
    if (input) input.value = '';
    await loadSavedLists();
    showToast('List created');
  } else {
    showToast(res.error || 'Unable to create list', 'error');
  }
}

async function moveSavedPostToList(postId, listName) {
  const res = await api(`/api/saved-post/${postId}/list`, 'POST', { listName });
  if (res && res.success) {
    await loadSavedLists();
    await loadSavedPosts();
    showToast('Saved post moved');
  } else {
    showToast(res.error || 'Unable to move post', 'error');
  }
}

async function loadSavedPosts() {
  const box = document.getElementById('savedPostsBox');
  const selectEl = document.getElementById('savedListSelect');
  if (!box || !selectEl) return;
  const listName = selectEl.value || 'General';
  currentSavedListFilter = listName;
  box.innerHTML = '<div class="muted">Loading saved posts...</div>';
  const res = await api(`/api/saved-posts?list=${encodeURIComponent(listName)}`);
  if (res.error) {
    box.innerHTML = `<div class="muted">${escapeHtml(res.error)}</div>`;
    return;
  }
  if (!res.posts || !res.posts.length) {
    box.innerHTML = '<div class="muted">No saved posts in this list.</div>';
    return;
  }
  const listsRes = await api('/api/saved-lists');
  const listNames = (listsRes && Array.isArray(listsRes.lists) ? listsRes.lists.map((l) => String(l.name || '')).filter(Boolean) : ['General']);
  box.innerHTML = '';
  res.posts.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'post';
    const options = listNames.map((n) => `<option value="${escapeHtml(n)}"${n === listName ? ' selected' : ''}>${escapeHtml(n)}</option>`).join('');
    card.innerHTML = `<div class="meta">${escapeHtml(p.name || p.username)} - ${formatDateTime(p.created_at)}</div>
      <div>${escapeHtml(p.content || '')}</div>
      <div class="row" style="justify-content:flex-start;margin-top:0.6rem">
        <select data-post-id="${p.id}" class="saved-move-select">${options}</select>
        <button class="btn secondary tiny-btn" data-remove-post-id="${p.id}" type="button">Remove</button>
      </div>`;
    const moveSelect = card.querySelector('.saved-move-select');
    if (moveSelect) {
      moveSelect.addEventListener('change', () => moveSavedPostToList(p.id, moveSelect.value));
    }
    const removeBtn = card.querySelector('[data-remove-post-id]');
    if (removeBtn) {
      removeBtn.addEventListener('click', async () => {
        const unsave = await api(`/api/post/${p.id}/save`, 'POST', { listName });
        if (unsave && unsave.success) {
          await loadSavedLists();
          await loadSavedPosts();
          showToast('Removed from saved');
        } else {
          showToast(unsave.error || 'Unable to remove', 'error');
        }
      });
    }
    box.appendChild(card);
  });
}

async function loadClanManagementPage() {
  const profileCard = document.getElementById('clanProfileCard');
  if (!profileCard) return;
  const clanId = new URLSearchParams(window.location.search).get('id');
  if (!clanId) {
    profileCard.innerHTML = '<div class="muted">Invalid clan id.</div>';
    return;
  }
  const detailRes = await api(`/api/groups/${encodeURIComponent(clanId)}/detail`);
  if (detailRes.error || !detailRes.group) {
    profileCard.innerHTML = `<div class="muted">${escapeHtml(detailRes.error || 'Unable to load clan')}</div>`;
    return;
  }
  const g = detailRes.group;
  const permissionList = Array.isArray(detailRes.myPermissions) ? detailRes.myPermissions : [];
  const hasPermission = (permission) => String(g.my_role || '') === 'admin' || permissionList.includes(permission);
  const canManage = hasPermission('manage_members') || hasPermission('manage_requests') || hasPermission('manage_roles');
  const isActiveMember = g.my_status === 'active';
  const header = document.getElementById('clanHeaderMeta');
  if (header) header.textContent = `${g.name} | Level ${g.clan_level || 1} | XP ${g.clan_xp || 0}`;
  const inviteToken = new URLSearchParams(window.location.search).get('invite');
  if (inviteToken && !isActiveMember) {
    const joinByInvite = await api(`/api/groups/invite/${encodeURIComponent(inviteToken)}/join`, 'POST', {});
    if (joinByInvite && joinByInvite.success) {
      showToast(joinByInvite.status === 'active' ? 'Joined via invite link' : 'Invite accepted, waiting for approval');
      window.history.replaceState({}, '', `/clan.html?id=${encodeURIComponent(joinByInvite.groupId || clanId)}`);
      loadClanManagementPage();
      return;
    } else if (joinByInvite && joinByInvite.error) {
      showToast(joinByInvite.error, 'error');
    }
  }
  profileCard.innerHTML = `<img src="${g.profile_picture || 'data:image/svg+xml,<svg></svg>'}" class="profile-picture" />
    <h3>${escapeHtml(g.name)}</h3>
    <p class="muted">${escapeHtml(g.description || '')}</p>
    <p class="muted">Members: ${g.member_count || 0} | Level ${g.clan_level || 1} | XP ${g.clan_xp || 0}</p>
    <p class="muted">Role: ${escapeHtml(g.my_role || 'none')} | Status: ${escapeHtml(g.my_status || 'none')}</p>
    ${!isActiveMember && g.my_status !== 'pending' ? '<button id="joinClanBtn" class="btn tiny-btn" type="button">Request to Join Clan</button>' : ''}
    ${g.my_status === 'pending' ? '<button id="cancelClanJoinBtn" class="btn secondary tiny-btn" type="button">Cancel Join Request</button>' : ''}
    ${isActiveMember ? '<button id="leaveClanBtn" class="btn secondary tiny-btn" type="button">Leave Clan</button>' : ''}
    ${hasPermission('manage_members') ? '<input id="clanPictureInput" type="file" accept="image/*" /><button id="updateClanPicBtn" class="btn secondary tiny-btn" type="button">Update Clan Picture</button>' : ''}`;
  const joinBtn = document.getElementById('joinClanBtn');
  if (joinBtn) {
    joinBtn.addEventListener('click', async () => {
      const joinRes = await api(`/api/groups/${encodeURIComponent(clanId)}/join`, 'POST', {});
      if (joinRes && joinRes.success) {
        showToast(joinRes.status === 'active' ? 'Joined clan' : 'Join request sent');
        loadClanManagementPage();
        loadGroups();
      } else {
        showToast(joinRes.error || 'Unable to join clan', 'error');
      }
    });
  }
  const leaveBtn = document.getElementById('leaveClanBtn');
  if (leaveBtn) {
    leaveBtn.addEventListener('click', async () => {
      const ok = window.confirm('Leave this clan now?');
      if (!ok) return;
      const leaveRes = await api(`/api/groups/${encodeURIComponent(clanId)}/leave`, 'POST', {});
      if (leaveRes && leaveRes.success) {
        showToast('You left the clan');
        location.href = '/dashboard';
      } else {
        showToast(leaveRes.error || 'Unable to leave clan', 'error');
      }
    });
  }
  const cancelBtn = document.getElementById('cancelClanJoinBtn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', async () => {
      const cancelRes = await api(`/api/groups/${encodeURIComponent(clanId)}/leave`, 'POST', {});
      if (cancelRes && cancelRes.success) {
        showToast('Join request cancelled');
        loadClanManagementPage();
      } else {
        showToast(cancelRes.error || 'Unable to cancel request', 'error');
      }
    });
  }
  if (hasPermission('manage_members')) {
    const updateBtn = document.getElementById('updateClanPicBtn');
    if (updateBtn) {
      updateBtn.addEventListener('click', async () => {
        const input = document.getElementById('clanPictureInput');
        const file = input && input.files ? input.files[0] : null;
        if (!file) {
          showToast('Select image first', 'error');
          return;
        }
        const reader = new FileReader();
        reader.onload = async (evt) => {
          const r = await api(`/api/groups/${encodeURIComponent(clanId)}/picture`, 'POST', { image: evt.target.result });
          if (r && r.success) {
            showToast('Clan picture updated');
            loadClanManagementPage();
            loadGroups();
          } else {
            showToast(r.error || 'Unable to update clan picture', 'error');
          }
        };
        reader.readAsDataURL(file);
      });
    }
  }
  renderClanInvitePanel({ clanId, isActiveMember, hasPermission, invite: detailRes.invite });
  renderClanRolePanel({ clanId, isActiveMember, hasPermission });

  const postsBox = document.getElementById('clanPosts');
  if (postsBox) {
    const clanPostForm = document.getElementById('clanPostForm');
    const canPostAny = hasPermission('post_messages') || hasPermission('post_quiz') || hasPermission('post_reminder') || hasPermission('post_links');
    if (clanPostForm) clanPostForm.classList.toggle('hidden', !isActiveMember || !canPostAny);
    const posts = Array.isArray(detailRes.posts) ? detailRes.posts : [];
    if (!isActiveMember) postsBox.innerHTML = '<div class="muted">Join this clan to view posts.</div>';
    else if (!posts.length) postsBox.innerHTML = '<div class="muted">No clan posts yet.</div>';
    else postsBox.innerHTML = posts.map(renderClanPostCard).join('');
  }

  const membersBox = document.getElementById('clanMembers');
  if (membersBox) {
    const members = Array.isArray(detailRes.members) ? detailRes.members : [];
    if (!isActiveMember) membersBox.innerHTML = '<div class="muted">Join this clan to view members.</div>';
    else if (!members.length) membersBox.innerHTML = '<div class="muted">No members found.</div>';
    else {
      membersBox.innerHTML = members.map((m) => {
        const roleLabel = m.custom_role_name ? `${m.custom_role_name} (custom)` : (m.role || 'member');
        return `<div class="request-item">
          <img src="${getProfilePictureUrl(m)}" style="width:30px;height:30px;border-radius:50%" />
          <strong>${escapeHtml(m.name || m.username)}</strong>
          <span class="muted">${escapeHtml(roleLabel)}</span>
          <button class="btn tiny-btn" data-chat-member-id="${m.id}" data-chat-member-name="${escapeHtml(m.name || m.username)}" type="button">Message</button>
          ${hasPermission('remove_members') && Number(m.id) !== Number(window.__me ? window.__me.id : 0) ? `<button class="btn secondary tiny-btn" data-remove-member-id="${m.id}" type="button">Remove</button>` : ''}
          ${hasPermission('manage_roles') ? `<button class="btn tiny-btn" data-role-member-id="${m.id}" type="button">Role</button>` : ''}
        </div>`;
      }).join('');
      membersBox.querySelectorAll('[data-chat-member-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const memberId = Number(btn.getAttribute('data-chat-member-id'));
          const memberName = btn.getAttribute('data-chat-member-name') || 'Member';
          if (!memberId) return;
          openChat(memberId, memberName);
        });
      });
      membersBox.querySelectorAll('[data-remove-member-id]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const targetId = btn.getAttribute('data-remove-member-id');
          if (!targetId) return;
          const ok = window.confirm('Remove this member from clan?');
          if (!ok) return;
          const removeRes = await api(`/api/groups/${encodeURIComponent(clanId)}/member/${encodeURIComponent(targetId)}`, 'DELETE');
          if (removeRes && removeRes.success) {
            showToast('Member removed');
            loadClanManagementPage();
            loadGroups();
          } else {
            showToast(removeRes.error || 'Unable to remove member', 'error');
          }
        });
      });
      membersBox.querySelectorAll('[data-role-member-id]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const targetId = Number(btn.getAttribute('data-role-member-id'));
          if (!targetId) return;
          const roleInput = window.prompt('Set system role: admin/moderator/member. Or type custom:<id> for custom role.');
          if (!roleInput) return;
          const raw = roleInput.trim();
          let payload = { userId: targetId };
          if (raw.toLowerCase().startsWith('custom:')) payload.customRoleId = Number(raw.split(':')[1]);
          else payload.role = raw.toLowerCase();
          const setRes = await api(`/api/groups/${encodeURIComponent(clanId)}/member-role`, 'POST', payload);
          if (setRes && setRes.success) {
            showToast('Member role updated');
            loadClanManagementPage();
          } else {
            showToast(setRes.error || 'Unable to update role', 'error');
          }
        });
      });
    }
  }

  const activityBox = document.getElementById('clanActivity');
  if (activityBox) {
    const actRes = await api(`/api/groups/${encodeURIComponent(clanId)}/activity`);
    if (actRes.error) activityBox.innerHTML = `<div class="muted">${escapeHtml(actRes.error)}</div>`;
    else if (!actRes.events || !actRes.events.length) activityBox.innerHTML = '<div class="muted">No recent activity.</div>';
    else activityBox.innerHTML = actRes.events.map((e) => `<div class="request-item"><span class="muted">${formatDateTime(e.created_at)}</span><span><strong>${escapeHtml(e.name || e.username || '')}</strong> ${escapeHtml(e.type || '')}${e.content ? `: ${escapeHtml(e.content)}` : ''}</span></div>`).join('');
  }

  const requestsBox = document.getElementById('clanRequests');
  if (requestsBox) {
    if (!hasPermission('manage_requests')) {
      requestsBox.innerHTML = '<div class="muted">Only clan admins/moderators can review requests.</div>';
    } else {
      const reqRes = await api(`/api/groups/${encodeURIComponent(clanId)}/requests`);
      const reqs = reqRes && Array.isArray(reqRes.requests) ? reqRes.requests : [];
      if (!reqs.length) requestsBox.innerHTML = '<div class="muted">No pending requests.</div>';
      else {
        requestsBox.innerHTML = '';
        reqs.forEach((r) => {
          const item = document.createElement('div');
          item.className = 'request-item';
          item.innerHTML = `<img src="${getProfilePictureUrl(r)}" style="width:30px;height:30px;border-radius:50%" /><strong>${escapeHtml(r.name || r.username)}</strong>`;
          const approveBtn = createActionButton('Approve', async () => {
            const ar = await api(`/api/groups/${encodeURIComponent(clanId)}/requests/${encodeURIComponent(r.id)}`, 'POST', { action: 'approve' });
            if (ar && ar.success) loadClanManagementPage();
            else showToast(ar.error || 'Unable to approve', 'error');
          }, 'btn tiny-btn');
          const rejectBtn = createActionButton('Reject', async () => {
            const rr = await api(`/api/groups/${encodeURIComponent(clanId)}/requests/${encodeURIComponent(r.id)}`, 'POST', { action: 'reject' });
            if (rr && rr.success) loadClanManagementPage();
            else showToast(rr.error || 'Unable to reject', 'error');
          }, 'btn secondary tiny-btn');
          item.appendChild(approveBtn);
          item.appendChild(rejectBtn);
          requestsBox.appendChild(item);
        });
      }
    }
  }
  if (isActiveMember) {
    loadClanLounge(clanId);
    if (clanLoungeInterval) window.clearInterval(clanLoungeInterval);
    clanLoungeInterval = window.setInterval(() => loadClanLounge(clanId), 10000);
  }
}

async function handleClanPostSubmit(e) {
  e.preventDefault();
  const clanId = new URLSearchParams(window.location.search).get('id');
  const typeEl = document.getElementById('clanPostType');
  const input = document.getElementById('clanPostContent');
  const mentionsEl = document.getElementById('clanPostMentions');
  const postType = typeEl ? typeEl.value : 'message';
  const content = input ? input.value.trim() : '';
  if (!clanId) return;
  const mentions = mentionsEl ? mentionsEl.value.split(',').map((s) => s.trim()).filter(Boolean) : [];
  const payload = {
    postType,
    content,
    mentions,
    image: selectedClanPostImageDataUrl || null,
    caption: document.getElementById('clanPostCaption') ? document.getElementById('clanPostCaption').value.trim() : '',
    quizQuestion: document.getElementById('clanQuizQuestion') ? document.getElementById('clanQuizQuestion').value.trim() : '',
    quizOptions: Array.from(document.querySelectorAll('.clanQuizOption')).map((el) => (el.value || '').trim()).filter(Boolean),
    quizCorrectIndex: document.getElementById('clanQuizCorrectIndex') ? Number(document.getElementById('clanQuizCorrectIndex').value) : null,
    reminderAt: document.getElementById('clanReminderAt') && document.getElementById('clanReminderAt').value ? new Date(document.getElementById('clanReminderAt').value).getTime() : null,
    reminderNote: document.getElementById('clanReminderNote') ? document.getElementById('clanReminderNote').value.trim() : '',
    linkUrl: document.getElementById('clanLinkUrl') ? document.getElementById('clanLinkUrl').value.trim() : '',
    linkLabel: document.getElementById('clanLinkLabel') ? document.getElementById('clanLinkLabel').value.trim() : ''
  };
  const res = await api(`/api/groups/${encodeURIComponent(clanId)}/post`, 'POST', payload);
  if (res && res.success) {
    if (input) input.value = '';
    if (mentionsEl) mentionsEl.value = '';
    selectedClanPostImageDataUrl = null;
    const clanImageInput = document.getElementById('clanPostImage');
    if (clanImageInput) clanImageInput.value = '';
    ['clanPostCaption', 'clanQuizQuestion', 'clanQuizCorrectIndex', 'clanReminderAt', 'clanReminderNote', 'clanLinkUrl', 'clanLinkLabel']
      .forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
    document.querySelectorAll('.clanQuizOption').forEach((el) => { el.value = ''; });
    showToast('Clan post shared');
    loadClanManagementPage();
  } else {
    showToast(res.error || 'Unable to post to clan', 'error');
  }
}

function escapeWithMentionsAndLinks(text) {
  const escaped = escapeHtml(text || '');
  const mentionized = escaped.replace(/(^|\s)@([a-zA-Z0-9_.-]{2,32})/g, '$1<span class="mention-tag">@$2</span>');
  return mentionized.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

function renderClanPostCard(post) {
  const type = String(post.post_type || 'message');
  const mentions = (() => {
    try {
      const parsed = JSON.parse(post.mentions || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  })();
  const mentionsHtml = mentions.length ? `<div class="muted">Mentions: ${mentions.map((m) => `<span class="mention-tag">@${escapeHtml(m)}</span>`).join(' ')}</div>` : '';
  const reminderHtml = type === 'reminder' && post.reminder_at ? `<div class="reminder-chip">${formatReminder(post.reminder_at)} ${post.reminder_note ? `- ${escapeHtml(post.reminder_note)}` : ''}</div>` : '';
  const linkHtml = type === 'link' && post.link_url ? `<div><a href="${escapeHtml(post.link_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(post.link_label || post.link_url)}</a></div>` : '';
  let quizHtml = '';
  if (type === 'quiz') {
    const options = parseQuizOptions(post.quiz_options);
    quizHtml = `<div class="quiz-box"><div class="quiz-question">${escapeHtml(post.quiz_question || '')}</div>${options.map((o, idx) => `<div class="muted">${idx + 1}. ${escapeHtml(o)}</div>`).join('')}</div>`;
  }
  return `<div class="post">
    <div class="meta">${escapeHtml(post.name || post.username)} - ${formatDateTime(post.created_at)} - ${escapeHtml(type)}</div>
    <div>${escapeWithMentionsAndLinks(post.content || '')}</div>
    ${post.image ? `<img class="post-image" src="${post.image}" alt="Clan post image" loading="lazy" />` : ''}
    ${post.caption ? `<div>${escapeWithMentionsAndLinks(post.caption)}</div>` : ''}
    ${mentionsHtml}
    ${reminderHtml}
    ${linkHtml}
    ${quizHtml}
  </div>`;
}

function setClanPostTypeUi() {
  const typeEl = document.getElementById('clanPostType');
  if (!typeEl) return;
  const type = typeEl.value;
  const visibilityMap = [
    ['clanImageFields', type === 'image'],
    ['clanQuizFields', type === 'quiz'],
    ['clanReminderFields', type === 'reminder'],
    ['clanLinkFields', type === 'link']
  ];
  visibilityMap.forEach(([id, show]) => {
    const node = document.getElementById(id);
    if (node) node.classList.toggle('hidden', !show);
  });
}

async function handleClanPostImageSelection(e) {
  const file = e.target && e.target.files ? e.target.files[0] : null;
  if (!file) {
    selectedClanPostImageDataUrl = null;
    updateFileNameChip(e.target);
    return;
  }
  if (!file.type.startsWith('image/')) {
    showToast('Select a valid image file', 'error');
    e.target.value = '';
    updateFileNameChip(e.target);
    return;
  }
  if (file.size > 4 * 1024 * 1024) {
    showToast('Image must be less than 4MB', 'error');
    e.target.value = '';
    updateFileNameChip(e.target);
    return;
  }
  const reader = new FileReader();
  reader.onload = (evt) => {
    selectedClanPostImageDataUrl = evt.target.result;
    showToast('Image attached');
  };
  reader.onerror = () => showToast('Unable to read image', 'error');
  reader.readAsDataURL(file);
}

async function renderClanInvitePanel({ clanId, isActiveMember, hasPermission, invite }) {
  const panel = document.getElementById('clanInvitePanel');
  if (!panel) return;
  if (!isActiveMember) {
    panel.innerHTML = '<div class="muted">Join this clan to create invite links.</div>';
    return;
  }
  if (!hasPermission('manage_invites')) {
    panel.innerHTML = '<div class="muted">Invite link creation is limited to members with invite permission.</div>';
    return;
  }
  const inviteUrl = invite && invite.token ? `${location.origin}/clan.html?id=${encodeURIComponent(clanId)}&invite=${encodeURIComponent(invite.token)}` : '';
  panel.innerHTML = `<div class="tool-group">
      <label class="tool-label">Expiry (hours)</label>
      <input id="clanInviteTtlHours" type="number" min="1" max="168" value="72" />
    </div>
    <div class="tool-group">
      <label class="tool-label">Max Uses (0 = unlimited)</label>
      <input id="clanInviteMaxUses" type="number" min="0" max="500" value="0" />
    </div>
    <div class="row" style="justify-content:flex-start">
      <button id="createClanInviteBtn" class="btn tiny-btn" type="button">Generate Invite</button>
    </div>
    <div id="clanInviteUrlBox" class="muted">${inviteUrl ? `Current: <a target="_blank" rel="noopener noreferrer" href="${inviteUrl}">${inviteUrl}</a>` : 'No invite generated yet.'}</div>`;
  const createBtn = document.getElementById('createClanInviteBtn');
  if (!createBtn) return;
  createBtn.addEventListener('click', async () => {
    const ttl = Number(document.getElementById('clanInviteTtlHours').value) || 72;
    const maxUses = Number(document.getElementById('clanInviteMaxUses').value) || 0;
    const res = await api(`/api/groups/${encodeURIComponent(clanId)}/invite`, 'POST', { ttlHours: ttl, maxUses });
    if (res && res.success) {
      const box = document.getElementById('clanInviteUrlBox');
      if (box) box.innerHTML = `Current: <a target="_blank" rel="noopener noreferrer" href="${escapeHtml(res.inviteUrl)}">${escapeHtml(res.inviteUrl)}</a>`;
      if (navigator.clipboard && res.inviteUrl) navigator.clipboard.writeText(res.inviteUrl).catch(() => null);
      showToast('Invite link generated and copied');
    } else {
      showToast(res.error || 'Unable to generate invite link', 'error');
    }
  });
}

async function renderClanRolePanel({ clanId, isActiveMember, hasPermission }) {
  const panel = document.getElementById('clanRolePanel');
  if (!panel) return;
  if (!isActiveMember || !hasPermission('manage_roles')) {
    panel.innerHTML = '<div class="muted">Role management is available for authorized admins.</div>';
    return;
  }
  const permissions = [
    'manage_members',
    'remove_members',
    'manage_requests',
    'manage_posts',
    'manage_roles',
    'manage_invites',
    'post_messages',
    'post_quiz',
    'post_reminder',
    'post_links',
    'access_lounge'
  ];
  const rolesRes = await api(`/api/groups/${encodeURIComponent(clanId)}/roles`);
  const roleOptions = (rolesRes.roles || []).map((r) => `<div class="muted">#${r.id} - ${escapeHtml(r.name)}: ${(r.permissions || []).join(', ')}</div>`).join('');
  panel.innerHTML = `<div class="muted">Custom roles</div>${roleOptions || '<div class="muted">No custom roles yet.</div>'}
    <div class="tool-group section-gap">
      <label class="tool-label">New Custom Role Name</label>
      <input id="newClanRoleName" type="text" maxlength="30" placeholder="Example: Senior Coordinator" />
    </div>
    <div class="tool-group">
      <label class="tool-label">Permissions (comma separated)</label>
      <input id="newClanRolePermissions" type="text" value="${permissions.join(',')}" />
    </div>
    <div class="row" style="justify-content:flex-start">
      <button id="createClanRoleBtn" class="btn tiny-btn" type="button">Create Custom Role</button>
    </div>`;
  const createBtn = document.getElementById('createClanRoleBtn');
  if (!createBtn) return;
  createBtn.addEventListener('click', async () => {
    const roleName = document.getElementById('newClanRoleName').value.trim();
    const selectedPerms = document.getElementById('newClanRolePermissions').value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    const res = await api(`/api/groups/${encodeURIComponent(clanId)}/roles`, 'POST', { name: roleName, permissions: selectedPerms });
    if (res && res.success) {
      showToast('Custom role created');
      loadClanManagementPage();
    } else {
      showToast(res.error || 'Unable to create custom role', 'error');
    }
  });
}

async function loadClanLounge(clanId) {
  const box = document.getElementById('clanLoungeMessages');
  if (!box) return;
  const res = await api(`/api/groups/${encodeURIComponent(clanId)}/lounge`);
  if (res.error) {
    box.innerHTML = `<div class="muted">${escapeHtml(res.error)}</div>`;
    return;
  }
  const messages = Array.isArray(res.messages) ? res.messages : [];
  if (!messages.length) {
    box.innerHTML = '<div class="muted">No lounge messages yet.</div>';
    return;
  }
  box.innerHTML = messages.map((m) => `<div class="post">
    <div class="meta">${escapeHtml(m.name || m.username)} - ${formatDateTime(m.created_at)}</div>
    <div>${escapeWithMentionsAndLinks(m.content || '')}</div>
  </div>`).join('');
}

async function handleClanLoungeSubmit(e) {
  e.preventDefault();
  const clanId = new URLSearchParams(window.location.search).get('id');
  const input = document.getElementById('clanLoungeInput');
  const content = input ? input.value.trim() : '';
  if (!clanId || !content) return;
  const res = await api(`/api/groups/${encodeURIComponent(clanId)}/lounge`, 'POST', { content });
  if (res && res.success) {
    if (input) input.value = '';
    loadClanLounge(clanId);
  } else {
    showToast(res.error || 'Unable to send lounge message', 'error');
  }
}

async function suggestSpeciality() {
  const input = document.getElementById('specialitySuggestionInput');
  const suggestion = input ? input.value.trim() : '';
  if (!suggestion) {
    showToast('Enter a speciality suggestion first', 'error');
    return;
  }
  const res = await api('/api/speciality/suggest', 'POST', { suggestion });
  if (res && res.success) {
    if (input) input.value = '';
    showToast('Speciality suggestion submitted');
  } else {
    showToast(res.error || 'Unable to submit suggestion', 'error');
  }
}

async function handleVerifyEmailPage() {
  const statusEl = document.getElementById('verifyEmailStatus');
  if (!statusEl) return;
  const token = new URLSearchParams(window.location.search).get('token');
  if (!token) {
    statusEl.textContent = 'Verification token is missing.';
    return;
  }
  const res = await api(`/api/verify-email?token=${encodeURIComponent(token)}`);
  if (res && res.success) {
    statusEl.textContent = 'Email verified successfully. You can now log in.';
  } else {
    statusEl.textContent = res.error || 'Unable to verify email.';
  }
}

async function loadPublicProfilePage() {
  const profileBox = document.getElementById('publicProfileBox');
  const feedBox = document.getElementById('publicProfileFeed');
  const actionsBox = document.getElementById('publicProfileActions');
  const reportWrap = document.getElementById('reportUserFormWrap');
  if (!profileBox || !feedBox) return;
  const userId = new URLSearchParams(window.location.search).get('id');
  if (!userId) {
    profileBox.innerHTML = '<div class="muted">Invalid user profile.</div>';
    return;
  }
  const meRes = await api('/api/me');
  const me = meRes.user || null;
  const userRes = await api(`/api/user/${encodeURIComponent(userId)}`);
  if (userRes.error || !userRes.user) {
    profileBox.innerHTML = `<div class="muted">${escapeHtml(userRes.error || 'User not found')}</div>`;
    return;
  }
  const u = userRes.user;
  const relation = u.relationship || {};
  profileBox.innerHTML = `<img src="${getProfilePictureUrl(u)}" class="profile-picture" />
    <h3>${escapeHtml(u.name || u.username)}${u.nickname ? ` <span class="muted">(${escapeHtml(u.nickname)})</span>` : ''}</h3>
    <p class="muted">@${escapeHtml(u.username || '')}</p>
    <p class="muted">${escapeHtml(formatGenderLabel(u.gender))}${u.date_of_birth ? ` | DOB: ${escapeHtml(u.date_of_birth)}` : ''}</p>
    <p class="muted">Status: ${u.online_visible ? (u.online ? 'Online' : 'Offline') : 'Hidden'}</p>
    <p class="muted">${escapeHtml(u.place_from || '')}</p>
    <p class="muted">${escapeHtml(u.status_description || '')}</p>
    <p class="muted">${escapeHtml(u.achievements || '')}</p>
    <p class="muted">${escapeHtml(u.bio || '')}</p>
    <p class="muted">${escapeHtml(u.speciality || '')}</p>
    <p class="muted">${escapeHtml(u.institute || '')}</p>
    <p class="muted">Connections: ${u.connections_count || 0}</p>`;
  if (actionsBox) {
    actionsBox.innerHTML = '';
    const isSelf = me && Number(me.id) === Number(u.id);
    if (!isSelf) {
      const connectLabel = relation.connectionStatus === 'accepted'
        ? 'Disconnect'
        : (relation.connectionStatus === 'pending'
          ? (relation.connectionRequestedByMe ? 'Cancel Request' : 'Pending')
          : 'Connect');
      const connectBtn = createActionButton(connectLabel, async () => {
        setLoading(connectBtn, true);
        let actionRes;
        if (relation.connectionStatus === 'accepted') actionRes = await api('/api/connect/disconnect', 'POST', { userId: u.id });
        else if (relation.connectionStatus === 'pending' && relation.connectionRequestedByMe && relation.connectionId) actionRes = await api('/api/connect/cancel', 'POST', { id: relation.connectionId });
        else actionRes = await api('/api/connect/request', 'POST', { to: u.id, viaProfileLink: true });
        setLoading(connectBtn, false);
        if (actionRes && actionRes.success) loadPublicProfilePage();
        else showToast(actionRes.error || 'Unable to update connection', 'error');
      }, 'btn tiny-btn');
      if (relation.connectionStatus === 'pending' && !relation.connectionRequestedByMe) connectBtn.disabled = true;

      const followBtn = createActionButton(relation.following ? 'Unfollow' : 'Follow', async () => {
        const r = await api('/api/follow/toggle', 'POST', { userId: u.id });
        if (r && r.success) loadPublicProfilePage();
        else showToast(r.error || 'Unable to update follow', 'error');
      }, 'btn tiny-btn');

      const shareBtn = createActionButton('Share', async () => {
        const profileUrl = `${location.origin}/user-profile.html?id=${encodeURIComponent(u.id)}`;
        try {
          await navigator.clipboard.writeText(profileUrl);
          showToast('Profile link copied');
        } catch (e) {
          showToast(profileUrl);
        }
      }, 'btn tiny-btn');

      const blockBtn = createActionButton(relation.blockedByMe ? 'Unblock' : 'Block', async () => {
        const r = await api('/api/block/toggle', 'POST', { userId: u.id, reason: relation.blockedByMe ? '' : 'user action' });
        if (r && r.success) loadPublicProfilePage();
        else showToast(r.error || 'Unable to update block', 'error');
      }, 'btn secondary tiny-btn');

      actionsBox.appendChild(connectBtn);
      actionsBox.appendChild(followBtn);
      actionsBox.appendChild(shareBtn);
      actionsBox.appendChild(blockBtn);

      if (reportWrap) {
        reportWrap.innerHTML = `<select id="reportCategory">
            <option value="">Report category</option>
            <option value="spam">Spam</option>
            <option value="harassment">Harassment</option>
            <option value="impersonation">Impersonation</option>
            <option value="other">Other</option>
          </select>
          <textarea id="reportDetails" maxlength="400" placeholder="Describe the issue"></textarea>
          <button id="reportUserBtn" class="btn secondary tiny-btn" type="button">Report User</button>`;
        const reportBtn = document.getElementById('reportUserBtn');
        if (reportBtn) {
          reportBtn.addEventListener('click', async () => {
            const categoryEl = document.getElementById('reportCategory');
            const detailsEl = document.getElementById('reportDetails');
            const category = categoryEl ? categoryEl.value.trim() : '';
            const details = detailsEl ? detailsEl.value.trim() : '';
            if (!category) {
              showToast('Select report category', 'error');
              return;
            }
            const r = await api('/api/report/user', 'POST', { userId: u.id, category, details });
            if (r && r.success) showToast('Report submitted');
            else showToast(r.error || 'Unable to report user', 'error');
          });
        }
      }
    } else if (reportWrap) {
      reportWrap.innerHTML = '';
    }
  }
  feedBox.innerHTML = '<div class="muted">Loading posts...</div>';
  const postsRes = await api(`/api/user/${encodeURIComponent(userId)}/posts`);
  if (postsRes.error) {
    feedBox.innerHTML = `<div class="muted">${escapeHtml(postsRes.error)}</div>`;
    return;
  }
  if (!postsRes.posts || !postsRes.posts.length) {
    feedBox.innerHTML = '<div class="muted">No visible posts for this profile.</div>';
    return;
  }
  feedBox.innerHTML = '';
  postsRes.posts.forEach((p) => {
    const el = document.createElement('div');
    el.className = 'post';
    el.innerHTML = `<div class="meta">${formatDateTime(p.created_at)} - ${escapeHtml(p.visibility || 'public')}</div><div>${escapeHtml(p.content || '')}</div>`;
    if (p.image) {
      const img = document.createElement('img');
      img.className = 'post-image';
      img.src = p.image;
      img.alt = 'Post image';
      el.appendChild(img);
    }
    feedBox.appendChild(el);
  });
}

async function acceptRequest(id) {
  const res = await api('/api/connect/accept','POST',{id});
  if (res && res.success) { 
    loadConnectionPanels();
    showToast('Connection accepted!');
  } else {
    showToast(res.error||'Unable to accept', 'error');
  }
}

async function declineRequest(id) {
  const res = await api('/api/connect/decline','POST',{id});
  if (res && res.success) { 
    loadConnectionPanels();
    showToast('Request ignored');
  } else {
    showToast(res.error||'Unable to decline', 'error');
  }
}

async function cancelRequest(id) {
  const res = await api('/api/connect/cancel', 'POST', { id });
  if (res && res.success) {
    loadConnectionPanels();
    showToast('Request cancelled');
  } else {
    showToast(res.error || 'Unable to cancel request', 'error');
  }
}

async function unignoreRequest(id) {
  const res = await api('/api/connect/unignore', 'POST', { id });
  if (res && res.success) {
    loadConnectionPanels();
    showToast('Removed from ignored');
  } else {
    showToast(res.error || 'Unable to update ignored request', 'error');
  }
}

function renderPersonCard(person, actionsHtml) {
  return `<div class="person-card">
    <div class="person-card-main">
      <img src="${getProfilePictureUrl(person)}" class="person-card-avatar" loading="lazy" />
      <div class="person-card-meta">
        <div class="person-card-name">${escapeHtml(person.name || person.username || 'Unknown')}</div>
        <div class="muted person-card-handle">@${escapeHtml(person.username || '')}</div>
      </div>
    </div>
    <div class="person-card-actions">${actionsHtml}</div>
  </div>`;
}

async function loadConnectionPanels() {
  const acceptedBox = document.getElementById('connections');
  const receivedBox = document.getElementById('receivedRequests');
  const sentBox = document.getElementById('sentRequests');
  const ignoredBox = document.getElementById('ignoredRequests');
  const suggestionsBox = document.getElementById('connectionSuggestions');
  if (!acceptedBox) return;

  [acceptedBox, receivedBox, sentBox, ignoredBox, suggestionsBox].forEach((box) => {
    if (box) box.innerHTML = '<div class="muted center" style="padding:12px">Loading...</div>';
  });

  const res = await api('/api/connections/overview');
  if (res.error) {
    [acceptedBox, receivedBox, sentBox, ignoredBox, suggestionsBox].forEach((box) => {
      if (box) box.innerHTML = `<div class="muted">${escapeHtml(res.error || 'Unable to load connections')}</div>`;
    });
    return;
  }

  const accepted = Array.isArray(res.accepted) ? res.accepted : [];
  const received = Array.isArray(res.received) ? res.received : [];
  const sent = Array.isArray(res.sent) ? res.sent : [];
  const ignored = Array.isArray(res.ignored) ? res.ignored : [];
  const suggestions = Array.isArray(res.suggestions) ? res.suggestions : [];

  acceptedBox.innerHTML = accepted.length ? accepted.map((c) => {
    const statusText = c.online_visible ? (c.online ? 'Online' : 'Offline') : 'Hidden';
    const statusClass = c.online_visible ? (c.online ? 'status-online' : 'status-offline') : 'status-offline';
    const chatLabel = (c.name || c.username || '').replace(/'/g, "\\'");
    const chatAvatar = (c.profile_picture || '').replace(/'/g, "\\'");
    connectionPresenceMap.set(Number(c.id), Boolean(c.online));
    return renderPersonCard(c, `<div class="post-actions">
      <div class="connection-status ${statusClass}">${statusText}</div>
      <button class="btn primary chat-open-btn" style="font-size:12px;padding:8px 12px" onclick="openChat(${c.id}, '${chatLabel}', ${c.online ? 'true' : 'false'}, '${chatAvatar}')"></button>
    </div>`);
  }).join('') : '<div class="muted" style="text-align:center;padding:16px">No connections yet.</div>';

  if (receivedBox) {
    receivedBox.innerHTML = received.length ? received.map((r) => renderPersonCard(r, `<div class="post-actions">
      <button class="btn" style="font-size:12px;padding:8px 12px" onclick="acceptRequest(${r.id})">Accept</button>
      <button class="btn secondary" style="font-size:12px;padding:8px 12px" onclick="declineRequest(${r.id})">Ignore</button>
    </div>`)).join('') : '<div class="muted" style="text-align:center;padding:16px">No received requests.</div>';
  }

  if (sentBox) {
    sentBox.innerHTML = sent.length ? sent.map((r) => renderPersonCard(r, `<button class="btn secondary" style="font-size:12px;padding:8px 12px" onclick="cancelRequest(${r.id})">Cancel</button>`)).join('') : '<div class="muted" style="text-align:center;padding:16px">No sent requests.</div>';
  }

  if (ignoredBox) {
    ignoredBox.innerHTML = ignored.length ? ignored.map((r) => renderPersonCard(r, `<div class="post-actions">
      <button class="btn secondary" style="font-size:12px;padding:8px 12px" onclick="unignoreRequest(${r.id})">Remove</button>
      <button class="btn" style="font-size:12px;padding:8px 12px" onclick="api('/api/connect/request','POST',{to:${Number(r.user_id)}}).then(()=>loadConnectionPanels())">Connect Again</button>
    </div>`)).join('') : '<div class="muted" style="text-align:center;padding:16px">No declined requests.</div>';
  }

  if (suggestionsBox) {
    suggestionsBox.innerHTML = suggestions.length ? suggestions.map((s) => renderPersonCard(s, `<button class="btn" style="font-size:12px;padding:8px 12px" onclick="api('/api/connect/request','POST',{to:${Number(s.id)}}).then((x)=>{ if(x&&x.success){showToast('Request sent');loadConnectionPanels();} else {showToast((x&&x.error)||'Unable to send request','error');}})">Connect</button>`)).join('') : '<div class="muted" style="text-align:center;padding:16px">No suggestions right now.</div>';
  }
  acceptedBox.querySelectorAll('.chat-open-btn').forEach((btn) => setActionButtonLabel(btn, 'Chat', 'chat'));
  applyIconifyAudit();
}

// Backward-compatible wrappers used elsewhere
async function loadConnections() {
  return loadConnectionPanels();
}

async function loadRequests() {
  return loadConnectionPanels();
}

async function loadLeaderboard() {
  const box = document.getElementById('leaderboard');
  if (!box) return;
  const res = await api('/api/leaderboard');
  if (res.error) {
    box.innerHTML = '<div class="muted">Unable to load leaderboard</div>';
    return;
  }
  if (!res.users || !res.users.length) {
    box.innerHTML = '<div class="muted">No users yet</div>';
    return;
  }
  box.innerHTML = '';
  res.users.slice(0, 8).forEach((u, idx) => {
    const row = document.createElement('div');
    row.className = 'leader-row';
    const clanCell = u.clan_id ? `<a href="/clan.html?id=${encodeURIComponent(u.clan_id)}">${escapeHtml(u.clan_name || 'Clan')}</a>` : `<span class="muted">${escapeHtml(u.clan_name || 'No clan')}</span>`;
    row.innerHTML = `<span>#${idx + 1}</span>
      <span><a href="/user-profile.html?id=${encodeURIComponent(u.id)}">${escapeHtml(u.name || u.username)}</a></span>
      <span>L${u.level || 1}</span>
      <span>${u.xp || 0} XP</span>
      <span>${clanCell}</span>`;
    box.appendChild(row);
  });
}

async function loadGroups() {
  const box = document.getElementById('groupsList');
  if (!box) return;
  const res = await api('/api/groups');
  if (res.error) {
    box.innerHTML = '<div class="muted">Unable to load groups</div>';
    return;
  }
  if (!res.groups || !res.groups.length) {
    box.innerHTML = '<div class="muted">No clans yet. Create one.</div>';
    return;
  }
  const myGroups = Array.isArray(res.myGroups) ? res.myGroups : [];
  const suggested = Array.isArray(res.suggestions) ? res.suggestions : [];
  box.innerHTML = '';
  if (myGroups.length) {
    const title = document.createElement('div');
    title.className = 'muted';
    title.style.marginBottom = '0.4rem';
    title.textContent = 'Your Clans';
    box.appendChild(title);
  }
  const renderClanCard = (g) => {
    const card = document.createElement('div');
    card.className = 'group-item';
    const privacy = Number(g.is_private) === 1 ? 'Private' : 'Public';
    const myState = g.my_status === 'active' ? 'Joined' : (g.my_status === 'pending' ? 'Requested' : 'Not joined');
    card.innerHTML = `<div class="group-top"><strong>${escapeHtml(g.name)}</strong><span class="muted">${privacy}</span></div>
      <div class="muted">${escapeHtml(g.description || '')}</div>
      <div class="muted">Members: ${g.member_count || 0} | Clan Level: ${g.clan_level || 1} | Clan XP: ${g.clan_xp || 0}</div>
      <div class="muted">${myState}${g.my_role ? ` | ${g.my_role}` : ''}</div>`;
    const actions = document.createElement('div');
    actions.className = 'post-actions';
    if (g.profile_picture) {
      const pic = document.createElement('img');
      pic.src = g.profile_picture;
      pic.alt = 'Clan picture';
      pic.style.width = '42px';
      pic.style.height = '42px';
      pic.style.objectFit = 'cover';
      pic.style.borderRadius = '10px';
      pic.style.border = '1px solid var(--line)';
      card.prepend(pic);
    }
    const isActiveMember = g.my_status === 'active';
    const canManage = isActiveMember && ['admin', 'moderator'].includes(String(g.my_role || ''));
    const openBtn = createActionButton('Open', async () => {
      if (!isActiveMember) {
        location.href = `/clan.html?id=${encodeURIComponent(g.id)}`;
        return;
      }
      selectedGroupId = g.id;
      selectedGroupRole = g.my_role || null;
      const title = document.getElementById('groupFeedTitle');
      if (title) title.textContent = `Clan Space - ${g.name}`;
      await loadGroupFeed();
      await loadGroupRequests();
    });
    actions.appendChild(openBtn);
    if (canManage) {
      const manageBtn = createActionButton('Manage Clan', () => {
        location.href = `/clan.html?id=${encodeURIComponent(g.id)}`;
      }, 'btn tiny-btn');
      actions.appendChild(manageBtn);
    }
    if (!g.my_status) {
      const joinBtn = createActionButton('Join', async () => {
        const joinRes = await api(`/api/groups/${g.id}/join`, 'POST', {});
        if (joinRes && joinRes.success) {
          showToast(joinRes.status === 'active' ? 'Joined clan' : 'Join request sent');
          loadGroups();
        } else {
          showToast(joinRes.error || 'Unable to join clan', 'error');
        }
      }, 'btn tiny-btn');
      actions.appendChild(joinBtn);
    }
    card.appendChild(actions);
    box.appendChild(card);
  };
  myGroups.forEach(renderClanCard);
  if (suggested.length) {
    const title = document.createElement('div');
    title.className = 'muted';
    title.style.margin = '0.5rem 0 0.4rem';
    title.textContent = 'Suggested Clans';
    box.appendChild(title);
    suggested.forEach(renderClanCard);
  }
}

async function loadGroupFeed() {
  const box = document.getElementById('groupFeed');
  if (!box) return;
  if (!selectedGroupId) {
    box.innerHTML = '<div class="muted">Select a clan from the left panel to view posts.</div>';
    return;
  }
  box.innerHTML = '<div class="muted">Loading clan posts...</div>';
  const res = await api(`/api/groups/${selectedGroupId}/feed`);
  if (res.error) {
    box.innerHTML = `<div class="muted">${escapeHtml(res.error)}</div>`;
    return;
  }
  if (!res.posts || !res.posts.length) {
    box.innerHTML = '<div class="muted">No clan posts yet.</div>';
    return;
  }
  box.innerHTML = '';
  const meId = window.__me ? window.__me.id : null;
  res.posts.forEach((p) => {
    const el = document.createElement('div');
    el.className = 'post';
    el.innerHTML = `<div class="meta">${escapeHtml(p.name || p.username)} - ${formatDateTime(p.created_at)}</div><div>${escapeHtml(p.content)}</div>`;
    const canDelete = meId && (Number(p.user_id) === Number(meId) || ['admin', 'moderator'].includes(selectedGroupRole));
    if (canDelete) {
      const actions = document.createElement('div');
      actions.className = 'post-actions';
      const delBtn = createActionButton('Delete', () => {}, 'btn secondary tiny-btn');
      delBtn.addEventListener('click', async () => {
        const ok = window.confirm('Delete this clan post?');
        if (!ok) return;
        setLoading(delBtn, true);
        const deleteRes = await api(`/api/groups/${p.group_id}/post/${p.id}`, 'DELETE');
        setLoading(delBtn, false);
        if (deleteRes && deleteRes.success) {
          el.remove();
          showToast('Clan post deleted');
        } else {
          showToast(deleteRes.error || 'Unable to delete clan post', 'error');
        }
      });
      actions.appendChild(delBtn);
      el.appendChild(actions);
    }
    box.appendChild(el);
  });
}

async function loadGroupRequests() {
  const box = document.getElementById('groupPendingRequests');
  if (!box) return;
  box.innerHTML = '';
  if (!selectedGroupId) return;
  const res = await api(`/api/groups/${selectedGroupId}/requests`);
  if (res.error) return;
  if (!res.requests || !res.requests.length) return;
  box.innerHTML = '<h4>Pending Requests</h4>';
  res.requests.forEach((r) => {
    const row = document.createElement('div');
    row.className = 'request-item';
    row.innerHTML = `<span>${escapeHtml(r.name || r.username)}</span>`;
    const approveBtn = createActionButton('Approve', async () => {
      const actionRes = await api(`/api/groups/${selectedGroupId}/requests/${r.id}`, 'POST', { action: 'approve' });
      if (actionRes && actionRes.success) {
        loadGroupRequests();
        loadGroups();
      } else {
        showToast(actionRes.error || 'Unable to approve', 'error');
      }
    }, 'btn tiny-btn');
    const rejectBtn = createActionButton('Reject', async () => {
      const actionRes = await api(`/api/groups/${selectedGroupId}/requests/${r.id}`, 'POST', { action: 'reject' });
      if (actionRes && actionRes.success) {
        loadGroupRequests();
      } else {
        showToast(actionRes.error || 'Unable to reject', 'error');
      }
    }, 'btn secondary tiny-btn');
    row.appendChild(approveBtn);
    row.appendChild(rejectBtn);
    box.appendChild(row);
  });
}

async function handleGroupCreate(e) {
  e.preventDefault();
  const nameEl = document.getElementById('groupName');
  const descEl = document.getElementById('groupDescription');
  const privateEl = document.getElementById('groupPrivate');
  const name = nameEl ? nameEl.value.trim() : '';
  const description = descEl ? descEl.value.trim() : '';
  if (!name) {
    showToast('Clan name is required', 'error');
    return;
  }
  const res = await api('/api/groups', 'POST', { name, description, isPrivate: privateEl ? privateEl.checked : true });
  if (res && res.success) {
    if (nameEl) nameEl.value = '';
    if (descEl) descEl.value = '';
    showToast('Clan created');
    loadGroups();
    loadProfile();
  } else {
    showToast(res.error || 'Unable to create clan', 'error');
  }
}

async function handleGroupPost(e) {
  e.preventDefault();
  if (!selectedGroupId) {
    showToast('Select a clan first', 'error');
    return;
  }
  const input = document.getElementById('groupPostContent');
  const content = input ? input.value.trim() : '';
  if (!content) return;
  const res = await api(`/api/groups/${selectedGroupId}/post`, 'POST', { content });
  if (res && res.success) {
    if (input) input.value = '';
    showToast('Posted to clan');
    loadGroupFeed();
    loadProfile();
  } else {
    showToast(res.error || 'Unable to post to clan', 'error');
  }
}

async function handleChangePassword(e) {
  e.preventDefault();
  const form = e.target;
  const currentEl = document.getElementById('currentPassword');
  const nextEl = document.getElementById('newPassword');
  const confirmEl = document.getElementById('confirmNewPassword');
  const currentPassword = currentEl ? currentEl.value.trim() : '';
  const newPassword = nextEl ? nextEl.value.trim() : '';
  const confirmPassword = confirmEl ? confirmEl.value.trim() : '';
  if (!currentPassword || !newPassword || !confirmPassword) {
    showToast('Please fill all password fields', 'error');
    return;
  }
  if (newPassword.length < 6) {
    showToast('New password must be at least 6 characters', 'error');
    return;
  }
  if (newPassword !== confirmPassword) {
    showToast('New password and confirm password do not match', 'error');
    return;
  }
  const submitBtn = form.querySelector('button[type="submit"]');
  setLoading(form, true);
  if (submitBtn) submitBtn.textContent = 'Updating...';
  const res = await api('/api/change-password', 'POST', { currentPassword, newPassword });
  setLoading(form, false);
  if (submitBtn) submitBtn.textContent = 'Update Password';
  if (res && res.success) {
    if (currentEl) currentEl.value = '';
    if (nextEl) nextEl.value = '';
    if (confirmEl) confirmEl.value = '';
    showToast('Password updated');
    closePasswordModal();
  } else {
    showToast(res.error || 'Unable to change password', 'error');
  }
}

async function loadLevelDetails() {
  const box = document.getElementById('levelDetails');
  if (!box) return;
  const res = await api('/api/xp/levels');
  if (res.error || !res.levels) {
    box.innerHTML = '<div class="muted">Unable to load level details</div>';
    return;
  }
  box.innerHTML = '';
  res.levels.forEach((l) => {
    const row = document.createElement('div');
    row.className = 'leader-row';
    row.innerHTML = `<span>L${l.level}</span><span>${escapeHtml(l.title)}</span><span>Min XP</span><span>${l.minXp}</span>`;
    box.appendChild(row);
  });
}

function openPasswordModal() {
  const modal = document.getElementById('passwordModal');
  if (!modal) return;
  const form = document.getElementById('changePasswordForm');
  if (form) form.classList.add('hidden');
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function closePasswordModal() {
  const modal = document.getElementById('passwordModal');
  if (!modal) return;
  const form = document.getElementById('changePasswordForm');
  if (form) form.classList.add('hidden');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

function initConnectionTabs() {
  const tabBtns = Array.from(document.querySelectorAll('.conn-tab-btn'));
  if (!tabBtns.length) return;
  const map = {
    accepted: 'connectionsPanelAccepted',
    received: 'connectionsPanelReceived',
    sent: 'connectionsPanelSent',
    ignored: 'connectionsPanelIgnored',
    suggestions: 'connectionsPanelSuggestions'
  };
  const activate = (tab) => {
    tabBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tab));
    Object.keys(map).forEach((key) => {
      const panel = document.getElementById(map[key]);
      if (!panel) return;
      panel.classList.toggle('hidden', key !== tab);
    });
  };
  tabBtns.forEach((btn) => btn.addEventListener('click', () => activate(btn.dataset.tab || 'accepted')));
  activate('accepted');
}

function initProfileSettingsModal() {
  const settingsBtn = document.getElementById('openSettingsBtn');
  if (settingsBtn) settingsBtn.onclick = openPasswordModal;
  const changePicBtn = document.getElementById('settingsChangePicBtn');
  if (changePicBtn) {
    changePicBtn.onclick = () => {
      const picInput = document.getElementById('picInput');
      if (!picInput) {
        showToast('Profile panel not ready', 'error');
        return;
      }
      picInput.click();
    };
  }
  const privacyBtn = document.getElementById('settingsPrivacyBtn');
  if (privacyBtn) privacyBtn.onclick = () => { location.href = '/profile#privacy'; };
  const changePassBtn = document.getElementById('settingsChangePassBtn');
  if (changePassBtn) {
    changePassBtn.onclick = () => {
      const form = document.getElementById('changePasswordForm');
      if (form) form.classList.toggle('hidden');
    };
  }
}

function upsertSavedListsTopButton(user) {
  const actions = document.querySelector('.actions');
  if (!actions) return;
  const existing = document.getElementById('savedListsMenuBtn');
  const isAuthenticated = Boolean(user && user.id);
  if (!isAuthenticated) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;
  const anchor = document.createElement('a');
  anchor.id = 'savedListsMenuBtn';
  anchor.className = 'btn';
  anchor.href = '/profile#savedPostsSection';
  anchor.textContent = 'Saved Lists';
  const themeToggle = document.getElementById('themeToggle');
  if (themeToggle && themeToggle.parentElement === actions) {
    themeToggle.insertAdjacentElement('afterend', anchor);
  } else {
    actions.prepend(anchor);
  }
}

// open chat with userId
let socket = null;
let currentChatUser = null;
let chatMinimized = false;
let chatAttachmentDataUrl = null;
const connectionPresenceMap = new Map();
let currentChatName = '';
let currentChatAvatar = '';
function ensureSocket(userId) {
  if (socket) return socket;
  socket = io();
  socket.on('connect', async ()=>{
    // identify after connected
    const me = await api('/api/me');
    if (me.user) socket.emit('identify', me.user.id);
  });
  socket.on('message', (m)=>{
    const meId = window.__me ? Number(window.__me.id) : 0;
    const current = currentChatUser ? Number(currentChatUser) : 0;
    const from = Number(m && (m.from ?? m.from_user));
    const to = Number(m && (m.to ?? m.to_user));
    if (!meId || !current) return;
    const isCurrentThread = (from === meId && to === current) || (from === current && to === meId);
    if (!isCurrentThread) return;
    appendMessage(m);
  });
  socket.on('connectionRequest', (data)=>{
    // new request received
    console.log('new connection request:', data);
    loadRequests(); // reload requests
  });
  socket.on('postShared', ()=>{
    showToast('A connection shared a post with you');
  });
  socket.on('presenceUpdate', (payload) => {
    const userIdNum = Number(payload && payload.userId);
    if (!userIdNum) return;
    connectionPresenceMap.set(userIdNum, Boolean(payload.online));
    if (currentChatUser && Number(currentChatUser) === userIdNum) {
      setChatStatus(Boolean(payload.online));
    }
  });
  socket.on('chatError', (payload) => {
    showToast((payload && payload.error) || 'Chat error', 'error');
  });
  return socket;
}

function setChatStatus(isOnline) {
  const statusEl = document.getElementById('chatStatus');
  if (!statusEl) return;
  statusEl.textContent = isOnline ? 'Online' : 'Offline';
  statusEl.className = `meta ${isOnline ? 'status-online' : 'status-offline'}`;
}

function updateChatAttachmentHint(msg = '') {
  const hint = document.getElementById('chatAttachmentHint');
  if (!hint) return;
  const text = String(msg || '').trim();
  hint.textContent = text;
  hint.classList.toggle('hidden', !text);
}

function clearChatAttachment() {
  chatAttachmentDataUrl = null;
  const input = document.getElementById('chatImageInput');
  if (input) input.value = '';
  updateChatAttachmentHint('');
}

function setChatMinimized(minimized) {
  const panel = document.getElementById('chatPanel');
  const minBtn = document.getElementById('chatMinimizeBtn');
  if (!panel || !minBtn) return;
  chatMinimized = Boolean(minimized);
  panel.classList.toggle('minimized', chatMinimized);
  setActionButtonLabel(minBtn, chatMinimized ? 'Expand' : 'Minimize', chatMinimized ? 'open' : 'minimize');
}

function initChatControls() {
  const panel = document.getElementById('chatPanel');
  const minBtn = document.getElementById('chatMinimizeBtn');
  const closeBtn = document.getElementById('chatCloseBtn');
  const attachBtn = document.getElementById('chatAttachBtn');
  const imageInput = document.getElementById('chatImageInput');
  const sendBtn = document.getElementById('chatSendBtn');
  if (!panel || !minBtn || !closeBtn) return;
  setActionButtonLabel(minBtn, chatMinimized ? 'Expand' : 'Minimize', chatMinimized ? 'open' : 'minimize');
  setActionButtonLabel(closeBtn, 'Close', 'close');
  if (sendBtn) setActionButtonLabel(sendBtn, 'Send', 'send');
  if (attachBtn && !attachBtn.dataset.bound) {
    attachBtn.dataset.bound = '1';
    setActionButtonLabel(attachBtn, 'Attach', 'attach');
    attachBtn.addEventListener('click', () => {
      if (imageInput) imageInput.click();
    });
  }
  if (imageInput && !imageInput.dataset.bound) {
    imageInput.dataset.bound = '1';
    imageInput.addEventListener('change', () => {
      const file = imageInput.files && imageInput.files[0] ? imageInput.files[0] : null;
      if (!file) {
        clearChatAttachment();
        return;
      }
      if (!file.type.startsWith('image/')) {
        showToast('Only image attachments are supported', 'error');
        clearChatAttachment();
        return;
      }
      if (file.size > 100 * 1024) {
        showToast('Attachment must be 100KB or smaller', 'error');
        clearChatAttachment();
        return;
      }
      const reader = new FileReader();
      reader.onload = (evt) => {
        chatAttachmentDataUrl = evt.target && evt.target.result ? String(evt.target.result) : null;
        updateChatAttachmentHint(file.name);
      };
      reader.onerror = () => {
        showToast('Unable to read attachment', 'error');
        clearChatAttachment();
      };
      reader.readAsDataURL(file);
    });
  }
  if (!minBtn.dataset.bound) {
    minBtn.dataset.bound = '1';
    minBtn.addEventListener('click', () => setChatMinimized(!chatMinimized));
  }
  if (!closeBtn.dataset.bound) {
    closeBtn.dataset.bound = '1';
    closeBtn.addEventListener('click', () => {
      panel.style.display = 'none';
      currentChatUser = null;
      setChatMinimized(false);
      clearChatAttachment();
    });
  }
}

async function openChat(otherId, otherName, knownOnline = null, otherAvatar = '') {
  const meRes = await api('/api/me');
  if (!meRes.user) return alert('Please log in');
  const me = meRes.user;
  window.__me = me; // ensure current user is stored
  const a = Number(me.id), b = Number(otherId);
  const room = `chat:${Math.min(a,b)}:${Math.max(a,b)}`;
  currentChatUser = otherId;
  currentChatName = String(otherName || 'User');
  currentChatAvatar = String(otherAvatar || '');
  const chatPanel = document.getElementById('chatPanel');
  chatPanel.style.display='grid';
  setChatMinimized(false);
  const titleEl = document.getElementById('chatTitle');
  const avatarEl = document.getElementById('chatTitleAvatar');
  if (titleEl) {
    titleEl.textContent = `${otherName}`;
    titleEl.style.cursor = 'pointer';
    titleEl.title = `Open ${otherName}'s profile`;
    titleEl.onclick = () => { location.href = `/user-profile.html?id=${encodeURIComponent(otherId)}`; };
  }
  if (avatarEl) avatarEl.src = otherAvatar || getDefaultAvatarDataUri('');
  if (knownOnline !== null && knownOnline !== undefined) setChatStatus(Boolean(knownOnline));
  else if (connectionPresenceMap.has(Number(otherId))) setChatStatus(Boolean(connectionPresenceMap.get(Number(otherId))));
  else setChatStatus(false);
  document.getElementById('messages').innerHTML = '<div class="muted">Loading...</div>';
  clearChatAttachment();
  ensureSocket(me.id).emit('joinRoom', room);
  // load history
  const hist = await api(`/api/messages/${otherId}`);
  const box = document.getElementById('messages');
  box.innerHTML='';
  box.dataset.lastDateKey = '';
  if (hist.error) {
    box.innerHTML = `<div class="muted">${escapeHtml(hist.error)}</div>`;
    return;
  }
  (hist.messages||[]).forEach(m=>appendMessage(m));
}

function appendMessage(m){
  const box = document.getElementById('messages');
  if (!box) return;
  const ts = toTimestamp(m.created_at);
  const date = ts !== null ? new Date(ts) : new Date();
  const dateKey = `${date.getFullYear()}-${date.getMonth()+1}-${date.getDate()}`;
  if (box.dataset.lastDateKey !== dateKey) {
    const divider = document.createElement('div');
    divider.className = 'chat-date-divider';
    const now = new Date();
    const todayKey = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}`;
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yKey = `${yesterday.getFullYear()}-${yesterday.getMonth()+1}-${yesterday.getDate()}`;
    if (dateKey === todayKey) divider.textContent = 'Today';
    else if (dateKey === yKey) divider.textContent = 'Yesterday';
    else divider.textContent = date.toLocaleDateString();
    box.appendChild(divider);
    box.dataset.lastDateKey = dateKey;
  }
  const el = document.createElement('div'); el.className='post';
  const msgWrapper = document.createElement('div'); msgWrapper.style.display='flex'; msgWrapper.style.gap='6px'; msgWrapper.style.alignItems='flex-start';
  const pic = document.createElement('img');
  pic.className='profile-picture';
  const meId = window.__me ? Number(window.__me.id) : 0;
  const fromId = Number(m && (m.from ?? m.from_user));
  const isMine = meId && fromId === meId;
  const fallbackAvatar = isMine
    ? getProfilePictureUrl(window.__me || {})
    : (currentChatAvatar || getDefaultAvatarDataUri(''));
  pic.src = m.from_picture || fallbackAvatar;
  pic.onerror = () => { pic.src = fallbackAvatar; };
  pic.style.width='24px'; pic.style.height='24px'; pic.style.borderRadius='50%'; pic.style.marginTop='2px';
  const msgContent = document.createElement('div');
  const meta = document.createElement('div'); meta.className='meta';
  const who = isMine ? 'You' : (m.from_username || currentChatName || m.from || 'User');
  const createdAtLabel = formatDateTime(m.created_at, formatDateTime(Date.now()));
  meta.textContent = `${who} - ${createdAtLabel}`;
  const content = document.createElement('div'); content.textContent = m.content;
  if (m.image) {
    const image = document.createElement('img');
    image.className = 'chat-msg-image';
    image.src = m.image;
    image.alt = 'Chat attachment';
    image.loading = 'lazy';
    msgContent.appendChild(image);
  }
  msgContent.appendChild(meta); if (m.content) msgContent.appendChild(content);
  msgWrapper.appendChild(pic); msgWrapper.appendChild(msgContent);
  el.appendChild(msgWrapper); box.appendChild(el); box.scrollTop = box.scrollHeight;
}

// composer submit
async function submitPost(e) {
  e.preventDefault();
  const form = e.target;
  const ta = document.getElementById('postContent');
  const reminderAtInput = document.getElementById('postReminderAt');
  const reminderNoteInput = document.getElementById('postReminderNote');
  const quizQuestionInput = document.getElementById('quizQuestion');
  const quizCorrectIndexInput = document.getElementById('quizCorrectIndex');
  const quizOptionEls = Array.from(document.querySelectorAll('.quiz-option'));
  const content = ta.value.trim();
  const reminderNote = reminderNoteInput ? reminderNoteInput.value.trim() : '';
  const visibilityInput = document.getElementById('postVisibility');
  const visibility = visibilityInput ? visibilityInput.value : 'public';
  const quizQuestion = quizQuestionInput ? quizQuestionInput.value.trim() : '';
  const quizOptions = quizOptionEls.map((el) => el.value.trim()).filter(Boolean);
  const quizCorrectIndexRaw = quizCorrectIndexInput ? quizCorrectIndexInput.value : '';
  const quizCorrectIndex = quizCorrectIndexRaw === '' ? null : Number(quizCorrectIndexRaw);
  const reminderAtRaw = reminderAtInput ? reminderAtInput.value : '';
  const reminderAt = reminderAtRaw ? new Date(reminderAtRaw).getTime() : null;
  const isReminderMode = postMode === 'reminder';
  const isQuizMode = postMode === 'quiz';
  const hasReminderInput = Boolean(reminderNote) || Boolean(reminderAtRaw);
  const hasQuizInput = Boolean(quizQuestion) || quizOptions.length > 0 || quizCorrectIndexRaw !== '';

  if (!content && !selectedPostImageDataUrl && !hasReminderInput && !hasQuizInput) { 
    showToast('Add text, image, reminder, or quiz first.');
    return;
  }
  if (content.length > 5000) {
    showToast('Post is too long (max 5000 characters)', 'error');
    return;
  }
  if (isReminderMode && reminderNote.length > 240) {
    showToast('Reminder note should be 240 chars or less', 'error');
    return;
  }
  if (isReminderMode && reminderAtRaw && Number.isNaN(reminderAt)) {
    showToast('Please choose a valid reminder date/time', 'error');
    return;
  }
  if (isQuizMode) {
    if (!quizQuestion) {
      showToast('Quiz question is required when adding a quiz', 'error');
      return;
    }
    if (quizOptions.length < 2 || quizOptions.length > 6) {
      showToast('Quiz needs 2 to 6 options', 'error');
      return;
    }
    if (Number.isNaN(quizCorrectIndex) || quizCorrectIndex < 0 || quizCorrectIndex >= quizOptions.length) {
      showToast('Please select the correct quiz option', 'error');
      return;
    }
  } else if (hasQuizInput) {
    showToast('Switch to Quiz Post mode to add a quiz', 'error');
    return;
  }
  if (!isReminderMode && hasReminderInput) {
    showToast('Switch to Reminder Post mode to add a reminder', 'error');
    return;
  }
  
  const btn = form.querySelector('button[type="submit"]');
  setLoading(form, true);
  btn.textContent = 'Posting...';
  
  const res = await api('/api/post','POST',{
    content,
    image: selectedPostImageDataUrl,
    visibility,
    reminderAt: isReminderMode ? reminderAt : null,
    reminderNote: isReminderMode ? reminderNote : '',
    quizQuestion: isQuizMode ? quizQuestion : null,
    quizOptions: isQuizMode ? quizOptions : null,
    quizCorrectIndex: isQuizMode ? quizCorrectIndex : null
  });
  
  setLoading(form, false);
  btn.textContent = 'Post';
  
  if (res && res.success) { 
    ta.value='';
    if (reminderAtInput) reminderAtInput.value = '';
    if (reminderNoteInput) reminderNoteInput.value = '';
    if (quizQuestionInput) quizQuestionInput.value = '';
    if (quizCorrectIndexInput) quizCorrectIndexInput.value = '';
    quizOptionEls.forEach((el) => { el.value = ''; });
    setPostMode(null);
    clearPostImageSelection();
    showToast('Post shared!');
    loadFeed();
  } else {
    showToast(res.error || 'Unable to post', 'error');
  }
}

// register/login handlers
async function handleRegister(e) {
  e.preventDefault();
  const form = e.target;
  const submitBtn = form.querySelector('button[type="submit"]');
  const u=document.getElementById('regUser').value.trim();
  const p=document.getElementById('regPass').value.trim();
  const n=document.getElementById('regName').value.trim();
  const emailEl = document.getElementById('regEmail');
  const email = emailEl ? emailEl.value.trim() : '';
  const instituteEl = document.getElementById('regInstitute');
  const programTypeEl = document.getElementById('regProgramType');
  const degreeEl = document.getElementById('regDegree');
  const yearEl = document.getElementById('regAcademicYear');
  const specialityEl = document.getElementById('regSpeciality');
  const institute = instituteEl ? instituteEl.value.trim() : '';
  const programType = programTypeEl ? programTypeEl.value.trim() : '';
  const degree = degreeEl ? degreeEl.value.trim() : '';
  const academicYear = yearEl ? yearEl.value.trim() : '';
  const speciality = specialityEl ? specialityEl.value.trim() : '';
  
  if (!u || !p || !n || !email || !institute) {
    showToast('Please fill required registration fields', 'error');
    return;
  }
  if (programType === 'student' && (!degree || !academicYear)) {
    showToast('Degree and academic year are required for students', 'error');
    return; 
  }
  
  if (p.length < 6) {
    showToast('Password must be at least 6 characters', 'error');
    return;
  }
  
  setLoading(form, true);
  submitBtn.textContent = 'Creating...';
  
  const res = await api('/api/register','POST',{username:u,password:p,name:n,email,institute,programType,degree,academicYear,speciality});
  
  setLoading(form, false);
  submitBtn.textContent = 'Register';
  
  if (res && res.success) { 
    showToast('Account created. Verify your email to login.');
    if (res.verifyUrl) {
      setTimeout(() => { location.href = res.verifyUrl; }, 900);
    } else {
      setTimeout(() => { location.href='/login.html'; }, 900);
    }
  } else { 
    showToast(res.error||'Registration failed', 'error');
  }
}

async function handleLogin(e){
  e.preventDefault();
  const form = e.target;
  const submitBtn = form.querySelector('button[type="submit"]');
  const u=document.getElementById('loginUser').value.trim();
  const p=document.getElementById('loginPass').value.trim();
  const rememberMeEl = document.getElementById('rememberMe');
  const rememberMe = rememberMeEl ? rememberMeEl.checked : false;
  
  if (!u || !p) { 
    showToast('Username and password required', 'error'); 
    return; 
  }
  
  setLoading(form, true);
  submitBtn.textContent = 'Logging in...';
  
  const res = await api('/api/login','POST',{username:u,password:p,rememberMe});
  
  setLoading(form, false);
  submitBtn.textContent = 'Log in';
  
  if (res && res.success) { 
    showToast('Login successful.');
    setTimeout(() => { location.href='/dashboard'; }, 800);
  } else { 
    showToast(res.error||'Login failed', 'error');
  }
}

async function handleForgotPassword(e) {
  e.preventDefault();
  const form = e.target;
  const submitBtn = form.querySelector('button[type="submit"]');
  const usernameEl = document.getElementById('forgotUser');
  const nameEl = document.getElementById('forgotName');
  const passEl = document.getElementById('forgotNewPass');
  const confirmEl = document.getElementById('forgotConfirmPass');
  const username = usernameEl ? usernameEl.value.trim() : '';
  const name = nameEl ? nameEl.value.trim() : '';
  const newPassword = passEl ? passEl.value.trim() : '';
  const confirmPassword = confirmEl ? confirmEl.value.trim() : '';

  if (!username || !newPassword || !confirmPassword) {
    showToast('Username and password fields are required', 'error');
    return;
  }
  if (newPassword.length < 6) {
    showToast('Password must be at least 6 characters', 'error');
    return;
  }
  if (newPassword !== confirmPassword) {
    showToast('Passwords do not match', 'error');
    return;
  }

  setLoading(form, true);
  if (submitBtn) submitBtn.textContent = 'Resetting...';
  const res = await api('/api/forgot-password', 'POST', { username, name, newPassword });
  setLoading(form, false);
  if (submitBtn) submitBtn.textContent = 'Reset Password';

  if (res && res.success) {
    showToast('Password reset successful. Redirecting to login...');
    setTimeout(() => { location.href = '/login.html'; }, 900);
  } else {
    showToast(res.error || 'Unable to reset password', 'error');
  }
}

async function loadProfile() {
  const holder = document.getElementById('profileBox');
  if (!holder) return;
  if (isPublicHomePage()) {
    holder.classList.add('hidden');
    holder.innerHTML = '';
    return;
  }
  const res = await api('/api/me');
  cachedMe = res.user || null;
  window.__me = cachedMe;
  upsertSavedListsTopButton(cachedMe);
  holder.classList.remove('hidden');
  if (!res.user) {
    holder.innerHTML = `<div class="profile card guest-profile">
      <h3>Welcome to Mednecta</h3>
      <p class="muted">Build social connections, turn posts into reminders, and collaborate with your medical community in one place.</p>
      <div class="guest-cta-row">
        <a class="btn primary" href="/register.html">Create Account</a>
        <a class="btn" href="/login.html">Log in</a>
      </div>
    </div>`;
    return;
  }
  const last = res.user.last_login ? formatDateTime(res.user.last_login, 'Never') : 'Never';
  const picUrl = getProfilePictureUrl(res.user);
  const adminActions = res.user.role === 'admin' ? '<div class="row" style="justify-content:flex-start;margin-top:0.6rem"><a class="btn tiny-btn" href="/admin">Open Admin Management</a></div>' : '';
  holder.innerHTML = `<div class="profile card">
    <img id="profilePic" src="${picUrl}" class="profile-picture" />
    <h3>${escapeHtml(res.user.name || res.user.username)}${res.user.nickname ? ` <span class="muted">(${escapeHtml(res.user.nickname)})</span>` : ''}</h3>
    <p class="muted">Title: ${escapeHtml(res.user.title || 'Rookie Medic')}</p>
    <p class="muted">${escapeHtml(formatGenderLabel(res.user.gender))}${res.user.date_of_birth ? ` | DOB: ${escapeHtml(res.user.date_of_birth)}` : ''}</p>
    <p class="muted">${escapeHtml(res.user.place_from || '')}</p>
    <p class="muted">${escapeHtml(res.user.status_description || '')}</p>
    <p class="muted">${escapeHtml(res.user.achievements || '')}</p>
    <p class="muted">${escapeHtml(res.user.bio || '')}</p>
    <p class="muted">Level ${res.user.level || 1} | XP ${res.user.xp || 0}</p>
    <p class="muted">Connections: ${res.user.connections_count || 0}</p>
    <p class="muted">Last login: ${last}</p>
    <div class="row" style="justify-content:flex-start;margin-top:0.4rem">
      <a class="btn tiny-btn" href="/profile">Edit Profile Details</a>
      <button id="openSettingsBtn" class="btn secondary tiny-btn" type="button" title="Settings">Settings</button>
    </div>
    ${adminActions}
    <input id="picInput" type="file" accept="image/*" style="display:none" />
  </div>`;
  document.getElementById('picInput').addEventListener('change', uploadProfilePicture);
  initProfileSettingsModal();
}

// upload profile picture
async function uploadProfilePicture(e) {
  const file = e.target.files[0];
  if (!file) return;
  
  // Validate file size (max 5MB)
  if (file.size > 5 * 1024 * 1024) {
    showToast('Image must be less than 5MB', 'error');
    return;
  }
  
  // Validate file type
  if (!file.type.startsWith('image/')) {
    showToast('Please select a valid image file', 'error');
    return;
  }
  
  showToast('Uploading...');
  const reader = new FileReader();
  reader.onload = async (evt) => {
    const image = evt.target.result;
    const res = await api('/api/upload-picture', 'POST', { image });
    if (res && res.success) {
      document.getElementById('profilePic').src = image;
      showToast('Photo updated.');
    } else {
      showToast('Upload failed: ' + (res.error || 'Unknown error'), 'error');
    }
  };
  reader.onerror = () => {
    showToast('Failed to read file', 'error');
  };
  reader.readAsDataURL(file);
}

function clearPostImageSelection() {
  selectedPostImageDataUrl = null;
  const imageInput = document.getElementById('postImage');
  const preview = document.getElementById('postImagePreview');
  if (imageInput) {
    imageInput.value = '';
    updateFileNameChip(imageInput);
  }
  if (preview) {
    preview.innerHTML = '';
    preview.classList.add('hidden');
  }
}

async function handlePostImageSelection(e) {
  const file = e.target.files[0];
  if (!file) {
    clearPostImageSelection();
    return;
  }
  if (!file.type.startsWith('image/')) {
    showToast('Please choose an image file', 'error');
    clearPostImageSelection();
    return;
  }
  if (file.size > 4 * 1024 * 1024) {
    showToast('Image must be below 4MB', 'error');
    clearPostImageSelection();
    return;
  }

  const preview = document.getElementById('postImagePreview');
  const reader = new FileReader();
  reader.onload = (evt) => {
    selectedPostImageDataUrl = evt.target.result;
    if (preview) {
      preview.classList.remove('hidden');
      preview.innerHTML = `<img src="${selectedPostImageDataUrl}" alt="Selected attachment" /><button type="button" class="btn secondary tiny-btn" id="removePostImage">Remove</button>`;
      const removeBtn = document.getElementById('removePostImage');
      if (removeBtn) removeBtn.addEventListener('click', clearPostImageSelection);
    }
  };
  reader.onerror = () => showToast('Failed to read image file', 'error');
  reader.readAsDataURL(file);
}

document.addEventListener('DOMContentLoaded', ()=>{
  upsertSavedListsTopButton(null);
  // Initialize theme toggle
  initThemeToggle();
  initFileUploadControls();
  initStaticActionIcons();
  applyIconifyAudit();
  
  // Initialize search bar
  const searchInput = document.getElementById('searchInput');
  if (searchInput) {
    const searchContainer = searchInput.parentElement;
    const resultsBox = document.createElement('div');
    resultsBox.id = 'searchResults';
    searchContainer.style.position = 'relative';
    searchContainer.appendChild(resultsBox);
    
    searchInput.addEventListener('input', (e) => {
      debouncedSearch(e.target.value);
    });
    
    // Close search results on blur
    searchInput.addEventListener('blur', () => {
      setTimeout(() => resultsBox.classList.remove('active'), 200);
    });
  }
  
  // Initialize socket immediately
  ensureSocket();
  initChatControls();
  
  // Dashboard-specific
  if (document.getElementById('connections')) loadConnectionPanels();
  if (document.getElementById('connections')) setInterval(loadConnectionPanels, 15000);
  initConnectionTabs();
  if (document.querySelector('.admin-tab-btn')) initAdminTabs();
  if (document.getElementById('groupsList')) loadGroups();
  if (document.getElementById('leaderboard')) loadLeaderboard();
  if (document.getElementById('groupFeed')) loadGroupFeed();
  if (document.getElementById('groupCreateForm')) document.getElementById('groupCreateForm').addEventListener('submit', handleGroupCreate);
  if (document.getElementById('groupPostForm')) document.getElementById('groupPostForm').addEventListener('submit', handleGroupPost);
  if (document.getElementById('clanPostForm')) document.getElementById('clanPostForm').addEventListener('submit', handleClanPostSubmit);
  if (document.getElementById('clanLoungeForm')) document.getElementById('clanLoungeForm').addEventListener('submit', handleClanLoungeSubmit);
  const clanTypeSelect = document.getElementById('clanPostType');
  if (clanTypeSelect) {
    clanTypeSelect.addEventListener('change', setClanPostTypeUi);
    setClanPostTypeUi();
  }
  const clanPostImageInput = document.getElementById('clanPostImage');
  if (clanPostImageInput) clanPostImageInput.addEventListener('change', handleClanPostImageSelection);
  if (document.getElementById('clanProfileCard')) loadClanManagementPage();
  if (document.getElementById('changePasswordForm')) document.getElementById('changePasswordForm').addEventListener('submit', handleChangePassword);
  const closePasswordModalBtn = document.getElementById('closePasswordModalBtn');
  const passwordModal = document.getElementById('passwordModal');
  if (closePasswordModalBtn) closePasswordModalBtn.addEventListener('click', closePasswordModal);
  if (passwordModal) {
    passwordModal.addEventListener('click', (evt) => {
      if (evt.target === passwordModal) closePasswordModal();
    });
  }

  // Make brand title clickable to homepage
  const brandTitle = document.querySelector('.brand h1');
  if (brandTitle) {
    brandTitle.style.cursor = 'pointer';
    brandTitle.addEventListener('click', async () => {
      const targetPath = await resolveHomePath();
      location.href = targetPath;
    });
  }
  
  // Post composer
  if (document.getElementById('postForm')) {
    document.getElementById('postForm').addEventListener('submit', submitPost);
    initPostModeSwitcher();
    const postImageInput = document.getElementById('postImage');
    if (postImageInput) postImageInput.addEventListener('change', handlePostImageSelection);
  }
  if (document.getElementById('storyForm')) {
    const storyForm = document.getElementById('storyForm');
    const storyComposerToggle = document.getElementById('storyComposerToggle');
    if (storyComposerToggle && storyForm) {
      storyComposerToggle.addEventListener('click', () => {
        const isHidden = storyForm.classList.toggle('hidden');
        storyComposerToggle.textContent = isHidden ? 'Add Story' : 'Close';
      });
    }
    storyForm.addEventListener('submit', handleStorySubmit);
    const storyImageInput = document.getElementById('storyImage');
    if (storyImageInput) storyImageInput.addEventListener('change', handleStoryImageSelection);
    const storyViewerModal = document.getElementById('storyViewerModal');
    const closeStoryViewerBtn = document.getElementById('closeStoryViewerBtn');
    const storyViewerPrevBtn = document.getElementById('storyViewerPrevBtn');
    const storyViewerNextBtn = document.getElementById('storyViewerNextBtn');
    const storyLikeBtn = document.getElementById('storyLikeBtn');
    const storyShareBtn = document.getElementById('storyShareBtn');
    const storyDeleteBtn = document.getElementById('storyDeleteBtn');
    const storyReplyForm = document.getElementById('storyReplyForm');
    if (closeStoryViewerBtn) closeStoryViewerBtn.addEventListener('click', closeStoryViewer);
    if (storyViewerModal) {
      storyViewerModal.addEventListener('click', (evt) => {
        if (evt.target === storyViewerModal) closeStoryViewer();
      });
    }
    if (storyViewerPrevBtn) {
      storyViewerPrevBtn.addEventListener('click', () => {
        goToPrevStory();
      });
    }
    if (storyViewerNextBtn) {
      storyViewerNextBtn.addEventListener('click', () => {
        goToNextStory();
      });
    }
    if (storyLikeBtn) storyLikeBtn.addEventListener('click', toggleStoryLike);
    if (storyShareBtn) storyShareBtn.addEventListener('click', shareActiveStory);
    if (storyDeleteBtn) storyDeleteBtn.addEventListener('click', deleteActiveStory);
    if (storyReplyForm) storyReplyForm.addEventListener('submit', submitStoryReply);
    loadStories();
    setInterval(loadStories, 30000);
  }
  if (document.getElementById('feed')) loadFeed();
  
  // Chat form
  if (document.getElementById('chatForm')) {
    document.getElementById('chatForm').addEventListener('submit', async (e)=>{
      e.preventDefault();
      const input = document.getElementById('chatInput');
      const content = input.value.trim();
      if (!content && !chatAttachmentDataUrl) return;
      if (!currentChatUser) {
        showToast('Open a chat first', 'error');
        return;
      }
      const socketInst = ensureSocket();
      socketInst.emit('chatMessage',{ to: Number(currentChatUser), content, image: chatAttachmentDataUrl || '' });
      input.value='';
      clearChatAttachment();
    });
  }
  
  // Auth forms
  if (document.getElementById('regForm')) document.getElementById('regForm').addEventListener('submit', handleRegister);
  if (document.getElementById('loginForm')) document.getElementById('loginForm').addEventListener('submit', handleLogin);
  if (document.getElementById('forgotForm')) document.getElementById('forgotForm').addEventListener('submit', handleForgotPassword);
  if (document.getElementById('profileEditForm')) {
    document.getElementById('profileEditForm').addEventListener('submit', handleProfileEditSubmit);
    loadProfileEditor();
    loadSavedLists().then(() => loadSavedPosts());
    const createListBtn = document.getElementById('createSavedListBtn');
    if (createListBtn) createListBtn.addEventListener('click', createSavedList);
    const suggestBtn = document.getElementById('specialitySuggestBtn');
    if (suggestBtn) suggestBtn.addEventListener('click', suggestSpeciality);
  }
  if (document.getElementById('verifyEmailStatus')) handleVerifyEmailPage();
  if (document.getElementById('publicProfileBox')) loadPublicProfilePage();
  
  // Profile display
  loadProfile();
  (async () => {
    const meRes = await api('/api/me');
    cachedMe = meRes.user || null;
    window.__me = cachedMe;
    if (document.getElementById('storiesBar')) loadStories();
    upsertSavedListsTopButton(cachedMe);
    const isAdmin = cachedMe && cachedMe.role === 'admin';
    const dashboardAdmin = document.getElementById('dashboardAdminSection');
    if (dashboardAdmin) dashboardAdmin.classList.toggle('hidden', !isAdmin);
    if (isAdmin && document.getElementById('adminUsers')) loadAdminUsers();
    if (isAdmin && document.getElementById('adminReports')) loadAdminReports();
    if (isAdmin && document.getElementById('adminClans')) loadAdminClans();
    const usersSearchBtn = document.getElementById('adminUsersSearchBtn');
    if (usersSearchBtn) usersSearchBtn.onclick = () => loadAdminUsers();
    const clansSearchBtn = document.getElementById('adminClansSearchBtn');
    if (clansSearchBtn) clansSearchBtn.onclick = () => loadAdminClans();
    const reportsSearchBtn = document.getElementById('adminReportsSearchBtn');
    if (reportsSearchBtn) reportsSearchBtn.onclick = () => loadAdminReports();
    applyIconifyAudit();
  })();
});


