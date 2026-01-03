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

// Firebase Admin Initialization with private_key fix
let db = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    let serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    // Fix newlines in private_key
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log("Firebase Admin initialized successfully ✅");
  } catch (err) {
    console.error("Firebase Admin init failed:", err.message);
  }
} else {
  console.warn("FIREBASE_SERVICE_ACCOUNT not set – Firestore writes disabled.");
}

app.get("/", (req, res) => res.send("Backend running ✅"));

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
    res.status(500).json({ error: err.message });
  }
});

// Complete payment + update Firestore
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
    const purchaseRef = db.collection("purchases").doc(userUid).collection("books").doc(bookId);

    await db.runTransaction(async (t) => {
      t.update(bookRef, { salesCount: admin.firestore.FieldValue.increment(1) });
      t.set(purchaseRef, { purchasedAt: Date.now() });
    });

    const bookSnap = await bookRef.get();
    res.json({ success: true, pdfUrl: bookSnap.data().pdf });
  } catch (err) {
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

// Reset sales
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

// Get all books (جلب الكتب من Firebase)
app.get("/books", async (req, res) => {
  if (!db) return res.status(500).json({ error: "Firestore not ready" });

  try {
    const snap = await db.collection("books").get();
    const books = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, books });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get ratings for a book (جلب التقييمات من Firebase)
app.post("/get-ratings", async (req, res) => {
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

// Get user purchases (جلب المشتريات من Firebase)
app.post("/purchases", async (req, res) => {
  const { userUid } = req.body;
  if (!userUid || !db) return res.status(400).json({ error: "missing userUid" });

  try {
    const purchasesSnap = await db.collection("purchases").doc(userUid).collection("books").get();
    const purchases = purchasesSnap.docs.map(doc => doc.id);
    const books = await Promise.all(purchases.map(async (bookId) => {
      const bookSnap = await db.collection("books").doc(bookId).get();
      return { id: bookId, ...bookSnap.data() };
    }));
    res.json({ success: true, purchases: books });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user sales (جلب المبيعات من Firebase)
app.post("/sales", async (req, res) => {
  const { username } = req.body;
  if (!username || !db) return res.status(400).json({ error: "missing username" });

  try {
    const snap = await db.collection("books").where("owner", "==", username).get();
    const sales = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, sales });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port} 🚀`));
