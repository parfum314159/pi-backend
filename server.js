import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ================= PI API KEY =================
const PI_API_KEY = process.env.PI_API_KEY;
if (!PI_API_KEY) {
  console.error("❌ PI_API_KEY is missing! Add it in Render Environment Variables.");
  process.exit(1);
}

// ================= FIREBASE ADMIN INITIALIZATION =================
let db = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    db = admin.firestore();
    console.log("Firebase Admin initialized successfully ✅");
  } catch (err) {
    console.error("Firebase Admin init failed:", err.message);
    console.warn("Firestore writes will be disabled until fixed.");
  }
} else {
  console.warn("FIREBASE_SERVICE_ACCOUNT not set – Firestore writes disabled.");
}

// ================= ROOT =================
app.get("/", (req, res) => {
  res.send("Spicy Library Backend is running ✅");
});

// ================= APPROVE PAYMENT =================
app.post("/approve-payment", async (req, res) => {
  const { paymentId } = req.body;
  if (!paymentId) return res.status(400).json({ error: "paymentId missing" });

  try {
    const response = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/approve`, {
      method: "POST",
      headers: {
        Authorization: `Key ${PI_API_KEY}`,
        "Content-Type": "application/json"
      }
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(errText || "Approval failed");
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Approve error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================= COMPLETE PAYMENT =================
app.post("/complete-payment", async (req, res) => {
  const { paymentId, txid, bookId, userUid } = req.body;
  if (!paymentId || !txid || !bookId || !userUid) {
    return res.status(400).json({ error: "missing data" });
  }

  if (!db) {
    return res.status(503).json({ error: "Firestore not initialized" });
  }

  try {
    const response = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Key ${PI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ txid })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(errText || "Completion failed");
    }

    const bookRef = db.collection("books").doc(bookId);
    const purchaseRef = db.collection("purchases").doc(userUid).collection("books").doc(bookId);

    await db.runTransaction(async (t) => {
      const bookDoc = await t.get(bookRef);
      if (!bookDoc.exists) throw new Error("Book not found");

      t.update(bookRef, { salesCount: admin.firestore.FieldValue.increment(1) });
      t.set(purchaseRef, { purchasedAt: Date.now() });
    });

    const bookSnap = await bookRef.get();
    const bookData = bookSnap.data();

    res.json({ success: true, pdfUrl: bookData.pdf });
  } catch (err) {
    console.error("Complete payment error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================= GET PDF =================
app.post("/get-pdf", async (req, res) => {
  const { bookId, userUid } = req.body;
  if (!bookId || !userUid || !db) {
    return res.status(400).json({ error: "missing data or Firestore not ready" });
  }

  try {
    const purchaseSnap = await db.collection("purchases").doc(userUid).collection("books").doc(bookId).get();
    if (!purchaseSnap.exists) return res.status(403).json({ error: "You have not purchased this book" });

    const bookSnap = await db.collection("books").doc(bookId).get();
    if (!bookSnap.exists) return res.status(404).json({ error: "Book not found" });

    const bookData = bookSnap.data();
    res.json({ success: true, pdfUrl: bookData.pdf });
  } catch (err) {
    console.error("Get PDF error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================= RATE BOOK =================
app.post("/rate-book", async (req, res) => {
  const { bookId, voteType, userUid } = req.body;
  if (!bookId || !voteType || !userUid || !db) {
    return res.status(400).json({ error: "missing data or Firestore not ready" });
  }

  if (!["like", "dislike"].includes(voteType)) {
    return res.status(400).json({ error: "invalid voteType" });
  }

  try {
    await db.collection("ratings").doc(bookId).collection("votes").doc(userUid).set({
      vote: voteType,
      votedAt: Date.now()
    });
    res.json({ success: true });
  } catch (err) {
    console.error("Rate book error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================= SAVE BOOK =================
app.post("/save-book", async (req, res) => {
  const { title, price, description, language, pageCount, cover, pdf, owner, ownerUid } = req.body;
  if (!title || !price || !cover || !pdf || !owner || !ownerUid || !db) {
    return res.status(400).json({ error: "missing data or Firestore not ready" });
  }

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
    console.error("Save book error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================= RESET SALES AFTER PAYOUT =================
app.post("/reset-sales", async (req, res) => {
  const { username } = req.body;
  if (!username || !db) {
    return res.status(400).json({ error: "missing username or Firestore not ready" });
  }

  try {
    const snap = await db.collection("books").where("owner", "==", username).get();
    if (snap.empty) return res.json({ success: true, message: "No books to reset" });

    const batch = db.batch();
    snap.forEach(doc => {
      batch.update(doc.ref, { salesCount: 0 });
    });
    await batch.commit();

    res.json({ success: true });
  } catch (err) {
    console.error("Reset sales error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ================= START SERVER =================
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Spicy Library Backend running on port ${port} 🚀`);
  console.log(`Date: January 03, 2026 – Ready for Pi Mainnet launch!`);
});
