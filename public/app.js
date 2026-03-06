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
let selectedGroupId = null;
let selectedGroupRole = null;
let cachedMe = null;
let postMode = null;

async function api(path, method='GET', data) {
  const opts = { method, headers: {}, cache: 'no-store' };
  if (data) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(data); }
  try {
    const res = await fetch(path, opts);
    const json = await res.json();
    if (!res.ok && !json.error) json.error = `HTTP ${res.status}`;
    return json;
  } catch (e) {
    console.error('API error:', e);
    return { error: e.message };
  }
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

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createActionButton(label, onClick, className = 'btn secondary tiny-btn') {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = className;
  btn.textContent = label;
  if (typeof onClick === 'function') btn.addEventListener('click', onClick);
  return btn;
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
    btn.textContent = `${res.liked ? 'Unlike' : 'Like'} (${res.count || 0})`;
  } else {
    showToast(res.error || 'Unable to like post', 'error');
  }
}

async function toggleSave(postId, btn) {
  setLoading(btn, true);
  const res = await api(`/api/post/${postId}/save`, 'POST');
  setLoading(btn, false);
  if (res && res.success) {
    btn.textContent = `${res.saved ? 'Saved' : 'Save'} (${res.count || 0})`;
  } else {
    showToast(res.error || 'Unable to save post', 'error');
  }
}

async function sharePost(postId, btn) {
  setLoading(btn, true);
  const res = await api(`/api/post/${postId}/share`, 'POST', {});
  setLoading(btn, false);
  if (res && res.success) {
    btn.textContent = `Shared (${res.count || 0})`;
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
      row.innerHTML = `<div class="meta">${escapeHtml(c.name || c.username)} - ${new Date(c.created_at).toLocaleString()}</div><div>${mentionPrefix}${escapeHtml(c.content)}</div>`;

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
    const date = new Date(p.created_at).toLocaleString();
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
  const res = await api('/api/admin/users');
  if (res.error) {
    box.innerHTML = '<div class="muted">Admin access required.</div>';
    return;
  }
  const users = Array.isArray(res.users) ? res.users : [];
  if (title) title.textContent = `Registered Users (${res.totalUsers || users.length || 0})`;
  if (!users.length) {
    box.innerHTML = '<div class="muted">No registered users found.</div>';
    return;
  }
  const rows = users.map((u) => {
    const email = u.email || (String(u.username || '').includes('@') ? u.username : 'Not provided');
    const name = escapeHtml(u.name || u.username || 'Unknown');
    const lastLogin = u.last_login ? new Date(u.last_login).toLocaleString() : 'Never';
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
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
  box.querySelectorAll('tr[data-user-id]').forEach((row) => {
    const select = row.querySelector('.admin-role-select');
    if (!select) return;
    select.addEventListener('change', async () => {
      const userId = Number(row.getAttribute('data-user-id'));
      const role = select.value;
      const res = await api(`/api/admin/users/${userId}/role`, 'POST', { role });
      if (res && res.success) showToast('Role updated');
      else showToast(res.error || 'Unable to update role', 'error');
    });
  });
}

async function handleStoryImageSelection(e) {
  const file = e.target.files[0];
  if (!file) {
    selectedStoryImageDataUrl = null;
    return;
  }
  if (!file.type.startsWith('image/')) {
    showToast('Please choose a valid story image', 'error');
    e.target.value = '';
    selectedStoryImageDataUrl = null;
    return;
  }
  if (file.size > 4 * 1024 * 1024) {
    showToast('Story image must be below 4MB', 'error');
    e.target.value = '';
    selectedStoryImageDataUrl = null;
    return;
  }
  const reader = new FileReader();
  reader.onload = (evt) => {
    selectedStoryImageDataUrl = evt.target.result;
  };
  reader.onerror = () => showToast('Unable to read story image', 'error');
  reader.readAsDataURL(file);
}

async function loadStories() {
  const box = document.getElementById('storiesList');
  if (!box) return;
  box.innerHTML = '<div class="muted">Loading stories...</div>';
  const res = await api('/api/stories');
  if (res.error) {
    box.innerHTML = '<div class="muted">Unable to load stories</div>';
    return;
  }
  if (!res.stories || !res.stories.length) {
    box.innerHTML = '<div class="muted">No active stories from your connections.</div>';
    return;
  }
  box.innerHTML = '';
  const rail = document.createElement('div');
  rail.className = 'stories-rail';
  res.stories.forEach((s) => {
    const story = document.createElement('article');
    story.className = 'story-card';
    story.innerHTML = `<div class="story-head">
      <img src="${s.profile_picture || 'data:image/svg+xml,<svg></svg>'}" loading="lazy" />
      <div>
        <div class="story-user">${escapeHtml(s.name || s.username)}</div>
        <div class="meta">${new Date(s.created_at).toLocaleString()}</div>
      </div>
    </div>`;
    if (s.image) {
      const image = document.createElement('img');
      image.className = 'story-image';
      image.src = s.image;
      image.alt = 'Story image';
      image.loading = 'lazy';
      story.appendChild(image);
    }
    if (s.content) {
      const text = document.createElement('div');
      text.className = 'story-content';
      text.textContent = s.content;
      story.appendChild(text);
    }
    rail.appendChild(story);
  });
  box.appendChild(rail);
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
    if (imageEl) imageEl.value = '';
    selectedStoryImageDataUrl = null;
    showToast('Story posted');
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
  const emailEl = document.getElementById('profileEditEmail');
  const instituteEl = document.getElementById('profileEditInstitute');
  const programTypeEl = document.getElementById('profileEditProgramType');
  const degreeEl = document.getElementById('profileEditDegree');
  const yearEl = document.getElementById('profileEditAcademicYear');
  const specialityEl = document.getElementById('profileEditSpeciality');
  const bioEl = document.getElementById('profileEditBio');
  if (nameEl) nameEl.value = res.user.name || '';
  if (emailEl) emailEl.value = res.user.email || '';
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
  const emailEl = document.getElementById('profileEditEmail');
  const instituteEl = document.getElementById('profileEditInstitute');
  const programTypeEl = document.getElementById('profileEditProgramType');
  const degreeEl = document.getElementById('profileEditDegree');
  const yearEl = document.getElementById('profileEditAcademicYear');
  const specialityEl = document.getElementById('profileEditSpeciality');
  const bioEl = document.getElementById('profileEditBio');
  const name = nameEl ? nameEl.value.trim() : '';
  const email = emailEl ? emailEl.value.trim() : '';
  const institute = instituteEl ? instituteEl.value.trim() : '';
  const programType = programTypeEl ? programTypeEl.value.trim() : '';
  const degree = degreeEl ? degreeEl.value.trim() : '';
  const academicYear = yearEl ? yearEl.value.trim() : '';
  const speciality = specialityEl ? specialityEl.value.trim() : '';
  const bio = bioEl ? bioEl.value.trim() : '';
  const btn = form.querySelector('button[type="submit"]');
  setLoading(form, true);
  if (btn) btn.textContent = 'Saving...';
  const res = await api('/api/profile', 'POST', { name, email, bio, institute, programType, degree, academicYear, speciality });
  setLoading(form, false);
  if (btn) btn.textContent = 'Save Changes';
  if (res && res.success) {
    showToast('Profile updated');
  } else {
    showToast(res.error || 'Unable to update profile', 'error');
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
  if (!profileBox || !feedBox) return;
  const userId = new URLSearchParams(window.location.search).get('id');
  if (!userId) {
    profileBox.innerHTML = '<div class="muted">Invalid user profile.</div>';
    return;
  }
  const userRes = await api(`/api/user/${encodeURIComponent(userId)}`);
  if (userRes.error || !userRes.user) {
    profileBox.innerHTML = `<div class="muted">${escapeHtml(userRes.error || 'User not found')}</div>`;
    return;
  }
  const u = userRes.user;
  profileBox.innerHTML = `<img src="${u.profile_picture || 'data:image/svg+xml,<svg></svg>'}" class="profile-picture" />
    <h3>${escapeHtml(u.name || u.username)}</h3>
    <p class="muted">@${escapeHtml(u.username || '')}</p>
    <p class="muted">${escapeHtml(u.speciality || '')}</p>
    <p class="muted">${escapeHtml(u.institute || '')}</p>
    <p class="muted">Connections: ${u.connections_count || 0}</p>`;
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
    el.innerHTML = `<div class="meta">${new Date(p.created_at).toLocaleString()} - ${escapeHtml(p.visibility || 'public')}</div><div>${escapeHtml(p.content || '')}</div>`;
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

// Load incoming requests
async function loadRequests() {
  const box = document.getElementById('requests');
  if (!box) return;
  const res = await api('/api/requests');
  if (res.error) { 
    box.innerHTML = '<div class="muted">Error loading requests</div>'; 
    return;
  }
  if (!res.requests || res.requests.length===0) { 
    box.innerHTML = '<div class="muted" style="text-align:center;padding:16px">No incoming requests</div>'; 
    return;
  }
  box.innerHTML = '';
  res.requests.forEach(r => {
    const el = document.createElement('div');
    el.innerHTML = `<div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;padding:12px;background:rgba(16,185,129,0.05);border-radius:8px;border-left:3px solid var(--accent)">
      <img src="${r.profile_picture || 'data:image/svg+xml,<svg></svg>'}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;border:2px solid var(--accent)" loading="lazy" />
      <div style="flex:1">
        <div style="font-weight:500">${r.name || r.username}</div>
      </div>
      <button class="btn" style="font-size:12px;padding:8px 12px" onclick="acceptRequest(${r.id})">Accept</button>
      <button class="btn secondary" style="font-size:12px;padding:8px 12px" onclick="declineRequest(${r.id})">Decline</button>
    </div>`;
    box.appendChild(el);
  });
}

async function acceptRequest(id) {
  const res = await api('/api/connect/accept','POST',{id});
  if (res && res.success) { 
    loadConnections(); 
    loadRequests();
    showToast('Connection accepted!');
  } else {
    showToast(res.error||'Unable to accept', 'error');
  }
}

async function declineRequest(id) {
  const res = await api('/api/connect/decline','POST',{id});
  if (res && res.success) { 
    loadRequests();
    showToast('Connection declined');
  } else {
    showToast(res.error||'Unable to decline', 'error');
  }
}

// Connections APIs
async function loadConnections() {
  const box = document.getElementById('connections');
  if (!box) return;
  box.innerHTML = '<div class="muted center" style="padding:20px">Loading...</div>';
  const res = await api('/api/connections');
  if (res.error) {
    box.innerHTML = '<div class="muted">Error loading connections</div>';
    return;
  }
  if (!res.connections || res.connections.length===0) {
    box.innerHTML = '<div class="muted" style="text-align:center;padding:16px">No connections yet.<br>Send connection requests to get started!</div>';
    return;
  }
  box.innerHTML = '';
  res.connections.forEach(c => {
    const statusText = c.online ? 'Online' : 'Offline';
    const statusClass = c.online ? 'status-online' : 'status-offline';
    const el = document.createElement('div');
    el.innerHTML = `<div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;padding:12px;background:var(--card);border-radius:8px;transition:all 0.2s;border:1px solid var(--border)" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
      <img src="${c.profile_picture || 'data:image/svg+xml,<svg></svg>'}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;border:2px solid var(--accent)" loading="lazy" />
      <div style="flex:1">
        <div style="font-weight:500">${c.name || c.username}</div>
        <div class="connection-status ${statusClass}">${statusText}</div>
      </div>
      <button class="btn primary" style="font-size:12px;padding:8px 12px" onclick="openChat(${c.id}, '${(c.name || c.username).replace(/'/g, "\\'")}'  )">Chat</button>
    </div>`;
    box.appendChild(el);
  });
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
    row.innerHTML = `<span>#${idx + 1}</span><span>${escapeHtml(u.name || u.username)}</span><span>${u.level || 1}</span><span>${u.xp || 0} XP</span>`;
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
    box.innerHTML = '<div class="muted">No groups yet. Create one.</div>';
    return;
  }
  box.innerHTML = '';
  res.groups.forEach((g) => {
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
    const openBtn = createActionButton('Open', async () => {
      selectedGroupId = g.id;
      selectedGroupRole = g.my_role || null;
      const title = document.getElementById('groupFeedTitle');
      if (title) title.textContent = `Group Space - ${g.name}`;
      await loadGroupFeed();
      await loadGroupRequests();
    });
    actions.appendChild(openBtn);
    if (!g.my_status) {
      const joinBtn = createActionButton('Join', async () => {
        const joinRes = await api(`/api/groups/${g.id}/join`, 'POST', {});
        if (joinRes && joinRes.success) {
          showToast(joinRes.status === 'active' ? 'Joined group' : 'Join request sent');
          loadGroups();
        } else {
          showToast(joinRes.error || 'Unable to join group', 'error');
        }
      }, 'btn tiny-btn');
      actions.appendChild(joinBtn);
    }
    card.appendChild(actions);
    box.appendChild(card);
  });
}

async function loadGroupFeed() {
  const box = document.getElementById('groupFeed');
  if (!box) return;
  if (!selectedGroupId) {
    box.innerHTML = '<div class="muted">Select a group from the left panel to view posts.</div>';
    return;
  }
  box.innerHTML = '<div class="muted">Loading group posts...</div>';
  const res = await api(`/api/groups/${selectedGroupId}/feed`);
  if (res.error) {
    box.innerHTML = `<div class="muted">${escapeHtml(res.error)}</div>`;
    return;
  }
  if (!res.posts || !res.posts.length) {
    box.innerHTML = '<div class="muted">No group posts yet.</div>';
    return;
  }
  box.innerHTML = '';
  const meId = window.__me ? window.__me.id : null;
  res.posts.forEach((p) => {
    const el = document.createElement('div');
    el.className = 'post';
    el.innerHTML = `<div class="meta">${escapeHtml(p.name || p.username)} - ${new Date(p.created_at).toLocaleString()}</div><div>${escapeHtml(p.content)}</div>`;
    const canDelete = meId && (Number(p.user_id) === Number(meId) || ['admin', 'moderator'].includes(selectedGroupRole));
    if (canDelete) {
      const actions = document.createElement('div');
      actions.className = 'post-actions';
      const delBtn = createActionButton('Delete', () => {}, 'btn secondary tiny-btn');
      delBtn.addEventListener('click', async () => {
        const ok = window.confirm('Delete this group post?');
        if (!ok) return;
        setLoading(delBtn, true);
        const deleteRes = await api(`/api/groups/${p.group_id}/post/${p.id}`, 'DELETE');
        setLoading(delBtn, false);
        if (deleteRes && deleteRes.success) {
          el.remove();
          showToast('Group post deleted');
        } else {
          showToast(deleteRes.error || 'Unable to delete group post', 'error');
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
    showToast('Group name is required', 'error');
    return;
  }
  const res = await api('/api/groups', 'POST', { name, description, isPrivate: privateEl ? privateEl.checked : true });
  if (res && res.success) {
    if (nameEl) nameEl.value = '';
    if (descEl) descEl.value = '';
    showToast('Group created');
    loadGroups();
    loadProfile();
  } else {
    showToast(res.error || 'Unable to create group', 'error');
  }
}

async function handleGroupPost(e) {
  e.preventDefault();
  if (!selectedGroupId) {
    showToast('Select a group first', 'error');
    return;
  }
  const input = document.getElementById('groupPostContent');
  const content = input ? input.value.trim() : '';
  if (!content) return;
  const res = await api(`/api/groups/${selectedGroupId}/post`, 'POST', { content });
  if (res && res.success) {
    if (input) input.value = '';
    showToast('Posted to group');
    loadGroupFeed();
    loadProfile();
  } else {
    showToast(res.error || 'Unable to post to group', 'error');
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
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
}

function closePasswordModal() {
  const modal = document.getElementById('passwordModal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

// open chat with userId
let socket = null;
let currentChatUser = null;
let chatMinimized = false;
function ensureSocket(userId) {
  if (socket) return socket;
  socket = io();
  socket.on('connect', async ()=>{
    // identify after connected
    const me = await api('/api/me');
    if (me.user) socket.emit('identify', me.user.id);
  });
  socket.on('message', (m)=>{
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
  return socket;
}

function setChatMinimized(minimized) {
  const panel = document.getElementById('chatPanel');
  const minBtn = document.getElementById('chatMinimizeBtn');
  if (!panel || !minBtn) return;
  chatMinimized = Boolean(minimized);
  panel.classList.toggle('minimized', chatMinimized);
  minBtn.textContent = chatMinimized ? 'Expand' : 'Minimize';
}

function initChatControls() {
  const panel = document.getElementById('chatPanel');
  const minBtn = document.getElementById('chatMinimizeBtn');
  const closeBtn = document.getElementById('chatCloseBtn');
  if (!panel || !minBtn || !closeBtn) return;
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
    });
  }
}

async function openChat(otherId, otherName) {
  const meRes = await api('/api/me');
  if (!meRes.user) return alert('Please log in');
  const me = meRes.user;
  window.__me = me; // ensure current user is stored
  const a = Number(me.id), b = Number(otherId);
  const room = `chat:${Math.min(a,b)}:${Math.max(a,b)}`;
  currentChatUser = otherId;
  const chatPanel = document.getElementById('chatPanel');
  chatPanel.style.display='block';
  setChatMinimized(false);
  document.getElementById('chatTitle').textContent = `Chat with ${otherName}`;
  document.getElementById('messages').innerHTML = '<div class="muted">Loading...</div>';
  ensureSocket(me.id).emit('joinRoom', room);
  // load history
  const hist = await api(`/api/messages/${otherId}`);
  const box = document.getElementById('messages'); box.innerHTML='';
  (hist.messages||[]).forEach(m=>appendMessage(m));
}

function appendMessage(m){
  const box = document.getElementById('messages');
  if (!box) return;
  const el = document.createElement('div'); el.className='post';
  const msgWrapper = document.createElement('div'); msgWrapper.style.display='flex'; msgWrapper.style.gap='6px'; msgWrapper.style.alignItems='flex-start';
  const pic = document.createElement('img'); pic.className='profile-picture'; pic.src = m.from_picture || 'data:image/svg+xml,<svg></svg>'; pic.style.width='24px'; pic.style.height='24px'; pic.style.borderRadius='50%'; pic.style.marginTop='2px';
  const msgContent = document.createElement('div');
  const meta = document.createElement('div'); meta.className='meta';
  const meId = window.__me ? window.__me.id : null;
  const who = m.from === meId || m.from_user === meId ? 'You' : (m.from_username || m.from || 'Unknown');
  meta.textContent = `${who} - ${new Date(m.created_at).toLocaleString()}`;
  const content = document.createElement('div'); content.textContent = m.content;
  msgContent.appendChild(meta); msgContent.appendChild(content);
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
  holder.classList.remove('hidden');
  if (!res.user) {
    holder.innerHTML = `<div class="profile card guest-profile">
      <h3>Welcome to MiniMedics</h3>
      <p class="muted">Build social connections, turn posts into reminders, and collaborate with your medical community in one place.</p>
      <div class="guest-cta-row">
        <a class="btn primary" href="/register.html">Create Account</a>
        <a class="btn" href="/login.html">Log in</a>
      </div>
    </div>`;
    return;
  }
  const last = res.user.last_login ? new Date(res.user.last_login).toLocaleString() : 'Never';
  const picUrl = res.user.profile_picture ? res.user.profile_picture : 'data:image/svg+xml,<svg></svg>';
  const adminActions = res.user.role === 'admin' ? '<div class="row" style="justify-content:flex-start;margin-top:0.6rem"><a class="btn tiny-btn" href="/admin">Open Admin Management</a></div>' : '';
  holder.innerHTML = `<div class="profile card">
    <img id="profilePic" src="${picUrl}" class="profile-picture" />
    <h3>${res.user.name || res.user.username}</h3>
    <p class="muted">Title: ${escapeHtml(res.user.title || 'Rookie Medic')}</p>
    <p class="muted">${escapeHtml(res.user.bio || '')}</p>
    <p class="muted">Level ${res.user.level || 1} | XP ${res.user.xp || 0}</p>
    <p class="muted">Connections: ${res.user.connections_count || 0}</p>
    <p class="muted">Last login: ${last}</p>
    <div class="row" style="justify-content:flex-start;margin-top:0.4rem"><a class="btn tiny-btn" href="/profile">Edit Profile Details</a></div>
    ${adminActions}
    <div class="pic-upload">
      <input id="picInput" type="file" accept="image/*" />
      <button class="pic-upload-btn" onclick="document.getElementById('picInput').click()">Upload Photo</button>
    </div>
  </div>`;
  document.getElementById('picInput').addEventListener('change', uploadProfilePicture);
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
  if (imageInput) imageInput.value = '';
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
  // Initialize theme toggle
  initThemeToggle();
  
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
  if (document.getElementById('connections')) { loadConnections(); loadRequests(); }
  if (document.getElementById('connections')) setInterval(loadConnections, 15000);
  if (document.getElementById('groupsList')) loadGroups();
  if (document.getElementById('leaderboard')) loadLeaderboard();
  if (document.getElementById('levelDetails')) loadLevelDetails();
  if (document.getElementById('groupFeed')) loadGroupFeed();
  if (document.getElementById('groupCreateForm')) document.getElementById('groupCreateForm').addEventListener('submit', handleGroupCreate);
  if (document.getElementById('groupPostForm')) document.getElementById('groupPostForm').addEventListener('submit', handleGroupPost);
  if (document.getElementById('changePasswordForm')) document.getElementById('changePasswordForm').addEventListener('submit', handleChangePassword);
  const openPasswordModalBtn = document.getElementById('openPasswordModalBtn');
  const closePasswordModalBtn = document.getElementById('closePasswordModalBtn');
  const passwordModal = document.getElementById('passwordModal');
  if (openPasswordModalBtn) openPasswordModalBtn.addEventListener('click', openPasswordModal);
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
    brandTitle.addEventListener('click', () => { location.href = '/'; });
  }
  
  // Post composer
  if (document.getElementById('postForm')) {
    document.getElementById('postForm').addEventListener('submit', submitPost);
    initPostModeSwitcher();
    const postImageInput = document.getElementById('postImage');
    if (postImageInput) postImageInput.addEventListener('change', handlePostImageSelection);
  }
  if (document.getElementById('storyForm')) {
    document.getElementById('storyForm').addEventListener('submit', handleStorySubmit);
    const storyImageInput = document.getElementById('storyImage');
    if (storyImageInput) storyImageInput.addEventListener('change', handleStoryImageSelection);
    loadStories();
    setInterval(loadStories, 30000);
  }
  if (document.getElementById('feed')) loadFeed();
  
  // Chat form
  if (document.getElementById('chatForm')) {
    document.getElementById('chatForm').addEventListener('submit', async (e)=>{
      e.preventDefault();
      const input = document.getElementById('chatInput');
      const content = input.value.trim(); if (!content) return;
      if (!currentChatUser) {
        showToast('Open a chat first', 'error');
        return;
      }
      const socketInst = ensureSocket();
      socketInst.emit('chatMessage',{ to: Number(currentChatUser), content });
      input.value='';
    });
  }
  
  // Auth forms
  if (document.getElementById('regForm')) document.getElementById('regForm').addEventListener('submit', handleRegister);
  if (document.getElementById('loginForm')) document.getElementById('loginForm').addEventListener('submit', handleLogin);
  if (document.getElementById('forgotForm')) document.getElementById('forgotForm').addEventListener('submit', handleForgotPassword);
  if (document.getElementById('profileEditForm')) {
    document.getElementById('profileEditForm').addEventListener('submit', handleProfileEditSubmit);
    loadProfileEditor();
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
    if (document.getElementById('adminUsers')) loadAdminUsers();
  })();
});
