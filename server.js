import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json());

/* ================= ENV ================= */
const PI_API_KEY = process.env.PI_API_KEY;
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!PI_API_KEY) {
  console.error("❌ PI_API_KEY is missing");
  process.exit(1);
}
if (!FIREBASE_SERVICE_ACCOUNT) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT is missing");
  process.exit(1);
}

/* ================= FIREBASE ADMIN ================= */
const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

/* ================= TEST ================= */
app.get("/", (req, res) => {
  res.send("Pi-backend is running securely ✅");
});

/* ================= APPROVE PAYMENT ================= */
app.post("/approve-payment", async (req, res) => {
  const { paymentId } = req.body;
  if (!paymentId) return res.status(400).json({ error: "paymentId missing" });

  try {
    const response = await fetch(
      `https://api.minepi.com/v2/payments/${paymentId}/approve`,
      {
        method: "POST",
        headers: {
          Authorization: `Key ${PI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      const err = await response.text();
      return res.status(400).json({ error: err });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Approve error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ================= COMPLETE PAYMENT (SECURE) ================= */
app.post("/complete-payment", async (req, res) => {
  const { paymentId, txid } = req.body;
  if (!paymentId || !txid) {
    return res.status(400).json({ error: "paymentId or txid missing" });
  }

  try {
    /* 1️⃣ Complete payment with Pi */
    const response = await fetch(
      `https://api.minepi.com/v2/payments/${paymentId}/complete`,
      {
        method: "POST",
        headers: {
          Authorization: `Key ${PI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ txid }),
      }
    );

    if (!response.ok) {
      const err = await response.text();
      return res.status(400).json({ error: err });
    }

    const paymentData = await response.json();

    /* 2️⃣ Verify metadata */
    const bookId = paymentData?.metadata?.bookId;
    const buyerUid = paymentData?.user_uid;

    if (!bookId || !buyerUid) {
      return res.status(400).json({ error: "Invalid payment metadata" });
    }

    /* 3️⃣ Secure Firestore update */
    const bookRef = db.collection("books").doc(bookId);

    await db.runTransaction(async (t) => {
      const bookDoc = await t.get(bookRef);
      if (!bookDoc.exists) throw new Error("Book not found");

      const currentSales = bookDoc.data().salesCount || 0;
      t.update(bookRef, { salesCount: currentSales + 1 });
    });

    await db
      .collection("purchases")
      .doc(buyerUid)
      .collection("books")
      .doc(bookId)
      .set({ purchasedAt: Date.now() });

    res.json({ success: true });
  } catch (err) {
    console.error("Complete error:", err);
    res.status(500).json({ error: "Payment completion failed" });
  }
});

/* ================= START ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
