import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import admin from "firebase-admin";

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

// Initialize Firebase Admin SDK
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

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
          Authorization: `Key ${PI_API_KEY}`,  // ← تغيير هنا: Key بدلاً من Bearer
          "Content-Type": "application/json"
        }
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(JSON.stringify(errorData));
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Approve error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================== COMPLETE PAYMENT ==================
app.post("/complete-payment", async (req, res) => {
  const { paymentId, txid, bookId, userUid } = req.body;  // استقبال txid, bookId, userUid

  if (!paymentId || !txid || !bookId || !userUid) {
    return res.status(400).json({ error: "paymentId, txid, bookId or userUid missing" });
  }

  try {
    const response = await fetch(
      `https://api.minepi.com/v2/payments/${paymentId}/complete`,
      {
        method: "POST",
        headers: {
          Authorization: `Key ${PI_API_KEY}`,  // ← تغيير هنا: Key بدلاً من Bearer
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ txid })  // إرسال txid
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(JSON.stringify(errorData));
    }

    const data = await response.json();

    // Update Firestore securely from backend
    const bookRef = db.collection("books").doc(bookId);
    const purchaseRef = db.collection("purchases").doc(userUid).collection("books").doc(bookId);

    await db.runTransaction(async (transaction) => {
      const bookDoc = await transaction.get(bookRef);
      if (!bookDoc.exists) {
        throw new Error("Book does not exist!");
      }
      const newSales = (bookDoc.data().salesCount || 0) + 1;
      transaction.update(bookRef, { salesCount: newSales });
      transaction.set(purchaseRef, { purchasedAt: Date.now() });
    });

    // Return PDF URL securely
    const bookDoc = await bookRef.get();
    const pdfUrl = bookDoc.data().pdf;

    res.json({ success: true, data, pdfUrl });
  } catch (err) {
    console.error("Complete error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================== GET PDF (for secure download) ==================
app.post("/get-pdf", async (req, res) => {
  const { bookId, userUid } = req.body;

  if (!bookId || !userUid) {
    return res.status(400).json({ error: "bookId or userUid missing" });
  }

  try {
    const purchaseDoc = await db.collection("purchases").doc(userUid).collection("books").doc(bookId).get();
    if (!purchaseDoc.exists) {
      return res.status(403).json({ error: "Access denied: You have not purchased this book" });
    }

    const bookDoc = await db.collection("books").doc(bookId).get();
    if (!bookDoc.exists) {
      return res.status(404).json({ error: "Book not found" });
    }

    const pdfUrl = bookDoc.data().pdf;
    res.json({ success: true, pdfUrl });
  } catch (err) {
    console.error("Get PDF error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================== START SERVER ==================
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port", port);
});
