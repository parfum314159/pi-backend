import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// 🔑 Pi Server API Key من Environment Variable
const PI_API_KEY = process.env.PI_API_KEY;

// حماية إضافية
if (!PI_API_KEY) {
  console.error("❌ PI_API_KEY is missing");
  process.exit(1);
}

// Route اختبار
app.get("/", (req, res) => {
  res.send("Pi-backend is running ✅");
});

// ================== APPROVE PAYMENT ==================
app.post("/approve-payment", async (req, res) => {
  const { paymentId } = req.body;

  if (!paymentId) {
    return res.status(400).json({ error: "paymentId missing" });
  }

  try {
    const response = await fetch(
      `https://api.minepi.com/v2/payments/${paymentId}/approve`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Approve error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================== COMPLETE PAYMENT ==================
app.post("/complete-payment", async (req, res) => {
  const { paymentId } = req.body;

  if (!paymentId) {
    return res.status(400).json({ error: "paymentId missing" });
  }

  try {
    const response = await fetch(
      `https://api.minepi.com/v2/payments/${paymentId}/complete`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Complete error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================== START SERVER ==================
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port", port);
});
