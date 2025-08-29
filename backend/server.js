import express from "express";
import sql from "mssql";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SQL_CONNECTION = process.env.SQL_CONNECTION;

// Connection pool (reused across requests)
let poolPromise;
async function getPool() {
  if (!poolPromise) {
    if (!SQL_CONNECTION) {
      throw new Error("SQL_CONNECTION env var not set.");
    }
    poolPromise = sql.connect(SQL_CONNECTION);
  }
  return poolPromise;
}

/**
 * Schema (see sql/01_schema.sql):
 * Transactions(
 *   Id INT IDENTITY PRIMARY KEY,
 *   TxDate DATE NOT NULL,
 *   Category NVARCHAR(100) NOT NULL,
 *   Note NVARCHAR(400) NULL,
 *   Amount DECIMAL(18,2) NOT NULL, -- positive for income, negative for expense
 *   CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
 * )
 */

// List transactions (latest first)
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
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

// Create a transaction
app.post("/api/transactions", async (req, res) => {
  try {
    const { txDate, category, note, amount, type } = req.body;

    // Basic validation
    if (!txDate || !category || typeof amount !== "number") {
      return res.status(400).json({ error: "txDate, category, amount are required" });
    }

    // By default treat as expense → store negative
    let finalAmount = -Math.abs(amount);

    // If explicitly marked income, store as positive
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
    res.status(500).json({ error: "Failed to create transaction" });
  }
});

// Summary (income, expense, balance)
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
    res.status(500).json({ error: "Failed to compute summary" });
  }
});

// Liveness
app.get("/health", (_req, res) => res.send("OK"));

app.listen(PORT, () => {
  console.log(`✅ Finance backend listening on ${PORT}`);
});
