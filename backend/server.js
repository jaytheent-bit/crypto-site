require('dotenv').config();
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const passport = require('passport');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Test database connection
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Error connecting to database:', err.stack);
  } else {
    console.log('✅ Database connected successfully');
    release();
  }
});

// Database schema initialization function
async function initializeDatabase() {
  try {
    // Check if tables exist
    const result = await pool.query(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables 
        WHERE table_name = 'users'
      )`
    );

    if (result.rows[0].exists) {
      console.log('✅ Database schema already initialized');
      return;
    }

    console.log('📊 Initializing database schema...');
    const schemaPath = path.join(__dirname, 'schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');
    
    // Execute the entire schema as one query to properly handle multi-line
    // PL/pgSQL blocks (functions/triggers) which contain semicolons
    await pool.query(schema);
    
    console.log('✅ Database schema initialized successfully');
  } catch (error) {
    console.error('❌ Error initializing database schema:', error.message);
    console.log('⚠️  Continuing startup - you may need to run: psql -d fynor_clone -f backend/schema.sql');
  }
}

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL,
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}));
app.use(passport.initialize());
app.use(passport.session());

// Passport Google OAuth Strategy (register only if env vars provided)
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_CALLBACK_URL) {
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: process.env.GOOGLE_CALLBACK_URL
  },
    async (accessToken, refreshToken, profile, done) => {
      try {
        // Check if user exists
        let result = await pool.query(
          'SELECT * FROM users WHERE google_id = $1',
          [profile.id]
        );

        if (result.rows.length === 0) {
          // Create new user
          result = await pool.query(
            `INSERT INTO users (email, google_id, full_name, avatar_url) 
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [
              profile.emails[0].value,
              profile.id,
              profile.displayName,
              profile.photos[0]?.value
            ]
          );

          // Create initial wallets for new user
          const userId = result.rows[0].id;
          await pool.query(
            `INSERT INTO wallets (user_id, currency, balance) 
             VALUES ($1, 'BTC', 0), ($1, 'ETH', 0), ($1, 'USDT', 1000)`,
            [userId]
          );
        }

        return done(null, result.rows[0]);
      } catch (error) {
        return done(error, null);
      }
    }
  ));
} else {
  console.log('⚠️ Google OAuth not fully configured; skipping GoogleStrategy registration');
}

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id, done) => {
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    done(null, result.rows[0]);
  } catch (error) {
    done(error, null);
  }
});

// Auth middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};

// Normalize symbol helper: accept formats like "BTC/USDT", "BTC-USDT", or "BTC_USDT"
function normalizeSymbolParam(raw) {
  if (!raw) return raw;
  if (raw.includes('/')) return raw;
  // Convert common separators to canonical forward-slash format
  return raw.replace(/[-_]/g, '/');
}

// ==================== AUTH ROUTES ====================

// Google OAuth
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login' }),
  (req, res) => {
    // Generate JWT token
    const token = jwt.sign(
      { id: req.user.id, email: req.user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    // Redirect to frontend with token
    res.redirect(`${process.env.FRONTEND_URL}?token=${token}`);
  }
);

// Regular login
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];

    if (!user.password) {
      return res.status(401).json({ error: 'Please use Google Sign In' });
    }

    const validPassword = await bcrypt.compare(password, user.password);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        avatar_url: user.avatar_url
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Register
app.post('/auth/register', async (req, res) => {
  let client;
  try {
    const { email, password, full_name } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    client = await pool.connect();

    await client.query('BEGIN');

    // Check if user exists
    const existing = await client.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    if (existing.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'User already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const result = await client.query(
      `INSERT INTO users (email, password, full_name) 
       VALUES ($1, $2, $3) RETURNING id, email, full_name`,
      [email, hashedPassword, full_name || email.split('@')[0]]
    );

    const user = result.rows[0];

    // Create initial wallets
    await client.query(
      `INSERT INTO wallets (user_id, currency, balance) 
       VALUES ($1, 'BTC', 0), ($1, 'ETH', 0), ($1, 'USDT', 1000)`,
      [user.id]
    );

    await client.query('COMMIT');

    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    res.status(201).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name
      }
    });
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('Register error details:', {
      message: error.message,
      stack: error.stack,
      detail: error.detail,
      code: error.code
    });
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    if (client) client.release();
  }
});

// Get current user
app.get('/auth/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, full_name, avatar_url FROM users WHERE id = $1',
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== MARKET ROUTES ====================

// Get all trading pairs
app.get('/market/pairs', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM trading_pairs WHERE is_active = true ORDER BY volume_24h DESC`
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Get pairs error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get ticker for specific pair
app.get('/market/ticker/:symbol', async (req, res) => {
  try {
    const rawSymbol = req.params.symbol;
    const symbol = normalizeSymbolParam(rawSymbol);
    const result = await pool.query(
      'SELECT * FROM trading_pairs WHERE symbol = $1',
      [symbol]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Trading pair not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get ticker error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get recent trades
app.get('/market/trades/:symbol', async (req, res) => {
  try {
    const rawSymbol = req.params.symbol;
    const symbol = normalizeSymbolParam(rawSymbol);
    const limit = req.query.limit || 50;

    const result = await pool.query(
      `SELECT * FROM trades WHERE symbol = $1 
       ORDER BY created_at DESC LIMIT $2`,
      [symbol, limit]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Get trades error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== WALLET ROUTES ====================

// Get user wallets
app.get('/wallet/balances', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM wallets WHERE user_id = $1',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Get balances error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get transactions
app.get('/wallet/transactions', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM transactions WHERE user_id = $1 
       ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== TRADING ROUTES ====================

// Place order
app.post('/trading/order', authenticateToken, async (req, res) => {
  const client = await pool.connect();

  try {
    const { side, type, price, quantity } = req.body;
    const rawSymbol = req.body.symbol;
    const symbol = normalizeSymbolParam(rawSymbol);

    await client.query('BEGIN');

    // Validate trading pair
    const pairResult = await client.query(
      'SELECT * FROM trading_pairs WHERE symbol = $1 AND is_active = true',
      [symbol]
    );

    if (pairResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid trading pair' });
    }

    const pair = pairResult.rows[0];

    // Check user balance
    const currency = side === 'BUY' ? pair.quote_asset : pair.base_asset;
    const requiredAmount = side === 'BUY'
      ? parseFloat(price) * parseFloat(quantity)
      : parseFloat(quantity);

    const walletResult = await client.query(
      'SELECT * FROM wallets WHERE user_id = $1 AND currency = $2',
      [req.user.id, currency]
    );

    if (walletResult.rows.length === 0 ||
      parseFloat(walletResult.rows[0].balance) < requiredAmount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Create order
    const orderResult = await client.query(
      `INSERT INTO orders (user_id, symbol, side, type, price, quantity, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'OPEN') RETURNING *`,
      [req.user.id, symbol, side, type, price, quantity]
    );

    // Lock balance
    await client.query(
      `UPDATE wallets 
       SET balance = balance - $1, locked_balance = locked_balance + $1
       WHERE user_id = $2 AND currency = $3`,
      [requiredAmount, req.user.id, currency]
    );

    await client.query('COMMIT');

    res.status(201).json(orderResult.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Place order error:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// Get user orders
app.get('/trading/orders', authenticateToken, async (req, res) => {
  try {
    const status = req.query.status || 'OPEN';
    const result = await pool.query(
      `SELECT * FROM orders WHERE user_id = $1 AND status = $2 
       ORDER BY created_at DESC LIMIT 50`,
      [req.user.id, status]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Get orders error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Cancel order
app.delete('/trading/order/:id', authenticateToken, async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    await client.query('BEGIN');

    const orderResult = await client.query(
      'SELECT * FROM orders WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (orderResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];

    if (order.status !== 'OPEN' && order.status !== 'PARTIAL') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot cancel this order' });
    }

    // Update order status
    await client.query(
      'UPDATE orders SET status = $1 WHERE id = $2',
      ['CANCELLED', id]
    );

    // Release locked balance
    const pairResult = await client.query(
      'SELECT * FROM trading_pairs WHERE symbol = $1',
      [order.symbol]
    );
    const pair = pairResult.rows[0];
    const currency = order.side === 'BUY' ? pair.quote_asset : pair.base_asset;
    const remaining = parseFloat(order.quantity) - parseFloat(order.filled);
    const amount = order.side === 'BUY'
      ? parseFloat(order.price) * remaining
      : remaining;

    await client.query(
      `UPDATE wallets 
       SET balance = balance + $1, locked_balance = locked_balance - $1
       WHERE user_id = $2 AND currency = $3`,
      [amount, req.user.id, currency]
    );

    await client.query('COMMIT');

    res.json({ message: 'Order cancelled successfully' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Cancel order error:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

// ==================== HEALTH CHECK ====================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
async function startServer() {
  try {
    await initializeDatabase();
    const server = app.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
    return server;
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer().then((server) => {
  // WebSocket server for real-time updates
  const wss = new WebSocket.Server({ server });

  wss.on('connection', (ws) => {
    console.log('📡 New WebSocket connection');

    ws.on('message', (message) => {
      console.log('Received:', message.toString());
    });

    // Send market updates every 2 seconds
    const interval = setInterval(async () => {
      try {
        const result = await pool.query('SELECT * FROM trading_pairs WHERE is_active = true');
        ws.send(JSON.stringify({
          type: 'MARKET_UPDATE',
          data: result.rows
        }));
      } catch (error) {
        console.error('WebSocket error:', error);
      }
    }, 2000);

    ws.on('close', () => {
      clearInterval(interval);
      console.log('📡 WebSocket connection closed');
    });
  });

}).catch((err) => {
  console.error('❌ Error during server startup:', err);
  process.exit(1);
});

app.use(express.static(path.join(__dirname, '../frontend')));

// Handle SPA routing - redirect all other requests to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

module.exports = app;
