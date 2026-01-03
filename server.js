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

// Firebase Admin Initialization with robust private_key fix
let db = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    let serviceAccountStr = process.env.FIREBASE_SERVICE_ACCOUNT;

    // إصلاح escaped newlines (\\n → \n)
    serviceAccountStr = serviceAccountStr.replace(/\\n/g, "\n");

    // إزالة أي مسافات زيادة أو أحرف غريبة قد تسبب خطأ JSON parse
    serviceAccountStr = serviceAccountStr.trim();

    const serviceAccount = JSON.parse(serviceAccountStr);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log("Firebase Admin initialized successfully ✅");
  } catch (err) {
    console.error("Firebase Admin init failed:", err.message);
    console.error("Full error:", err);
    console.error("Check your FIREBASE_SERVICE_ACCOUNT JSON format – especially private_key with correct \\n");
  }
} else {
  console.warn("FIREBASE_SERVICE_ACCOUNT not set – Firestore disabled.");
}

// Root
app.get("/", (req, res) => res.send("Spicy Library Backend Running Securely ✅"));

// Approve payment
app.post("/approve-payment", async (req, res) => {
  const { paymentId } = req.body;
  if (!paymentId) return res.status(400).json({ error: "paymentId missing" });

  try {
    const response = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/approve`, {
      method: "POST",
      headers: { Authorization: `Key ${PI_API_KEY}` }
    });
    if (!response.ok) throw new Error(await response.text());
    res.json({ success: true });
  } catch (err) {
    console.error("Approve error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Complete payment
app.post("/complete-payment", async (req, res) => {
  const { paymentId, txid, bookId, userUid } = req.body;
  if (!paymentId || !txid || !bookId || !userUid || !db) {
    return res.status(400).json({ error: "missing data or Firestore not ready" });
  }

  try {
    const response = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/complete`, {
      method: "POST",
      headers: { Authorization: `Key ${PI_API_KEY}` },
      body: JSON.stringify({ txid })
    });
    if (!response.ok) throw new Error(await response.text());

    const bookRef = db.collection("books").doc(bookId);
    const purchaseRef = db.collection("purchases").doc(userUid).collection("books").doc(bookId);

    await db.runTransaction(async (t) => {
      t.update(bookRef, { salesCount: admin.firestore.FieldValue.increment(1) });
      t.set(purchaseRef, { purchasedAt: Date.now() });
    });

    const bookSnap = await bookRef.get();
    res.json({ success: true, pdfUrl: bookSnap.data().pdf });
  } catch (err) {
    console.error("Complete payment error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get PDF
app.post("/get-pdf", async (req, res) => {
  const { bookId, userUid } = req.body;
  if (!bookId || !userUid || !db) return res.status(400).json({ error: "missing data" });

  try {
    const purchaseSnap = await db.collection("purchases").doc(userUid).collection("books").doc(bookId).get();
    if (!purchaseSnap.exists) return res.status(403).json({ error: "not purchased" });

    const bookSnap = await db.collection("books").doc(bookId).get();
    res.json({ success: true, pdfUrl: bookSnap.data().pdf });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rate book
app.post("/rate-book", async (req, res) => {
  const { bookId, voteType, userUid } = req.body;
  if (!bookId || !voteType || !userUid || !db) return res.status(400).json({ error: "missing data" });

  try {
    await db.collection("ratings").doc(bookId).collection("votes").doc(userUid).set({
      vote: voteType,
      votedAt: Date.now()
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save book
app.post("/save-book", async (req, res) => {
  const { title, price, description, language, pageCount, cover, pdf, owner, ownerUid } = req.body;
  if (!title || !price || !cover || !pdf || !owner || !ownerUid || !db) return res.status(400).json({ error: "missing data" });

  try {
    const docRef = await db.collection("books").add({
      title,
      price: Number(price),
      description: description || "",
      language: language || "",
      pageCount: pageCount || "Unknown",
      salesCount: 0,
      cover,
      pdf,
      owner,
      ownerUid,
      createdAt: Date.now()
    });
    res.json({ success: true, bookId: docRef.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reset sales after payout
app.post("/reset-sales", async (req, res) => {
  const { username } = req.body;
  if (!username || !db) return res.status(400).json({ error: "missing username" });

  try {
    const snap = await db.collection("books").where("owner", "==", username).get();
    const batch = db.batch();
    snap.forEach(doc => batch.update(doc.ref, { salesCount: 0 }));
    await batch.commit();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// جلب جميع الكتب (للـ HTML)
app.get("/books", async (req, res) => {
  if (!db) return res.status(503).json({ error: "Firestore not initialized" });
  try {
    const snap = await db.collection("books").orderBy("createdAt", "desc").get();
    const books = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, books });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// جلب تقييمات كتاب معين
app.post("/book-ratings", async (req, res) => {
  const { bookId, userUid } = req.body;
  if (!bookId || !db) return res.status(400).json({ error: "missing data" });
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
    res.status(500).json({ error: err.message });
  }
});

// جلب مشتريات المستخدم
app.post("/my-purchases", async (req, res) => {
  const { userUid } = req.body;
  if (!userUid || !db) return res.status(400).json({ error: "missing userUid" });
  try {
    const purchasesSnap = await db.collection("purchases").doc(userUid).collection("books").get();
    const bookIds = purchasesSnap.docs.map(doc => doc.id);
    const books = [];
    for (const bookId of bookIds) {
      const bookSnap = await db.collection("books").doc(bookId).get();
      if (bookSnap.exists) {
        books.push({ id: bookId, ...bookSnap.data() });
      }
    }
    res.json({ success: true, books });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// جلب مبيعات المستخدم
app.post("/my-sales", async (req, res) => {
  const { username } = req.body;
  if (!username || !db) return res.status(400).json({ error: "missing username" });
  try {
    const snap = await db.collection("books").where("owner", "==", username).get();
    const books = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, books });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Spicy Library Backend running on port ${port} 🚀`);
  console.log(`Date: January 03, 2026 – Ready for Pi Mainnet!`);
});
