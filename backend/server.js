import express from 'express';
import sql from 'mssql';
import { DefaultAzureCredential } from '@azure/identity';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SQL_CONNECTION_STRING = process.env.SQL_CONNECTION_STRING;

let pool;
let tokenCredential;

async function getPool() {
  if (!pool) {
    if (!SQL_CONNECTION_STRING) {
      throw new Error("SQL_CONNECTION_STRING env var not set");
    }

    // Parse the connection string to extract server and database
    const config = parseConnectionString(SQL_CONNECTION_STRING);
    
    // Initialize credential once
    if (!tokenCredential) {
      tokenCredential = new DefaultAzureCredential();
    }

    // Get token synchronously before creating config
    let token;
    try {
      console.log('Acquiring access token for database...');
      const tokenResponse = await tokenCredential.getToken('https://database.windows.net/.default');
      token = tokenResponse.token;
      console.log('Token acquired successfully');
    } catch (tokenError) {
      console.error('❌ Failed to acquire token:', tokenError);
      throw new Error(`Token acquisition failed: ${tokenError.message}`);
    }

    const dbConfig = {
      server: config.server,
      database: config.database,
      options: {
        encrypt: true,
        trustServerCertificate: false,
        connectTimeout: 60000,
        enableArithAbort: true,
        requestTimeout: 60000
      },
      // Token must be a string, not a function
      authentication: {
        type: 'azure-active-directory-access-token',
        options: {
          token: token // Direct string value
        }
      },
      pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
      }
    };

    try {
      console.log(`Connecting to database: ${config.server}, ${config.database}`);
      pool = await sql.connect(dbConfig);
      
      // Test the connection
      await pool.request().query('SELECT 1 as test');
      console.log('✅ Database connection established with managed identity');
    } catch (err) {
      console.error('❌ Database connection failed:', err);
      
      if (err.code === 'ELOGIN') {
        console.error('Authentication failed. Check:');
        console.error('1. Managed identity permissions in SQL');
        console.error('2. SQL user exists for managed identity');
        console.error('3. Network connectivity to SQL server');
      }
      throw err;
    }
  }
  return pool;
}

function parseConnectionString(connectionString) {
  const params = {};
  
  connectionString.split(';').forEach(param => {
    const [key, ...valueParts] = param.split('=');
    if (key && valueParts.length > 0) {
      const value = valueParts.join('=').trim();
      const normalizedKey = key.trim().toLowerCase();
      
      switch (normalizedKey) {
        case 'server':
        case 'data source':
          let server = value.replace(/^tcp:/i, '');
          const serverParts = server.split(',');
          params.server = serverParts[0];
          if (serverParts.length > 1) {
            params.port = parseInt(serverParts[1]);
          }
          break;
        case 'database':
        case 'initial catalog':
          params.database = value;
          break;
      }
    }
  });

  if (!params.server || !params.database) {
    throw new Error('Connection string must contain Server and Database parameters');
  }

  return params;
}

// Token refresh logic (tokens expire after 1 hour)
async function refreshToken() {
  if (tokenCredential) {
    try {
      console.log('Refreshing database token...');
      const tokenResponse = await tokenCredential.getToken('https://database.windows.net/.default');
      
      // Close existing pool to force reconnection with new token
      if (pool) {
        await pool.close();
        pool = null;
      }
      
      console.log('Token refreshed successfully');
    } catch (error) {
      console.error('Token refresh failed:', error);
    }
  }
}

// Refresh token every 45 minutes to avoid expiration
setInterval(refreshToken, 45 * 60 * 1000);

// Test database connection on startup with retry
async function initializeApp() {
  const maxRetries = 3;
  let retryCount = 0;
  
  while (retryCount < maxRetries) {
    try {
      console.log(`Initializing database connection (attempt ${retryCount + 1})...`);
      await getPool();
      console.log('✅ App initialized successfully');
      return;
    } catch (error) {
      retryCount++;
      console.error(`❌ Initialization attempt ${retryCount} failed:`, error.message);
      
      if (retryCount < maxRetries) {
        console.log(`Retrying in 5 seconds...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      } else {
        console.error('❌ All initialization attempts failed');
        process.exit(1);
      }
    }
  }
}

// Add connection error handling
sql.on('error', err => {
  console.error('SQL Pool error:', err);
  pool = null;
});

// Your existing routes remain the same...
app.get("/api/transactions", async (_req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request()
      .query(`
        SELECT TOP 100 
          Id, 
          TxDate, 
          Category, 
          Note, 
          Amount, 
          CreatedAt,
          CASE WHEN Amount < 0 THEN 'expense' ELSE 'income' END AS Type
        FROM Transactions 
        ORDER BY CreatedAt DESC
      `);
    res.json(result.recordset);
  } catch (err) {
    console.error("GET /api/transactions error:", err);
    if (err.code === 'ELOGIN' || err.code === 'ESOCKET') {
      pool = null;
    }
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

app.post("/api/transactions", async (req, res) => {
  try {
    const { txDate, category, note, amount, type } = req.body;
    if (!txDate || !category || typeof amount !== "number") {
      return res.status(400).json({ error: "txDate, category, amount are required" });
    }

    let finalAmount = -Math.abs(amount);
    if (type === "income") {
      finalAmount = Math.abs(amount);
    }

    const pool = await getPool();
    const result = await pool.request()
      .input("txDate", sql.Date, txDate)
      .input("category", sql.NVarChar(100), category)
      .input("note", sql.NVarChar(400), note || null)
      .input("amount", sql.Decimal(18, 2), finalAmount)
      .query(`
        INSERT INTO Transactions (TxDate, Category, Note, Amount)
        OUTPUT INSERTED.Id, 
               INSERTED.TxDate, 
               INSERTED.Category, 
               INSERTED.Note, 
               INSERTED.Amount, 
               INSERTED.CreatedAt,
               CASE WHEN INSERTED.Amount < 0 THEN 'expense' ELSE 'income' END AS Type
        VALUES (@txDate, @category, @note, @amount);
      `);

    res.status(201).json(result.recordset[0]);
  } catch (err) {
    console.error("POST /api/transactions error:", err);
    if (err.code === 'ELOGIN' || err.code === 'ESOCKET') {
      pool = null;
    }
    res.status(500).json({ error: "Failed to create transaction" });
  }
});

app.get("/api/summary", async (_req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT
        SUM(CASE WHEN Amount > 0 THEN Amount ELSE 0 END) AS totalIncome,
        SUM(CASE WHEN Amount < 0 THEN -Amount ELSE 0 END) as totalExpense,
        SUM(Amount) AS balance
      FROM Transactions;
    `);
    res.json(result.recordset[0] || { totalIncome: 0, totalExpense: 0, balance: 0 });
  } catch (err) {
    console.error("GET /api/summary error:", err);
    if (err.code === 'ELOGIN' || err.code === 'ESOCKET') {
      pool = null;
    }
    res.status(500).json({ error: "Failed to compute summary" });
  }
});

app.get("/health", async (_req, res) => {
  try {
    const pool = await getPool();
    await pool.request().query('SELECT 1 as health');
    res.json({ status: "OK", database: "connected" });
  } catch (err) {
    res.status(500).json({ status: "ERROR", database: "disconnected", error: err.message });
  }
});

// Debug endpoint to check authentication
app.get("/debug/auth", async (_req, res) => {
  try {
    if (!tokenCredential) {
      tokenCredential = new DefaultAzureCredential();
    }
    const token = await tokenCredential.getToken('https://database.windows.net/.default');
    
    res.json({
      tokenAvailable: !!token,
      tokenLength: token?.token?.length,
      expiresOn: token?.expiresOnTimestamp,
      managedIdentity: true
    });
  } catch (error) {
    res.status(500).json({ 
      error: "Failed to get token", 
      message: error.message 
    });
  }
});

// Initialize app
initializeApp().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ Finance backend listening on ${PORT}`);
  });
});