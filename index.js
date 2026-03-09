require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const SUPERADMIN_USERNAME = 'elroshan';
const SUPERADMIN_PASSWORD = 'medicalwizardry28';

app.set('trust proxy', 1);

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

function getPublicBaseUrl(req) {
	const explicit = typeof process.env.PUBLIC_BASE_URL === 'string' ? process.env.PUBLIC_BASE_URL.trim() : '';
	if (explicit) return explicit.replace(/\/+$/, '');
	if (req && req.headers && req.headers.host) {
		const proto = req.protocol || 'http';
		return `${proto}://${req.headers.host}`;
	}
	return `http://localhost:${PORT}`;
}

function getRequestBaseUrl(req) {
	if (req && req.headers && req.headers.host) {
		const forwardedProto = typeof req.headers['x-forwarded-proto'] === 'string' ? req.headers['x-forwarded-proto'].split(',')[0].trim() : '';
		const proto = forwardedProto || req.protocol || 'http';
		return `${proto}://${req.headers.host}`.replace(/\/+$/, '');
	}
	return getPublicBaseUrl(req);
}

const EMAIL_FROM = typeof process.env.EMAIL_FROM === 'string' && process.env.EMAIL_FROM.trim()
	? process.env.EMAIL_FROM.trim()
	: 'onboarding@resend.dev';
const APP_NAME = typeof process.env.APP_NAME === 'string' && process.env.APP_NAME.trim()
	? process.env.APP_NAME.trim()
	: 'Mednecta';

function createVerificationToken() {
	return crypto.randomBytes(32).toString('hex');
}

function hashToken(rawToken) {
	return crypto.createHash('sha256').update(String(rawToken || '')).digest('hex');
}

function getPasswordPolicyError(password) {
	const pwd = typeof password === 'string' ? password : '';
	if (pwd.length < 6) return 'Password must be at least 6 characters';
	if (!/[A-Z]/.test(pwd)) return 'Password must include at least one uppercase letter';
	if (!/[^A-Za-z0-9]/.test(pwd)) return 'Password must include at least one special character';
	return '';
}

async function sendVerificationEmail(toEmail, verifyUrl) {
	const apiKey = typeof process.env.RESEND_API_KEY === 'string' ? process.env.RESEND_API_KEY.trim() : '';
	if (!apiKey) throw new Error('RESEND_API_KEY is not configured');
	if (!toEmail) throw new Error('Recipient email is missing');
	if (!verifyUrl) throw new Error('Verification URL is missing');
	const html = `
			<div style="font-family:Arial,sans-serif;line-height:1.6;color:#0f172a">
				<h2 style="margin:0 0 10px">Welcome to ${APP_NAME}</h2>
				<p style="margin:0 0 12px">Please verify your email to activate your account.</p>
				<p style="margin:0 0 16px">
					<a href="${verifyUrl}" style="display:inline-block;padding:10px 16px;background:#0f9f9a;color:#ffffff;text-decoration:none;border-radius:8px">Verify Email</a>
				</p>
				<p style="margin:0 0 8px">Or copy this link into your browser:</p>
				<p style="margin:0 0 16px;word-break:break-all">${verifyUrl}</p>
				<p style="margin:0;color:#475569">If you did not create this account, you can ignore this email.</p>
			</div>
		`;
	const body = JSON.stringify({
		from: EMAIL_FROM,
		to: [toEmail],
		subject: `Verify your ${APP_NAME} account`,
		html
	});
	const result = await new Promise((resolve, reject) => {
		const req = https.request('https://api.resend.com/emails', {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(body)
			}
		}, (res) => {
			let raw = '';
			res.on('data', (chunk) => { raw += chunk; });
			res.on('end', () => {
				let json = null;
				try {
					json = raw ? JSON.parse(raw) : null;
				} catch (e) {
					json = null;
				}
				resolve({ statusCode: res.statusCode || 0, json, raw });
			});
		});
		req.on('error', reject);
		req.write(body);
		req.end();
	});
	if (result.statusCode < 200 || result.statusCode >= 300) {
		const details = result.json && (result.json.message || result.json.error)
			? `${result.json.message || result.json.error}`
			: (result.raw || '').slice(0, 300);
		throw new Error(`Resend API error (${result.statusCode})${details ? ` - ${details}` : ''}`);
	}
}

async function sendPasswordResetEmail(toEmail, resetUrl) {
	const apiKey = typeof process.env.RESEND_API_KEY === 'string' ? process.env.RESEND_API_KEY.trim() : '';
	if (!apiKey) throw new Error('RESEND_API_KEY is not configured');
	if (!toEmail) throw new Error('Recipient email is missing');
	if (!resetUrl) throw new Error('Reset URL is missing');
	const html = `
			<div style="font-family:Arial,sans-serif;line-height:1.6;color:#0f172a">
				<h2 style="margin:0 0 10px">${APP_NAME} password reset</h2>
				<p style="margin:0 0 12px">We received a request to reset your password.</p>
				<p style="margin:0 0 16px">
					<a href="${resetUrl}" style="display:inline-block;padding:10px 16px;background:#0f9f9a;color:#ffffff;text-decoration:none;border-radius:8px">Reset Password</a>
				</p>
				<p style="margin:0 0 8px">Or copy this link into your browser:</p>
				<p style="margin:0 0 16px;word-break:break-all">${resetUrl}</p>
				<p style="margin:0;color:#475569">This link expires in 15 minutes. If you did not request this, ignore this email.</p>
			</div>
		`;
	const body = JSON.stringify({
		from: EMAIL_FROM,
		to: [toEmail],
		subject: `Reset your ${APP_NAME} password`,
		html
	});
	const result = await new Promise((resolve, reject) => {
		const req = https.request('https://api.resend.com/emails', {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(body)
			}
		}, (res) => {
			let raw = '';
			res.on('data', (chunk) => { raw += chunk; });
			res.on('end', () => {
				let json = null;
				try { json = raw ? JSON.parse(raw) : null; } catch (e) { json = null; }
				resolve({ statusCode: res.statusCode || 0, json, raw });
			});
		});
		req.on('error', reject);
		req.write(body);
		req.end();
	});
	if (result.statusCode < 200 || result.statusCode >= 300) {
		const details = result.json && (result.json.message || result.json.error)
			? `${result.json.message || result.json.error}`
			: (result.raw || '').slice(0, 300);
		throw new Error(`Resend API error (${result.statusCode})${details ? ` - ${details}` : ''}`);
	}
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

async function ensureNotificationsReady() {
	await runAsync(`CREATE TABLE IF NOT EXISTS notifications (
		id BIGSERIAL PRIMARY KEY,
		user_id BIGINT NOT NULL,
		actor_id BIGINT,
		type TEXT NOT NULL,
		title TEXT,
		message TEXT,
		ref_type TEXT,
		ref_id BIGINT,
		is_read INTEGER DEFAULT 0,
		created_at BIGINT NOT NULL
	)`);
	await runAsync(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS actor_id BIGINT`);
	await runAsync(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS ref_type TEXT`);
	await runAsync(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS ref_id BIGINT`);
	await runAsync(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_read INTEGER DEFAULT 0`);
	await runAsync(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS seen_at BIGINT`);
}

async function createUserNotification(userId, payload = {}) {
	await ensureNotificationsReady();
	const toUserId = Number(userId);
	if (!toUserId) return null;
	const actorId = Number(payload.actorId || 0) || null;
	const type = typeof payload.type === 'string' ? payload.type.trim() : 'general';
	const title = typeof payload.title === 'string' ? payload.title.trim() : '';
	const message = typeof payload.message === 'string' ? payload.message.trim() : '';
	const refType = typeof payload.refType === 'string' ? payload.refType.trim() : null;
	const refId = Number(payload.refId || 0) || null;
	const ts = Date.now();
	const created = await runAsync(`INSERT INTO notifications
		(user_id, actor_id, type, title, message, ref_type, ref_id, is_read, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [toUserId, actorId, type || 'general', title || null, message || null, refType || null, refId, 0, ts]);
	const notification = {
		id: created.lastID,
		user_id: toUserId,
		actor_id: actorId,
		type: type || 'general',
		title: title || '',
		message: message || '',
		ref_type: refType || null,
		ref_id: refId,
		is_read: 0,
		created_at: ts
	};
	io.to(`user:${toUserId}`).emit('notification:new', notification);
	return notification;
}

async function getGroupRole(groupId, userId) {
	const row = await getAsync('SELECT role, status FROM group_memberships WHERE group_id = ? AND user_id = ?', [groupId, userId]);
	return row || null;
}

const GROUP_PERMISSION_KEYS = [
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

function parsePermissionList(raw) {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.map((p) => String(p || '').trim()).filter((p) => GROUP_PERMISSION_KEYS.includes(p));
	} catch (e) {
		return [];
	}
}

function roleDefaults(roleName) {
	const role = String(roleName || '').toLowerCase();
	if (role === 'admin') return [...GROUP_PERMISSION_KEYS];
	if (role === 'moderator') {
		return ['manage_posts', 'manage_requests', 'post_messages', 'post_quiz', 'post_reminder', 'post_links', 'access_lounge'];
	}
	return ['post_messages', 'post_quiz', 'post_reminder', 'post_links', 'access_lounge'];
}

async function getGroupMembershipDetails(groupId, userId) {
	const row = await getAsync(`SELECT gm.user_id, gm.group_id, gm.role, gm.status, gm.custom_role_id, gr.permissions AS custom_permissions
		FROM group_memberships gm
		LEFT JOIN group_roles gr ON gr.id = gm.custom_role_id
		WHERE gm.group_id = ? AND gm.user_id = ?`, [groupId, userId]);
	if (!row) return null;
	const customPermissions = parsePermissionList(row.custom_permissions);
	const permissions = customPermissions.length ? customPermissions : roleDefaults(row.role);
	return { ...row, permissions };
}

function hasGroupPermission(membership, permission) {
	if (!membership || String(membership.status || '') !== 'active') return false;
	if (String(membership.role || '') === 'admin') return true;
	const permissionSet = new Set(Array.isArray(membership.permissions) ? membership.permissions : []);
	return permissionSet.has(permission);
}

async function getActiveClanMembership(userId, excludeGroupId = null) {
	const params = [userId];
	let sql = 'SELECT group_id, role, status FROM group_memberships WHERE user_id = ? AND status = ?';
	params.push('active');
	if (excludeGroupId) {
		sql += ' AND group_id <> ?';
		params.push(excludeGroupId);
	}
	sql += ' ORDER BY created_at DESC LIMIT 1';
	return getAsync(sql, params);
}

async function getOccupiedClanMembership(userId, excludeGroupId = null) {
	const params = [userId, 'active', 'pending'];
	let sql = 'SELECT group_id, role, status FROM group_memberships WHERE user_id = ? AND status IN (?, ?)';
	if (excludeGroupId) {
		sql += ' AND group_id <> ?';
		params.push(excludeGroupId);
	}
	sql += ' ORDER BY created_at DESC LIMIT 1';
	return getAsync(sql, params);
}

function createInviteToken() {
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function createShareToken() {
	return crypto.randomBytes(18).toString('hex');
}

async function createShareLink(itemType, itemId, userId, req) {
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const token = createShareToken();
		try {
			await runAsync(`INSERT INTO share_links (token, item_type, item_id, created_by, created_at)
				VALUES (?, ?, ?, ?, ?)`, [token, itemType, itemId, userId, Date.now()]);
			return { token, shareUrl: `${getRequestBaseUrl(req)}/dashboard?share=${encodeURIComponent(token)}` };
		} catch (e) {
			if (!String(e.message || '').toLowerCase().includes('unique')) throw e;
		}
	}
	throw new Error('Unable to create share link');
}

async function resolveShareLink(token) {
	const link = await getAsync('SELECT token, item_type, item_id FROM share_links WHERE token = ?', [token]);
	if (!link) return null;
	if (link.item_type === 'story') {
		const story = await getAsync('SELECT id, expires_at FROM stories WHERE id = ?', [link.item_id]);
		if (!story || Number(story.expires_at) <= Date.now()) return null;
	} else if (link.item_type === 'post') {
		const post = await getAsync('SELECT id FROM posts WHERE id = ?', [link.item_id]);
		if (!post) return null;
	} else {
		return null;
	}
	await runAsync('UPDATE share_links SET last_used_at = ? WHERE token = ?', [Date.now(), token]).catch(() => {});
	return { itemType: link.item_type, itemId: Number(link.item_id) || 0 };
}

async function initializeDatabase() {
	await runAsync(`CREATE TABLE IF NOT EXISTS users (
		id BIGSERIAL PRIMARY KEY,
		username TEXT UNIQUE NOT NULL,
		password TEXT NOT NULL,
		name TEXT,
		nickname TEXT,
		email TEXT,
		gender TEXT,
		date_of_birth TEXT,
		bio TEXT,
		status_description TEXT,
		achievements TEXT,
		place_from TEXT,
		country TEXT,
		state TEXT,
		pincode TEXT,
		contact_country_code TEXT,
		contact_number TEXT,
		institute TEXT,
		program_type TEXT,
		degree TEXT,
		academic_year TEXT,
		speciality TEXT,
		email_verified INTEGER DEFAULT 0,
		email_verify_token TEXT,
		password_reset_token_hash TEXT,
		password_reset_expires_at BIGINT,
		last_login BIGINT,
		profile_picture TEXT,
		privacy_show_online TEXT DEFAULT 'connections',
		privacy_discoverability TEXT DEFAULT 'everyone',
		privacy_in_suggestions TEXT DEFAULT 'everyone',
		privacy_request_policy TEXT DEFAULT 'everyone',
		account_blocked INTEGER DEFAULT 0,
		role TEXT DEFAULT 'user',
		xp INTEGER DEFAULT 0,
		level INTEGER DEFAULT 1,
		title TEXT DEFAULT 'Rookie Medic',
		last_xp_login_day TEXT
	)`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'user'`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS nickname TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status_description TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS achievements TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS place_from TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS country TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS state TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pincode TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS contact_country_code TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS contact_number TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS institute TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS program_type TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS degree TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS academic_year TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS speciality TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified INTEGER DEFAULT 0`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verify_token TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_token_hash TEXT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_expires_at BIGINT`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_show_online TEXT DEFAULT 'connections'`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_discoverability TEXT DEFAULT 'everyone'`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_in_suggestions TEXT DEFAULT 'everyone'`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_request_policy TEXT DEFAULT 'everyone'`);
	await runAsync(`ALTER TABLE users ADD COLUMN IF NOT EXISTS account_blocked INTEGER DEFAULT 0`);
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
	await runAsync(`CREATE TABLE IF NOT EXISTS follows (
		id BIGSERIAL PRIMARY KEY,
		follower_id BIGINT NOT NULL,
		followee_id BIGINT NOT NULL,
		created_at BIGINT,
		UNIQUE(follower_id, followee_id)
	)`);
	await runAsync(`CREATE TABLE IF NOT EXISTS user_blocks (
		id BIGSERIAL PRIMARY KEY,
		blocker_id BIGINT NOT NULL,
		blocked_id BIGINT NOT NULL,
		reason TEXT,
		created_at BIGINT,
		UNIQUE(blocker_id, blocked_id)
	)`);
	await runAsync(`CREATE TABLE IF NOT EXISTS user_reports (
		id BIGSERIAL PRIMARY KEY,
		reporter_id BIGINT NOT NULL,
		target_user_id BIGINT NOT NULL,
		category TEXT,
		details TEXT,
		status TEXT DEFAULT 'open',
		created_at BIGINT
	)`);
	await runAsync(`CREATE TABLE IF NOT EXISTS clan_reports (
		id BIGSERIAL PRIMARY KEY,
		reporter_id BIGINT NOT NULL,
		clan_id BIGINT NOT NULL,
		category TEXT,
		details TEXT,
		status TEXT DEFAULT 'open',
		created_at BIGINT
	)`);
	await runAsync(`CREATE TABLE IF NOT EXISTS support_tickets (
		id BIGSERIAL PRIMARY KEY,
		user_id BIGINT NOT NULL,
		subject TEXT NOT NULL,
		category TEXT,
		message TEXT NOT NULL,
		status TEXT DEFAULT 'waiting',
		created_at BIGINT NOT NULL,
		updated_at BIGINT NOT NULL
	)`);
	await runAsync(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS category TEXT`);
	await runAsync(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'waiting'`);
	await runAsync(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS updated_at BIGINT`);
	await runAsync(`UPDATE support_tickets SET status = 'waiting' WHERE status IS NULL OR TRIM(status) = ''`);
	await runAsync(`UPDATE support_tickets SET updated_at = COALESCE(updated_at, created_at, ?)`, [Date.now()]);
	await runAsync(`CREATE TABLE IF NOT EXISTS messages (
		id BIGSERIAL PRIMARY KEY,
		from_user BIGINT,
		to_user BIGINT,
		content TEXT,
		image TEXT,
		seen_at BIGINT,
		created_at BIGINT
	)`);
	await runAsync(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS image TEXT`);
	await runAsync(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS seen_at BIGINT`);
	await runAsync(`CREATE TABLE IF NOT EXISTS notifications (
		id BIGSERIAL PRIMARY KEY,
		user_id BIGINT NOT NULL,
		actor_id BIGINT,
		type TEXT NOT NULL,
		title TEXT,
		message TEXT,
		ref_type TEXT,
		ref_id BIGINT,
		is_read INTEGER DEFAULT 0,
		created_at BIGINT NOT NULL
	)`);
	await runAsync(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS actor_id BIGINT`);
	await runAsync(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS ref_type TEXT`);
	await runAsync(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS ref_id BIGINT`);
	await runAsync(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_read INTEGER DEFAULT 0`);
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
		list_name TEXT DEFAULT 'General',
		created_at BIGINT,
		UNIQUE(post_id, user_id)
	)`);
	await runAsync(`ALTER TABLE saved_posts ADD COLUMN IF NOT EXISTS list_name TEXT DEFAULT 'General'`);
	await runAsync(`UPDATE saved_posts SET list_name = 'General' WHERE list_name IS NULL OR TRIM(list_name) = ''`);
	await runAsync(`CREATE TABLE IF NOT EXISTS saved_post_lists (
		id BIGSERIAL PRIMARY KEY,
		user_id BIGINT NOT NULL,
		name TEXT NOT NULL,
		created_at BIGINT,
		UNIQUE(user_id, name)
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
		profile_picture TEXT,
		is_private INTEGER DEFAULT 1,
		clan_xp INTEGER DEFAULT 0,
		clan_level INTEGER DEFAULT 1,
		created_by BIGINT NOT NULL,
		created_at BIGINT
	)`);
	await runAsync(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS profile_picture TEXT`);
	await runAsync(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS clan_xp INTEGER DEFAULT 0`);
	await runAsync(`ALTER TABLE groups ADD COLUMN IF NOT EXISTS clan_level INTEGER DEFAULT 1`);
	await runAsync(`CREATE TABLE IF NOT EXISTS group_memberships (
		id BIGSERIAL PRIMARY KEY,
		group_id BIGINT NOT NULL,
		user_id BIGINT NOT NULL,
		role TEXT DEFAULT 'member',
		custom_role_id BIGINT,
		status TEXT DEFAULT 'pending',
		created_at BIGINT,
		UNIQUE(group_id, user_id)
	)`);
	await runAsync(`ALTER TABLE group_memberships ADD COLUMN IF NOT EXISTS custom_role_id BIGINT`);
	await runAsync(`CREATE TABLE IF NOT EXISTS group_roles (
		id BIGSERIAL PRIMARY KEY,
		group_id BIGINT NOT NULL,
		name TEXT NOT NULL,
		permissions TEXT,
		is_system INTEGER DEFAULT 0,
		created_by BIGINT NOT NULL,
		created_at BIGINT,
		UNIQUE(group_id, name)
	)`);
	await runAsync(`CREATE TABLE IF NOT EXISTS group_posts (
		id BIGSERIAL PRIMARY KEY,
		group_id BIGINT NOT NULL,
		user_id BIGINT NOT NULL,
		content TEXT NOT NULL,
		post_type TEXT DEFAULT 'message',
		image TEXT,
		caption TEXT,
		mentions TEXT,
		quiz_question TEXT,
		quiz_options TEXT,
		quiz_correct_index INTEGER,
		reminder_at BIGINT,
		reminder_note TEXT,
		link_url TEXT,
		link_label TEXT,
		created_at BIGINT
	)`);
	await runAsync(`ALTER TABLE group_posts ADD COLUMN IF NOT EXISTS post_type TEXT DEFAULT 'message'`);
	await runAsync(`ALTER TABLE group_posts ADD COLUMN IF NOT EXISTS image TEXT`);
	await runAsync(`ALTER TABLE group_posts ADD COLUMN IF NOT EXISTS caption TEXT`);
	await runAsync(`ALTER TABLE group_posts ADD COLUMN IF NOT EXISTS mentions TEXT`);
	await runAsync(`ALTER TABLE group_posts ADD COLUMN IF NOT EXISTS quiz_question TEXT`);
	await runAsync(`ALTER TABLE group_posts ADD COLUMN IF NOT EXISTS quiz_options TEXT`);
	await runAsync(`ALTER TABLE group_posts ADD COLUMN IF NOT EXISTS quiz_correct_index INTEGER`);
	await runAsync(`ALTER TABLE group_posts ADD COLUMN IF NOT EXISTS reminder_at BIGINT`);
	await runAsync(`ALTER TABLE group_posts ADD COLUMN IF NOT EXISTS reminder_note TEXT`);
	await runAsync(`ALTER TABLE group_posts ADD COLUMN IF NOT EXISTS link_url TEXT`);
	await runAsync(`ALTER TABLE group_posts ADD COLUMN IF NOT EXISTS link_label TEXT`);
	await runAsync(`CREATE TABLE IF NOT EXISTS group_invites (
		id BIGSERIAL PRIMARY KEY,
		group_id BIGINT NOT NULL,
		token TEXT UNIQUE NOT NULL,
		created_by BIGINT NOT NULL,
		max_uses INTEGER DEFAULT 0,
		used_count INTEGER DEFAULT 0,
		expires_at BIGINT,
		created_at BIGINT
	)`);
	await runAsync(`CREATE TABLE IF NOT EXISTS group_lounge_messages (
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
	await runAsync(`CREATE TABLE IF NOT EXISTS story_likes (
		id BIGSERIAL PRIMARY KEY,
		story_id BIGINT NOT NULL,
		user_id BIGINT NOT NULL,
		created_at BIGINT,
		UNIQUE(story_id, user_id)
	)`);
	await runAsync(`CREATE TABLE IF NOT EXISTS story_comments (
		id BIGSERIAL PRIMARY KEY,
		story_id BIGINT NOT NULL,
		user_id BIGINT NOT NULL,
		content TEXT NOT NULL,
		created_at BIGINT
	)`);
	await runAsync(`CREATE TABLE IF NOT EXISTS story_replies (
		id BIGSERIAL PRIMARY KEY,
		story_id BIGINT NOT NULL,
		from_user_id BIGINT NOT NULL,
		to_user_id BIGINT NOT NULL,
		content TEXT NOT NULL,
		created_at BIGINT
	)`);
	await runAsync(`CREATE TABLE IF NOT EXISTS story_shares (
		id BIGSERIAL PRIMARY KEY,
		story_id BIGINT NOT NULL,
		user_id BIGINT NOT NULL,
		created_at BIGINT,
		UNIQUE(story_id, user_id)
	)`);
	await runAsync(`CREATE TABLE IF NOT EXISTS share_links (
		id BIGSERIAL PRIMARY KEY,
		token TEXT UNIQUE NOT NULL,
		item_type TEXT NOT NULL,
		item_id BIGINT NOT NULL,
		created_by BIGINT NOT NULL,
		created_at BIGINT,
		last_used_at BIGINT
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

async function ensureSuperAdmin() {
	try {
		const existing = await getAsync('SELECT id, role FROM users WHERE username = ?', [SUPERADMIN_USERNAME]);
		const hash = await bcrypt.hash(SUPERADMIN_PASSWORD, 10);
		if (!existing) {
			const ts = Date.now().toString(36);
			await runAsync(`INSERT INTO users
				(username, password, name, email_verified, role, email_verify_token, account_blocked)
				VALUES (?, ?, ?, ?, ?, ?, ?)`, [SUPERADMIN_USERNAME, hash, 'Super Admin', 1, 'admin', null, 0]);
			console.log(`Superadmin created: ${SUPERADMIN_USERNAME}`);
			return;
		}
		await runAsync('UPDATE users SET password = ?, role = ?, account_blocked = 0, email_verified = 1 WHERE id = ?', [hash, 'admin', existing.id]);
		console.log(`Superadmin ensured: ${SUPERADMIN_USERNAME}`);
	} catch (e) {
		console.error('Failed to ensure superadmin:', e.message || e);
	}
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

app.get('/favicon.ico', (req, res) => {
	res.sendFile(path.join(__dirname, 'public', 'favicon.ico'));
});

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
	const passwordPolicyError = getPasswordPolicyError(String(password || ''));
	if (passwordPolicyError) return res.status(400).json({ error: passwordPolicyError });
	
	try {
		const countRow = await getAsync('SELECT COUNT(*) as cnt FROM users');
		const isFirstUser = Number(countRow && countRow.cnt) === 0;
		const hash = await bcrypt.hash(password, 10);
		const role = isFirstUser ? 'admin' : 'user';
		const verifyToken = createVerificationToken();
		const created = await runAsync(
			'INSERT INTO users (username, password, name, email, institute, program_type, degree, academic_year, speciality, role, email_verified, email_verify_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
			[username, hash, name || '', safeEmail || null, safeInstitute || null, safeProgramType || null, safeDegree || null, safeAcademicYear || null, safeSpeciality || null, role, 0, verifyToken]
		);
		const userId = created.lastID;
		const verifyPath = `/verify-email.html?token=${encodeURIComponent(verifyToken)}`;
		const verifyUrl = `${getPublicBaseUrl(req)}${verifyPath}`;
		console.log(`User registered: ${username} (ID: ${userId}, Role: ${role})`);
		try {
			await sendVerificationEmail(safeEmail, verifyUrl);
			console.log(`Verification email sent to ${safeEmail}`);
		} catch (mailErr) {
			console.error(`Verification email failed for ${username}:`, mailErr.message || mailErr);
			await runAsync('DELETE FROM users WHERE id = ?', [userId]);
			return res.status(500).json({ error: 'Unable to send verification email right now. Please try again shortly.' });
		}
		const payload = {
			success: true,
			id: userId,
			role,
			emailVerified: false,
			message: 'Registration successful. Please check your email to verify your account.'
		};
		if (!isProduction) {
			payload.verifyUrl = verifyUrl;
			payload.verifyToken = verifyToken;
		}
		return res.json(payload);
	} catch (e) {
		if (String(e && e.message || '').toLowerCase().includes('unique')) {
			return res.status(400).json({ error: 'Username already exists' });
		}
		console.error('Register exception:', e);
		return res.status(500).json({ error: 'Server error: ' + e.message });
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
			if (Number(user.account_blocked)) {
				return res.status(403).json({ error: 'Your account is blocked. Contact administrator.' });
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
	const confirmNewPassword = typeof req.body.confirmNewPassword === 'string' ? req.body.confirmNewPassword.trim() : '';
	if (!currentPassword || !newPassword || !confirmNewPassword) return res.status(400).json({ error: 'Current, new, and confirm password are required' });
	if (newPassword !== confirmNewPassword) return res.status(400).json({ error: 'New password and confirm password do not match' });
	const passwordPolicyError = getPasswordPolicyError(newPassword);
	if (passwordPolicyError) return res.status(400).json({ error: passwordPolicyError });
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

app.post('/api/forgot-password/request', async (req, res) => {
	const identifier = typeof req.body.identifier === 'string' ? req.body.identifier.trim() : '';
	if (!identifier) return res.status(400).json({ error: 'Username or email is required' });
	try {
		const user = await getAsync('SELECT id, email, email_verified FROM users WHERE username = ? OR email = ?', [identifier, identifier]);
		// Avoid account enumeration: return success even when user is not found.
		if (!user) return res.json({ success: true, message: 'If an account exists, a password reset email has been sent.' });
		if (!Number(user.email_verified) || !user.email) return res.json({ success: true, message: 'If an account exists, a password reset email has been sent.' });
		const rawToken = createVerificationToken();
		const tokenHash = hashToken(rawToken);
		const expiresAt = Date.now() + (15 * 60 * 1000);
		await runAsync('UPDATE users SET password_reset_token_hash = ?, password_reset_expires_at = ? WHERE id = ?', [tokenHash, expiresAt, user.id]);
		const resetUrl = `${getPublicBaseUrl(req)}/forgot.html?token=${encodeURIComponent(rawToken)}`;
		await sendPasswordResetEmail(user.email, resetUrl);
		const payload = { success: true, message: 'If an account exists, a password reset email has been sent.' };
		if (!isProduction) payload.resetUrl = resetUrl;
		return res.json(payload);
	} catch (e) {
		console.error('Forgot password request error:', e);
		return res.status(500).json({ error: 'Unable to process reset request right now' });
	}
});

app.get('/api/forgot-password/validate', async (req, res) => {
	const token = typeof req.query.token === 'string' ? req.query.token.trim() : '';
	if (!token) return res.status(400).json({ error: 'Invalid reset token' });
	try {
		const tokenHash = hashToken(token);
		const row = await getAsync('SELECT id, password_reset_expires_at FROM users WHERE password_reset_token_hash = ?', [tokenHash]);
		if (!row) return res.status(400).json({ error: 'Invalid or expired reset link' });
		if (!row.password_reset_expires_at || Number(row.password_reset_expires_at) < Date.now()) {
			return res.status(400).json({ error: 'Invalid or expired reset link' });
		}
		return res.json({ success: true, valid: true });
	} catch (e) {
		console.error('Forgot password validate error:', e);
		return res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/forgot-password/confirm', async (req, res) => {
	const token = typeof req.body.token === 'string' ? req.body.token.trim() : '';
	const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword.trim() : '';
	const confirmNewPassword = typeof req.body.confirmNewPassword === 'string' ? req.body.confirmNewPassword.trim() : '';
	if (!token || !newPassword || !confirmNewPassword) return res.status(400).json({ error: 'Token, new password, and confirm password are required' });
	if (newPassword !== confirmNewPassword) return res.status(400).json({ error: 'Passwords do not match' });
	const passwordPolicyError = getPasswordPolicyError(newPassword);
	if (passwordPolicyError) return res.status(400).json({ error: passwordPolicyError });
	try {
		const tokenHash = hashToken(token);
		const user = await getAsync('SELECT id, password_reset_expires_at FROM users WHERE password_reset_token_hash = ?', [tokenHash]);
		if (!user) return res.status(400).json({ error: 'Invalid or expired reset link' });
		if (!user.password_reset_expires_at || Number(user.password_reset_expires_at) < Date.now()) {
			return res.status(400).json({ error: 'Invalid or expired reset link' });
		}
		const hash = await bcrypt.hash(newPassword, 10);
		await runAsync('UPDATE users SET password = ?, password_reset_token_hash = NULL, password_reset_expires_at = NULL WHERE id = ?', [hash, user.id]);
		return res.json({ success: true });
	} catch (e) {
		console.error('Forgot password confirm error:', e);
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
	db.get('SELECT id, username, name, nickname, email, gender, date_of_birth, bio, status_description, achievements, place_from, country, state, pincode, contact_country_code, contact_number, institute, program_type, degree, academic_year, speciality, privacy_show_online, privacy_discoverability, privacy_in_suggestions, privacy_request_policy, role, email_verified, last_login, profile_picture, xp, level, title FROM users WHERE id = ?', [req.session.userId], (err, user) => {
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

app.get('/api/dev/verify-link', async (req, res) => {
	if (isProduction) return res.status(403).json({ error: 'Not available in production' });
	const identifier = typeof req.query.identifier === 'string' ? req.query.identifier.trim() : '';
	if (!identifier) return res.status(400).json({ error: 'identifier is required (username or email)' });
	try {
		const user = await getAsync('SELECT id, username, email_verified, email_verify_token FROM users WHERE username = ? OR email = ?', [identifier, identifier]);
		if (!user) return res.status(404).json({ error: 'User not found' });
		let token = user.email_verify_token;
		if (!Number(user.email_verified) && !token) {
			token = Math.random().toString(36).slice(2) + Date.now().toString(36);
			await runAsync('UPDATE users SET email_verify_token = ? WHERE id = ?', [token, user.id]);
		}
		if (Number(user.email_verified)) {
			return res.json({ success: true, username: user.username, alreadyVerified: true, loginUrl: `${getPublicBaseUrl(req)}/login.html` });
		}
		if (!token) return res.status(404).json({ error: 'No pending verification token found' });
		const verifyPath = `/verify-email.html?token=${encodeURIComponent(token)}`;
		const verifyUrl = `${getPublicBaseUrl(req)}${verifyPath}`;
		return res.json({ success: true, username: user.username, verifyUrl, token });
	} catch (e) {
		return res.status(500).json({ error: 'Server error' });
	}
});

app.get('/dev/verify-user/:username', async (req, res) => {
	if (isProduction) return res.status(403).send('Not available in production');
	const username = typeof req.params.username === 'string' ? req.params.username.trim() : '';
	if (!username) return res.status(400).send('Username is required');
	try {
		const user = await getAsync('SELECT id, email_verified, email_verify_token FROM users WHERE username = ?', [username]);
		if (!user) return res.status(404).send('User not found');
		if (Number(user.email_verified)) return res.redirect('/login.html?verified=1');
		let token = user.email_verify_token;
		if (!token) {
			token = Math.random().toString(36).slice(2) + Date.now().toString(36);
			await runAsync('UPDATE users SET email_verify_token = ? WHERE id = ?', [token, user.id]);
		}
		return res.redirect(`/verify-email.html?token=${encodeURIComponent(token)}`);
	} catch (e) {
		return res.status(500).send('Server error');
	}
});

app.get('/api/profile', requireAuth, async (req, res) => {
	try {
		const user = await getAsync('SELECT id, username, name, nickname, email, gender, date_of_birth, bio, status_description, achievements, place_from, country, state, pincode, contact_country_code, contact_number, institute, program_type, degree, academic_year, speciality, privacy_show_online, privacy_discoverability, privacy_in_suggestions, privacy_request_policy, profile_picture FROM users WHERE id = ?', [req.session.userId]);
		if (!user) return res.status(404).json({ error: 'User not found' });
		res.json({ user });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/profile', requireAuth, async (req, res) => {
	const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
	const nickname = typeof req.body.nickname === 'string' ? req.body.nickname.trim() : '';
	const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
	const gender = typeof req.body.gender === 'string' ? req.body.gender.trim().toLowerCase() : '';
	const dateOfBirth = typeof req.body.dateOfBirth === 'string' ? req.body.dateOfBirth.trim() : '';
	const bio = typeof req.body.bio === 'string' ? req.body.bio.trim() : '';
	const statusDescription = typeof req.body.statusDescription === 'string' ? req.body.statusDescription.trim() : '';
	const achievements = typeof req.body.achievements === 'string' ? req.body.achievements.trim() : '';
	const placeFrom = typeof req.body.placeFrom === 'string' ? req.body.placeFrom.trim() : '';
	const country = typeof req.body.country === 'string' ? req.body.country.trim() : '';
	const state = typeof req.body.state === 'string' ? req.body.state.trim() : '';
	const pincode = typeof req.body.pincode === 'string' ? req.body.pincode.trim() : '';
	const contactCountryCode = typeof req.body.contactCountryCode === 'string' ? req.body.contactCountryCode.trim() : '';
	const contactNumber = typeof req.body.contactNumber === 'string' ? req.body.contactNumber.trim() : '';
	const privacyShowOnline = typeof req.body.privacyShowOnline === 'string' ? req.body.privacyShowOnline.trim() : '';
	const privacyDiscoverability = typeof req.body.privacyDiscoverability === 'string' ? req.body.privacyDiscoverability.trim() : '';
	const privacyInSuggestions = typeof req.body.privacyInSuggestions === 'string' ? req.body.privacyInSuggestions.trim() : '';
	const privacyRequestPolicy = typeof req.body.privacyRequestPolicy === 'string' ? req.body.privacyRequestPolicy.trim() : '';
	const institute = typeof req.body.institute === 'string' ? req.body.institute.trim() : '';
	const programType = typeof req.body.programType === 'string' ? req.body.programType.trim() : '';
	const degree = typeof req.body.degree === 'string' ? req.body.degree.trim() : '';
	const academicYear = typeof req.body.academicYear === 'string' ? req.body.academicYear.trim() : '';
	const speciality = typeof req.body.speciality === 'string' ? req.body.speciality.trim() : '';
	if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		return res.status(400).json({ error: 'Please provide a valid email address' });
	}
	if (gender && !['male', 'female', 'other', 'prefer_not_to_say'].includes(gender)) {
		return res.status(400).json({ error: 'Invalid gender value' });
	}
	if (dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
		return res.status(400).json({ error: 'Date of birth must be YYYY-MM-DD' });
	}
	if (privacyShowOnline && !['everyone', 'connections', 'nobody'].includes(privacyShowOnline)) return res.status(400).json({ error: 'Invalid online visibility option' });
	if (privacyDiscoverability && !['everyone', 'nobody'].includes(privacyDiscoverability)) return res.status(400).json({ error: 'Invalid discoverability option' });
	if (privacyInSuggestions && !['everyone', 'nobody'].includes(privacyInSuggestions)) return res.status(400).json({ error: 'Invalid suggestion visibility option' });
	if (privacyRequestPolicy && !['everyone', 'link_only', 'nobody'].includes(privacyRequestPolicy)) return res.status(400).json({ error: 'Invalid request policy option' });
	if (name.length > 120) return res.status(400).json({ error: 'Name is too long' });
	if (nickname.length > 60) return res.status(400).json({ error: 'Nickname is too long' });
	if (bio.length > 400) return res.status(400).json({ error: 'Bio is too long' });
	if (statusDescription.length > 180) return res.status(400).json({ error: 'Status description is too long' });
	if (achievements.length > 300) return res.status(400).json({ error: 'Achievements are too long' });
	if (placeFrom.length > 120) return res.status(400).json({ error: 'Place is too long' });
	if (country.length > 80) return res.status(400).json({ error: 'Country is too long' });
	if (state.length > 80) return res.status(400).json({ error: 'State is too long' });
	if (pincode.length > 20) return res.status(400).json({ error: 'Pincode is too long' });
	if (pincode && !/^[A-Za-z0-9\- ]{3,20}$/.test(pincode)) return res.status(400).json({ error: 'Invalid pincode format' });
	if (contactCountryCode.length > 6) return res.status(400).json({ error: 'Country code is too long' });
	if (contactCountryCode && !/^\+\d{1,5}$/.test(contactCountryCode)) return res.status(400).json({ error: 'Invalid country code format' });
	if (contactNumber.length > 20) return res.status(400).json({ error: 'Contact number is too long' });
	if (contactNumber && !/^\d{6,20}$/.test(contactNumber)) return res.status(400).json({ error: 'Invalid contact number format' });
	if ((contactCountryCode && !contactNumber) || (!contactCountryCode && contactNumber)) {
		return res.status(400).json({ error: 'Add both country code and contact number' });
	}
	try {
		await runAsync('UPDATE users SET name = ?, nickname = ?, email = ?, gender = ?, date_of_birth = ?, bio = ?, status_description = ?, achievements = ?, place_from = ?, country = ?, state = ?, pincode = ?, contact_country_code = ?, contact_number = ?, institute = ?, program_type = ?, degree = ?, academic_year = ?, speciality = ?, privacy_show_online = ?, privacy_discoverability = ?, privacy_in_suggestions = ?, privacy_request_policy = ? WHERE id = ?', [name || null, nickname || null, email || null, gender || null, dateOfBirth || null, bio || null, statusDescription || null, achievements || null, placeFrom || null, country || null, state || null, pincode || null, contactCountryCode || null, contactNumber || null, institute || null, programType || null, degree || null, academicYear || null, speciality || null, privacyShowOnline || 'connections', privacyDiscoverability || 'everyone', privacyInSuggestions || 'everyone', privacyRequestPolicy || 'everyone', req.session.userId]);
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
	const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
	try {
		const rows = await allAsync(`SELECT
			u.id,
			u.username,
			u.name,
			u.email,
			u.role,
			u.email_verified,
			u.account_blocked,
			u.xp,
			u.last_login,
			(SELECT COUNT(*) FROM connections c WHERE (c.user_a = u.id OR c.user_b = u.id) AND c.status = 'accepted') AS total_connections
			FROM users u
			WHERE u.username <> ?
			AND (? = '' OR LOWER(u.username) LIKE LOWER(?) OR LOWER(COALESCE(u.name, '')) LIKE LOWER(?) OR LOWER(COALESCE(u.email, '')) LIKE LOWER(?))
			ORDER BY u.id DESC`, [SUPERADMIN_USERNAME, q, `%${q}%`, `%${q}%`, `%${q}%`]);
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
		const target = await getAsync('SELECT username FROM users WHERE id = ?', [userId]);
		if (!target) return res.status(404).json({ error: 'User not found' });
		if (target.username === SUPERADMIN_USERNAME) return res.status(403).json({ error: 'Operation not allowed for this account' });
		await runAsync('UPDATE users SET role = ? WHERE id = ?', [role, userId]);
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/admin/users/:id/verify-email', requireAdmin, async (req, res) => {
	const userId = Number(req.params.id);
	if (!userId) return res.status(400).json({ error: 'Invalid user id' });
	try {
		const target = await getAsync('SELECT username FROM users WHERE id = ?', [userId]);
		if (!target) return res.status(404).json({ error: 'User not found' });
		if (target.username === SUPERADMIN_USERNAME) return res.status(403).json({ error: 'Operation not allowed for this account' });
		const updated = await runAsync('UPDATE users SET email_verified = 1, email_verify_token = NULL WHERE id = ?', [userId]);
		if (!updated.changes) return res.status(404).json({ error: 'User not found' });
		return res.json({ success: true });
	} catch (e) {
		return res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/admin/users/:id/block', requireAdmin, async (req, res) => {
	const userId = Number(req.params.id);
	const blocked = Number(req.body.blocked) ? 1 : 0;
	if (!userId) return res.status(400).json({ error: 'Invalid user id' });
	if (Number(req.session.userId) === userId) return res.status(400).json({ error: 'Cannot block yourself' });
	try {
		const target = await getAsync('SELECT username FROM users WHERE id = ?', [userId]);
		if (!target) return res.status(404).json({ error: 'User not found' });
		if (target.username === SUPERADMIN_USERNAME) return res.status(403).json({ error: 'Operation not allowed for this account' });
		const updated = await runAsync('UPDATE users SET account_blocked = ? WHERE id = ?', [blocked, userId]);
		if (!updated.changes) return res.status(404).json({ error: 'User not found' });
		res.json({ success: true, blocked: Boolean(blocked) });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

async function deleteUserAndRelatedData(userId) {
	const postRows = await allAsync('SELECT id FROM posts WHERE user_id = ?', [userId]);
	const postIds = postRows.map((r) => Number(r.id)).filter((id) => !Number.isNaN(id));
	if (postIds.length) {
		const placeholders = postIds.map(() => '?').join(', ');
		await runAsync(`DELETE FROM quiz_attempts WHERE post_id IN (${placeholders})`, postIds);
		await runAsync(`DELETE FROM post_likes WHERE post_id IN (${placeholders})`, postIds);
		await runAsync(`DELETE FROM post_comments WHERE post_id IN (${placeholders})`, postIds);
		await runAsync(`DELETE FROM saved_posts WHERE post_id IN (${placeholders})`, postIds);
		await runAsync(`DELETE FROM post_shares WHERE post_id IN (${placeholders})`, postIds);
	}
	await runAsync('DELETE FROM quiz_attempts WHERE user_id = ?', [userId]);
	await runAsync('DELETE FROM post_likes WHERE user_id = ?', [userId]);
	await runAsync('DELETE FROM post_comments WHERE user_id = ? OR mention_user_id = ?', [userId, userId]);
	await runAsync('DELETE FROM saved_posts WHERE user_id = ?', [userId]);
	await runAsync('DELETE FROM saved_post_lists WHERE user_id = ?', [userId]);
	await runAsync('DELETE FROM post_shares WHERE from_user = ? OR to_user = ?', [userId, userId]);
	await runAsync('DELETE FROM posts WHERE user_id = ?', [userId]);

	await runAsync('DELETE FROM connections WHERE user_a = ? OR user_b = ?', [userId, userId]);
	await runAsync('DELETE FROM follows WHERE follower_id = ? OR followee_id = ?', [userId, userId]);
	await runAsync('DELETE FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?', [userId, userId]);
	await runAsync('DELETE FROM user_reports WHERE reporter_id = ? OR target_user_id = ?', [userId, userId]);
	await runAsync('DELETE FROM clan_reports WHERE reporter_id = ?', [userId]);
	await runAsync('DELETE FROM notifications WHERE user_id = ? OR actor_id = ?', [userId, userId]);
	await runAsync('DELETE FROM messages WHERE from_user = ? OR to_user = ?', [userId, userId]);
	await runAsync('DELETE FROM xp_events WHERE user_id = ?', [userId]);
	await runAsync('DELETE FROM story_likes WHERE user_id = ?', [userId]);
	await runAsync('DELETE FROM story_comments WHERE user_id = ?', [userId]);
	await runAsync('DELETE FROM story_replies WHERE from_user_id = ? OR to_user_id = ?', [userId, userId]);
	await runAsync('DELETE FROM story_shares WHERE user_id = ?', [userId]);
	await runAsync('DELETE FROM story_likes WHERE story_id IN (SELECT id FROM stories WHERE user_id = ?)', [userId]);
	await runAsync('DELETE FROM story_comments WHERE story_id IN (SELECT id FROM stories WHERE user_id = ?)', [userId]);
	await runAsync('DELETE FROM story_replies WHERE story_id IN (SELECT id FROM stories WHERE user_id = ?)', [userId]);
	await runAsync('DELETE FROM story_shares WHERE story_id IN (SELECT id FROM stories WHERE user_id = ?)', [userId]);
	await runAsync('DELETE FROM stories WHERE user_id = ?', [userId]);
	await runAsync('DELETE FROM speciality_suggestions WHERE user_id = ?', [userId]);

	const ownedGroups = await allAsync('SELECT id FROM groups WHERE created_by = ?', [userId]);
	for (const group of ownedGroups) {
		const groupId = Number(group.id);
		if (!groupId) continue;
		await runAsync('DELETE FROM clan_reports WHERE clan_id = ?', [groupId]);
		await runAsync('DELETE FROM group_memberships WHERE group_id = ?', [groupId]);
		await runAsync('DELETE FROM group_roles WHERE group_id = ?', [groupId]);
		await runAsync('DELETE FROM group_posts WHERE group_id = ?', [groupId]);
		await runAsync('DELETE FROM group_invites WHERE group_id = ?', [groupId]);
		await runAsync('DELETE FROM group_lounge_messages WHERE group_id = ?', [groupId]);
		await runAsync('DELETE FROM groups WHERE id = ?', [groupId]);
	}

	await runAsync('DELETE FROM group_memberships WHERE user_id = ?', [userId]);
	await runAsync('DELETE FROM group_roles WHERE created_by = ?', [userId]);
	await runAsync('DELETE FROM group_posts WHERE user_id = ?', [userId]);
	await runAsync('DELETE FROM group_invites WHERE created_by = ?', [userId]);
	await runAsync('DELETE FROM group_lounge_messages WHERE user_id = ?', [userId]);

	// Best effort cleanup for persistent sessions created by connect-pg-simple.
	try {
		await runAsync(`DELETE FROM user_sessions WHERE COALESCE((sess::json->>'userId'), '') = ?`, [String(userId)]);
	} catch (e) {
		if (!e || String(e.code) !== '42P01') throw e;
	}

	const deleted = await runAsync('DELETE FROM users WHERE id = ?', [userId]);
	return Boolean(deleted && deleted.changes);
}

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
	const userId = Number(req.params.id);
	const actorId = Number(req.session.userId);
	if (!userId) return res.status(400).json({ error: 'Invalid user id' });
	if (!actorId) return res.status(401).json({ error: 'Unauthorized' });
	if (userId === actorId) return res.status(400).json({ error: 'Cannot delete your own account from admin panel' });
	try {
		const actor = await getAsync('SELECT username, role FROM users WHERE id = ?', [actorId]);
		if (!actor || actor.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
		const target = await getAsync('SELECT username, role FROM users WHERE id = ?', [userId]);
		if (!target) return res.status(404).json({ error: 'User not found' });
		if (target.username === SUPERADMIN_USERNAME) return res.status(403).json({ error: 'Operation not allowed for this account' });
		if (target.role === 'admin' && actor.username !== SUPERADMIN_USERNAME) {
			return res.status(403).json({ error: 'Only superadmin can delete admin accounts' });
		}
		const ok = await deleteUserAndRelatedData(userId);
		if (!ok) return res.status(404).json({ error: 'User not found' });
		res.json({ success: true });
	} catch (e) {
		console.error('Admin delete user API error:', e);
		res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/admin/reports', requireAdmin, async (req, res) => {
	const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
	const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
	const fromTs = Number(req.query.from || 0);
	try {
		const rows = await allAsync(`SELECT
			r.id,
			r.reporter_id,
			r.target_user_id,
			r.category,
			r.details,
			r.status,
			r.created_at,
			reporter.username AS reporter_username,
			target.username AS target_username
			FROM user_reports r
			LEFT JOIN users reporter ON reporter.id = r.reporter_id
			LEFT JOIN users target ON target.id = r.target_user_id
			WHERE COALESCE(reporter.username, '') <> ?
			AND COALESCE(target.username, '') <> ?
			AND (? = '' OR r.status = ?)
			AND (? = 0 OR r.created_at >= ?)
			AND (? = '' OR LOWER(COALESCE(reporter.username, '')) LIKE LOWER(?) OR LOWER(COALESCE(target.username, '')) LIKE LOWER(?) OR LOWER(COALESCE(r.category, '')) LIKE LOWER(?) OR LOWER(COALESCE(r.details, '')) LIKE LOWER(?))
			ORDER BY r.created_at DESC
			LIMIT 500`, [SUPERADMIN_USERNAME, SUPERADMIN_USERNAME, status, status, fromTs, fromTs, q, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`]);
		res.json({ reports: rows });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/admin/reports/all', requireAdmin, async (req, res) => {
	const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
	const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
	const fromTs = Number(req.query.from || 0);
	try {
		const userRows = await allAsync(`SELECT
			'user' AS report_type,
			r.id,
			r.reporter_id,
			r.target_user_id AS target_id,
			NULL::BIGINT AS clan_id,
			r.category,
			r.details,
			r.status,
			r.created_at,
			reporter.username AS reporter_username,
			target.username AS target_name
			FROM user_reports r
			LEFT JOIN users reporter ON reporter.id = r.reporter_id
			LEFT JOIN users target ON target.id = r.target_user_id
			WHERE COALESCE(reporter.username, '') <> ?
			AND COALESCE(target.username, '') <> ?
			AND (? = '' OR r.status = ?)
			AND (? = 0 OR r.created_at >= ?)
			AND (? = '' OR LOWER(COALESCE(reporter.username, '')) LIKE LOWER(?) OR LOWER(COALESCE(target.username, '')) LIKE LOWER(?) OR LOWER(COALESCE(r.category, '')) LIKE LOWER(?) OR LOWER(COALESCE(r.details, '')) LIKE LOWER(?))
			ORDER BY r.created_at DESC
			LIMIT 500`, [SUPERADMIN_USERNAME, SUPERADMIN_USERNAME, status, status, fromTs, fromTs, q, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`]);
		const clanRows = await allAsync(`SELECT
			'clan' AS report_type,
			r.id,
			r.reporter_id,
			NULL::BIGINT AS target_id,
			r.clan_id,
			r.category,
			r.details,
			r.status,
			r.created_at,
			reporter.username AS reporter_username,
			g.name AS target_name
			FROM clan_reports r
			LEFT JOIN users reporter ON reporter.id = r.reporter_id
			LEFT JOIN groups g ON g.id = r.clan_id
			WHERE COALESCE(reporter.username, '') <> ?
			AND (? = '' OR r.status = ?)
			AND (? = 0 OR r.created_at >= ?)
			AND (? = '' OR LOWER(COALESCE(reporter.username, '')) LIKE LOWER(?) OR LOWER(COALESCE(g.name, '')) LIKE LOWER(?) OR LOWER(COALESCE(r.category, '')) LIKE LOWER(?) OR LOWER(COALESCE(r.details, '')) LIKE LOWER(?))
			ORDER BY r.created_at DESC
			LIMIT 500`, [SUPERADMIN_USERNAME, status, status, fromTs, fromTs, q, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`]);
		const reports = [...userRows, ...clanRows].sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0)).slice(0, 800);
		res.json({ reports });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/admin/clans', requireAdmin, async (req, res) => {
	const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
	const sort = typeof req.query.sort === 'string' ? req.query.sort.trim() : 'members_desc';
	try {
		const rows = await allAsync(`SELECT
			g.id,
			g.name,
			g.description,
			g.is_private,
			g.clan_level,
			g.clan_xp,
			g.created_at,
			(SELECT COUNT(*) FROM group_memberships gm WHERE gm.group_id = g.id AND gm.status = 'active') AS total_members,
			(SELECT MAX(gp.created_at) FROM group_posts gp WHERE gp.group_id = g.id) AS last_active,
			(SELECT COUNT(*) FROM clan_reports cr WHERE cr.clan_id = g.id AND cr.status = 'open') AS open_reports
			FROM groups g
			WHERE (? = '' OR LOWER(g.name) LIKE LOWER(?) OR LOWER(COALESCE(g.description, '')) LIKE LOWER(?))
			ORDER BY g.created_at DESC
			LIMIT 500`, [q, `%${q}%`, `%${q}%`]);
		const sorted = [...rows].sort((a, b) => {
			if (sort === 'name_asc') return String(a.name || '').localeCompare(String(b.name || ''));
			if (sort === 'last_active_desc') return Number(b.last_active || 0) - Number(a.last_active || 0);
			if (sort === 'reports_desc') return Number(b.open_reports || 0) - Number(a.open_reports || 0);
			return Number(b.total_members || 0) - Number(a.total_members || 0);
		});
		res.json({ clans: sorted });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/support/tickets', requireAuth, async (req, res) => {
	const subject = typeof req.body.subject === 'string' ? req.body.subject.trim() : '';
	const category = typeof req.body.category === 'string' ? req.body.category.trim() : 'general';
	const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';
	if (!subject) return res.status(400).json({ error: 'Subject is required' });
	if (!message) return res.status(400).json({ error: 'Message is required' });
	if (subject.length > 140) return res.status(400).json({ error: 'Subject is too long' });
	if (message.length > 5000) return res.status(400).json({ error: 'Message is too long' });
	try {
		const now = Date.now();
		const created = await runAsync(`INSERT INTO support_tickets (user_id, subject, category, message, status, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`, [req.session.userId, subject, category || 'general', message, 'waiting', now, now]);
		res.json({ success: true, id: created.lastID, status: 'waiting' });
	} catch (e) {
		console.error('Support ticket create error:', e);
		res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/support/tickets/mine', requireAuth, async (req, res) => {
	try {
		const rows = await allAsync(`SELECT id, subject, category, message, status, created_at, updated_at
			FROM support_tickets
			WHERE user_id = ?
			ORDER BY created_at DESC
			LIMIT 100`, [req.session.userId]);
		res.json({ tickets: rows });
	} catch (e) {
		console.error('Support ticket mine error:', e);
		res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/admin/tickets', requireAdmin, async (req, res) => {
	const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
	const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
	try {
		const rows = await allAsync(`SELECT
			t.id,
			t.user_id,
			t.subject,
			t.category,
			t.message,
			t.status,
			t.created_at,
			t.updated_at,
			u.username,
			u.name
			FROM support_tickets t
			LEFT JOIN users u ON u.id = t.user_id
			WHERE (? = '' OR t.status = ?)
			AND (? = '' OR LOWER(COALESCE(t.subject, '')) LIKE LOWER(?) OR LOWER(COALESCE(t.message, '')) LIKE LOWER(?) OR LOWER(COALESCE(u.username, '')) LIKE LOWER(?) OR LOWER(COALESCE(u.name, '')) LIKE LOWER(?))
			ORDER BY t.created_at DESC
			LIMIT 600`, [status, status, q, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`]);
		res.json({ tickets: rows });
	} catch (e) {
		console.error('Admin tickets load error:', e);
		res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/admin/tickets/:id/status', requireAdmin, async (req, res) => {
	const id = Number(req.params.id);
	const status = typeof req.body.status === 'string' ? req.body.status.trim().toLowerCase() : '';
	if (!id) return res.status(400).json({ error: 'Invalid ticket id' });
	if (!['waiting', 'open', 'progress', 'resolved'].includes(status)) {
		return res.status(400).json({ error: 'Invalid status' });
	}
	try {
		const updated = await runAsync('UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?', [status, Date.now(), id]);
		if (!updated.changes) return res.status(404).json({ error: 'Ticket not found' });
		res.json({ success: true, status });
	} catch (e) {
		console.error('Admin ticket status update error:', e);
		res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/admin/reports/:id/status', requireAdmin, async (req, res) => {
	const id = Number(req.params.id);
	const status = typeof req.body.status === 'string' ? req.body.status.trim() : '';
	if (!id) return res.status(400).json({ error: 'Invalid report id' });
	if (!['open', 'reviewed', 'closed'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
	try {
		await runAsync('UPDATE user_reports SET status = ? WHERE id = ?', [status, id]);
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
	const viewerId = Number(req.session.userId || 0);
	db.get('SELECT id, username, name, nickname, gender, date_of_birth, bio, status_description, achievements, place_from, country, state, pincode, contact_country_code, contact_number, institute, program_type, degree, academic_year, speciality, profile_picture, privacy_show_online, privacy_discoverability, level, title FROM users WHERE id = ? AND username <> ?', [uid, SUPERADMIN_USERNAME], (err, user) => {
		if (err || !user) return res.status(404).json({ error: 'User not found' });
		if (user.privacy_discoverability === 'nobody' && (!viewerId || Number(uid) !== viewerId)) {
			return res.status(404).json({ error: 'User not found' });
		}
		const q = `SELECT COUNT(*) as cnt FROM connections WHERE ((user_a = ? OR user_b = ?) AND status = 'accepted')`;
		db.get(q, [uid, uid], async (err2, row) => {
			if (err2) user.connections_count = 0;
			else user.connections_count = row.cnt || 0;
			user.online = false;
			user.online_visible = false;
			if (!viewerId || Number(uid) === viewerId) return res.json({ user });
			try {
				const [connection, follow, blockedByMe, blockedMe] = await Promise.all([
					getAsync(`SELECT id, status, user_a FROM connections
						WHERE (user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)
						ORDER BY created_at DESC LIMIT 1`, [viewerId, uid, uid, viewerId]),
					getAsync('SELECT id FROM follows WHERE follower_id = ? AND followee_id = ?', [viewerId, uid]),
					getAsync('SELECT id FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', [viewerId, uid]),
					getAsync('SELECT id FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', [uid, viewerId])
				]);
				user.relationship = {
					connectionStatus: connection ? connection.status : 'none',
					connectionId: connection ? connection.id : null,
					connectionRequestedByMe: connection ? Number(connection.user_a) === viewerId : false,
					following: Boolean(follow),
					blockedByMe: Boolean(blockedByMe),
					blockedMe: Boolean(blockedMe)
				};
				const canSeeOnline = user.privacy_show_online === 'everyone' || (user.privacy_show_online === 'connections' && connection && connection.status === 'accepted');
				user.online_visible = Boolean(canSeeOnline);
				user.online = canSeeOnline ? isUserOnline(uid) : false;
			} catch (relErr) {
				user.relationship = {
					connectionStatus: 'unknown',
					connectionId: null,
					following: false,
					blockedByMe: false,
					blockedMe: false
				};
				user.online_visible = false;
				user.online = false;
			}
			return res.json({ user });
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
		(SELECT COUNT(*) FROM quiz_attempts qa WHERE qa.post_id = p.id AND qa.user_id = ${uid}) as my_quiz_attempted,
		(SELECT qa2.selected_index FROM quiz_attempts qa2 WHERE qa2.post_id = p.id AND qa2.user_id = ${uid} ORDER BY qa2.created_at DESC LIMIT 1) as my_quiz_selected_index,
		(SELECT qa3.is_correct FROM quiz_attempts qa3 WHERE qa3.post_id = p.id AND qa3.user_id = ${uid} ORDER BY qa3.created_at DESC LIMIT 1) as my_quiz_is_correct
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
		) AND u.username <> '${SUPERADMIN_USERNAME}'
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
	const viaProfileLink = Boolean(req.body && req.body.viaProfileLink);
	if (!to) return res.status(400).json({ error: 'Missing target user' });
	const a = Number(req.session.userId), b = Number(to);
	if (!a || !b || a === b) return res.status(400).json({ error: 'Invalid target user' });
	const ts = Date.now();
	db.get('SELECT id, username, privacy_request_policy FROM users WHERE id = ?', [b], (targetErr, targetUser) => {
		if (targetErr) return res.status(500).json({ error: 'Server error' });
		if (!targetUser) return res.status(404).json({ error: 'Target user not found' });
		if (targetUser.username === SUPERADMIN_USERNAME) return res.status(404).json({ error: 'Target user not found' });
		const policy = String(targetUser.privacy_request_policy || 'everyone');
		if (policy === 'nobody') return res.status(403).json({ error: 'This user is not accepting requests' });
		if (policy === 'link_only' && !viaProfileLink) return res.status(403).json({ error: 'This user accepts requests only from profile link' });
	db.get('SELECT id FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)', [a, b, b, a], (blockErr, blockRow) => {
		if (blockErr) return res.status(500).json({ error: 'Server error' });
		if (blockRow) return res.status(403).json({ error: 'Unable to connect with this user' });
		db.get(`SELECT id, status FROM connections
			WHERE (user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)
			ORDER BY created_at DESC LIMIT 1`, [a, b, b, a], (existingErr, existing) => {
			if (existingErr) return res.status(500).json({ error: 'Server error' });
			if (existing && existing.status === 'accepted') return res.status(400).json({ error: 'Already connected' });
			if (existing && existing.status === 'pending') return res.status(400).json({ error: 'Connection request already pending' });
			db.run('INSERT INTO connections (user_a,user_b,status,created_at) VALUES (?,?,?,?)', [a, b, 'pending', ts], function (err) {
				if (err) return res.status(400).json({ error: 'Unable to create request' });
				io.to(`user:${b}`).emit('connectionRequest', { from: a, to: b });
				createUserNotification(b, {
					actorId: a,
					type: 'connection_request',
					title: 'New connection request',
					message: 'Someone sent you a connection request.',
					refType: 'connection',
					refId: this && this.lastID ? Number(this.lastID) : null
				}).catch((notifyErr) => console.error('Connection notification error:', notifyErr));
				res.json({ success: true });
			});
		});
	});
	});
});

app.post('/api/connect/disconnect', requireAuth, async (req, res) => {
	const otherId = Number(req.body.userId);
	const me = Number(req.session.userId);
	if (!otherId || !me) return res.status(400).json({ error: 'Invalid user id' });
	try {
		await runAsync('DELETE FROM connections WHERE (user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)', [me, otherId, otherId, me]);
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/follow/toggle', requireAuth, async (req, res) => {
	const targetId = Number(req.body.userId);
	const me = Number(req.session.userId);
	if (!targetId || !me || targetId === me) return res.status(400).json({ error: 'Invalid user id' });
	try {
		const blocked = await getAsync('SELECT id FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)', [me, targetId, targetId, me]);
		if (blocked) return res.status(403).json({ error: 'Unable to follow this user' });
		const existing = await getAsync('SELECT id FROM follows WHERE follower_id = ? AND followee_id = ?', [me, targetId]);
		if (existing) {
			await runAsync('DELETE FROM follows WHERE id = ?', [existing.id]);
			return res.json({ success: true, following: false });
		}
		await runAsync('INSERT INTO follows (follower_id, followee_id, created_at) VALUES (?, ?, ?)', [me, targetId, Date.now()]);
		return res.json({ success: true, following: true });
	} catch (e) {
		return res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/block/toggle', requireAuth, async (req, res) => {
	const targetId = Number(req.body.userId);
	const me = Number(req.session.userId);
	const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
	if (!targetId || !me || targetId === me) return res.status(400).json({ error: 'Invalid user id' });
	try {
		const existing = await getAsync('SELECT id FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', [me, targetId]);
		if (existing) {
			await runAsync('DELETE FROM user_blocks WHERE id = ?', [existing.id]);
			return res.json({ success: true, blocked: false });
		}
		await runAsync('INSERT INTO user_blocks (blocker_id, blocked_id, reason, created_at) VALUES (?, ?, ?, ?)', [me, targetId, reason || null, Date.now()]);
		await runAsync('DELETE FROM connections WHERE (user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)', [me, targetId, targetId, me]);
		await runAsync('DELETE FROM follows WHERE (follower_id = ? AND followee_id = ?) OR (follower_id = ? AND followee_id = ?)', [me, targetId, targetId, me]);
		return res.json({ success: true, blocked: true });
	} catch (e) {
		return res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/report/user', requireAuth, async (req, res) => {
	const targetId = Number(req.body.userId);
	const category = typeof req.body.category === 'string' ? req.body.category.trim() : '';
	const details = typeof req.body.details === 'string' ? req.body.details.trim() : '';
	const me = Number(req.session.userId);
	if (!targetId || !me || targetId === me) return res.status(400).json({ error: 'Invalid user id' });
	if (!category) return res.status(400).json({ error: 'Report category is required' });
	if (details.length > 400) return res.status(400).json({ error: 'Report details are too long' });
	try {
		await runAsync('INSERT INTO user_reports (reporter_id, target_user_id, category, details, status, created_at) VALUES (?, ?, ?, ?, ?, ?)', [me, targetId, category, details || null, 'open', Date.now()]);
		return res.json({ success: true });
	} catch (e) {
		return res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/report/clan', requireAuth, async (req, res) => {
	const clanId = Number(req.body.clanId);
	const category = typeof req.body.category === 'string' ? req.body.category.trim() : '';
	const details = typeof req.body.details === 'string' ? req.body.details.trim() : '';
	const me = Number(req.session.userId);
	if (!clanId || !me) return res.status(400).json({ error: 'Invalid clan id' });
	if (!category) return res.status(400).json({ error: 'Report category is required' });
	if (details.length > 400) return res.status(400).json({ error: 'Report details are too long' });
	try {
		const clan = await getAsync('SELECT id FROM groups WHERE id = ?', [clanId]);
		if (!clan) return res.status(404).json({ error: 'Clan not found' });
		await runAsync('INSERT INTO clan_reports (reporter_id, clan_id, category, details, status, created_at) VALUES (?, ?, ?, ?, ?, ?)', [me, clanId, category, details || null, 'open', Date.now()]);
		return res.json({ success: true });
	} catch (e) {
		return res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/user/:id/posts', requireAuth, async (req, res) => {
	const profileUserId = Number(req.params.id);
	const viewerId = Number(req.session.userId);
	if (!profileUserId) return res.status(400).json({ error: 'Invalid user id' });
	try {
		const profileUser = await getAsync('SELECT id, username FROM users WHERE id = ?', [profileUserId]);
		if (!profileUser || profileUser.username === SUPERADMIN_USERNAME) return res.status(404).json({ error: 'User not found' });
		const blocked = await getAsync('SELECT id FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)', [viewerId, profileUserId, profileUserId, viewerId]);
		if (blocked) return res.status(403).json({ error: 'Profile is not available' });
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
	db.run('UPDATE connections SET status = ? WHERE id = ? AND user_b = ? AND status = ?', ['accepted', id, req.session.userId, 'pending'], function (err) {
		if (err) return res.status(500).json({ error: 'Server error' });
		if (!this.changes) return res.status(404).json({ error: 'Request not found' });
		res.json({ success: true });
	});
});

// decline/reject request
app.post('/api/connect/decline', requireAuth, (req, res) => {
	const { id } = req.body;
	if (!id) return res.status(400).json({ error: 'Missing id' });
	db.run('UPDATE connections SET status = ? WHERE id = ? AND user_b = ? AND status = ?', ['ignored', id, req.session.userId, 'pending'], function (err) {
		if (err) return res.status(500).json({ error: 'Server error' });
		if (!this.changes) return res.status(404).json({ error: 'Request not found' });
		res.json({ success: true });
	});
});

app.post('/api/connect/cancel', requireAuth, (req, res) => {
	const { id } = req.body;
	if (!id) return res.status(400).json({ error: 'Missing id' });
	db.run('DELETE FROM connections WHERE id = ? AND user_a = ? AND status = ?', [id, req.session.userId, 'pending'], function (err) {
		if (err) return res.status(500).json({ error: 'Server error' });
		if (!this.changes) return res.status(404).json({ error: 'Pending request not found' });
		res.json({ success: true });
	});
});

app.post('/api/connect/unignore', requireAuth, (req, res) => {
	const { id } = req.body;
	if (!id) return res.status(400).json({ error: 'Missing id' });
	db.run('DELETE FROM connections WHERE id = ? AND user_b = ? AND status = ?', [id, req.session.userId, 'ignored'], function (err) {
		if (err) return res.status(500).json({ error: 'Server error' });
		if (!this.changes) return res.status(404).json({ error: 'Ignored request not found' });
		res.json({ success: true });
	});
});

// list accepted connections for current user
app.get('/api/connections', requireAuth, (req, res) => {
	const uid = req.session.userId;
	const q = `SELECT u.id, u.username, u.name, u.profile_picture, u.privacy_show_online
		FROM users u JOIN connections c ON ( (c.user_a = ? AND c.user_b = u.id) OR (c.user_b = ? AND c.user_a = u.id) )
		WHERE c.status = 'accepted'
		AND u.username <> ?`;
	db.all(q, [uid, uid, SUPERADMIN_USERNAME], (err, rows) => {
		if (err) return res.status(500).json({ error: 'Server error' });
		const withPresence = (rows || []).map((r) => {
			const canSee = r.privacy_show_online === 'everyone' || r.privacy_show_online === 'connections';
			return { ...r, online_visible: canSee, online: canSee ? isUserOnline(r.id) : false };
		});
		res.json({ connections: withPresence });
	});
});

// list incoming requests
app.get('/api/requests', requireAuth, (req, res) => {
	const uid = req.session.userId;
		db.all('SELECT c.id, c.user_a, c.user_b, c.status, u.username, u.name, u.profile_picture FROM connections c JOIN users u ON u.id = c.user_a WHERE c.user_b = ? AND c.status = ? AND u.username <> ?', [uid, 'pending', SUPERADMIN_USERNAME], (err, rows) => {
		if (err) return res.status(500).json({ error: 'Server error' });
		res.json({ requests: rows });
	});
});

app.get('/api/connections/overview', requireAuth, async (req, res) => {
	const uid = Number(req.session.userId);
	try {
		const acceptedRows = await allAsync(`SELECT u.id, u.username, u.name, u.profile_picture, u.privacy_show_online
			FROM users u
			JOIN connections c ON ((c.user_a = ? AND c.user_b = u.id) OR (c.user_b = ? AND c.user_a = u.id))
			WHERE c.status = 'accepted'
			AND u.username <> ?`, [uid, uid, SUPERADMIN_USERNAME]);
		const sentRows = await allAsync(`SELECT c.id, c.created_at, u.id as user_id, u.username, u.name, u.profile_picture
			FROM connections c
			JOIN users u ON u.id = c.user_b
			WHERE c.user_a = ? AND c.status = 'pending' AND u.username <> ?
			ORDER BY c.created_at DESC`, [uid, SUPERADMIN_USERNAME]);
		const receivedRows = await allAsync(`SELECT c.id, c.created_at, u.id as user_id, u.username, u.name, u.profile_picture
			FROM connections c
			JOIN users u ON u.id = c.user_a
			WHERE c.user_b = ? AND c.status = 'pending' AND u.username <> ?
			ORDER BY c.created_at DESC`, [uid, SUPERADMIN_USERNAME]);
		const ignoredRows = await allAsync(`SELECT c.id, c.created_at, u.id as user_id, u.username, u.name, u.profile_picture
			FROM connections c
			JOIN users u ON u.id = c.user_a
			WHERE c.user_b = ? AND c.status = 'ignored' AND u.username <> ?
			ORDER BY c.created_at DESC`, [uid, SUPERADMIN_USERNAME]);
		const suggestionRows = await allAsync(`SELECT u.id, u.username, u.name, u.profile_picture
			FROM users u
			WHERE u.id <> ?
			AND u.username <> ?
			AND COALESCE(u.privacy_in_suggestions, 'everyone') <> 'nobody'
			AND COALESCE(u.privacy_discoverability, 'everyone') <> 'nobody'
			AND NOT EXISTS (
				SELECT 1 FROM connections c
				WHERE ((c.user_a = ? AND c.user_b = u.id) OR (c.user_a = u.id AND c.user_b = ?))
				AND c.status IN ('pending', 'accepted', 'ignored')
			)
			AND NOT EXISTS (
				SELECT 1 FROM user_blocks b
				WHERE (b.blocker_id = ? AND b.blocked_id = u.id) OR (b.blocker_id = u.id AND b.blocked_id = ?)
			)
			ORDER BY u.username ASC
			LIMIT 40`, [uid, SUPERADMIN_USERNAME, uid, uid, uid, uid]);
		const accepted = acceptedRows.map((r) => {
			const canSee = r.privacy_show_online === 'everyone' || r.privacy_show_online === 'connections';
			return { ...r, online_visible: canSee, online: canSee ? isUserOnline(r.id) : false };
		});
		res.json({
			accepted,
			sent: sentRows,
			received: receivedRows,
			ignored: ignoredRows,
			suggestions: suggestionRows
		});
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

// messages history between current user and otherId
app.get('/api/messages/:otherId', requireAuth, (req, res) => {
	const uid = Number(req.session.userId);
	const other = Number(req.params.otherId);
	if (!uid || !other || uid === other) return res.status(400).json({ error: 'Invalid user' });
	const allowedQ = `SELECT id FROM connections
		WHERE status = 'accepted'
		AND ((user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?))
		LIMIT 1`;
	db.get(allowedQ, [uid, other, other, uid], (allowedErr, allowed) => {
		if (allowedErr) return res.status(500).json({ error: 'Server error' });
		if (!allowed) return res.status(403).json({ error: 'Chat is available only with accepted connections' });
		const q = `SELECT m.*, ua.username as from_username, ua.profile_picture as from_picture, ub.username as to_username FROM messages m LEFT JOIN users ua ON ua.id = m.from_user LEFT JOIN users ub ON ub.id = m.to_user WHERE (m.from_user = ? AND m.to_user = ?) OR (m.from_user = ? AND m.to_user = ?) ORDER BY m.created_at ASC`;
		db.all(q, [uid, other, other, uid], (err, rows) => {
			if (err) return res.status(500).json({ error: 'Server error' });
			res.json({ messages: rows });
		});
	});
});

app.post('/api/messages/:otherId/mark-seen', requireAuth, async (req, res) => {
	const uid = Number(req.session.userId);
	const other = Number(req.params.otherId);
	if (!uid || !other || uid === other) return res.status(400).json({ error: 'Invalid user' });
	try {
		await ensureNotificationsReady();
		const allowed = await getAsync(`SELECT id FROM connections
			WHERE status = 'accepted'
			AND ((user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?))
			LIMIT 1`, [uid, other, other, uid]);
		if (!allowed) return res.status(403).json({ error: 'Chat is available only with accepted connections' });
		const ts = Date.now();
		const updated = await runAsync('UPDATE messages SET seen_at = ? WHERE to_user = ? AND from_user = ? AND seen_at IS NULL', [ts, uid, other]);
		await runAsync(`UPDATE notifications
			SET is_read = 1
			WHERE user_id = ? AND type = 'chat_message' AND actor_id = ? AND is_read = 0`, [uid, other]);
		io.to(`user:${other}`).emit('chatSeen', { by: uid, other, seenAt: ts });
		res.json({ success: true, updated: Number(updated.changes) || 0 });
	} catch (e) {
		console.error('Mark seen error:', e);
		res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/notifications', requireAuth, async (req, res) => {
	const limitRaw = Number(req.query.limit);
	const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(100, limitRaw)) : 40;
	try {
		await ensureNotificationsReady();
		const rows = await allAsync(`SELECT n.id, n.user_id, n.actor_id, n.type, n.title, n.message, n.ref_type, n.ref_id, n.is_read, n.created_at,
			u.username AS actor_username, u.name AS actor_name, u.profile_picture AS actor_picture
			FROM notifications n
			LEFT JOIN users u ON u.id = n.actor_id
			WHERE n.user_id = ?
			ORDER BY n.created_at DESC
			LIMIT ?`, [req.session.userId, limit]);
		res.json({ notifications: rows });
	} catch (e) {
		console.error('Notifications load error:', e);
		res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/notifications/unread-count', requireAuth, async (req, res) => {
	try {
		await ensureNotificationsReady();
		const row = await getAsync('SELECT COUNT(*)::int AS cnt FROM notifications WHERE user_id = ? AND COALESCE(is_read, 0) = 0', [req.session.userId]);
		res.json({ unread: Number(row && row.cnt) || 0 });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/notifications/mark-read', requireAuth, async (req, res) => {
	const id = Number(req.body.id);
	if (!id) return res.status(400).json({ error: 'Invalid notification id' });
	try {
		await ensureNotificationsReady();
		await runAsync('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?', [id, req.session.userId]);
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/notifications/mark-all-read', requireAuth, async (req, res) => {
	try {
		await ensureNotificationsReady();
		await runAsync('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND COALESCE(is_read, 0) = 0', [req.session.userId]);
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/post/:id/comments', (req, res) => {
	const postId = Number(req.params.id);
	if (!postId) return res.status(400).json({ error: 'Invalid post id' });
	const q = `SELECT c.id, c.post_id, c.user_id, c.parent_comment_id, c.mention_user_id, c.content, c.created_at, u.username, u.name, u.profile_picture, mu.username as mention_username
		FROM post_comments c
		JOIN users u ON u.id = c.user_id
		LEFT JOIN users mu ON mu.id = c.mention_user_id
		WHERE c.post_id = ? AND u.username <> '${SUPERADMIN_USERNAME}'
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
		const rows = await allAsync(`SELECT s.id, s.user_id, s.content, s.image, s.created_at, s.expires_at, u.username, u.name, u.profile_picture,
			(SELECT COUNT(*)::int FROM story_likes sl WHERE sl.story_id = s.id) AS likes_count,
			(SELECT COUNT(*)::int FROM story_replies sr WHERE sr.story_id = s.id) AS replies_count,
			(SELECT COUNT(*)::int FROM story_shares ss WHERE ss.story_id = s.id) AS shares_count,
			EXISTS (SELECT 1 FROM story_likes sl2 WHERE sl2.story_id = s.id AND sl2.user_id = ?) AS liked_by_me
			FROM stories s
			JOIN users u ON u.id = s.user_id
			WHERE s.expires_at > ? AND s.user_id IN (${placeholders}) AND u.username <> ?
			ORDER BY s.created_at DESC`, [userId, Date.now(), ...ids, SUPERADMIN_USERNAME]);
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

app.delete('/api/stories/:id', requireAuth, async (req, res) => {
	const storyId = Number(req.params.id);
	const userId = Number(req.session.userId);
	if (!storyId) return res.status(400).json({ error: 'Invalid story id' });
	try {
		const story = await getAsync('SELECT id, user_id FROM stories WHERE id = ?', [storyId]);
		if (!story) return res.status(404).json({ error: 'Story not found' });
		if (Number(story.user_id) !== userId) return res.status(403).json({ error: 'You can delete only your own story' });
		await runAsync('DELETE FROM story_likes WHERE story_id = ?', [storyId]);
		await runAsync('DELETE FROM story_comments WHERE story_id = ?', [storyId]);
		await runAsync('DELETE FROM story_replies WHERE story_id = ?', [storyId]);
		await runAsync('DELETE FROM story_shares WHERE story_id = ?', [storyId]);
		await runAsync('DELETE FROM stories WHERE id = ?', [storyId]);
		return res.json({ success: true });
	} catch (e) {
		console.error('Story delete error:', e);
		return res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/stories/:id/like', requireAuth, async (req, res) => {
	const storyId = Number(req.params.id);
	const userId = Number(req.session.userId);
	if (!storyId) return res.status(400).json({ error: 'Invalid story id' });
	try {
		const story = await getAsync('SELECT id, expires_at FROM stories WHERE id = ?', [storyId]);
		if (!story || Number(story.expires_at) <= Date.now()) return res.status(404).json({ error: 'Story not found' });
		const existing = await getAsync('SELECT id FROM story_likes WHERE story_id = ? AND user_id = ?', [storyId, userId]);
		if (existing) {
			await runAsync('DELETE FROM story_likes WHERE id = ?', [existing.id]);
			const count = await getAsync('SELECT COUNT(*)::int AS cnt FROM story_likes WHERE story_id = ?', [storyId]);
			return res.json({ success: true, liked: false, count: Number(count && count.cnt) || 0 });
		}
		await runAsync('INSERT INTO story_likes (story_id, user_id, created_at) VALUES (?, ?, ?)', [storyId, userId, Date.now()]);
		const count = await getAsync('SELECT COUNT(*)::int AS cnt FROM story_likes WHERE story_id = ?', [storyId]);
		return res.json({ success: true, liked: true, count: Number(count && count.cnt) || 0 });
	} catch (e) {
		console.error('Story like error:', e);
		return res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/stories/:id/reply', requireAuth, async (req, res) => {
	const storyId = Number(req.params.id);
	const userId = Number(req.session.userId);
	const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
	if (!storyId) return res.status(400).json({ error: 'Invalid story id' });
	if (!content) return res.status(400).json({ error: 'Reply is required' });
	if (content.length > 500) return res.status(400).json({ error: 'Reply is too long' });
	try {
		const row = await getAsync('SELECT id, user_id, content, expires_at FROM stories WHERE id = ?', [storyId]);
		if (!row || Number(row.expires_at) <= Date.now()) return res.status(404).json({ error: 'Story not found' });
		const toUserId = Number(row.user_id);
		if (!toUserId) return res.status(400).json({ error: 'Invalid story owner' });
		const ts = Date.now();
		await runAsync('INSERT INTO story_replies (story_id, from_user_id, to_user_id, content, created_at) VALUES (?, ?, ?, ?, ?)', [storyId, userId, toUserId, content, ts]);
		if (toUserId !== userId) {
			const storyTextRaw = typeof row.content === 'string' ? row.content.trim() : '';
			const storySnippet = storyTextRaw ? storyTextRaw.slice(0, 120) : '';
			const storyQuote = storySnippet ? `"${storySnippet}${storyTextRaw.length > 120 ? '...' : ''}"` : `story #${storyId}`;
			const chatMessage = `Story reply on ${storyQuote}\nReply: ${content}`;
			await runAsync('INSERT INTO messages (from_user,to_user,content,created_at) VALUES (?,?,?,?)', [userId, toUserId, chatMessage, ts]);
			await createUserNotification(toUserId, {
				actorId: userId,
				type: 'story_reply',
				title: 'New story reply',
				message: 'You received a reply on your story. Tap to open chat.',
				refType: 'story',
				refId: storyId
			});
			io.to(`user:${toUserId}`).emit('storyReply', { storyId, from: userId, to: toUserId, content, created_at: ts });
		}
		const count = await getAsync('SELECT COUNT(*)::int AS cnt FROM story_replies WHERE story_id = ?', [storyId]);
		return res.json({ success: true, count: Number(count && count.cnt) || 0 });
	} catch (e) {
		console.error('Story reply create error:', e);
		return res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/stories/:id/share', requireAuth, async (req, res) => {
	const storyId = Number(req.params.id);
	const userId = Number(req.session.userId);
	if (!storyId) return res.status(400).json({ error: 'Invalid story id' });
	try {
		const row = await getAsync('SELECT id, expires_at FROM stories WHERE id = ?', [storyId]);
		if (!row || Number(row.expires_at) <= Date.now()) return res.status(404).json({ error: 'Story not found' });
		const connections = await getAcceptedConnectionIds(userId);
		if (!connections.length) return res.status(400).json({ error: 'No accepted connections to share with' });
		const requestedTargets = Array.isArray(req.body.targets) ? req.body.targets.map((v) => Number(v)).filter((v) => !Number.isNaN(v)) : [];
		if (!requestedTargets.length) return res.status(400).json({ error: 'Select at least one connection to share with' });
		const targets = connections.filter((id) => requestedTargets.includes(id));
		if (!targets.length) return res.status(400).json({ error: 'No valid targets selected' });
		const ts = Date.now();
		await runAsync(`INSERT INTO story_shares (story_id, user_id, created_at)
			VALUES (?, ?, ?)
			ON CONFLICT (story_id, user_id) DO NOTHING`, [storyId, userId, ts]);
		for (const toUser of targets) {
			try {
				await runAsync('INSERT INTO messages (from_user,to_user,content,created_at) VALUES (?,?,?,?)', [userId, toUser, `Shared a story (#${storyId})`, ts]);
				await createUserNotification(toUser, {
					actorId: userId,
					type: 'story_shared',
					title: 'Story shared with you',
					message: `A connection shared story #${storyId} with you.`,
					refType: 'story_shared',
					refId: storyId
				});
			} catch (shareErr) {
				console.error('Story share delivery error:', shareErr);
			}
		}
		const count = await getAsync('SELECT COUNT(*)::int AS cnt FROM story_shares WHERE story_id = ?', [storyId]);
		const { shareUrl } = await createShareLink('story', storyId, userId, req);
		return res.json({ success: true, count: Number(count && count.cnt) || 0, sharedTo: targets.length, shareUrl });
	} catch (e) {
		console.error('Story share error:', e);
		return res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/stories/:id/share-link', requireAuth, async (req, res) => {
	const storyId = Number(req.params.id);
	if (!storyId) return res.status(400).json({ error: 'Invalid story id' });
	try {
		const story = await getAsync('SELECT id, expires_at FROM stories WHERE id = ?', [storyId]);
		if (!story || Number(story.expires_at) <= Date.now()) return res.status(404).json({ error: 'Story not found' });
		const link = await createShareLink('story', storyId, Number(req.session.userId), req);
		return res.json({ success: true, token: link.token, shareUrl: link.shareUrl });
	} catch (e) {
		console.error('Story share-link error:', e);
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
	const listNameRaw = typeof req.body.listName === 'string' ? req.body.listName.trim() : '';
	const listName = listNameRaw || 'General';
	if (!postId) return res.status(400).json({ error: 'Invalid post id' });
	if (listName.length > 40) return res.status(400).json({ error: 'List name is too long' });
	try {
		const existing = await getAsync('SELECT id FROM saved_posts WHERE post_id = ? AND user_id = ?', [postId, userId]);
		if (existing) {
			const existingRow = await getAsync('SELECT list_name FROM saved_posts WHERE id = ?', [existing.id]);
			const existingList = String(existingRow && existingRow.list_name ? existingRow.list_name : 'General');
			if (existingList.toLowerCase() === listName.toLowerCase()) {
				await runAsync('DELETE FROM saved_posts WHERE id = ?', [existing.id]);
				const c = await getAsync('SELECT COUNT(*) as cnt FROM saved_posts WHERE post_id = ?', [postId]);
				return res.json({ success: true, saved: false, count: c.cnt || 0, listName: existingList });
			}
			await runAsync('UPDATE saved_posts SET list_name = ? WHERE id = ?', [listName, existing.id]);
			await runAsync(`INSERT INTO saved_post_lists (user_id, name, created_at)
				VALUES (?, ?, ?)
				ON CONFLICT (user_id, name) DO NOTHING`, [userId, listName, Date.now()]);
			const c = await getAsync('SELECT COUNT(*) as cnt FROM saved_posts WHERE post_id = ?', [postId]);
			return res.json({ success: true, saved: true, moved: true, count: c.cnt || 0, listName });
		}
		await runAsync('INSERT INTO saved_posts (post_id, user_id, list_name, created_at) VALUES (?, ?, ?, ?)', [postId, userId, listName, Date.now()]);
		await runAsync(`INSERT INTO saved_post_lists (user_id, name, created_at)
			VALUES (?, ?, ?)
			ON CONFLICT (user_id, name) DO NOTHING`, [userId, listName, Date.now()]);
		await addXp(userId, 'POST_SAVE', 'post', postId);
		const c = await getAsync('SELECT COUNT(*) as cnt FROM saved_posts WHERE post_id = ?', [postId]);
		return res.json({ success: true, saved: true, count: c.cnt || 0, listName });
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
		if (!requestedTargets.length) return res.status(400).json({ error: 'Select at least one connection to share with' });
		const targets = connections.filter((id) => requestedTargets.includes(id));
		if (!targets.length) return res.status(400).json({ error: 'No valid targets selected' });
		const ts = Date.now();
		for (const toUser of targets) {
			try {
				await runAsync('INSERT INTO post_shares (post_id, from_user, to_user, created_at) VALUES (?, ?, ?, ?)', [postId, userId, toUser, ts]);
				await runAsync('INSERT INTO messages (from_user,to_user,content,created_at) VALUES (?,?,?,?)', [userId, toUser, `Shared a post (#${postId})`, ts]);
				await createUserNotification(toUser, {
					actorId: userId,
					type: 'post_shared',
					title: 'Post shared with you',
					message: `A connection shared post #${postId} with you.`,
					refType: 'post',
					refId: postId
				});
				io.to(`user:${toUser}`).emit('postShared', { postId, from: userId, to: toUser });
			} catch (shareErr) {
				// ignore duplicate share for same target
			}
		}
		await addXp(userId, 'POST_SHARE', 'post', postId);
		const c = await getAsync('SELECT COUNT(*) as cnt FROM post_shares WHERE post_id = ?', [postId]);
		const { shareUrl } = await createShareLink('post', postId, userId, req);
		return res.json({ success: true, sharedTo: targets.length, count: c.cnt || 0, shareUrl });
	} catch (e) {
		console.error('Share API error:', e);
		return res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/post/:id/share-link', requireAuth, async (req, res) => {
	const postId = Number(req.params.id);
	if (!postId) return res.status(400).json({ error: 'Invalid post id' });
	try {
		const post = await getAsync('SELECT id FROM posts WHERE id = ?', [postId]);
		if (!post) return res.status(404).json({ error: 'Post not found' });
		const link = await createShareLink('post', postId, Number(req.session.userId), req);
		return res.json({ success: true, token: link.token, shareUrl: link.shareUrl });
	} catch (e) {
		console.error('Post share-link error:', e);
		return res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/share-link/:token', requireAuth, async (req, res) => {
	const token = String(req.params.token || '').trim();
	if (!token) return res.status(400).json({ error: 'Invalid share token' });
	try {
		const resolved = await resolveShareLink(token);
		if (!resolved) return res.status(404).json({ error: 'Share link not found or expired' });
		return res.json({ success: true, itemType: resolved.itemType, itemId: resolved.itemId });
	} catch (e) {
		console.error('Share link resolve error:', e);
		return res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/saved-posts', requireAuth, async (req, res) => {
	try {
		const listName = typeof req.query.list === 'string' ? req.query.list.trim() : '';
		const rows = await allAsync(`SELECT p.id, p.content, p.image, p.quiz_question, p.quiz_options, p.quiz_correct_index, p.reminder_at, p.reminder_note, p.created_at, u.id as user_id, u.username, u.name, u.profile_picture
			FROM saved_posts sp
			JOIN posts p ON p.id = sp.post_id
			JOIN users u ON u.id = p.user_id
			WHERE sp.user_id = ?
			AND u.username <> ?
			AND (? = '' OR sp.list_name = ?)
			ORDER BY sp.created_at DESC`, [req.session.userId, SUPERADMIN_USERNAME, listName, listName]);
		res.json({ posts: rows });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/saved-lists', requireAuth, async (req, res) => {
	try {
		const rows = await allAsync(`SELECT name,
			(SELECT COUNT(*) FROM saved_posts sp WHERE sp.user_id = ? AND sp.list_name = l.name) AS post_count
			FROM saved_post_lists l
			WHERE l.user_id = ?
			UNION
			SELECT 'General' as name,
			(SELECT COUNT(*) FROM saved_posts sp2 WHERE sp2.user_id = ? AND sp2.list_name = 'General') as post_count
			ORDER BY name ASC`, [req.session.userId, req.session.userId, req.session.userId]);
		const dedup = [];
		const seen = new Set();
		for (const r of rows) {
			const key = String(r.name || '');
			if (!key || seen.has(key)) continue;
			seen.add(key);
			dedup.push(r);
		}
		res.json({ lists: dedup });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/saved-lists', requireAuth, async (req, res) => {
	const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
	if (!name) return res.status(400).json({ error: 'List name is required' });
	if (name.length > 40) return res.status(400).json({ error: 'List name is too long' });
	try {
		await runAsync(`INSERT INTO saved_post_lists (user_id, name, created_at)
			VALUES (?, ?, ?)
			ON CONFLICT (user_id, name) DO NOTHING`, [req.session.userId, name, Date.now()]);
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/saved-post/:id/list', requireAuth, async (req, res) => {
	const postId = Number(req.params.id);
	const listName = typeof req.body.listName === 'string' ? req.body.listName.trim() : '';
	if (!postId) return res.status(400).json({ error: 'Invalid post id' });
	if (!listName) return res.status(400).json({ error: 'List name is required' });
	if (listName.length > 40) return res.status(400).json({ error: 'List name is too long' });
	try {
		const updated = await runAsync('UPDATE saved_posts SET list_name = ? WHERE post_id = ? AND user_id = ?', [listName, postId, req.session.userId]);
		if (!updated.changes) return res.status(404).json({ error: 'Saved post not found' });
		await runAsync(`INSERT INTO saved_post_lists (user_id, name, created_at)
			VALUES (?, ?, ?)
			ON CONFLICT (user_id, name) DO NOTHING`, [req.session.userId, listName, Date.now()]);
		res.json({ success: true });
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
		const rows = await allAsync(`SELECT
			u.id, u.username, u.name, u.profile_picture, u.xp, u.level, u.title,
			(SELECT g.id
			 FROM group_memberships gm
			 JOIN groups g ON g.id = gm.group_id
			 WHERE gm.user_id = u.id AND gm.status = 'active'
			 ORDER BY gm.created_at DESC
			 LIMIT 1) AS clan_id,
			(SELECT g.name
			 FROM group_memberships gm
			 JOIN groups g ON g.id = gm.group_id
			 WHERE gm.user_id = u.id AND gm.status = 'active'
			 ORDER BY gm.created_at DESC
			 LIMIT 1) AS clan_name
			FROM users u
			WHERE u.username <> ?
			AND COALESCE(u.email_verified, 0) = 1
			ORDER BY u.xp DESC, u.id ASC
			LIMIT 20`, [SUPERADMIN_USERNAME]);
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
		const activeClan = await getOccupiedClanMembership(req.session.userId);
		if (activeClan) return res.status(409).json({ error: 'Leave or cancel your existing clan membership before creating another.' });
		const ts = Date.now();
		const created = await runAsync('INSERT INTO groups (name, description, is_private, clan_xp, clan_level, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [name, description, isPrivate, 0, 1, req.session.userId, ts]);
		await runAsync('INSERT INTO group_memberships (group_id, user_id, role, status, created_at) VALUES (?, ?, ?, ?, ?)', [created.lastID, req.session.userId, 'admin', 'active', ts]);
		await runAsync(`INSERT INTO group_roles (group_id, name, permissions, is_system, created_by, created_at)
			VALUES (?, ?, ?, ?, ?, ?)`, [created.lastID, 'Officer', JSON.stringify(['manage_posts', 'manage_requests', 'post_messages', 'post_quiz', 'post_reminder', 'post_links', 'access_lounge']), 0, req.session.userId, ts]);
		await addXp(req.session.userId, 'GROUP_CREATE', 'group', created.lastID);
		res.json({ success: true, id: created.lastID });
	} catch (e) {
		console.error('Create group error:', e);
		res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/groups', requireAuth, async (req, res) => {
	try {
		const myGroups = await allAsync(`SELECT g.id, g.name, g.description, g.profile_picture, g.is_private, g.clan_xp, g.clan_level, g.created_by, g.created_at,
			(SELECT COUNT(*) FROM group_memberships gm WHERE gm.group_id = g.id AND gm.status = 'active') as member_count,
			(SELECT role FROM group_memberships gm2 WHERE gm2.group_id = g.id AND gm2.user_id = ?) as my_role,
			(SELECT status FROM group_memberships gm3 WHERE gm3.group_id = g.id AND gm3.user_id = ?) as my_status
			FROM groups g
			WHERE EXISTS (
				SELECT 1 FROM group_memberships mine
				WHERE mine.group_id = g.id AND mine.user_id = ? AND mine.status IN ('active', 'pending')
			)
			ORDER BY g.created_at DESC`, [req.session.userId, req.session.userId, req.session.userId]);
		const suggestions = await allAsync(`SELECT g.id, g.name, g.description, g.profile_picture, g.is_private, g.clan_xp, g.clan_level, g.created_by, g.created_at,
			(SELECT COUNT(*) FROM group_memberships gm WHERE gm.group_id = g.id AND gm.status = 'active') as member_count,
			NULL as my_role,
			NULL as my_status
			FROM groups g
			WHERE g.is_private = 0
			AND NOT EXISTS (
				SELECT 1 FROM group_memberships mine
				WHERE mine.group_id = g.id AND mine.user_id = ?
			)
			ORDER BY g.created_at DESC
			LIMIT 8`, [req.session.userId]);
		const my = myGroups.map((g) => ({ ...g, is_suggested: 0 }));
		const suggested = suggestions.map((g) => ({ ...g, is_suggested: 1 }));
		res.json({ groups: [...my, ...suggested], myGroups: my, suggestions: suggested });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/groups/:id/detail', requireAuth, async (req, res) => {
	const groupId = Number(req.params.id);
	if (!groupId) return res.status(400).json({ error: 'Invalid group id' });
	try {
		const group = await getAsync(`SELECT g.id, g.name, g.description, g.profile_picture, g.is_private, g.clan_xp, g.clan_level, g.created_by, g.created_at,
			(SELECT COUNT(*) FROM group_memberships gm WHERE gm.group_id = g.id AND gm.status = 'active') as member_count,
			(SELECT role FROM group_memberships gm2 WHERE gm2.group_id = g.id AND gm2.user_id = ?) as my_role,
			(SELECT status FROM group_memberships gm3 WHERE gm3.group_id = g.id AND gm3.user_id = ?) as my_status,
			(SELECT custom_role_id FROM group_memberships gm4 WHERE gm4.group_id = g.id AND gm4.user_id = ?) as my_custom_role_id
			FROM groups g WHERE g.id = ?`, [req.session.userId, req.session.userId, req.session.userId, groupId]);
		if (!group) return res.status(404).json({ error: 'Clan not found' });
		const mine = await getGroupMembershipDetails(groupId, req.session.userId);
		const canViewContent = mine && mine.status === 'active';
		const posts = canViewContent
			? await allAsync(`SELECT gp.id, gp.group_id, gp.user_id, gp.content, gp.post_type, gp.image, gp.caption, gp.mentions, gp.quiz_question, gp.quiz_options, gp.quiz_correct_index, gp.reminder_at, gp.reminder_note, gp.link_url, gp.link_label, gp.created_at, u.username, u.name, u.profile_picture
				FROM group_posts gp
				JOIN users u ON u.id = gp.user_id
				WHERE gp.group_id = ? AND u.username <> ?
				ORDER BY gp.created_at DESC
				LIMIT 100`, [groupId, SUPERADMIN_USERNAME])
			: [];
		const members = canViewContent
			? await allAsync(`SELECT gm.user_id as id, gm.role, gm.custom_role_id, gm.status, gm.created_at, u.username, u.name, u.profile_picture, gr.name AS custom_role_name, gr.permissions AS custom_role_permissions
				FROM group_memberships gm
				JOIN users u ON u.id = gm.user_id
				LEFT JOIN group_roles gr ON gr.id = gm.custom_role_id
				WHERE gm.group_id = ? AND gm.status = 'active' AND u.username <> ?
				ORDER BY CASE gm.role WHEN 'admin' THEN 1 WHEN 'moderator' THEN 2 ELSE 3 END, u.username ASC`, [groupId, SUPERADMIN_USERNAME])
			: [];
		const myInvite = canViewContent
			? await getAsync(`SELECT token, max_uses, used_count, expires_at, created_at
				FROM group_invites WHERE group_id = ? ORDER BY created_at DESC LIMIT 1`, [groupId])
			: null;
		res.json({ group, posts, members, canViewContent: Boolean(canViewContent), myPermissions: mine ? mine.permissions : [], invite: myInvite });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/groups/:id/activity', requireAuth, async (req, res) => {
	const groupId = Number(req.params.id);
	if (!groupId) return res.status(400).json({ error: 'Invalid group id' });
	try {
		const mine = await getGroupRole(groupId, req.session.userId);
		if (!mine || mine.status !== 'active') return res.status(403).json({ error: 'Not an active clan member' });
		const postActivity = await allAsync(`SELECT 'post' AS type, gp.created_at, u.username, u.name, gp.content
			FROM group_posts gp JOIN users u ON u.id = gp.user_id
			WHERE gp.group_id = ? AND u.username <> ?
			ORDER BY gp.created_at DESC
			LIMIT 20`, [groupId, SUPERADMIN_USERNAME]);
		const joinActivity = await allAsync(`SELECT CASE WHEN gm.status = 'pending' THEN 'join_request' ELSE 'join' END AS type,
			gm.created_at, u.username, u.name, '' AS content
			FROM group_memberships gm JOIN users u ON u.id = gm.user_id
			WHERE gm.group_id = ? AND u.username <> ?
			ORDER BY gm.created_at DESC
			LIMIT 20`, [groupId, SUPERADMIN_USERNAME]);
		const events = [...postActivity, ...joinActivity]
			.sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))
			.slice(0, 30);
		res.json({ events });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/groups/:id/picture', requireAuth, async (req, res) => {
	const groupId = Number(req.params.id);
	const image = typeof req.body.image === 'string' ? req.body.image : '';
	if (!groupId) return res.status(400).json({ error: 'Invalid group id' });
	if (!image || !image.startsWith('data:image')) return res.status(400).json({ error: 'Invalid image' });
	try {
		const mine = await getGroupRole(groupId, req.session.userId);
		if (!mine || mine.status !== 'active' || !['admin', 'moderator'].includes(mine.role)) return res.status(403).json({ error: 'Admin/moderator access required' });
		await runAsync('UPDATE groups SET profile_picture = ? WHERE id = ?', [image, groupId]);
		res.json({ success: true });
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
		const existing = await getAsync('SELECT status FROM group_memberships WHERE group_id = ? AND user_id = ?', [groupId, req.session.userId]);
		if (existing && existing.status === 'active') return res.json({ success: true, status: 'active' });
		const activeClan = await getOccupiedClanMembership(req.session.userId, groupId);
		if (activeClan) return res.status(409).json({ error: 'You can only be in one clan at a time. Leave your current clan first.' });
		const status = Number(g.is_private) === 1 ? 'pending' : 'active';
		await runAsync(`INSERT INTO group_memberships (group_id, user_id, role, status, created_at)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (group_id, user_id)
			DO UPDATE SET
				role = COALESCE(group_memberships.role, EXCLUDED.role),
				custom_role_id = NULL,
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
		const mine = await getGroupMembershipDetails(groupId, req.session.userId);
		if (!mine || mine.status !== 'active') return res.status(403).json({ error: 'Join this group first' });
		const rows = await allAsync(`SELECT gm.user_id as id, gm.role, gm.custom_role_id, gm.status, u.username, u.name, u.profile_picture, gr.name AS custom_role_name, gr.permissions AS custom_role_permissions
			FROM group_memberships gm
			JOIN users u ON u.id = gm.user_id
			LEFT JOIN group_roles gr ON gr.id = gm.custom_role_id
			WHERE gm.group_id = ? AND u.username <> ?
			ORDER BY CASE gm.role WHEN 'admin' THEN 1 WHEN 'moderator' THEN 2 ELSE 3 END, u.username ASC`, [groupId, SUPERADMIN_USERNAME]);
		res.json({ members: rows });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/groups/:id/requests', requireAuth, async (req, res) => {
	const groupId = Number(req.params.id);
	if (!groupId) return res.status(400).json({ error: 'Invalid group id' });
	try {
		const mine = await getGroupMembershipDetails(groupId, req.session.userId);
		if (!hasGroupPermission(mine, 'manage_requests')) return res.status(403).json({ error: 'Request moderation permission required' });
		const rows = await allAsync(`SELECT gm.user_id as id, u.username, u.name, u.profile_picture, gm.created_at
			FROM group_memberships gm
			JOIN users u ON u.id = gm.user_id
			WHERE gm.group_id = ? AND gm.status = 'pending' AND u.username <> ?
			ORDER BY gm.created_at ASC`, [groupId, SUPERADMIN_USERNAME]);
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
		const mine = await getGroupMembershipDetails(groupId, req.session.userId);
		if (!hasGroupPermission(mine, 'manage_requests')) return res.status(403).json({ error: 'Request moderation permission required' });
		if (action === 'approve') {
			const activeClan = await getOccupiedClanMembership(targetUserId, groupId);
			if (activeClan) return res.status(409).json({ error: 'User already has another clan membership.' });
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
		const mine = await getGroupMembershipDetails(groupId, req.session.userId);
		if (!hasGroupPermission(mine, 'manage_roles')) return res.status(403).json({ error: 'Role management permission required' });
		await runAsync('UPDATE group_memberships SET role = ?, custom_role_id = NULL WHERE group_id = ? AND user_id = ? AND status = ?', [nextRole, groupId, targetUserId, 'active']);
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/groups/:id/member-role', requireAuth, async (req, res) => {
	const groupId = Number(req.params.id);
	const targetUserId = Number(req.body.userId);
	const nextRole = typeof req.body.role === 'string' ? req.body.role.trim() : '';
	const customRoleId = Number(req.body.customRoleId) || null;
	if (!groupId || !targetUserId) return res.status(400).json({ error: 'Invalid request' });
	if (nextRole && !['admin', 'moderator', 'member'].includes(nextRole)) return res.status(400).json({ error: 'Invalid system role' });
	try {
		const mine = await getGroupMembershipDetails(groupId, req.session.userId);
		if (!hasGroupPermission(mine, 'manage_roles')) return res.status(403).json({ error: 'Role management permission required' });
		const target = await getAsync('SELECT user_id, role FROM group_memberships WHERE group_id = ? AND user_id = ? AND status = ?', [groupId, targetUserId, 'active']);
		if (!target) return res.status(404).json({ error: 'Member not found' });
		if (targetUserId === req.session.userId && nextRole && nextRole !== 'admin') return res.status(400).json({ error: 'Use transfer flow to remove your own admin role.' });
		if (customRoleId) {
			const customRole = await getAsync('SELECT id, name FROM group_roles WHERE id = ? AND group_id = ?', [customRoleId, groupId]);
			if (!customRole) return res.status(404).json({ error: 'Custom role not found' });
			await runAsync('UPDATE group_memberships SET role = ?, custom_role_id = ? WHERE group_id = ? AND user_id = ?', ['member', customRoleId, groupId, targetUserId]);
			return res.json({ success: true });
		}
		const effectiveRole = nextRole || 'member';
		await runAsync('UPDATE group_memberships SET role = ?, custom_role_id = NULL WHERE group_id = ? AND user_id = ?', [effectiveRole, groupId, targetUserId]);
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/groups/:id/roles', requireAuth, async (req, res) => {
	const groupId = Number(req.params.id);
	if (!groupId) return res.status(400).json({ error: 'Invalid group id' });
	try {
		const mine = await getGroupMembershipDetails(groupId, req.session.userId);
		if (!mine || mine.status !== 'active') return res.status(403).json({ error: 'Join this clan first' });
		const roles = await allAsync(`SELECT id, name, permissions, is_system, created_by, created_at
			FROM group_roles WHERE group_id = ? ORDER BY is_system DESC, created_at ASC, id ASC`, [groupId]);
		res.json({ roles: roles.map((r) => ({ ...r, permissions: parsePermissionList(r.permissions) })) });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/groups/:id/roles', requireAuth, async (req, res) => {
	const groupId = Number(req.params.id);
	const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
	const permissions = Array.isArray(req.body.permissions) ? req.body.permissions.map((p) => String(p || '').trim()) : [];
	if (!groupId) return res.status(400).json({ error: 'Invalid group id' });
	if (!name) return res.status(400).json({ error: 'Role name is required' });
	if (name.length > 30) return res.status(400).json({ error: 'Role name too long' });
	const normalizedPermissions = permissions.filter((p) => GROUP_PERMISSION_KEYS.includes(p));
	if (!normalizedPermissions.length) return res.status(400).json({ error: 'Select at least one permission' });
	try {
		const mine = await getGroupMembershipDetails(groupId, req.session.userId);
		if (!hasGroupPermission(mine, 'manage_roles')) return res.status(403).json({ error: 'Role management permission required' });
		const created = await runAsync(`INSERT INTO group_roles (group_id, name, permissions, is_system, created_by, created_at)
			VALUES (?, ?, ?, ?, ?, ?)`, [groupId, name, JSON.stringify(normalizedPermissions), 0, req.session.userId, Date.now()]);
		res.json({ success: true, id: created.lastID });
	} catch (e) {
		if (String(e.message || '').toLowerCase().includes('unique')) return res.status(409).json({ error: 'Role name already exists' });
		res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/groups/:id/leave', requireAuth, async (req, res) => {
	const groupId = Number(req.params.id);
	if (!groupId) return res.status(400).json({ error: 'Invalid group id' });
	try {
		const mine = await getGroupMembershipDetails(groupId, req.session.userId);
		if (!mine || !['active', 'pending'].includes(mine.status)) return res.status(400).json({ error: 'You are not a member of this clan' });
		if (mine.status === 'active' && mine.role === 'admin') {
			const otherAdmins = await getAsync(`SELECT COUNT(*)::int AS cnt FROM group_memberships
				WHERE group_id = ? AND status = 'active' AND role = 'admin' AND user_id <> ?`, [groupId, req.session.userId]);
			if (!otherAdmins || Number(otherAdmins.cnt) < 1) {
				return res.status(400).json({ error: 'Add another admin before leaving this clan.' });
			}
		}
		await runAsync('DELETE FROM group_memberships WHERE group_id = ? AND user_id = ?', [groupId, req.session.userId]);
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.delete('/api/groups/:id/member/:userId', requireAuth, async (req, res) => {
	const groupId = Number(req.params.id);
	const targetUserId = Number(req.params.userId);
	if (!groupId || !targetUserId) return res.status(400).json({ error: 'Invalid request' });
	try {
		const mine = await getGroupMembershipDetails(groupId, req.session.userId);
		if (!hasGroupPermission(mine, 'remove_members')) return res.status(403).json({ error: 'Member removal permission required' });
		if (targetUserId === req.session.userId) return res.status(400).json({ error: 'Use Leave Clan for yourself.' });
		const target = await getAsync('SELECT role, status FROM group_memberships WHERE group_id = ? AND user_id = ?', [groupId, targetUserId]);
		if (!target || target.status !== 'active') return res.status(404).json({ error: 'Member not found' });
		if (target.role === 'admin') return res.status(400).json({ error: 'Transfer admin rights first.' });
		await runAsync('DELETE FROM group_memberships WHERE group_id = ? AND user_id = ?', [groupId, targetUserId]);
		res.json({ success: true });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/groups/:id/invite', requireAuth, async (req, res) => {
	const groupId = Number(req.params.id);
	const ttlHours = Math.max(1, Math.min(168, Number(req.body.ttlHours) || 72));
	const maxUses = Math.max(0, Math.min(500, Number(req.body.maxUses) || 0));
	if (!groupId) return res.status(400).json({ error: 'Invalid group id' });
	try {
		const mine = await getGroupMembershipDetails(groupId, req.session.userId);
		if (!hasGroupPermission(mine, 'manage_invites')) return res.status(403).json({ error: 'Invite permission required' });
		const token = createInviteToken();
		const now = Date.now();
		const expiresAt = now + ttlHours * 60 * 60 * 1000;
		await runAsync(`INSERT INTO group_invites (group_id, token, created_by, max_uses, used_count, expires_at, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)`, [groupId, token, req.session.userId, maxUses, 0, expiresAt, now]);
		const inviteUrl = `${getPublicBaseUrl(req)}/clan.html?id=${groupId}&invite=${encodeURIComponent(token)}`;
		res.json({ success: true, token, inviteUrl, expiresAt, maxUses });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/groups/invite/:token/join', requireAuth, async (req, res) => {
	const token = String(req.params.token || '').trim();
	if (!token) return res.status(400).json({ error: 'Invalid invite token' });
	try {
		const invite = await getAsync(`SELECT gi.id, gi.group_id, gi.max_uses, gi.used_count, gi.expires_at, g.is_private
			FROM group_invites gi JOIN groups g ON g.id = gi.group_id
			WHERE gi.token = ?`, [token]);
		if (!invite) return res.status(404).json({ error: 'Invite not found' });
		const now = Date.now();
		if (invite.expires_at && Number(invite.expires_at) < now) return res.status(410).json({ error: 'Invite has expired' });
		if (Number(invite.max_uses) > 0 && Number(invite.used_count) >= Number(invite.max_uses)) return res.status(410).json({ error: 'Invite has reached max uses' });
		const activeClan = await getOccupiedClanMembership(req.session.userId, invite.group_id);
		if (activeClan) return res.status(409).json({ error: 'Leave your current clan before joining a new one.' });
		const status = Number(invite.is_private) === 1 ? 'pending' : 'active';
		await runAsync(`INSERT INTO group_memberships (group_id, user_id, role, custom_role_id, status, created_at)
			VALUES (?, ?, ?, ?, ?, ?)
			ON CONFLICT (group_id, user_id)
			DO UPDATE SET status = EXCLUDED.status, custom_role_id = NULL, created_at = EXCLUDED.created_at`, [invite.group_id, req.session.userId, 'member', null, status, now]);
		await runAsync('UPDATE group_invites SET used_count = COALESCE(used_count, 0) + 1 WHERE id = ?', [invite.id]);
		res.json({ success: true, groupId: invite.group_id, status });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/groups/:id/feed', requireAuth, async (req, res) => {
	const groupId = Number(req.params.id);
	if (!groupId) return res.status(400).json({ error: 'Invalid group id' });
	try {
		const mine = await getGroupMembershipDetails(groupId, req.session.userId);
		if (!mine || mine.status !== 'active') return res.status(403).json({ error: 'Join this group first' });
		const rows = await allAsync(`SELECT gp.id, gp.group_id, gp.user_id, gp.content, gp.post_type, gp.image, gp.caption, gp.mentions, gp.quiz_question, gp.quiz_options, gp.quiz_correct_index, gp.reminder_at, gp.reminder_note, gp.link_url, gp.link_label, gp.created_at, u.username, u.name, u.profile_picture
			FROM group_posts gp
			JOIN users u ON u.id = gp.user_id
			WHERE gp.group_id = ? AND u.username <> ?
			ORDER BY gp.created_at DESC
			LIMIT 50`, [groupId, SUPERADMIN_USERNAME]);
		res.json({ posts: rows });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/groups/:id/post', requireAuth, async (req, res) => {
	const groupId = Number(req.params.id);
	const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
	const postType = typeof req.body.postType === 'string' ? req.body.postType.trim().toLowerCase() : 'message';
	const image = typeof req.body.image === 'string' ? req.body.image : '';
	const caption = typeof req.body.caption === 'string' ? req.body.caption.trim() : '';
	const mentions = Array.isArray(req.body.mentions) ? req.body.mentions.map((m) => String(m || '').trim()).filter(Boolean).slice(0, 15) : [];
	const quizQuestion = typeof req.body.quizQuestion === 'string' ? req.body.quizQuestion.trim() : '';
	const quizOptions = Array.isArray(req.body.quizOptions) ? req.body.quizOptions.map((o) => String(o || '').trim()).filter(Boolean).slice(0, 6) : [];
	const quizCorrectIndex = Number(req.body.quizCorrectIndex);
	const reminderAt = Number(req.body.reminderAt) || null;
	const reminderNote = typeof req.body.reminderNote === 'string' ? req.body.reminderNote.trim() : '';
	const linkUrl = typeof req.body.linkUrl === 'string' ? req.body.linkUrl.trim() : '';
	const linkLabel = typeof req.body.linkLabel === 'string' ? req.body.linkLabel.trim() : '';
	const allowedPostTypes = ['message', 'image', 'quiz', 'reminder', 'link'];
	if (!groupId) return res.status(400).json({ error: 'Invalid group id' });
	if (!allowedPostTypes.includes(postType)) return res.status(400).json({ error: 'Invalid post type' });
	if (!content && postType === 'message') return res.status(400).json({ error: 'Post content is required' });
	if (content.length > 5000) return res.status(400).json({ error: 'Post too long' });
	if (postType === 'image' && !image.startsWith('data:image')) return res.status(400).json({ error: 'Image post requires an image attachment' });
	if (postType === 'quiz') {
		if (!quizQuestion) return res.status(400).json({ error: 'Quiz question is required' });
		if (quizOptions.length < 2) return res.status(400).json({ error: 'At least two quiz options are required' });
		if (Number.isNaN(quizCorrectIndex) || quizCorrectIndex < 0 || quizCorrectIndex >= quizOptions.length) return res.status(400).json({ error: 'Select a valid correct option' });
	}
	if (postType === 'reminder' && !reminderAt) return res.status(400).json({ error: 'Reminder date/time is required' });
	if (postType === 'link') {
		if (!linkUrl) return res.status(400).json({ error: 'Link URL is required' });
		if (!/^https?:\/\//i.test(linkUrl)) return res.status(400).json({ error: 'Link must start with http:// or https://' });
	}
	try {
		const mine = await getGroupMembershipDetails(groupId, req.session.userId);
		if (!mine || mine.status !== 'active') return res.status(403).json({ error: 'Join this group first' });
		const postPermissionMap = {
			message: 'post_messages',
			image: 'post_messages',
			quiz: 'post_quiz',
			reminder: 'post_reminder',
			link: 'post_links'
		};
		const permissionKey = postPermissionMap[postType] || 'post_messages';
		if (!hasGroupPermission(mine, permissionKey)) return res.status(403).json({ error: 'You do not have permission for this post type' });
		const payloadContent = content || caption || linkLabel || reminderNote || quizQuestion;
		const created = await runAsync(`INSERT INTO group_posts
			(group_id, user_id, content, post_type, image, caption, mentions, quiz_question, quiz_options, quiz_correct_index, reminder_at, reminder_note, link_url, link_label, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
			groupId,
			req.session.userId,
			payloadContent,
			postType,
			image || null,
			caption || null,
			mentions.length ? JSON.stringify(mentions) : null,
			quizQuestion || null,
			quizOptions.length ? JSON.stringify(quizOptions) : null,
			Number.isNaN(quizCorrectIndex) ? null : quizCorrectIndex,
			reminderAt,
			reminderNote || null,
			linkUrl || null,
			linkLabel || null,
			Date.now()
		]);
		await runAsync('UPDATE groups SET clan_xp = COALESCE(clan_xp, 0) + 10, clan_level = (FLOOR((COALESCE(clan_xp, 0) + 10) / 5000) + 1) WHERE id = ?', [groupId]);
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
		const mine = await getGroupMembershipDetails(groupId, userId);
		if (!mine || mine.status !== 'active') return res.status(403).json({ error: 'Join this group first' });
		const post = await getAsync('SELECT id, user_id FROM group_posts WHERE id = ? AND group_id = ?', [postId, groupId]);
		if (!post) return res.status(404).json({ error: 'Group post not found' });
		const canModerate = hasGroupPermission(mine, 'manage_posts');
		const isOwner = Number(post.user_id) === userId;
		if (!isOwner && !canModerate) return res.status(403).json({ error: 'Not allowed to delete this group post' });
		await runAsync('DELETE FROM group_posts WHERE id = ?', [postId]);
		return res.json({ success: true });
	} catch (e) {
		console.error('Delete group post API error:', e);
		return res.status(500).json({ error: 'Server error' });
	}
});

app.get('/api/groups/:id/lounge', requireAuth, async (req, res) => {
	const groupId = Number(req.params.id);
	if (!groupId) return res.status(400).json({ error: 'Invalid group id' });
	try {
		const mine = await getGroupMembershipDetails(groupId, req.session.userId);
		if (!hasGroupPermission(mine, 'access_lounge')) return res.status(403).json({ error: 'Lounge access permission required' });
		const messages = await allAsync(`SELECT glm.id, glm.group_id, glm.user_id, glm.content, glm.created_at, u.username, u.name, u.profile_picture
			FROM group_lounge_messages glm
			JOIN users u ON u.id = glm.user_id
			WHERE glm.group_id = ? AND u.username <> ?
			ORDER BY glm.created_at DESC
			LIMIT 80`, [groupId, SUPERADMIN_USERNAME]);
		res.json({ messages: messages.reverse() });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

app.post('/api/groups/:id/lounge', requireAuth, async (req, res) => {
	const groupId = Number(req.params.id);
	const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
	if (!groupId) return res.status(400).json({ error: 'Invalid group id' });
	if (!content) return res.status(400).json({ error: 'Message is required' });
	if (content.length > 1200) return res.status(400).json({ error: 'Message too long' });
	try {
		const mine = await getGroupMembershipDetails(groupId, req.session.userId);
		if (!hasGroupPermission(mine, 'access_lounge')) return res.status(403).json({ error: 'Lounge access permission required' });
		const now = Date.now();
		await runAsync('INSERT INTO group_lounge_messages (group_id, user_id, content, created_at) VALUES (?, ?, ?, ?)', [groupId, req.session.userId, content, now]);
		res.json({ success: true, createdAt: now });
	} catch (e) {
		res.status(500).json({ error: 'Server error' });
	}
});

// search API
app.get('/api/search', (req, res) => {
	const q = req.query.q ? req.query.q.trim() : '';
	if (!q || q.length < 2) return res.json({ results: [] });
	
	const searchTerm = `%${q}%`;
	
	// Search users
	const userQuery = `SELECT id, username, name, profile_picture, 'user' as type
		FROM users
		WHERE (username LIKE ? OR name LIKE ?)
		AND username <> ?
		AND COALESCE(privacy_discoverability, 'everyone') <> 'nobody'
		LIMIT 8`;
	
	// Search posts
	const postQuery = `SELECT p.id, p.content, p.created_at, u.id as user_id, u.username, u.name, u.profile_picture, 'post' as type FROM posts p JOIN users u ON p.user_id = u.id WHERE p.content LIKE ? AND u.username <> ? ORDER BY p.created_at DESC LIMIT 8`;
	
	const allResults = [];
	
	db.all(userQuery, [searchTerm, searchTerm, SUPERADMIN_USERNAME], (err, users) => {
		if (users) allResults.push(...users);
		
		db.all(postQuery, [searchTerm, SUPERADMIN_USERNAME], (err2, posts) => {
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
	if (!req.session.userId) return res.redirect(`/login.html?next=${encodeURIComponent(req.originalUrl || '/dashboard')}`);
	res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/shared/:token', (req, res) => {
	const token = String(req.params.token || '').trim();
	if (!token) return res.redirect('/dashboard');
	return res.redirect(`/dashboard?share=${encodeURIComponent(token)}`);
});

app.get('/admin', requireAdmin, (req, res) => {
	res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/profile', requireAuth, (req, res) => {
	res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

app.get('/clan', requireAuth, (req, res) => {
	res.sendFile(path.join(__dirname, 'public', 'clan.html'));
});

app.get('/verify-email.html', (req, res) => {
	res.sendFile(path.join(__dirname, 'public', 'verify-email.html'));
});

app.get('/user-profile.html', requireAuth, (req, res) => {
	res.sendFile(path.join(__dirname, 'public', 'user-profile.html'));
});

app.use('/api', (req, res) => {
	res.status(404).json({ error: 'API route not found' });
});

app.use((err, req, res, next) => {
	console.error('Unhandled server error:', err && (err.stack || err.message || err));
	if (req && String(req.path || '').startsWith('/api/')) {
		return res.status(500).json({ error: 'Server error' });
	}
	return res.status(500).send('Server error');
});

const http = require('http');
const server = http.createServer(app);
const { Server: IOServer } = require('socket.io');
const io = new IOServer(server);

async function emitPresence(userId, online) {
	try {
		const ids = await getAcceptedConnectionIds(userId);
		ids.forEach((id) => {
			io.to(`user:${id}`).emit('presenceUpdate', { userId: Number(userId), online: Boolean(online) });
		});
	} catch (e) {
		console.error('Presence emit error:', e && (e.message || e));
	}
}

io.on('connection', (socket) => {
	socket.activeChatPeer = 0;

	socket.on('identify', (userId) => {
		socket.userId = userId;
		markUserOnline(userId, socket.id);
		socket.join(`user:${userId}`);
		emitPresence(userId, true);
	});

	socket.on('joinRoom', (room) => {
		socket.join(room);
	});

	socket.on('chatViewing', (payload) => {
		const peerId = Number(payload && payload.peerId);
		socket.activeChatPeer = Number.isFinite(peerId) && peerId > 0 ? peerId : 0;
	});

	socket.on('chatMessage', async (data) => {
		// data: { to, content }
		const from = Number(socket.userId);
		if (!from) return;
		const to = Number(data && data.to);
		const content = typeof data.content === 'string' ? data.content.trim() : '';
		const image = typeof data.image === 'string' ? data.image : '';
		const hasImage = Boolean(image && image.startsWith('data:image'));
		if (!to || to === from) return;
		if (!content && !hasImage) return;
		if (content.length > 2000) return;
		if (hasImage && image.length > 100 * 1024) {
			socket.emit('chatError', { error: 'Image attachment must be 100KB or smaller' });
			return;
		}
		try {
			const allowed = await getAsync(`SELECT id FROM connections
				WHERE status = 'accepted'
				AND ((user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?))
				LIMIT 1`, [from, to, to, from]);
			if (!allowed) {
				socket.emit('chatError', { error: 'Chat is allowed only with accepted connections' });
				return;
			}
		} catch (e) {
			socket.emit('chatError', { error: 'Unable to send message right now' });
			return;
		}
		const created_at = Date.now();
		let seenAt = null;
		for (const s of io.sockets.sockets.values()) {
			if (Number(s.userId) === to && Number(s.activeChatPeer || 0) === from) {
				seenAt = created_at;
				break;
			}
		}
		db.run('INSERT INTO messages (from_user,to_user,content,image,seen_at,created_at) VALUES (?,?,?,?,?,?)', [from, to, content || null, hasImage ? image : null, seenAt, created_at], function (err) {
			if (err) {
				socket.emit('chatError', { error: 'Unable to send message right now' });
				return;
			}
			const msgId = this ? this.lastID : null;
			db.get('SELECT username, profile_picture FROM users WHERE id = ?', [from], (metaErr, sender) => {
				const msg = {
					id: msgId,
					from,
					to,
					content,
					image: hasImage ? image : null,
					seen_at: seenAt,
					created_at,
					from_username: sender && sender.username ? sender.username : null,
					from_picture: sender && sender.profile_picture ? sender.profile_picture : null
				};
				// room is normalized: smallerId:largerId
				const a = Number(from), b = Number(to);
				const room = `chat:${Math.min(a,b)}:${Math.max(a,b)}`;
				io.to(room).emit('message', msg);
				io.to(`user:${to}`).emit('incomingMessage', msg);
				if (seenAt) {
					io.to(`user:${from}`).emit('chatSeen', { by: to, other: from, seenAt });
				} else {
					createUserNotification(to, {
						actorId: from,
						type: 'chat_message',
						title: sender && sender.username ? `Message from ${sender.username}` : 'New message',
						message: content ? content.slice(0, 180) : 'Image message',
						refType: 'chat_user',
						refId: from
					}).catch((notifyErr) => console.error('Chat notification error:', notifyErr));
				}
			});
		});
	});

	socket.on('disconnect', () => {
		if (socket.userId) {
			markUserOffline(socket.userId, socket.id);
			if (!isUserOnline(socket.userId)) emitPresence(socket.userId, false);
		}
	});
});

initializeDatabase()
	.then(async () => {
		await ensureSuperAdmin();
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


