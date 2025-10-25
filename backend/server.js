import express from 'express';
import sql from 'mssql';

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SQL_CONNECTION_STRING = process.env.SQL_CONNECTION_STRING;

let pool;

async function getPool() {
  if (!pool) {
    if (!SQL_CONNECTION_STRING) {
      throw new Error("SQL_CONNECTION_STRING env var not set");
    }

    try {
      console.log('Establishing database connection...');
      pool = await sql.connect(SQL_CONNECTION_STRING);
      console.log('✅ Database connection established');
    } catch (err) {
      console.error('❌ Database connection failed:', err);
      throw err;
    }
  }
  return pool;
}

// Test database connection on startup
async function initializeApp() {
  try {
    await getPool();
    console.log('✅ App initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize app:', error);
    process.exit(1);
  }
}

// Your existing routes remain exactly the same...
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
        SUM(CASE WHEN Amount < 0 THEN -Amount ELSE 0 END) AS totalExpense,
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
    res.status(500).json({ status: "ERROR", database: "disconnected" });
  }
});

// Initialize app
initializeApp().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ Finance backend listening on ${PORT}`);
  });
});