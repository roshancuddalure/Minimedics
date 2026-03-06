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
          // Go to user profile or open user card
          showToast('Opening profile for ' + (r.name || r.username));
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
let selectedGroupId = null;
let selectedGroupRole = null;

async function api(path, method='GET', data) {
  const opts = { method, headers: {} };
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
  res.comments.slice(0, 10).forEach((c) => {
    const row = document.createElement('div');
    row.className = 'comment-item';
    row.innerHTML = `<div class="meta">${escapeHtml(c.name || c.username)} - ${new Date(c.created_at).toLocaleString()}</div><div>${escapeHtml(c.content)}</div>`;
    const canDelete = meId && (Number(c.user_id) === Number(meId) || Number(postOwnerId) === Number(meId));
    if (canDelete) {
      const delBtn = createActionButton('Delete', () => {}, 'btn secondary tiny-btn');
      delBtn.addEventListener('click', () => deleteComment(postId, c.id, mountEl, meId, postOwnerId, delBtn));
      row.appendChild(delBtn);
    }
    mountEl.appendChild(row);
  });
}

async function postComment(postId, inputEl, commentsMount, meId = null, postOwnerId = null) {
  const content = inputEl.value.trim();
  if (!content) return;
  const res = await api(`/api/post/${postId}/comment`, 'POST', { content });
  if (res && res.success) {
    inputEl.value = '';
    loadComments(postId, commentsMount, meId, postOwnerId);
    showToast('Comment added');
  } else {
    showToast(res.error || 'Unable to add comment', 'error');
  }
}

// load feed
async function loadFeed() {
  const box = document.getElementById('feed');
  if (!box) return;
  box.innerHTML = '<div class="muted center" style="padding:40px">Loading posts...</div>';
  const { posts, error } = await api('/api/feed');
  if (error) { 
    box.innerHTML = '<div class="muted" style="padding:20px;text-align:center">Unable to load posts</div>'; 
    return;
  }
  if (!posts || posts.length===0) { 
    box.innerHTML = '<div class="muted" style="padding:40px;text-align:center">No posts yet. Be the first to share!</div>'; 
    return;
  }
  box.innerHTML = '';
  const meRes = await api('/api/me');
  const meId = meRes.user ? meRes.user.id : null;
  window.__me = meRes.user || null;
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
    const el = document.createElement('div');
    el.innerHTML = `<div style="display:flex;gap:12px;align-items:center;margin-bottom:12px;padding:12px;background:var(--card);border-radius:8px;transition:all 0.2s;border:1px solid var(--border)" onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
      <img src="${c.profile_picture || 'data:image/svg+xml,<svg></svg>'}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;border:2px solid var(--accent)" loading="lazy" />
      <div style="flex:1">
        <div style="font-weight:500">${c.name || c.username}</div>
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
      <div class="muted">Members: ${g.member_count || 0} | ${myState}${g.my_role ? ` | ${g.my_role}` : ''}</div>`;
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
  const content = ta.value.trim();
  const reminderNote = reminderNoteInput ? reminderNoteInput.value.trim() : '';
  const reminderAtRaw = reminderAtInput ? reminderAtInput.value : '';
  const reminderAt = reminderAtRaw ? new Date(reminderAtRaw).getTime() : null;

  if (!content && !selectedPostImageDataUrl && !reminderNote) { 
    showToast('Add text, image, or a reminder first.'); 
    return;
  }
  if (content.length > 5000) {
    showToast('Post is too long (max 5000 characters)', 'error');
    return;
  }
  if (reminderNote.length > 240) {
    showToast('Reminder note should be 240 chars or less', 'error');
    return;
  }
  if (reminderAtRaw && Number.isNaN(reminderAt)) {
    showToast('Please choose a valid reminder date/time', 'error');
    return;
  }
  
  const btn = form.querySelector('button[type="submit"]');
  setLoading(form, true);
  btn.textContent = 'Posting...';
  
  const res = await api('/api/post','POST',{
    content,
    image: selectedPostImageDataUrl,
    reminderAt,
    reminderNote
  });
  
  setLoading(form, false);
  btn.textContent = 'Post';
  
  if (res && res.success) { 
    ta.value='';
    if (reminderAtInput) reminderAtInput.value = '';
    if (reminderNoteInput) reminderNoteInput.value = '';
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
  
  if (!u || !p) { 
    showToast('Username and password required', 'error'); 
    return; 
  }
  
  if (p.length < 6) {
    showToast('Password must be at least 6 characters', 'error');
    return;
  }
  
  setLoading(form, true);
  submitBtn.textContent = 'Creating...';
  
  const res = await api('/api/register','POST',{username:u,password:p,name:n});
  
  setLoading(form, false);
  submitBtn.textContent = 'Register';
  
  if (res && res.success) { 
    showToast('Account created. Redirecting...');
    setTimeout(() => { location.href='/dashboard'; }, 1000);
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
  
  if (!u || !p) { 
    showToast('Username and password required', 'error'); 
    return; 
  }
  
  setLoading(form, true);
  submitBtn.textContent = 'Logging in...';
  
  const res = await api('/api/login','POST',{username:u,password:p});
  
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
  const res = await api('/api/me');
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
  holder.innerHTML = `<div class="profile card">
    <img id="profilePic" src="${picUrl}" class="profile-picture" />
    <h3>${res.user.name || res.user.username}</h3>
    <p class="muted">Title: ${escapeHtml(res.user.title || 'Rookie Medic')}</p>
    <p class="muted">Level ${res.user.level || 1} | XP ${res.user.xp || 0}</p>
    <p class="muted">Connections: ${res.user.connections_count || 0}</p>
    <p class="muted">Last login: ${last}</p>
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
  if (document.getElementById('groupsList')) loadGroups();
  if (document.getElementById('leaderboard')) loadLeaderboard();
  if (document.getElementById('groupFeed')) loadGroupFeed();
  if (document.getElementById('groupCreateForm')) document.getElementById('groupCreateForm').addEventListener('submit', handleGroupCreate);
  if (document.getElementById('groupPostForm')) document.getElementById('groupPostForm').addEventListener('submit', handleGroupPost);
  
  // Post composer
  if (document.getElementById('postForm')) {
    document.getElementById('postForm').addEventListener('submit', submitPost);
    const postImageInput = document.getElementById('postImage');
    if (postImageInput) postImageInput.addEventListener('change', handlePostImageSelection);
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
  
  // Profile display
  loadProfile();
});
