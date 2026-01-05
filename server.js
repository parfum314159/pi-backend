import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

/* ================= ENV ================= */
const PI_API_KEY = process.env.PI_API_KEY;
if (!PI_API_KEY) {
  console.error("❌ PI_API_KEY is missing");
  process.exit(1);
}

/* ================= FIREBASE ================= */
let db = null;
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    db = admin.firestore();
    console.log("✅ Firebase initialized");
  } else {
    console.error("❌ FIREBASE_SERVICE_ACCOUNT missing");
  }
} catch (e) {
  console.error("❌ Firebase init error:", e.message);
}

/* ================= PI PENDING HANDLER ================= */
async function handleIncompletePayment(paymentId) {
  try {
    // approve
    await fetch(`https://api.minepi.com/v2/payments/${paymentId}/approve`, {
      method: "POST",
      headers: { Authorization: `Key ${PI_API_KEY}` },
    });

    // complete (force)
    await fetch(`https://api.minepi.com/v2/payments/${paymentId}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Key ${PI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ txid: "auto-resolve" }),
    });

    console.log("✅ Pending payment resolved:", paymentId);
  } catch (e) {
    console.log("⚠️ Pending resolve failed:", paymentId, e.message);
  }
}

/* ================= ROOT ================= */
app.get("/", (req, res) => {
  res.send("Backend running");
});

/* ================= BOOKS ================= */
app.get("/books", async (req, res) => {
  if (!db) return res.status(500).json({ error: "Firestore not ready" });
  try {
    const snap = await db
      .collection("books")
      .orderBy("createdAt", "desc")
      .get();

    const books = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ success: true, books });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= SAVE BOOK ================= */
app.post("/save-book", async (req, res) => {
  if (!db) return res.status(500).json({ error: "Firestore not ready" });

  const {
    title,
    price,
    description,
    language,
    pageCount,
    cover,
    pdf,
    owner,
    ownerUid,
  } = req.body;

  if (!title || !price || !cover || !pdf || !owner || !ownerUid) {
    return res.status(400).json({ error: "missing data" });
  }

  try {
    const doc = await db.collection("books").add({
      title,
      price: Number(price),
      description: description || "",
      language: language || "",
      pageCount: pageCount || "Unknown",
      cover,
      pdf,
      owner,
      ownerUid,
      salesCount: 0,
      createdAt: Date.now(),
    });

    res.json({ success: true, bookId: doc.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= APPROVE PAYMENT ================= */
app.post("/approve-payment", async (req, res) => {
  try {
    const { paymentId } = req.body;
    if (!paymentId)
      return res.status(400).json({ error: "missing paymentId" });

    const r = await fetch(
      `https://api.minepi.com/v2/payments/${paymentId}/approve`,
      {
        method: "POST",
        headers: { Authorization: `Key ${PI_API_KEY}` },
      }
    );

    if (!r.ok) {
      await handleIncompletePayment(paymentId);
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= COMPLETE PAYMENT ================= */
app.post("/complete-payment", async (req, res) => {
  if (!db) return res.status(500).json({ error: "Firestore not ready" });

  const { paymentId, txid, bookId, userUid } = req.body;
  if (!paymentId || !txid || !bookId || !userUid) {
    return res.status(400).json({ error: "missing data" });
  }

  try {
    const r = await fetch(
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

    if (!r.ok) {
      await handleIncompletePayment(paymentId);
    }

    const bookRef = db.collection("books").doc(bookId);
    const purchaseRef = db
      .collection("purchases")
      .doc(userUid)
      .collection("books")
      .doc(bookId);

    await db.runTransaction(async (t) => {
      t.update(bookRef, {
        salesCount: admin.firestore.FieldValue.increment(1),
      });
      t.set(purchaseRef, { purchasedAt: Date.now() });
    });

    const bookSnap = await bookRef.get();
    res.json({ success: true, pdfUrl: bookSnap.data().pdf });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= GET PDF ================= */
app.post("/get-pdf", async (req, res) => {
  if (!db) return res.status(500).json({ error: "Firestore not ready" });

  const { bookId, userUid } = req.body;
  if (!bookId || !userUid) {
    return res.status(400).json({ error: "missing data" });
  }

  try {
    const purchase = await db
      .collection("purchases")
      .doc(userUid)
      .collection("books")
      .doc(bookId)
      .get();

    if (!purchase.exists)
      return res.status(403).json({ error: "not purchased" });

    const book = await db.collection("books").doc(bookId).get();
    res.json({ success: true, pdfUrl: book.data().pdf });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= RATE BOOK ================= */
app.post("/rate-book", async (req, res) => {
  if (!db) return res.status(500).json({ error: "Firestore not ready" });

  const { bookId, voteType, userUid } = req.body;
  if (!bookId || !voteType || !userUid) {
    return res.status(400).json({ error: "missing data" });
  }

  try {
    await db
      .collection("ratings")
      .doc(bookId)
      .collection("votes")
      .doc(userUid)
      .set({
        vote: voteType,
        votedAt: Date.now(),
      });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= RESOLVE PENDING (MANUAL) ================= */
app.post("/resolve-pending", async (req, res) => {
  try {
    const { paymentId } = req.body;
    await handleIncompletePayment(paymentId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= RESET SALES ================= */
app.post("/reset-sales", async (req, res) => {
  if (!db) return res.status(500).json({ error: "Firestore not ready" });

  const { username } = req.body;
  if (!username) {
    return res.status(400).json({ error: "missing username" });
  }

  try {
    const snap = await db
      .collection("books")
      .where("owner", "==", username)
      .get();

    const batch = db.batch();
    snap.forEach((d) => batch.update(d.ref, { salesCount: 0 }));
    await batch.commit();

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= START ================= */
const port = process.env.PORT || 10000;
app.listen(port, () =>
  console.log(`🚀 Backend running on port ${port}`)
);
