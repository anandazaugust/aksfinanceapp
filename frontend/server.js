import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import fetch from "node-fetch";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// IMPORTANT: only the frontend knows the backend URL.
// The browser never calls backend directly.
const BACKEND_URL = process.env.BACKEND_URL || "http://backend:3000";

app.use(express.json());
app.use(express.static(__dirname)); // serve index.html & style.css

// Proxy: list transactions
app.get("/api/transactions", async (_req, res) => {
  try {
    const r = await fetch(`${BACKEND_URL}/api/transactions`);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    console.error("Proxy GET /api/transactions:", e);
    res.status(502).json({ error: "Proxy failed to reach backend" });
  }
});

// Proxy: create transaction
app.post("/api/transactions", async (req, res) => {
  try {
    const r = await fetch(`${BACKEND_URL}/api/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body)
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    console.error("Proxy POST /api/transactions:", e);
    res.status(502).json({ error: "Proxy failed to reach backend" });
  }
});

// Proxy: summary
app.get("/api/summary", async (_req, res) => {
  try {
    const r = await fetch(`${BACKEND_URL}/api/summary`);
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    console.error("Proxy GET /api/summary:", e);
    res.status(502).json({ error: "Proxy failed to reach backend" });
  }
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`🚀 Finance frontend listening on ${PORT}`);
});
