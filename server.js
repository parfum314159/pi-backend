import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json());

const PI_API_KEY = process.env.PI_API_KEY;
if (!PI_API_KEY) {
  console.error("PI_API_KEY missing");
  process.exit(1);
}

let db;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log("Firebase initialized");
  } catch (err) {
    console.error("Firebase init failed:", err.message);
  }
} else {
  console.warn("No FIREBASE_SERVICE_ACCOUNT - running without Firestore updates");
}

// Approve
app.post("/approve-payment", async (req, res) => {
  const { paymentId } = req.body;
  if (!paymentId) return res.status(400).json({ error: "missing paymentId" });

  try {
    const response = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/approve`, {
      method: "POST",
      headers: { Authorization: `Key ${PI_API_KEY}` }
    });
    if (!response.ok) throw new Error("Approve failed");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Complete + update purchases/sales
app.post("/complete-payment", async (req, res) => {
  const { paymentId, txid, bookId, userUid } = req.body;
  if (!paymentId || !txid || !bookId || !userUid || !db) return res.status(400).json({ error: "missing data or Firestore not ready" });

  try {
    const response = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/complete`, {
      method: "POST",
      headers: { Authorization: `Key ${PI_API_KEY}` },
      body: JSON.stringify({ txid })
    });
    if (!response.ok) throw new Error("Complete failed");

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

// Get PDF (secure)
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

// Rate book (via backend)
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

// Save book (via backend)
app.post("/save-book", async (req, res) => {
  const { title, price, description, language, pageCount, cover, pdf, owner, ownerUid } = req.body;
  if (!title || !price || !cover || !pdf || !ownerUid || !db) return res.status(400).json({ error: "missing data" });

  try {
    await db.collection("books").add({
      title, price, description, language, pageCount, salesCount: 0, cover, pdf, owner, ownerUid, createdAt: Date.now()
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.send("Backend running"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server on port ${port}`));
