import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import admin from "firebase-admin";
import fs from "fs";

const app = express();
app.use(cors());
app.use(express.json());

/* ================= PI API ================= */
const PI_API_KEY = "PUT_YOUR_PI_SERVER_API_KEY_HERE";

/* ================= FIREBASE ADMIN ================= */
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(fs.readFileSync("./serviceAccountKey.json"))
  )
});
const db = admin.firestore();

/* ================= TEST ================= */
app.get("/", (req, res) => {
  res.send("Backend running securely ✅");
});

/* ================= APPROVE ================= */
app.post("/approve-payment", async (req, res) => {
  const { paymentId } = req.body;

  try {
    await fetch(
      `https://api.minepi.com/v2/payments/${paymentId}/approve`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "approve failed" });
  }
});

/* ================= COMPLETE ================= */
app.post("/complete-payment", async (req, res) => {
  const { paymentId, txid } = req.body;

  try {
    // 1️⃣ complete payment in Pi
    const r = await fetch(
      `https://api.minepi.com/v2/payments/${paymentId}/complete`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const payment = await r.json();
    const { metadata, user_uid } = payment;

    // 2️⃣ سجل الشراء
    await db
      .collection("purchases")
      .doc(user_uid)
      .collection("books")
      .doc(metadata.bookId)
      .set({
        paymentId,
        txid,
        createdAt: Date.now()
      });

    // 3️⃣ أرجع نجاح
    res.json({ success: true });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "completion failed" });
  }
});

/* ================= START ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on", PORT);
});
