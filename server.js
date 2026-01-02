import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

// 🔑 Pi Server API Key من Environment Variable فقط (أمان عالي)
const PI_API_KEY = process.env.PI_API_KEY;

if (!PI_API_KEY) {
  console.error("❌ PI_API_KEY is missing! Add it in Render Environment Variables.");
  process.exit(1);
}

// Rate limiting بسيط لمنع الـ abuse (حد أقصى 100 طلب في 15 دقيقة من IP واحد)
const rateLimit = new Map();
app.use((req, res, next) => {
  const ip = req.ip;
  const now = Date.now();
  const window = 15 * 60 * 1000; // 15 دقيقة
  const limit = 100;

  if (!rateLimit.has(ip)) rateLimit.set(ip, []);
  const requests = rateLimit.get(ip).filter(t => now - t < window);
  rateLimit.set(ip, [...requests, now]);

  if (requests.length >= limit) {
    return res.status(429).json({ error: "Too many requests. Try again later." });
  }
  next();
});

// Route اختبار
app.get("/", (req, res) => {
  res.send("Pi-backend is running securely ✅");
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
          Authorization: `Key ${PI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      console.error("Approve failed:", errorData);
      throw new Error(JSON.stringify(errorData));
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Approve error:", err.message);
    res.status(500).json({ error: "Server error during approval" });
  }
});

// ================== COMPLETE PAYMENT ==================
app.post("/complete-payment", async (req, res) => {
  const { paymentId, txid } = req.body;

  if (!paymentId || !txid) {
    return res.status(400).json({ error: "paymentId or txid missing" });
  }

  try {
    const response = await fetch(
      `https://api.minepi.com/v2/payments/${paymentId}/complete`,
      {
        method: "POST",
        headers: {
          Authorization: `Key ${PI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ txid })
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      console.error("Complete failed:", errorData);
      throw new Error(JSON.stringify(errorData));
    }

    const data = await response.json();
    res.json({ success: true, data });
  } catch (err) {
    console.error("Complete error:", err.message);
    res.status(500).json({ error: "Server error during completion" });
  }
});

// ================== START SERVER ==================
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Secure server running on port ${port}`);
});
