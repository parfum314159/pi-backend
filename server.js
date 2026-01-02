import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json());

/* ================= PI API ================= */
// هذا المفتاح نضعه في Render Environment Variables
const PI_API_KEY = process.env.PI_API_KEY;

/* ================= FIREBASE ADMIN ================= */
// هذا أيضًا نضعه في Render Environment Variables
const serviceAccount = JSON.parse(
  process.env.FIREBASE_SERVICE_ACCOUNT
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

/* ================= TEST ================= */
app.get("/", (req, res) => {
  res.send("Backend running securely ✅");
});

/* ================= APPROVE PAYMENT ================= */
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
    console.error("Approve error:", e);
    res.status(500).json({ error: "approve failed" });
  }
});

/* ================= COMPLETE PAYMENT ================= */
app.post("/complete-payment", async (req, res) => {
  const { paymentId, txid } = req.body;

  try {
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

    const userUid = payment.user_uid;
    const bookId = payment.metadata.bookId;

    // تسجيل الشراء بأمان
    await db
      .collection("purchases")
      .doc(userUid)
      .collection("books")
      .doc(bookId)
      .set({
        paymentId,
        txid,
        createdAt: Date.now()
      });

    res.json({ success: true });

  } catch (e) {
    console.error("Complete error:", e);
    res.status(500).json({ error: "completion failed" });
  }
});

/* ================= START ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
