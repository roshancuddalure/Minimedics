const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);

const app = express();
const PORT = process.env.PORT || 3000;

// ensure data directory
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// sqlite DB
const dbFile = path.join(dataDir, 'app.db');
const db = new sqlite3.Database(dbFile, (err) => {
	if (err) console.error('Database connection error:', err);
	else console.log('Database connected');
});

const XP_RULES = {
	DAILY_LOGIN: 20,
	POST_CREATE: 15,
	POST_LIKE: 4,
	POST_COMMENT: 6,
	POST_SAVE: 2,
	POST_SHARE: 8,
	GROUP_CREATE: 30,
	GROUP_POST: 10
};

function getLevelFromXp(xp) {
	const safeXp = Number(xp) || 0;
	return Math.floor(safeXp / 100) + 1;
}

function getTitleForLevel(level) {
	if (level >= 90) return 'Legend of Care';
	if (level >= 80) return 'Med Vanguard';
	if (level >= 70) return 'Chief Healer';
	if (level >= 60) return 'Health Innovator';
	if (level >= 50) return 'Community Mentor';
	if (level >= 40) return 'Diagnostic Strategist';
	if (level >= 30) return 'Care Coordinator';
	if (level >= 20) return 'Ward Collaborator';
	if (level >= 10) return 'Clinical Explorer';
	return 'Rookie Medic';
}

const runAsync = (sql, params = []) => new Promise((resolve, reject) => {
	db.run(sql, params, function onRun(err) {
		if (err) return reject(err);
		resolve(this);
	});
});

const getAsync = (sql, params = []) => new Promise((resolve, reject) => {
	db.get(sql, params, (err, row) => {
		if (err) return reject(err);
		resolve(row);
	});
});

const allAsync = (sql, params = []) => new Promise((resolve, reject) => {
	db.all(sql, params, (err, rows) => {
		if (err) return reject(err);
		resolve(rows);
	});
});

async function addXp(userId, activity, refType = null, refId = null) {
	const delta = XP_RULES[activity] || 0;
	if (!delta || !userId) return null;
	const user = await getAsync('SELECT xp FROM users WHERE id = ?', [userId]);
	if (!user) return null;
	const nextXp = (Number(user.xp) || 0) + delta;
	const nextLevel = getLevelFromXp(nextXp);
	const nextTitle = getTitleForLevel(nextLevel);
	await runAsync('UPDATE users SET xp = ?, level = ?, title = ? WHERE id = ?', [nextXp, nextLevel, nextTitle, userId]);
	await runAsync('INSERT INTO xp_events (user_id, activity, xp_delta, ref_type, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', [userId, activity, delta, refType, refId, Date.now()]);
	return { xp: nextXp, level: nextLevel, title: nextTitle, gained: delta };
}

async function getAcceptedConnectionIds(userId) {
	const rows = await allAsync(`SELECT CASE WHEN user_a = ? THEN user_b ELSE user_a END as id
		FROM connections
		WHERE (user_a = ? OR user_b = ?) AND status = 'accepted'`, [userId, userId, userId]);
	return rows.map((r) => Number(r.id)).filter((v) => !Number.isNaN(v));
}

async function getGroupRole(groupId, userId) {
	const row = await getAsync('SELECT role, status FROM group_memberships WHERE group_id = ? AND user_id = ?', [groupId, userId]);
	return row || null;
}

db.serialize(() => {
	db.run(`CREATE TABLE IF NOT EXISTS users (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT UNIQUE NOT NULL,
		password TEXT NOT NULL,
		name TEXT,
		last_login INTEGER,
		profile_picture TEXT,
		role TEXT DEFAULT 'user',
		xp INTEGER DEFAULT 0,
		level INTEGER DEFAULT 1,
		title TEXT DEFAULT 'Rookie Medic',
		last_xp_login_day TEXT
	)`, (err) => { if(err) console.log('Users table:', err); else console.log('Users table ready'); });
	
	// Add role column if it doesn't exist (for existing databases)
	db.run(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'`, (err) => {
		// It's OK if column already exists
	});
	db.run(`ALTER TABLE users ADD COLUMN xp INTEGER DEFAULT 0`, () => {});
	db.run(`ALTER TABLE users ADD COLUMN level INTEGER DEFAULT 1`, () => {});
	db.run(`ALTER TABLE users ADD COLUMN title TEXT DEFAULT 'Rookie Medic'`, () => {});
	db.run(`ALTER TABLE users ADD COLUMN last_xp_login_day TEXT`, () => {});
	db.run(`UPDATE users SET xp = COALESCE(xp, 0)`);
	db.run(`UPDATE users SET level = CASE WHEN level IS NULL OR level < 1 THEN 1 ELSE level END`);
	db.run(`UPDATE users SET title = COALESCE(title, 'Rookie Medic')`);
	db.run(`CREATE TABLE IF NOT EXISTS posts (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER,
		content TEXT,
		image TEXT,
		reminder_at INTEGER,
		reminder_note TEXT,
		created_at INTEGER,
		FOREIGN KEY(user_id) REFERENCES users(id)
	)`, (err) => { if(err) console.log('Posts table:', err); else console.log('Posts table ready'); });
	db.run(`ALTER TABLE posts ADD COLUMN image TEXT`, () => {});
	db.run(`ALTER TABLE posts ADD COLUMN reminder_at INTEGER`, () => {});
	db.run(`ALTER TABLE posts ADD COLUMN reminder_note TEXT`, () => {});
	db.run(`CREATE TABLE IF NOT EXISTS connections (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_a INTEGER,
		user_b INTEGER,
		status TEXT,
		created_at INTEGER
	)`, (err) => { if(err) console.log('Connections table:', err); else console.log('Connections table ready'); });
	db.run(`CREATE TABLE IF NOT EXISTS messages (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		from_user INTEGER,
		to_user INTEGER,
		content TEXT,
		created_at INTEGER
	)`, (err) => { if(err) console.log('Messages table:', err); else console.log('Messages table ready'); });
	db.run(`CREATE TABLE IF NOT EXISTS post_likes (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		post_id INTEGER NOT NULL,
		user_id INTEGER NOT NULL,
		created_at INTEGER,
		UNIQUE(post_id, user_id)
	)`);
	db.run(`CREATE TABLE IF NOT EXISTS post_comments (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		post_id INTEGER NOT NULL,
		user_id INTEGER NOT NULL,
		content TEXT NOT NULL,
		created_at INTEGER
	)`);
	db.run(`CREATE TABLE IF NOT EXISTS saved_posts (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		post_id INTEGER NOT NULL,
		user_id INTEGER NOT NULL,
		created_at INTEGER,
		UNIQUE(post_id, user_id)
	)`);
	db.run(`CREATE TABLE IF NOT EXISTS post_shares (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		post_id INTEGER NOT NULL,
		from_user INTEGER NOT NULL,
		to_user INTEGER NOT NULL,
		created_at INTEGER,
		UNIQUE(post_id, from_user, to_user)
	)`);
	db.run(`CREATE TABLE IF NOT EXISTS xp_events (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		user_id INTEGER NOT NULL,
		activity TEXT NOT NULL,
		xp_delta INTEGER NOT NULL,
		ref_type TEXT,
		ref_id INTEGER,
		created_at INTEGER
	)`);
	db.run(`CREATE TABLE IF NOT EXISTS groups (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL,
		description TEXT,
		is_private INTEGER DEFAULT 1,
		created_by INTEGER NOT NULL,
		created_at INTEGER
	)`);
	db.run(`CREATE TABLE IF NOT EXISTS group_memberships (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		group_id INTEGER NOT NULL,
		user_id INTEGER NOT NULL,
		role TEXT DEFAULT 'member',
		status TEXT DEFAULT 'pending',
		created_at INTEGER,
		UNIQUE(group_id, user_id)
	)`);
	db.run(`CREATE TABLE IF NOT EXISTS group_posts (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		group_id INTEGER NOT NULL,
		user_id INTEGER NOT NULL,
		content TEXT NOT NULL,
		created_at INTEGER
	)`);
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use(session({
	store: new SQLiteStore({ db: 'sessions.sqlite', dir: dataDir }),
	secret: process.env.SESSION_SECRET || 'dev-secret',
	resave: false,
	saveUninitialized: false,
	cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

app.use(express.static(path.join(__dirname, 'public')));

function requireAuth(req, res, next) {
	if (req.session.userId) return next();
	res.status(401).json({ error: 'Unauthorized' });
}

function requireAdmin(req, res, next) {
	if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
	db.get('SELECT role FROM users WHERE id = ?', [req.session.userId], (err, user) => {
		if (err || !user || user.role !== 'admin') {
			return res.status(403).json({ error: 'Forbidden - Admin access required' });
		}
		next();
	});
}

app.post('/api/register', async (req, res) => {
	const { username, password, name } = req.body;
	if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });
	
	try {
		// Check if this is the first user
		db.get('SELECT COUNT(*) as cnt FROM users', [], async (err, row) => {
			const isFirstUser = !err && row.cnt === 0;
			
			const hash = await bcrypt.hash(password, 10);
			const role = isFirstUser ? 'admin' : 'user';
			
			db.run('INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)', 
				[username, hash, name || '', role], 
				function (err) {
					if (err) {
						console.error('Register insert error:', err.message);
						return res.status(400).json({ error: 'Username already exists or database error' });
					}
					const userId = this.lastID;
					req.session.userId = userId;
					req.session.save((err) => {
						if (err) {
							console.error('Session save error:', err);
							return res.status(500).json({ error: 'Session error' });
						}
						console.log(`User registered: ${username} (ID: ${userId}, Role: ${role})`);
						res.json({ success: true, id: userId, role: role });
					});
				}
			);
		});
	} catch (e) {
		console.error('Register exception:', e);
		res.status(500).json({ error: 'Server error: ' + e.message });
	}
});

app.post('/api/login', (req, res) => {
	const { username, password } = req.body;
	if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });
	
	db.get('SELECT * FROM users WHERE username = ?', [username], async (err, user) => {
		if (err) {
			console.error('Login query error:', err);
			return res.status(500).json({ error: 'Database error' });
		}
		if (!user) {
			return res.status(400).json({ error: 'Invalid username or password' });
		}
		
		try {
			const ok = await bcrypt.compare(password, user.password);
			if (!ok) {
				return res.status(400).json({ error: 'Invalid username or password' });
			}
			
			// update last_login
			const ts = Date.now();
			db.run('UPDATE users SET last_login = ? WHERE id = ?', [ts, user.id], (err) => {
				if (err) console.error('Update last_login error:', err);
			});
			const today = new Date().toISOString().slice(0, 10);
			if (user.last_xp_login_day !== today) {
				db.run('UPDATE users SET last_xp_login_day = ? WHERE id = ?', [today, user.id], async (dayErr) => {
					if (!dayErr) {
						try { await addXp(user.id, 'DAILY_LOGIN', 'login', null); } catch (xpErr) { console.error('Daily XP error:', xpErr); }
					}
				});
			}
			
			req.session.userId = user.id;
			req.session.save((err) => {
				if (err) {
					console.error('Login session save error:', err);
					return res.status(500).json({ error: 'Session error' });
				}
				console.log(`User logged in: ${username} (ID: ${user.id})`);
				res.json({ success: true, id: user.id, last_login: user.last_login });
			});
		} catch (e) {
			console.error('Login bcrypt error:', e);
			res.status(500).json({ error: 'Authentication error' });
		}
	});
});

app.post('/api/forgot-password', async (req, res) => {
	const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
	const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
	const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword.trim() : '';
	if (!username || !newPassword) return res.status(400).json({ error: 'Username and new password are required' });
	if (newPassword.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
	try {
		const user = await getAsync('SELECT id, name FROM users WHERE username = ?', [username]);
		if (!user) return res.status(400).json({ error: 'Unable to verify account details' });
		const savedName = String(user.name || '').trim().toLowerCase();
		const providedName = name.toLowerCase();
		if (savedName && savedName !== providedName) return res.status(400).json({ error: 'Unable to verify account details' });
		const hash = await bcrypt.hash(newPassword, 10);
		await runAsync('UPDATE users SET password = ? WHERE id = ?', [hash, user.id]);
		return res.json({ success: true });
	} catch (e) {
		console.error('Forgot password error:', e);
		return res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/logout', (req, res) => {
	req.session.destroy(err => {
		res.json({ success: true });
	});
});

app.get('/api/me', (req, res) => {
	if (!req.session.userId) return res.json({ user: null });
	db.get('SELECT id, username, name, last_login, profile_picture, xp, level, title FROM users WHERE id = ?', [req.session.userId], (err, user) => {
		if (err) return res.status(500).json({ error: 'Server error' });
		if (!user) return res.json({ user: null });
		// get connections count
		const q = `SELECT COUNT(*) as cnt FROM connections WHERE ((user_a = ? OR user_b = ?) AND status = 'accepted')`;
		db.get(q, [user.id, user.id], (err2, row) => {
			if (err2) user.connections_count = 0;
			else user.connections_count = row.cnt || 0;
			res.json({ user });
		});
	});
});

// upload profile picture
app.post('/api/upload-picture', requireAuth, (req, res) => {
	const { image } = req.body; // base64 image
	if (!image || !image.startsWith('data:image')) return res.status(400).json({ error: 'Invalid image' });
	db.run('UPDATE users SET profile_picture = ? WHERE id = ?', [image, req.session.userId], (err) => {
		if (err) return res.status(500).json({ error: 'Server error' });
		res.json({ success: true });
	});
});

// get public user info with connections count
app.get('/api/user/:id', (req, res) => {
	const uid = req.params.id;
	db.get('SELECT id, username, name, profile_picture, level, title FROM users WHERE id = ?', [uid], (err, user) => {
		if (err || !user) return res.status(404).json({ error: 'User not found' });
		const q = `SELECT COUNT(*) as cnt FROM connections WHERE ((user_a = ? OR user_b = ?) AND status = 'accepted')`;
		db.get(q, [uid, uid], (err2, row) => {
			if (err2) user.connections_count = 0;
			else user.connections_count = row.cnt || 0;
			res.json({ user });
		});
	});
});

app.get('/api/feed', (req, res) => {
	const uid = Number(req.session.userId || 0);
	const q = `SELECT p.id, p.content, p.image, p.reminder_at, p.reminder_note, p.created_at, u.id as user_id, u.username, u.name, u.profile_picture,
		(SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) as like_count,
		(SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = p.id) as comment_count,
		(SELECT COUNT(*) FROM saved_posts sp WHERE sp.post_id = p.id) as save_count,
		(SELECT COUNT(*) FROM post_shares ps WHERE ps.post_id = p.id) as share_count,
		(SELECT COUNT(*) FROM post_likes pl2 WHERE pl2.post_id = p.id AND pl2.user_id = ${uid}) as my_liked,
		(SELECT COUNT(*) FROM saved_posts sp2 WHERE sp2.post_id = p.id AND sp2.user_id = ${uid}) as my_saved
		FROM posts p JOIN users u ON p.user_id = u.id
		ORDER BY p.created_at DESC LIMIT 50`;
	db.all(q, [], (err, rows) => {
		if (err) return res.status(500).json({ error: 'Server error' });
		res.json({ posts: rows });
	});
});

app.post('/api/post', requireAuth, (req, res) => {
	const { content, image, reminderAt, reminderNote } = req.body;
	const safeContent = typeof content === 'string' ? content.trim() : '';
	const safeReminderNote = typeof reminderNote === 'string' ? reminderNote.trim() : '';
	const hasImage = typeof image === 'string' && image.startsWith('data:image');
	let reminderAtTs = null;
	if (reminderAt) {
		const parsed = Number(reminderAt);
		if (!Number.isNaN(parsed) && parsed > 0) reminderAtTs = parsed;
	}
	if (!safeContent && !hasImage && !safeReminderNote) {
		return res.status(400).json({ error: 'Add text, image, or a reminder before posting' });
	}
	if (safeContent.length > 5000) return res.status(400).json({ error: 'Post too long' });
	if (hasImage && image.length > 7 * 1024 * 1024) return res.status(400).json({ error: 'Image is too large' });
	if (safeReminderNote.length > 240) return res.status(400).json({ error: 'Reminder note is too long' });
	const ts = Date.now();
	db.run('INSERT INTO posts (user_id, content, image, reminder_at, reminder_note, created_at) VALUES (?, ?, ?, ?, ?, ?)', 
		[req.session.userId, safeContent, hasImage ? image : null, reminderAtTs, safeReminderNote || null, ts], 
		async function (err) {
			if (err) {
				console.error('Post insert error:', err);
				return res.status(500).json({ error: 'Server error' });
			}
			console.log(`Post created: ${this.lastID}`);
			try { await addXp(req.session.userId, 'POST_CREATE', 'post', this.lastID); } catch (xpErr) { console.error('POST_CREATE XP error:', xpErr); }
			res.json({ success: true, id: this.lastID });
		});
});

app.delete('/api/post/:id', requireAuth, async (req, res) => {
	const postId = Number(req.params.id);
	const userId = Number(req.session.userId);
	if (!postId) return res.status(400).json({ error: 'Invalid post id' });
	try {
		const post = await getAsync('SELECT id, user_id FROM posts WHERE id = ?', [postId]);
		if (!post) return res.status(404).json({ error: 'Post not found' });
		if (Number(post.user_id) !== userId) return res.status(403).json({ error: 'You can delete only your own posts' });
		await runAsync('DELETE FROM post_comments WHERE post_id = ?', [postId]);
		await runAsync('DELETE FROM post_likes WHERE post_id = ?', [postId]);
		await runAsync('DELETE FROM saved_posts WHERE post_id = ?', [postId]);
		await runAsync('DELETE FROM post_shares WHERE post_id = ?', [postId]);
		await runAsync('DELETE FROM posts WHERE id = ?', [postId]);
		return res.json({ success: true });
	} catch (e) {
		console.error('Delete post API error:', e);
		return res.status(500).json({ error: 'Server error' });
	}
});

// Connections: send request
app.post('/api/connect/request', requireAuth, (req, res) => {
	const { to } = req.body;
	if (!to) return res.status(400).json({ error: 'Missing target user' });
	const a = Number(req.session.userId), b = Number(to);
	const ts = Date.now();
	// normalize ensure no duplicate
	const stmt = db.prepare('INSERT INTO connections (user_a,user_b,status,created_at) VALUES (?,?,?,?)');
	stmt.run(a, b, 'pending', ts, function (err) {
		if (err) return res.status(400).json({ error: 'Unable to create request' });
    // emit socket event to target user's room
    io.to(`user:${b}`).emit('connectionRequest', { from: a, to: b });
		res.json({ success: true });
	});
});

// accept request
app.post('/api/connect/accept', requireAuth, (req, res) => {
	const { id } = req.body;
	if (!id) return res.status(400).json({ error: 'Missing id' });
	db.run('UPDATE connections SET status = ? WHERE id = ?', ['accepted', id], function (err) {
		if (err) return res.status(500).json({ error: 'Server error' });
		res.json({ success: true });
	});
});

// decline/reject request
app.post('/api/connect/decline', requireAuth, (req, res) => {
	const { id } = req.body;
	if (!id) return res.status(400).json({ error: 'Missing id' });
	db.run('DELETE FROM connections WHERE id = ?', [id], function (err) {
		if (err) return res.status(500).json({ error: 'Server error' });
		res.json({ success: true });
	});
});

// list accepted connections for current user
app.get('/api/connections', requireAuth, (req, res) => {
	const uid = req.session.userId;
	const q = `SELECT u.id, u.username, u.name, u.profile_picture FROM users u JOIN connections c ON ( (c.user_a = ? AND c.user_b = u.id) OR (c.user_b = ? AND c.user_a = u.id) ) WHERE c.status = 'accepted'`;
	db.all(q, [uid, uid], (err, rows) => {
		if (err) return res.status(500).json({ error: 'Server error' });
		res.json({ connections: rows });
	});
});

// list incoming requests
app.get('/api/requests', requireAuth, (req, res) => {
	const uid = req.session.userId;
		db.all('SELECT c.id, c.user_a, c.user_b, c.status, u.username, u.name, u.profile_picture FROM connections c JOIN users u ON u.id = c.user_a WHERE c.user_b = ? AND c.status = ?', [uid, 'pending'], (err, rows) => {
		if (err) return res.status(500).json({ error: 'Server error' });
		res.json({ requests: rows });
	});
});

// messages history between current user and otherId
app.get('/api/messages/:otherId', requireAuth, (req, res) => {
	const uid = Number(req.session.userId);
	const other = Number(req.params.otherId);
	const q = `SELECT m.*, ua.username as from_username, ua.profile_picture as from_picture, ub.username as to_username FROM messages m LEFT JOIN users ua ON ua.id = m.from_user LEFT JOIN users ub ON ub.id = m.to_user WHERE (m.from_user = ? AND m.to_user = ?) OR (m.from_user = ? AND m.to_user = ?) ORDER BY m.created_at ASC`;
	db.all(q, [uid, other, other, uid], (err, rows) => {
		if (err) return res.status(500).json({ error: 'Server error' });
		res.json({ messages: rows });
	});
});

app.get('/api/post/:id/comments', (req, res) => {
	const postId = Number(req.params.id);
	if (!postId) return res.status(400).json({ error: 'Invalid post id' });
	const q = `SELECT c.id, c.post_id, c.user_id, c.content, c.created_at, u.username, u.name, u.profile_picture
		FROM post_comments c
		JOIN users u ON u.id = c.user_id
		WHERE c.post_id = ?
		ORDER BY c.created_at DESC
		LIMIT 50`;
	db.all(q, [postId], (err, rows) => {
		if (err) return res.status(500).json({ error: 'Server error' });
		res.json({ comments: rows });
	});
});

app.post('/api/post/:id/comment', requireAuth, (req, res) => {
	const postId = Number(req.params.id);
	const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
	if (!postId) return res.status(400).json({ error: 'Invalid post id' });
	if (!content) return res.status(400).json({ error: 'Comment cannot be empty' });
	if (content.length > 700) return res.status(400).json({ error: 'Comment too long' });
	const ts = Date.now();
	db.run('INSERT INTO post_comments (post_id, user_id, content, created_at) VALUES (?, ?, ?, ?)', [postId, req.session.userId, content, ts], async function onComment(err) {
		if (err) return res.status(500).json({ error: 'Server error' });
		try { await addXp(req.session.userId, 'POST_COMMENT', 'post', postId); } catch (xpErr) { console.error('POST_COMMENT XP error:', xpErr); }
		res.json({ success: true, id: this.lastID });
	});
});

app.delete('/api/post/:postId/comment/:commentId', requireAuth, async (req, res) => {
	const postId = Number(req.params.postId);
	const commentId = Number(req.params.commentId);
	const userId = Number(req.session.userId);
	if (!postId || !commentId) return res.status(400).json({ error: 'Invalid request' });
	try {
		const row = await getAsync(`SELECT c.id, c.user_id, c.post_id, p.user_id as post_owner_id
			FROM post_comments c
			JOIN posts p ON p.id = c.post_id
			WHERE c.id = ? AND c.post_id = ?`, [commentId, postId]);
		if (!row) return res.status(404).json({ error: 'Comment not found' });
		const isCommentOwner = Number(row.user_id) === userId;
		const isPostOwner = Number(row.post_owner_id) === userId;
		if (!isCommentOwner && !isPostOwner) return res.status(403).json({ error: 'Not allowed to delete this comment' });
		await runAsync('DELETE FROM post_comments WHERE id = ?', [commentId]);
		return res.json({ success: true });
	} catch (e) {
		console.error('Delete comment API error:', e);
		return res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/post/:id/like', requireAuth, async (req, res) => {
	const postId = Number(req.params.id);
	const userId = Number(req.session.userId);
	if (!postId) return res.status(400).json({ error: 'Invalid post id' });
	try {
		const existing = await getAsync('SELECT id FROM post_likes WHERE post_id = ? AND user_id = ?', [postId, userId]);
		if (existing) {
			await runAsync('DELETE FROM post_likes WHERE id = ?', [existing.id]);
			const c = await getAsync('SELECT COUNT(*) as cnt FROM post_likes WHERE post_id = ?', [postId]);
			return res.json({ success: true, liked: false, count: c.cnt || 0 });
		}
		await runAsync('INSERT INTO post_likes (post_id, user_id, created_at) VALUES (?, ?, ?)', [postId, userId, Date.now()]);
		await addXp(userId, 'POST_LIKE', 'post', postId);
		const c = await getAsync('SELECT COUNT(*) as cnt FROM post_likes WHERE post_id = ?', [postId]);
		return res.json({ success: true, liked: true, count: c.cnt || 0 });
	} catch (e) {
		console.error('Like API error:', e);
		return res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/post/:id/save', requireAuth, async (req, res) => {
	const postId = Number(req.params.id);
	const userId = Number(req.session.userId);
	if (!postId) return res.status(400).json({ error: 'Invalid post id' });
	try {
		const existing = await getAsync('SELECT id FROM saved_posts WHERE post_id = ? AND user_id = ?', [postId, userId]);
		if (existing) {
			await runAsync('DELETE FROM saved_posts WHERE id = ?', [existing.id]);
			const c = await getAsync('SELECT COUNT(*) as cnt FROM saved_posts WHERE post_id = ?', [postId]);
			return res.json({ success: true, saved: false, count: c.cnt || 0 });
		}
		await runAsync('INSERT INTO saved_posts (post_id, user_id, created_at) VALUES (?, ?, ?)', [postId, userId, Date.now()]);
		await addXp(userId, 'POST_SAVE', 'post', postId);
		const c = await getAsync('SELECT COUNT(*) as cnt FROM saved_posts WHERE post_id = ?', [postId]);
		return res.json({ success: true, saved: true, count: c.cnt || 0 });
	} catch (e) {
		console.error('Save API error:', e);
		return res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/post/:id/share', requireAuth, async (req, res) => {
	const postId = Number(req.params.id);
	const userId = Number(req.session.userId);
	if (!postId) return res.status(400).json({ error: 'Invalid post id' });
	try {
		const connections = await getAcceptedConnectionIds(userId);
		if (!connections.length) return res.status(400).json({ error: 'No accepted connections to share with' });
		const requestedTargets = Array.isArray(req.body.targets) ? req.body.targets.map((v) => Number(v)).filter((v) => !Number.isNaN(v)) : [];
		const targets = requestedTargets.length ? connections.filter((id) => requestedTargets.includes(id)) : connections;
		if (!targets.length) return res.status(400).json({ error: 'No valid targets selected' });
		const ts = Date.now();
		for (const toUser of targets) {
			try {
				await runAsync('INSERT INTO post_shares (post_id, from_user, to_user, created_at) VALUES (?, ?, ?, ?)', [postId, userId, toUser, ts]);
				await runAsync('INSERT INTO messages (from_user,to_user,content,created_at) VALUES (?,?,?,?)', [userId, toUser, `Shared a post (#${postId})`, ts]);
				io.to(`user:${toUser}`).emit('postShared', { postId, from: userId, to: toUser });
			} catch (shareErr) {
				// ignore duplicate share for same target
			}
		}
		await addXp(userId, 'POST_SHARE', 'post', postId);
		const c = await getAsync('SELECT COUNT(*) as cnt FROM post_shares WHERE post_id = ?', [postId]);
		return res.json({ success: true, sharedTo: targets.length, count: c.cnt || 0 });
	} catch (e) {
		console.error('Share API error:', e);
		return res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/saved-posts', requireAuth, async (req, res) => {
	try {
		const rows = await allAsync(`SELECT p.id, p.content, p.image, p.reminder_at, p.reminder_note, p.created_at, u.id as user_id, u.username, u.name, u.profile_picture
			FROM saved_posts sp
			JOIN posts p ON p.id = sp.post_id
			JOIN users u ON u.id = p.user_id
			WHERE sp.user_id = ?
			ORDER BY sp.created_at DESC`, [req.session.userId]);
		res.json({ posts: rows });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/xp/history', requireAuth, async (req, res) => {
	try {
		const rows = await allAsync('SELECT * FROM xp_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [req.session.userId]);
		res.json({ events: rows });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/leaderboard', async (req, res) => {
	try {
		const rows = await allAsync('SELECT id, username, name, profile_picture, xp, level, title FROM users ORDER BY xp DESC, id ASC LIMIT 20');
		res.json({ users: rows });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/groups', requireAuth, async (req, res) => {
	const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
	const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
	const isPrivate = req.body.isPrivate ? 1 : 0;
	if (!name) return res.status(400).json({ error: 'Group name is required' });
	if (name.length > 80) return res.status(400).json({ error: 'Group name is too long' });
	try {
		const ts = Date.now();
		const created = await runAsync('INSERT INTO groups (name, description, is_private, created_by, created_at) VALUES (?, ?, ?, ?, ?)', [name, description, isPrivate, req.session.userId, ts]);
		await runAsync('INSERT INTO group_memberships (group_id, user_id, role, status, created_at) VALUES (?, ?, ?, ?, ?)', [created.lastID, req.session.userId, 'admin', 'active', ts]);
		await addXp(req.session.userId, 'GROUP_CREATE', 'group', created.lastID);
		res.json({ success: true, id: created.lastID });
	} catch (e) {
		console.error('Create group error:', e);
		res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/groups', requireAuth, async (req, res) => {
	try {
		const rows = await allAsync(`SELECT g.id, g.name, g.description, g.is_private, g.created_by, g.created_at,
			(SELECT COUNT(*) FROM group_memberships gm WHERE gm.group_id = g.id AND gm.status = 'active') as member_count,
			(SELECT role FROM group_memberships gm2 WHERE gm2.group_id = g.id AND gm2.user_id = ?) as my_role,
			(SELECT status FROM group_memberships gm3 WHERE gm3.group_id = g.id AND gm3.user_id = ?) as my_status
			FROM groups g
			ORDER BY g.created_at DESC`, [req.session.userId, req.session.userId]);
		res.json({ groups: rows });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/groups/:id/join', requireAuth, async (req, res) => {
	const groupId = Number(req.params.id);
	if (!groupId) return res.status(400).json({ error: 'Invalid group id' });
	try {
		const g = await getAsync('SELECT id, is_private FROM groups WHERE id = ?', [groupId]);
		if (!g) return res.status(404).json({ error: 'Group not found' });
		const status = Number(g.is_private) === 1 ? 'pending' : 'active';
		await runAsync('INSERT OR REPLACE INTO group_memberships (group_id, user_id, role, status, created_at) VALUES (?, ?, COALESCE((SELECT role FROM group_memberships WHERE group_id = ? AND user_id = ?), ?), ?, ?)', [groupId, req.session.userId, groupId, req.session.userId, 'member', status, Date.now()]);
		res.json({ success: true, status });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/groups/:id/members', requireAuth, async (req, res) => {
	const groupId = Number(req.params.id);
	if (!groupId) return res.status(400).json({ error: 'Invalid group id' });
	try {
		const mine = await getGroupRole(groupId, req.session.userId);
		if (!mine || mine.status !== 'active') return res.status(403).json({ error: 'Join this group first' });
		const rows = await allAsync(`SELECT gm.user_id as id, gm.role, gm.status, u.username, u.name, u.profile_picture
			FROM group_memberships gm
			JOIN users u ON u.id = gm.user_id
			WHERE gm.group_id = ?
			ORDER BY CASE gm.role WHEN 'admin' THEN 1 WHEN 'moderator' THEN 2 ELSE 3 END, u.username ASC`, [groupId]);
		res.json({ members: rows });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/groups/:id/requests', requireAuth, async (req, res) => {
	const groupId = Number(req.params.id);
	if (!groupId) return res.status(400).json({ error: 'Invalid group id' });
	try {
		const mine = await getGroupRole(groupId, req.session.userId);
		if (!mine || mine.status !== 'active' || !['admin', 'moderator'].includes(mine.role)) return res.status(403).json({ error: 'Moderator access required' });
		const rows = await allAsync(`SELECT gm.user_id as id, u.username, u.name, u.profile_picture, gm.created_at
			FROM group_memberships gm
			JOIN users u ON u.id = gm.user_id
			WHERE gm.group_id = ? AND gm.status = 'pending'
			ORDER BY gm.created_at ASC`, [groupId]);
		res.json({ requests: rows });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/groups/:id/requests/:userId', requireAuth, async (req, res) => {
	const groupId = Number(req.params.id);
	const targetUserId = Number(req.params.userId);
	const action = req.body.action;
	if (!groupId || !targetUserId) return res.status(400).json({ error: 'Invalid request' });
	if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
	try {
		const mine = await getGroupRole(groupId, req.session.userId);
		if (!mine || mine.status !== 'active' || !['admin', 'moderator'].includes(mine.role)) return res.status(403).json({ error: 'Moderator access required' });
		if (action === 'approve') {
			await runAsync('UPDATE group_memberships SET status = ? WHERE group_id = ? AND user_id = ?', ['active', groupId, targetUserId]);
		} else {
			await runAsync('DELETE FROM group_memberships WHERE group_id = ? AND user_id = ? AND status = ?', [groupId, targetUserId, 'pending']);
		}
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/groups/:id/role', requireAuth, async (req, res) => {
	const groupId = Number(req.params.id);
	const targetUserId = Number(req.body.userId);
	const nextRole = req.body.role;
	if (!groupId || !targetUserId) return res.status(400).json({ error: 'Invalid request' });
	if (!['admin', 'moderator', 'member'].includes(nextRole)) return res.status(400).json({ error: 'Invalid role' });
	try {
		const mine = await getGroupRole(groupId, req.session.userId);
		if (!mine || mine.status !== 'active' || mine.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
		await runAsync('UPDATE group_memberships SET role = ? WHERE group_id = ? AND user_id = ? AND status = ?', [nextRole, groupId, targetUserId, 'active']);
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/groups/:id/feed', requireAuth, async (req, res) => {
	const groupId = Number(req.params.id);
	if (!groupId) return res.status(400).json({ error: 'Invalid group id' });
	try {
		const mine = await getGroupRole(groupId, req.session.userId);
		if (!mine || mine.status !== 'active') return res.status(403).json({ error: 'Join this group first' });
		const rows = await allAsync(`SELECT gp.id, gp.group_id, gp.user_id, gp.content, gp.created_at, u.username, u.name, u.profile_picture
			FROM group_posts gp
			JOIN users u ON u.id = gp.user_id
			WHERE gp.group_id = ?
			ORDER BY gp.created_at DESC
			LIMIT 50`, [groupId]);
		res.json({ posts: rows });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/groups/:id/post', requireAuth, async (req, res) => {
	const groupId = Number(req.params.id);
	const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
	if (!groupId) return res.status(400).json({ error: 'Invalid group id' });
	if (!content) return res.status(400).json({ error: 'Post content is required' });
	if (content.length > 5000) return res.status(400).json({ error: 'Post too long' });
	try {
		const mine = await getGroupRole(groupId, req.session.userId);
		if (!mine || mine.status !== 'active') return res.status(403).json({ error: 'Join this group first' });
		const created = await runAsync('INSERT INTO group_posts (group_id, user_id, content, created_at) VALUES (?, ?, ?, ?)', [groupId, req.session.userId, content, Date.now()]);
		await addXp(req.session.userId, 'GROUP_POST', 'group', groupId);
		res.json({ success: true, id: created.lastID });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.delete('/api/groups/:groupId/post/:postId', requireAuth, async (req, res) => {
	const groupId = Number(req.params.groupId);
	const postId = Number(req.params.postId);
	const userId = Number(req.session.userId);
	if (!groupId || !postId) return res.status(400).json({ error: 'Invalid request' });
	try {
		const mine = await getGroupRole(groupId, userId);
		if (!mine || mine.status !== 'active') return res.status(403).json({ error: 'Join this group first' });
		const post = await getAsync('SELECT id, user_id FROM group_posts WHERE id = ? AND group_id = ?', [postId, groupId]);
		if (!post) return res.status(404).json({ error: 'Group post not found' });
		const canModerate = ['admin', 'moderator'].includes(mine.role);
		const isOwner = Number(post.user_id) === userId;
		if (!isOwner && !canModerate) return res.status(403).json({ error: 'Not allowed to delete this group post' });
		await runAsync('DELETE FROM group_posts WHERE id = ?', [postId]);
		return res.json({ success: true });
	} catch (e) {
		console.error('Delete group post API error:', e);
		return res.status(500).json({ error: 'Server error' });
	}
});

// search API
app.get('/api/search', (req, res) => {
	const q = req.query.q ? req.query.q.trim() : '';
	if (!q || q.length < 2) return res.json({ results: [] });
	
	const searchTerm = `%${q}%`;
	
	// Search users
	const userQuery = `SELECT id, username, name, profile_picture, 'user' as type FROM users WHERE username LIKE ? OR name LIKE ? LIMIT 8`;
	
	// Search posts
	const postQuery = `SELECT p.id, p.content, p.created_at, u.id as user_id, u.username, u.name, u.profile_picture, 'post' as type FROM posts p JOIN users u ON p.user_id = u.id WHERE p.content LIKE ? ORDER BY p.created_at DESC LIMIT 8`;
	
	const allResults = [];
	
	db.all(userQuery, [searchTerm, searchTerm], (err, users) => {
		if (users) allResults.push(...users);
		
		db.all(postQuery, [searchTerm], (err2, posts) => {
			if (posts) allResults.push(...posts);
			
			// Sort: users first, then posts
			const sorted = [
				...allResults.filter(r => r.type === 'user'),
				...allResults.filter(r => r.type === 'post')
			];
			
			res.json({ results: sorted });
		});
	});
});

app.get('/dashboard', (req, res) => {
	if (!req.session.userId) return res.redirect('/login.html');
	res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

const http = require('http');
const server = http.createServer(app);
const { Server: IOServer } = require('socket.io');
const io = new IOServer(server);

// simple in-memory map of userId -> socket ids
const userSockets = new Map();

io.on('connection', (socket) => {
	socket.on('identify', (userId) => {
		socket.userId = userId;
		userSockets.set(String(userId), socket.id);
		socket.join(`user:${userId}`);
	});

	socket.on('joinRoom', (room) => {
		socket.join(room);
	});

	socket.on('chatMessage', (data) => {
		// data: { to, content }
		const from = socket.userId;
		if (!from) return;
		const to = data.to;
		const content = data.content;
		const created_at = Date.now();
		db.run('INSERT INTO messages (from_user,to_user,content,created_at) VALUES (?,?,?,?)', [from, to, content, created_at], function (err) {
			const msg = { id: this ? this.lastID : null, from, to, content, created_at };
			// room is normalized: smallerId:largerId
			const a = Number(from), b = Number(to);
			const room = `chat:${Math.min(a,b)}:${Math.max(a,b)}`;
			io.to(room).emit('message', msg);
		});
	});

	socket.on('disconnect', () => {
		if (socket.userId) userSockets.delete(String(socket.userId));
	});
});

server.listen(PORT, () => {
	console.log(`Server listening on http://localhost:${PORT}`);
});
