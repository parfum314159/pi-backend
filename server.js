import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PI_API_KEY = process.env.PI_API_KEY;
if (!PI_API_KEY) {
  console.error("❌ PI_API_KEY is missing!");
  process.exit(1);
}

// Firebase Admin
let db = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    let serviceAccountStr = process.env.FIREBASE_SERVICE_ACCOUNT;
    serviceAccountStr = serviceAccountStr.replace(/\\n/g, '\n');
    const serviceAccount = JSON.parse(serviceAccountStr);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log("Firebase initialized successfully");
  } catch (err) {
    console.error("Firebase init failed:", err.message);
  }
}

app.get("/", (req, res) => res.send("Backend running"));

// جلب الكتب
app.get("/books", async (req, res) => {
  if (!db) return res.status(500).json({ success: false, error: "Firestore not ready" });
  try {
    const snap = await db.collection("books").orderBy("createdAt", "desc").get();
    const books = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, books });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// جلب التقييمات
app.post("/book-ratings", async (req, res) => {
  const { bookId, userUid } = req.body;
  if (!bookId || !db) return res.status(400).json({ success: false, error: "missing data" });
  try {
    const ratingsSnap = await db.collection("ratings").doc(bookId).collection("votes").get();
    const likes = ratingsSnap.docs.filter(d => d.data().vote === "like").length;
    const dislikes = ratingsSnap.docs.filter(d => d.data().vote === "dislike").length;
    let userVote = null;
    if (userUid) {
      const userVoteDoc = await db.collection("ratings").doc(bookId).collection("votes").doc(userUid).get();
      userVote = userVoteDoc.exists ? userVoteDoc.data().vote : null;
    }
    res.json({ success: true, likes, dislikes, userVote });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// جلب المشتريات
app.post("/my-purchases", async (req, res) => {
  const { userUid } = req.body;
  if (!userUid || !db) return res.status(400).json({ success: false, error: "missing userUid" });
  try {
    const purchasesSnap = await db.collection("purchases").doc(userUid).collection("books").get();
    const bookIds = purchasesSnap.docs.map(doc => doc.id);
    const books = [];
    for (const bookId of bookIds) {
      const bookSnap = await db.collection("books").doc(bookId).get();
      if (bookSnap.exists) books.push({ id: bookId, ...bookSnap.data() });
    }
    res.json({ success: true, books });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// جلب المبيعات
app.post("/my-sales", async (req, res) => {
  const { username } = req.body;
  if (!username || !db) return res.status(400).json({ success: false, error: "missing username" });
  try {
    const snap = await db.collection("books").where("owner", "==", username).get();
    const books = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, books });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Approve payment (احفظ كـ pending)
app.post("/approve-payment", async (req, res) => {
  const { paymentId, bookId, userUid } = req.body;
  if (!paymentId || !bookId || !userUid || !db) return res.status(400).json({ error: "missing data" });
  try {
    await db.collection("pendingPayments").doc(paymentId).set({ bookId, userUid, status: "pending", createdAt: Date.now() });

    const response = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/approve`, {
      method: "POST",
      headers: { Authorization: `Key ${PI_API_KEY}` }
    });
    if (!response.ok) throw new Error(await response.text());
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Complete payment
app.post("/complete-payment", async (req, res) => {
  const { paymentId, txid, bookId, userUid } = req.body;
  if (!paymentId || !txid || !bookId || !userUid || !db) return res.status(400).json({ error: "missing data" });
  try {
    const response = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/complete`, {
      method: "POST",
      headers: { Authorization: `Key ${PI_API_KEY}` },
      body: JSON.stringify({ txid })
    });
    if (!response.ok) throw new Error(await response.text());

    const bookRef = db.collection("books").doc(bookId);
    await db.runTransaction(async (t) => {
      t.update(bookRef, { salesCount: admin.firestore.FieldValue.increment(1) });
      t.set(db.collection("purchases").doc(userUid).collection("books").doc(bookId), { purchasedAt: Date.now() });
    });

    await db.collection("pendingPayments").doc(paymentId).delete();

    const bookSnap = await bookRef.get();
    res.json({ success: true, pdfUrl: bookSnap.data().pdf });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// جلب الدفعات المعلقة للمستخدم
app.get("/pending-payments", async (req, res) => {
  const { userUid } = req.query;
  if (!userUid || !db) return res.status(400).json({ success: false, error: "missing userUid" });
  try {
    const snap = await db.collection("pendingPayments").where("userUid", "==", userUid).get();
    const pendingPayments = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, pendingPayments });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// باقي الـ endpoints (save-book, rate-book, get-pdf, reset-sales) زي ما في الكود بتاعك

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
