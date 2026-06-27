const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──
app.use(cors({
  credentials: true,
  origin: true // Allows all origins with credentials
}));
app.use(express.json());
app.use(cookieParser());

// ── PostgreSQL connection ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ── Helper: get client IP ──
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() ||
         req.connection?.remoteAddress ||
         req.socket?.remoteAddress ||
         'unknown';
}

// ── Helper: check if IP is blocked ──
async function isIpBlocked(ip) {
  const result = await pool.query('SELECT blocked_at FROM blocks WHERE ip = $1', [ip]);
  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  const now = Date.now();
  const expiry = row.blocked_at + 24 * 60 * 60 * 1000; // 24 hours in milliseconds
  
  if (now < expiry) {
    let remainingMs = expiry - now;
    // ── Safety cap: never return more than 24 hours ──
    const maxMs = 24 * 60 * 60 * 1000;
    if (remainingMs > maxMs) remainingMs = maxMs;
    return { blocked: true, remainingMs };
  } else {
    // Block expired – clean up
    await pool.query('DELETE FROM blocks WHERE ip = $1', [ip]);
    return null;
  }
}

// ── Initialize tables (with edit_token column added) ──
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS links (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      description TEXT NOT NULL,
      timestamp BIGINT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS blocks (
      ip TEXT PRIMARY KEY,
      blocked_at BIGINT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS referrals (
      id TEXT PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      reward_url TEXT NOT NULL,
      reward_description TEXT NOT NULL,
      click_count INTEGER DEFAULT 0,
      created_at BIGINT NOT NULL,
      last_posted_at BIGINT,
      edit_token TEXT UNIQUE
    )
  `);
  // Ensure edit_token column exists (in case table was created earlier)
  await pool.query(`
    ALTER TABLE referrals ADD COLUMN IF NOT EXISTS edit_token TEXT UNIQUE
  `).catch(() => {});
  console.log('✅ Database tables ready');
}
initDb().catch(err => console.error('DB init error:', err));

// ── Root route – redirect to frontend ──
app.get('/', (req, res) => {
  res.redirect('https://link-share-frontend.onrender.com');
});

// ── API: Get latest 10 links ──
app.get('/api/links', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM links ORDER BY timestamp DESC LIMIT 10'
    );
    res.json({ success: true, links: result.rows || [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── API: Check block status ──
app.get('/api/block-status', async (req, res) => {
  try {
    const ip = getClientIp(req);
    const block = await isIpBlocked(ip);
    if (block) {
      res.json({ 
        blocked: true, 
        remainingSeconds: Math.floor(block.remainingMs / 1000) 
      });
    } else {
      res.json({ blocked: false, remainingSeconds: 0 });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── API: Submit a new link (with IP block) ──
app.post('/api/links', async (req, res) => {
  const { url, description } = req.body;
  if (!url || !description) {
    return res.status(400).json({ error: 'URL and description are required' });
  }
  try { new URL(url); } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const ip = getClientIp(req);
  try {
    const block = await isIpBlocked(ip);
    if (block) {
      return res.status(403).json({ 
        error: 'blocked', 
        remainingSeconds: Math.floor(block.remainingMs / 1000) 
      });
    }

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const timestamp = Date.now();
    await pool.query(
      'INSERT INTO links (id, url, description, timestamp) VALUES ($1, $2, $3, $4)',
      [id, url, description, timestamp]
    );

    await pool.query(
      'INSERT INTO blocks (ip, blocked_at) VALUES ($1, $2) ON CONFLICT (ip) DO UPDATE SET blocked_at = EXCLUDED.blocked_at',
      [ip, timestamp]
    );

    res.json({ success: true, link: { id, url, description, timestamp } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── REFERRAL: Create a new referral campaign ──
app.post('/api/referrals', async (req, res) => {
  const { rewardUrl, rewardDescription } = req.body;
  if (!rewardUrl || !rewardDescription) {
    return res.status(400).json({ error: 'Both fields are required' });
  }
  try { new URL(rewardUrl); } catch {
    return res.status(400).json({ error: 'Invalid reward URL' });
  }

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const slug = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  const createdAt = Date.now();
  const editToken = crypto.randomBytes(16).toString('hex');

  try {
    await pool.query(
      `INSERT INTO referrals (id, slug, reward_url, reward_description, created_at, edit_token)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, slug, rewardUrl, rewardDescription, createdAt, editToken]
    );
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({
      success: true,
      referral: {
        id,
        slug,
        rewardUrl,
        rewardDescription,
        referralLink: `${baseUrl}/ref/${slug}`,
        clickCount: 0,
        editToken,
        editLink: `${req.protocol}://link-share-frontend.onrender.com/?edit=${editToken}`
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── REFERRAL: Get stats for a referral ──
app.get('/api/referrals/:slug', async (req, res) => {
  const { slug } = req.params;
  try {
    const result = await pool.query(
      'SELECT click_count, reward_url, reward_description FROM referrals WHERE slug = $1',
      [slug]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Referral not found' });
    }
    res.json({ success: true, stats: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── REFERRAL: Visit a referral link (sets a cookie, does NOT count as a click) ──
app.get('/ref/:slug', async (req, res) => {
  const { slug } = req.params;

  try {
    const result = await pool.query(
      'SELECT id FROM referrals WHERE slug = $1',
      [slug]
    );
    if (result.rows.length === 0) {
      return res.status(404).send('Referral not found');
    }

    // Set a cookie that expires in 24 hours
    res.cookie('ref_slug', slug, { 
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      httpOnly: true,
      path: '/',
      sameSite: 'lax'
    });

    // Redirect to the homepage
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// ── REFERRAL: Track a click on a link/sponsor (triggered by frontend) ──
app.post('/api/ref-click', async (req, res) => {
  const slug = req.cookies.ref_slug;
  if (!slug) {
    return res.json({ success: false, message: 'No referral cookie' });
  }

  try {
    // Get the referral
    const result = await pool.query(
      'SELECT id, click_count, reward_url, reward_description FROM referrals WHERE slug = $1',
      [slug]
    );
    if (result.rows.length === 0) {
      return res.json({ success: false, message: 'Referral not found' });
    }

    const ref = result.rows[0];
    const newCount = ref.click_count + 1;

    // Update the click count
    await pool.query(
      'UPDATE referrals SET click_count = $1 WHERE id = $2',
      [newCount, ref.id]
    );

    let posted = false;
    let postedLink = null;

    // If we reached 50 clicks, post the reward and reset
    if (newCount >= 50) {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      const timestamp = Date.now();

      await pool.query(
        'INSERT INTO links (id, url, description, timestamp) VALUES ($1, $2, $3, $4)',
        [id, ref.reward_url, ref.reward_description, timestamp]
      );

      // Reset the counter to 0
      await pool.query(
        'UPDATE referrals SET click_count = 0, last_posted_at = $1 WHERE id = $2',
        [timestamp, ref.id]
      );

      posted = true;
      postedLink = { id, url: ref.reward_url, description: ref.reward_description, timestamp };
      console.log(`🎉 Reward posted for referral ${slug} at action #${newCount}`);
    }

    res.json({ success: true, posted, postedLink });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ── REFERRAL: Load referral data via edit token (GET) ──
app.get('/edit/:token', async (req, res) => {
  const { token } = req.params;
  try {
    const result = await pool.query(
      'SELECT id, reward_url, reward_description, slug FROM referrals WHERE edit_token = $1',
      [token]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid edit token' });
    }
    res.json({ success: true, referral: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── REFERRAL: Update referral data via edit token (PUT) ──
app.put('/api/referrals/:token', async (req, res) => {
  const { token } = req.params;
  const { rewardUrl, rewardDescription } = req.body;
  if (!rewardUrl || !rewardDescription) {
    return res.status(400).json({ error: 'Both fields are required' });
  }
  try { new URL(rewardUrl); } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const result = await pool.query(
      `UPDATE referrals 
       SET reward_url = $1, reward_description = $2 
       WHERE edit_token = $3 
       RETURNING id, slug, reward_url, reward_description`,
      [rewardUrl, rewardDescription, token]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid edit token' });
    }
    res.json({ success: true, referral: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
