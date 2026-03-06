require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);

const app = express();
const PORT = process.env.PORT || 3000;

function getDatabaseUrl() {
	const candidateKeys = [
		'DATABASE_URL',
		'DATABASE_PRIVATE_URL',
		'POSTGRES_URL',
		'POSTGRESQL_URL',
		'PGDATABASE_URL'
	];
	for (const key of candidateKeys) {
		const value = typeof process.env[key] === 'string' ? process.env[key].trim() : '';
		if (value) return value;
	}
	// Optional fallback (disabled by default): enable only when explicitly requested.
	const allowFileFallback = String(process.env.USE_RAILWAY_FILE_DB_URL || '').toLowerCase() === 'true';
	if (!allowFileFallback) return '';
	const localRailwayFile = path.join(__dirname, 'postgresql railway.txt');
	if (fs.existsSync(localRailwayFile)) {
		const raw = fs.readFileSync(localRailwayFile, 'utf8').trim();
		if (raw) return raw;
	}
	return '';
}

const databaseUrl = getDatabaseUrl();
const dbConfig = databaseUrl
	? { connectionString: databaseUrl }
	: {
		host: process.env.PGHOST || 'localhost',
		port: Number(process.env.PGPORT || 5432),
		user: process.env.PGUSER || 'postgres',
		password: process.env.PGPASSWORD || '',
		database: process.env.PGDATABASE || 'project1codex'
	};

function shouldEnableSsl(url) {
	const mode = String(process.env.PGSSLMODE || '').toLowerCase();
	if (mode === 'disable') return false;
	if (mode === 'require') return true;
	if (!url) return process.env.NODE_ENV === 'production';
	try {
		const host = new URL(url).hostname || '';
		if (host.endsWith('.railway.internal')) return false;
	} catch (e) {
		// ignore parse issues and keep default behavior
	}
	return process.env.NODE_ENV === 'production';
}

const shouldUseSsl = shouldEnableSsl(databaseUrl);

function getDbTargetLabel() {
	if (databaseUrl) {
		try {
			const parsed = new URL(databaseUrl);
			return `${parsed.hostname}:${parsed.port || '5432'}`;
		} catch (e) {
			return 'DATABASE_URL';
		}
	}
	return `${dbConfig.host}:${dbConfig.port}`;
}

const pool = new Pool({
	...dbConfig,
	ssl: shouldUseSsl ? { rejectUnauthorized: false } : undefined
});
pool.on('error', (err) => {
	console.error('PostgreSQL pool error:', err);
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

// userId -> set of connected socket ids
const userSockets = new Map();

function markUserOnline(userId, socketId) {
	const key = String(userId);
	if (!key || !socketId) return;
	if (!userSockets.has(key)) userSockets.set(key, new Set());
	userSockets.get(key).add(String(socketId));
}

function markUserOffline(userId, socketId) {
	const key = String(userId);
	if (!key || !socketId) return;
	const sockets = userSockets.get(key);
	if (!sockets) return;
	sockets.delete(String(socketId));
	if (!sockets.size) userSockets.delete(key);
}

function isUserOnline(userId) {
	const sockets = userSockets.get(String(userId));
	return Boolean(sockets && sockets.size > 0);
}

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

function convertPlaceholders(sql) {
	let idx = 0;
	return sql.replace(/\?/g, () => {
		idx += 1;
		return `$${idx}`;
	});
}

async function executeQuery(sql, params = [], options = {}) {
	const convertedSql = convertPlaceholders(sql);
	const isInsert = /^\s*insert\s+/i.test(convertedSql);
	const hasReturning = /\breturning\b/i.test(convertedSql);
	const finalSql = (options.expectLastId && isInsert && !hasReturning)
		? `${convertedSql} RETURNING id`
		: convertedSql;
	const result = await pool.query(finalSql, params);
	return result;
}

const db = {
	run(sql, params = [], cb) {
		executeQuery(sql, params, { expectLastId: true })
			.then((result) => {
				const ctx = {
					lastID: result.rows && result.rows[0] ? result.rows[0].id : null,
					changes: result.rowCount || 0
				};
				if (typeof cb === 'function') cb.call(ctx, null);
			})
			.catch((err) => {
				if (typeof cb === 'function') cb.call({ lastID: null, changes: 0 }, err);
			});
	},
	get(sql, params = [], cb) {
		executeQuery(sql, params)
			.then((result) => cb(null, result.rows[0] || undefined))
			.catch((err) => cb(err));
	},
	all(sql, params = [], cb) {
		executeQuery(sql, params)
			.then((result) => cb(null, result.rows || []))
			.catch((err) => cb(err));
	}
};

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

async function initializeDatabase() {
	await runAsync(`CREATE TABLE IF NOT EXISTS users (
		id BIGSERIAL PRIMARY KEY,
		username TEXT UNIQUE NOT NULL,
		password TEXT NOT NULL,
		name TEXT,
		email TEXT,
		bio TEXT,
		institute TEXT,
		program_type TEXT,
		degree TEXT,
		academic_year TEXT,
		speciality TEXT,
		email_verified INTEGER DEFAULT 0,
		email_verify_token TEXT,
		last_login BIGINT,
		profile_picture TEXT,
		role TEXT DEFAULT 'user',
		xp INTEGER DEFAULT 0,
		level INTEGER DEFAULT 1,
		title TEXT DEFAULT 'Rookie Medic',
		last_xp_login_day TEXT
	)`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user'`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS institute TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS program_type TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS degree TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS academic_year TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS speciality TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified INTEGER DEFAULT 0`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_token TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS xp INTEGER DEFAULT 0`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS level INTEGER DEFAULT 1`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS title TEXT DEFAULT 'Rookie Medic'`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_xp_login_day TEXT`);
	await runAsync(`UPDATE users SET xp = COALESCE(xp, 0)`);
	await runAsync(`UPDATE users SET level = CASE WHEN level IS NULL OR level < 1 THEN 1 ELSE level END`);
	await runAsync(`UPDATE users SET title = COALESCE(title, 'Rookie Medic')`);

	await runAsync(`CREATE TABLE IF NOT EXISTS posts (
		id BIGSERIAL PRIMARY KEY,
		user_id BIGINT REFERENCES users(id),
		content TEXT,
		image TEXT,
		quiz_question TEXT,
		quiz_options TEXT,
		quiz_correct_index INTEGER,
		visibility TEXT DEFAULT 'public',
		reminder_at BIGINT,
		reminder_note TEXT,
		created_at BIGINT
	)`);
	await runAsync(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS image TEXT`);
	await runAsync(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS quiz_question TEXT`);
	await runAsync(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS quiz_options TEXT`);
	await runAsync(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS quiz_correct_index INTEGER`);
	await runAsync(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS visibility TEXT DEFAULT 'public'`);
	await runAsync(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS reminder_at BIGINT`);
	await runAsync(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS reminder_note TEXT`);

	await runAsync(`CREATE TABLE IF NOT EXISTS connections (
		id BIGSERIAL PRIMARY KEY,
		user_a BIGINT,
		user_b BIGINT,
		status TEXT,
		created_at BIGINT
	)`);
	await runAsync(`CREATE TABLE IF NOT EXISTS messages (
		id BIGSERIAL PRIMARY KEY,
		from_user BIGINT,
		to_user BIGINT,
		content TEXT,
		created_at BIGINT
	)`);
	await runAsync(`CREATE TABLE IF NOT EXISTS post_likes (
		id BIGSERIAL PRIMARY KEY,
		post_id BIGINT NOT NULL,
		user_id BIGINT NOT NULL,
		created_at BIGINT,
		UNIQUE(post_id, user_id)
	)`);
	await runAsync(`CREATE TABLE IF NOT EXISTS post_comments (
		id BIGSERIAL PRIMARY KEY,
		post_id BIGINT NOT NULL,
		user_id BIGINT NOT NULL,
		parent_comment_id BIGINT,
		mention_user_id BIGINT,
		content TEXT NOT NULL,
		created_at BIGINT
	)`);
	await runAsync(`ALTER TABLE post_comments ADD COLUMN IF NOT EXISTS parent_comment_id BIGINT`);
	await runAsync(`ALTER TABLE post_comments ADD COLUMN IF NOT EXISTS mention_user_id BIGINT`);
	await runAsync(`CREATE TABLE IF NOT EXISTS saved_posts (
		id BIGSERIAL PRIMARY KEY,
		post_id BIGINT NOT NULL,
		user_id BIGINT NOT NULL,
		created_at BIGINT,
		UNIQUE(post_id, user_id)
	)`);
	await runAsync(`CREATE TABLE IF NOT EXISTS post_shares (
		id BIGSERIAL PRIMARY KEY,
		post_id BIGINT NOT NULL,
		from_user BIGINT NOT NULL,
		to_user BIGINT NOT NULL,
		created_at BIGINT,
		UNIQUE(post_id, from_user, to_user)
	)`);
	await runAsync(`CREATE TABLE IF NOT EXISTS xp_events (
		id BIGSERIAL PRIMARY KEY,
		user_id BIGINT NOT NULL,
		activity TEXT NOT NULL,
		xp_delta INTEGER NOT NULL,
		ref_type TEXT,
		ref_id BIGINT,
		created_at BIGINT
	)`);
	await runAsync(`CREATE TABLE IF NOT EXISTS groups (
		id BIGSERIAL PRIMARY KEY,
		name TEXT NOT NULL,
		description TEXT,
		is_private INTEGER DEFAULT 1,
		clan_xp INTEGER DEFAULT 0,
		clan_level INTEGER DEFAULT 1,
		created_by BIGINT NOT NULL,
		created_at BIGINT
	)`);
	await runAsync(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS clan_xp INTEGER DEFAULT 0`);
	await runAsync(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS clan_level INTEGER DEFAULT 1`);
	await runAsync(`CREATE TABLE IF NOT EXISTS group_memberships (
		id BIGSERIAL PRIMARY KEY,
		group_id BIGINT NOT NULL,
		user_id BIGINT NOT NULL,
		role TEXT DEFAULT 'member',
		status TEXT DEFAULT 'pending',
		created_at BIGINT,
		UNIQUE(group_id, user_id)
	)`);
	await runAsync(`CREATE TABLE IF NOT EXISTS group_posts (
		id BIGSERIAL PRIMARY KEY,
		group_id BIGINT NOT NULL,
		user_id BIGINT NOT NULL,
		content TEXT NOT NULL,
		created_at BIGINT
	)`);
	await runAsync(`CREATE TABLE IF NOT EXISTS stories (
		id BIGSERIAL PRIMARY KEY,
		user_id BIGINT NOT NULL,
		content TEXT,
		image TEXT,
		created_at BIGINT NOT NULL,
		expires_at BIGINT NOT NULL
	)`);
	await runAsync(`CREATE TABLE IF NOT EXISTS quiz_attempts (
		id BIGSERIAL PRIMARY KEY,
		post_id BIGINT NOT NULL,
		user_id BIGINT NOT NULL,
		selected_index INTEGER NOT NULL,
		is_correct INTEGER NOT NULL,
		created_at BIGINT,
		UNIQUE(post_id, user_id)
	)`);
	await runAsync(`CREATE TABLE IF NOT EXISTS speciality_suggestions (
		id BIGSERIAL PRIMARY KEY,
		user_id BIGINT NOT NULL,
		suggestion TEXT NOT NULL,
		created_at BIGINT
	)`);
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use(session({
	store: new PgSession({
		pool,
		tableName: 'user_sessions',
		createTableIfMissing: true
	}),
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
	const { username, password, name, email, institute, programType, degree, academicYear, speciality } = req.body;
	if (!username || !password || !name || !email || !institute) {
		return res.status(400).json({ error: 'Username, password, full name, email, and institute are required' });
	}
	const safeEmail = typeof email === 'string' ? email.trim() : '';
	const safeInstitute = typeof institute === 'string' ? institute.trim() : '';
	const safeProgramType = typeof programType === 'string' ? programType.trim() : '';
	const safeDegree = typeof degree === 'string' ? degree.trim() : '';
	const safeAcademicYear = typeof academicYear === 'string' ? academicYear.trim() : '';
	const safeSpeciality = typeof speciality === 'string' ? speciality.trim() : '';
	if (safeEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safeEmail)) {
		return res.status(400).json({ error: 'Please provide a valid email address' });
	}
	if (safeProgramType === 'student' && (!safeDegree || !safeAcademicYear)) {
		return res.status(400).json({ error: 'Degree and academic year are required for students' });
	}
	
	try {
		// Check if this is the first user
		db.get('SELECT COUNT(*) as cnt FROM users', [], async (err, row) => {
			const isFirstUser = !err && row.cnt === 0;
			
			const hash = await bcrypt.hash(password, 10);
			const role = isFirstUser ? 'admin' : 'user';
			const verifyToken = Math.random().toString(36).slice(2) + Date.now().toString(36);
			
			db.run('INSERT INTO users (username, password, name, email, institute, program_type, degree, academic_year, speciality, role, email_verified, email_verify_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 
				[username, hash, name || '', safeEmail || null, safeInstitute || null, safeProgramType || null, safeDegree || null, safeAcademicYear || null, safeSpeciality || null, role, 0, verifyToken], 
				function (err) {
					if (err) {
						console.error('Register insert error:', err.message);
						return res.status(400).json({ error: 'Username already exists or database error' });
					}
					const userId = this.lastID;
					console.log(`User registered: ${username} (ID: ${userId}, Role: ${role})`);
					res.json({ success: true, id: userId, role: role, emailVerified: false, verifyUrl: `/verify-email.html?token=${verifyToken}` });
				}
			);
		});
	} catch (e) {
		console.error('Register exception:', e);
		res.status(500).json({ error: 'Server error: ' + e.message });
	}
});

app.post('/api/login', (req, res) => {
	const { username, password, rememberMe } = req.body;
	if (!username || !password) return res.status(400).json({ error: 'Missing username or password' });
	
	db.get('SELECT * FROM users WHERE username = ? OR email = ?', [username, username], async (err, user) => {
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
			if (!Number(user.email_verified)) {
				return res.status(403).json({ error: 'Please verify your email before logging in' });
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
			req.session.cookie.maxAge = rememberMe ? (1000 * 60 * 60 * 24 * 7) : (1000 * 60 * 60 * 24);
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

app.post('/api/change-password', requireAuth, async (req, res) => {
	const currentPassword = typeof req.body.currentPassword === 'string' ? req.body.currentPassword.trim() : '';
	const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword.trim() : '';
	if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password are required' });
	if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });
	try {
		const user = await getAsync('SELECT id, password FROM users WHERE id = ?', [req.session.userId]);
		if (!user) return res.status(404).json({ error: 'User not found' });
		const ok = await bcrypt.compare(currentPassword, user.password);
		if (!ok) return res.status(400).json({ error: 'Current password is incorrect' });
		const hash = await bcrypt.hash(newPassword, 10);
		await runAsync('UPDATE users SET password = ? WHERE id = ?', [hash, req.session.userId]);
		res.json({ success: true });
	} catch (e) {
		console.error('Change password error:', e);
		res.status(500).json({ error: 'Server error' });
	}
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
	db.get('SELECT id, username, name, email, bio, institute, program_type, degree, academic_year, speciality, role, email_verified, last_login, profile_picture, xp, level, title FROM users WHERE id = ?', [req.session.userId], (err, user) => {
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

app.get('/api/verify-email', async (req, res) => {
	const token = typeof req.query.token === 'string' ? req.query.token.trim() : '';
	if (!token) return res.status(400).json({ error: 'Invalid token' });
	try {
		const updated = await runAsync('UPDATE users SET email_verified = 1, email_verify_token = NULL WHERE email_verify_token = ?', [token]);
		if (!updated.changes) return res.status(400).json({ error: 'Invalid or expired verification token' });
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/profile', requireAuth, async (req, res) => {
	try {
		const user = await getAsync('SELECT id, username, name, email, bio, institute, program_type, degree, academic_year, speciality, profile_picture FROM users WHERE id = ?', [req.session.userId]);
		if (!user) return res.status(404).json({ error: 'User not found' });
		res.json({ user });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/profile', requireAuth, async (req, res) => {
	const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
	const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
	const bio = typeof req.body.bio === 'string' ? req.body.bio.trim() : '';
	const institute = typeof req.body.institute === 'string' ? req.body.institute.trim() : '';
	const programType = typeof req.body.programType === 'string' ? req.body.programType.trim() : '';
	const degree = typeof req.body.degree === 'string' ? req.body.degree.trim() : '';
	const academicYear = typeof req.body.academicYear === 'string' ? req.body.academicYear.trim() : '';
	const speciality = typeof req.body.speciality === 'string' ? req.body.speciality.trim() : '';
	if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		return res.status(400).json({ error: 'Please provide a valid email address' });
	}
	if (name.length > 120) return res.status(400).json({ error: 'Name is too long' });
	if (bio.length > 400) return res.status(400).json({ error: 'Bio is too long' });
	try {
		await runAsync('UPDATE users SET name = ?, email = ?, bio = ?, institute = ?, program_type = ?, degree = ?, academic_year = ?, speciality = ? WHERE id = ?', [name || null, email || null, bio || null, institute || null, programType || null, degree || null, academicYear || null, speciality || null, req.session.userId]);
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
	try {
		const rows = await allAsync(`SELECT
			u.id,
			u.username,
			u.name,
			u.email,
			u.role,
			u.email_verified,
			u.xp,
			u.last_login,
			(SELECT COUNT(*) FROM connections c WHERE (c.user_a = u.id OR c.user_b = u.id) AND c.status = 'accepted') AS total_connections
			FROM users u
			ORDER BY u.id DESC`);
		res.json({ totalUsers: rows.length, users: rows });
	} catch (e) {
		console.error('Admin users API error:', e);
		res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/admin/users/:id/role', requireAdmin, async (req, res) => {
	const userId = Number(req.params.id);
	const role = typeof req.body.role === 'string' ? req.body.role.trim() : '';
	if (!userId) return res.status(400).json({ error: 'Invalid user id' });
	if (!['user', 'moderator', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
	try {
		await runAsync('UPDATE users SET role = ? WHERE id = ?', [role, userId]);
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
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
	db.get('SELECT id, username, name, bio, institute, program_type, degree, academic_year, speciality, profile_picture, level, title FROM users WHERE id = ?', [uid], (err, user) => {
		if (err || !user) return res.status(404).json({ error: 'User not found' });
		const q = `SELECT COUNT(*) as cnt FROM connections WHERE ((user_a = ? OR user_b = ?) AND status = 'accepted')`;
		db.get(q, [uid, uid], (err2, row) => {
			if (err2) user.connections_count = 0;
			else user.connections_count = row.cnt || 0;
			res.json({ user });
		});
	});
});

app.get('/api/feed', requireAuth, (req, res) => {
	const uid = Number(req.session.userId || 0);
	const q = `SELECT p.id, p.content, p.image, p.quiz_question, p.quiz_options, p.quiz_correct_index, p.visibility, p.reminder_at, p.reminder_note, p.created_at, u.id as user_id, u.username, u.name, u.profile_picture,
		(SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) as like_count,
		(SELECT COUNT(*) FROM post_comments pc WHERE pc.post_id = p.id) as comment_count,
		(SELECT COUNT(*) FROM saved_posts sp WHERE sp.post_id = p.id) as save_count,
		(SELECT COUNT(*) FROM post_shares ps WHERE ps.post_id = p.id) as share_count,
		(SELECT COUNT(*) FROM post_likes pl2 WHERE pl2.post_id = p.id AND pl2.user_id = ${uid}) as my_liked,
		(SELECT COUNT(*) FROM saved_posts sp2 WHERE sp2.post_id = p.id AND sp2.user_id = ${uid}) as my_saved,
		(SELECT COUNT(*) FROM quiz_attempts qa WHERE qa.post_id = p.id AND qa.user_id = ${uid}) as my_quiz_attempted
		FROM posts p JOIN users u ON p.user_id = u.id
		WHERE (
			p.visibility IS NULL OR p.visibility = 'public'
			OR p.user_id = ${uid}
			OR (
				p.visibility = 'connections' AND EXISTS (
					SELECT 1 FROM connections c
					WHERE c.status = 'accepted'
					AND ((c.user_a = ${uid} AND c.user_b = p.user_id) OR (c.user_b = ${uid} AND c.user_a = p.user_id))
				)
			)
		)
		ORDER BY p.created_at DESC LIMIT 50`;
	db.all(q, [], (err, rows) => {
		if (err) return res.status(500).json({ error: 'Server error' });
		res.json({ posts: rows });
	});
});

app.post('/api/post', requireAuth, (req, res) => {
	const { content, image, visibility, reminderAt, reminderNote, quizQuestion, quizOptions, quizCorrectIndex } = req.body;
	const safeContent = typeof content === 'string' ? content.trim() : '';
	const safeVisibility = ['public', 'connections', 'private'].includes(String(visibility || '').trim()) ? String(visibility).trim() : 'public';
	const safeReminderNote = typeof reminderNote === 'string' ? reminderNote.trim() : '';
	const hasImage = typeof image === 'string' && image.startsWith('data:image');
	const safeQuizQuestion = typeof quizQuestion === 'string' ? quizQuestion.trim() : '';
	const hasQuizCorrectIndex = quizCorrectIndex !== undefined && quizCorrectIndex !== null && quizCorrectIndex !== '';
	const isQuizPost = safeQuizQuestion.length > 0 || Array.isArray(quizOptions) || hasQuizCorrectIndex;
	let safeQuizOptions = null;
	let safeQuizCorrectIndex = null;
	if (isQuizPost) {
		const normalized = Array.isArray(quizOptions) ? quizOptions.map((v) => String(v || '').trim()).filter((v) => v.length > 0) : [];
		const parsedCorrect = Number(quizCorrectIndex);
		if (!safeQuizQuestion) return res.status(400).json({ error: 'Quiz question is required' });
		if (safeQuizQuestion.length > 400) return res.status(400).json({ error: 'Quiz question is too long' });
		if (normalized.length < 2 || normalized.length > 6) return res.status(400).json({ error: 'Quiz must have 2 to 6 options' });
		if (normalized.some((opt) => opt.length > 200)) return res.status(400).json({ error: 'Quiz option is too long' });
		if (Number.isNaN(parsedCorrect) || parsedCorrect < 0 || parsedCorrect >= normalized.length) {
			return res.status(400).json({ error: 'Choose a valid correct answer for the quiz' });
		}
		safeQuizOptions = JSON.stringify(normalized);
		safeQuizCorrectIndex = parsedCorrect;
	}
	let reminderAtTs = null;
	if (reminderAt) {
		const parsed = Number(reminderAt);
		if (!Number.isNaN(parsed) && parsed > 0) reminderAtTs = parsed;
	}
	if (!safeContent && !hasImage && !safeReminderNote && !isQuizPost) {
		return res.status(400).json({ error: 'Add text, image, reminder, or quiz before posting' });
	}
	if (safeContent.length > 5000) return res.status(400).json({ error: 'Post too long' });
	if (hasImage && image.length > 7 * 1024 * 1024) return res.status(400).json({ error: 'Image is too large' });
	if (safeReminderNote.length > 240) return res.status(400).json({ error: 'Reminder note is too long' });
	const ts = Date.now();
	db.run('INSERT INTO posts (user_id, content, image, quiz_question, quiz_options, quiz_correct_index, visibility, reminder_at, reminder_note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 
		[req.session.userId, safeContent, hasImage ? image : null, safeQuizQuestion || null, safeQuizOptions, safeQuizCorrectIndex, safeVisibility, reminderAtTs, safeReminderNote || null, ts], 
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
	db.run('INSERT INTO connections (user_a,user_b,status,created_at) VALUES (?,?,?,?)', [a, b, 'pending', ts], function (err) {
		if (err) return res.status(400).json({ error: 'Unable to create request' });
    // emit socket event to target user's room
    io.to(`user:${b}`).emit('connectionRequest', { from: a, to: b });
		res.json({ success: true });
	});
});

app.get('/api/user/:id/posts', requireAuth, async (req, res) => {
	const profileUserId = Number(req.params.id);
	const viewerId = Number(req.session.userId);
	if (!profileUserId) return res.status(400).json({ error: 'Invalid user id' });
	try {
		const isSelf = profileUserId === viewerId;
		const connected = await getAsync(`SELECT id FROM connections
			WHERE status = 'accepted'
			AND ((user_a = ? AND user_b = ?) OR (user_b = ? AND user_a = ?))`, [viewerId, profileUserId, viewerId, profileUserId]);
		const rows = await allAsync(`SELECT p.id, p.content, p.image, p.quiz_question, p.quiz_options, p.quiz_correct_index, p.visibility, p.reminder_at, p.reminder_note, p.created_at
			FROM posts p
			WHERE p.user_id = ?
			AND (
				p.visibility IS NULL OR p.visibility = 'public'
				OR (? = 1)
				OR (? = 1 AND p.visibility = 'connections')
			)
			ORDER BY p.created_at DESC
			LIMIT 50`, [profileUserId, isSelf ? 1 : 0, connected ? 1 : 0]);
		res.json({ posts: rows });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
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
		const withPresence = (rows || []).map((r) => ({ ...r, online: isUserOnline(r.id) }));
		res.json({ connections: withPresence });
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
	const q = `SELECT c.id, c.post_id, c.user_id, c.parent_comment_id, c.mention_user_id, c.content, c.created_at, u.username, u.name, u.profile_picture, mu.username as mention_username
		FROM post_comments c
		JOIN users u ON u.id = c.user_id
		LEFT JOIN users mu ON mu.id = c.mention_user_id
		WHERE c.post_id = ?
		ORDER BY c.created_at ASC
		LIMIT 50`;
	db.all(q, [postId], (err, rows) => {
		if (err) return res.status(500).json({ error: 'Server error' });
		res.json({ comments: rows });
	});
});

app.post('/api/post/:id/comment', requireAuth, (req, res) => {
	const postId = Number(req.params.id);
	const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
	const parentCommentId = req.body.parentCommentId ? Number(req.body.parentCommentId) : null;
	const mentionUserId = req.body.mentionUserId ? Number(req.body.mentionUserId) : null;
	if (!postId) return res.status(400).json({ error: 'Invalid post id' });
	if (!content) return res.status(400).json({ error: 'Comment cannot be empty' });
	if (content.length > 700) return res.status(400).json({ error: 'Comment too long' });
	if (parentCommentId && Number.isNaN(parentCommentId)) return res.status(400).json({ error: 'Invalid parent comment' });
	if (mentionUserId && Number.isNaN(mentionUserId)) return res.status(400).json({ error: 'Invalid mention user' });
	const ts = Date.now();
	if (parentCommentId) {
		db.get('SELECT id FROM post_comments WHERE id = ? AND post_id = ?', [parentCommentId, postId], (parentErr, parent) => {
			if (parentErr) return res.status(500).json({ error: 'Server error' });
			if (!parent) return res.status(400).json({ error: 'Parent comment not found' });
			db.run('INSERT INTO post_comments (post_id, user_id, parent_comment_id, mention_user_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)', [postId, req.session.userId, parentCommentId, mentionUserId || null, content, ts], async function onReply(err) {
				if (err) return res.status(500).json({ error: 'Server error' });
				try { await addXp(req.session.userId, 'POST_COMMENT', 'post', postId); } catch (xpErr) { console.error('POST_COMMENT XP error:', xpErr); }
				res.json({ success: true, id: this.lastID });
			});
		});
		return;
	}
	db.run('INSERT INTO post_comments (post_id, user_id, parent_comment_id, mention_user_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)', [postId, req.session.userId, null, null, content, ts], async function onComment(err) {
		if (err) return res.status(500).json({ error: 'Server error' });
		try { await addXp(req.session.userId, 'POST_COMMENT', 'post', postId); } catch (xpErr) { console.error('POST_COMMENT XP error:', xpErr); }
		res.json({ success: true, id: this.lastID });
	});
});

app.post('/api/post/:id/quiz-attempt', requireAuth, async (req, res) => {
	const postId = Number(req.params.id);
	const selectedIndex = Number(req.body.selectedIndex);
	const userId = Number(req.session.userId);
	if (!postId || Number.isNaN(selectedIndex)) return res.status(400).json({ error: 'Invalid quiz attempt' });
	try {
		const post = await getAsync('SELECT id, quiz_options, quiz_correct_index FROM posts WHERE id = ?', [postId]);
		if (!post || post.quiz_correct_index === null || post.quiz_correct_index === undefined) return res.status(404).json({ error: 'Quiz not found' });
		const options = (() => {
			try { return JSON.parse(post.quiz_options || '[]'); } catch (e) { return []; }
		})();
		if (!Array.isArray(options) || selectedIndex < 0 || selectedIndex >= options.length) {
			return res.status(400).json({ error: 'Invalid selected option' });
		}
		const existing = await getAsync('SELECT id FROM quiz_attempts WHERE post_id = ? AND user_id = ?', [postId, userId]);
		if (existing) return res.status(400).json({ error: 'Quiz already attempted' });
		const isCorrect = Number(selectedIndex) === Number(post.quiz_correct_index) ? 1 : 0;
		await runAsync('INSERT INTO quiz_attempts (post_id, user_id, selected_index, is_correct, created_at) VALUES (?, ?, ?, ?, ?)', [postId, userId, selectedIndex, isCorrect, Date.now()]);
		res.json({ success: true, isCorrect: Boolean(isCorrect), correctIndex: Number(post.quiz_correct_index), correctAnswer: options[Number(post.quiz_correct_index)] || '' });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/xp/levels', (req, res) => {
	const levels = [
		{ level: 1, minXp: 0, title: 'Rookie Medic' },
		{ level: 10, minXp: 900, title: 'Clinical Explorer' },
		{ level: 20, minXp: 1900, title: 'Ward Collaborator' },
		{ level: 30, minXp: 2900, title: 'Care Coordinator' },
		{ level: 40, minXp: 3900, title: 'Diagnostic Strategist' },
		{ level: 50, minXp: 4900, title: 'Community Mentor' },
		{ level: 60, minXp: 5900, title: 'Health Innovator' },
		{ level: 70, minXp: 6900, title: 'Chief Healer' },
		{ level: 80, minXp: 7900, title: 'Med Vanguard' },
		{ level: 90, minXp: 8900, title: 'Legend of Care' }
	];
	res.json({ levels });
});

app.post('/api/speciality/suggest', requireAuth, async (req, res) => {
	const suggestion = typeof req.body.suggestion === 'string' ? req.body.suggestion.trim() : '';
	if (!suggestion) return res.status(400).json({ error: 'Suggestion is required' });
	if (suggestion.length > 120) return res.status(400).json({ error: 'Suggestion too long' });
	try {
		await runAsync('INSERT INTO speciality_suggestions (user_id, suggestion, created_at) VALUES (?, ?, ?)', [req.session.userId, suggestion, Date.now()]);
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
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
		await runAsync('DELETE FROM post_comments WHERE id = ? OR parent_comment_id = ?', [commentId, commentId]);
		return res.json({ success: true });
	} catch (e) {
		console.error('Delete comment API error:', e);
		return res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/stories', requireAuth, async (req, res) => {
	try {
		const userId = Number(req.session.userId);
		const connectionIds = await getAcceptedConnectionIds(userId);
		const ids = [userId, ...connectionIds];
		if (!ids.length) return res.json({ stories: [] });
		const placeholders = ids.map(() => '?').join(',');
		const rows = await allAsync(`SELECT s.id, s.user_id, s.content, s.image, s.created_at, s.expires_at, u.username, u.name, u.profile_picture
			FROM stories s
			JOIN users u ON u.id = s.user_id
			WHERE s.expires_at > ? AND s.user_id IN (${placeholders})
			ORDER BY s.created_at DESC`, [Date.now(), ...ids]);
		res.json({ stories: rows });
	} catch (e) {
		console.error('Stories fetch error:', e);
		res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/stories', requireAuth, async (req, res) => {
	const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
	const image = typeof req.body.image === 'string' ? req.body.image : '';
	const hasImage = Boolean(image && image.startsWith('data:image'));
	if (!content && !hasImage) return res.status(400).json({ error: 'Add text or image for the story' });
	if (content.length > 300) return res.status(400).json({ error: 'Story content is too long' });
	if (hasImage && image.length > 7 * 1024 * 1024) return res.status(400).json({ error: 'Story image is too large' });
	try {
		const now = Date.now();
		const expiresAt = now + (24 * 60 * 60 * 1000);
		const created = await runAsync('INSERT INTO stories (user_id, content, image, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', [req.session.userId, content || null, hasImage ? image : null, now, expiresAt]);
		res.json({ success: true, id: created.lastID });
	} catch (e) {
		console.error('Story create error:', e);
		res.status(500).json({ error: 'Server error' });
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
		const rows = await allAsync(`SELECT p.id, p.content, p.image, p.quiz_question, p.quiz_options, p.quiz_correct_index, p.reminder_at, p.reminder_note, p.created_at, u.id as user_id, u.username, u.name, u.profile_picture
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
		const created = await runAsync('INSERT INTO groups (name, description, is_private, clan_xp, clan_level, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [name, description, isPrivate, 0, 1, req.session.userId, ts]);
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
		const rows = await allAsync(`SELECT g.id, g.name, g.description, g.is_private, g.clan_xp, g.clan_level, g.created_by, g.created_at,
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
		await runAsync(`INSERT INTO group_memberships (group_id, user_id, role, status, created_at)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (group_id, user_id)
			DO UPDATE SET
				role = COALESCE(group_memberships.role, EXCLUDED.role),
				status = EXCLUDED.status,
				created_at = EXCLUDED.created_at`, [groupId, req.session.userId, 'member', status, Date.now()]);
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
		await runAsync('UPDATE groups SET clan_xp = COALESCE(clan_xp, 0) + 10, clan_level = (FLOOR((COALESCE(clan_xp, 0) + 10) / 200) + 1) WHERE id = ?', [groupId]);
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

app.get('/admin', requireAdmin, (req, res) => {
	res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/profile', requireAuth, (req, res) => {
	res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

app.get('/verify-email.html', (req, res) => {
	res.sendFile(path.join(__dirname, 'public', 'verify-email.html'));
});

app.get('/user-profile.html', requireAuth, (req, res) => {
	res.sendFile(path.join(__dirname, 'public', 'user-profile.html'));
});

const http = require('http');
const server = http.createServer(app);
const { Server: IOServer } = require('socket.io');
const io = new IOServer(server);

io.on('connection', (socket) => {
	socket.on('identify', (userId) => {
		socket.userId = userId;
		markUserOnline(userId, socket.id);
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
		if (socket.userId) markUserOffline(socket.userId, socket.id);
	});
});

initializeDatabase()
	.then(async () => {
		await pool.query('SELECT 1');
		console.log('PostgreSQL connected');
		server.listen(PORT, () => {
			console.log(`Server listening on http://localhost:${PORT}`);
		});
	})
	.catch((err) => {
		console.error('Database initialization failed:', err.message || err);
		console.error(`PostgreSQL target: ${getDbTargetLabel()}`);
		if (err && err.code === 'ECONNREFUSED') {
			console.error('ECONNREFUSED: PostgreSQL is not running or not reachable at that host/port.');
		}
		if (err && err.code === 'ENOTFOUND') {
			console.error('ENOTFOUND: Hostname cannot be resolved. Railway internal hostnames only work inside Railway.');
		}
		console.error('Set DATABASE_URL in .env for local run, for example: postgresql://postgres:password@localhost:5432/project1codex');
		process.exit(1);
	});
