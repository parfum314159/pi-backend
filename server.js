import express from "express";
import admin from "firebase-admin";
import fetch from "node-fetch";
import cors from "cors";
import fs from "fs";

const app = express();
app.use(cors());
app.use(express.json());

/* ================= FIREBASE ADMIN ================= */
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  )
});

const db = admin.firestore();

/* ================= PI CONFIG ================= */
const PI_API_KEY = process.env.PI_API_KEY;
const PI_API_URL = "https://api.minepi.com/v2";

/* ================= AUTH MIDDLEWARE ================= */
async function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No token" });
    }

    const idToken = header.split("Bearer ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/* ================= SAVE BOOK ================= */
app.post("/save-book", authMiddleware, async (req, res) => {
  try {
    const { title, price, description, cover, pdf, owner } = req.body;

    if (!title || !price || !cover || !pdf) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const doc = await db.collection("books").add({
      title,
      price: Number(price),
      description: description || "",
      cover,
      pdf,
      owner,
      ownerUid: req.user.uid,
      salesCount: 0,
      createdAt: Date.now()
    });

    res.json({ success: true, bookId: doc.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= GET BOOKS ================= */
app.get("/books", async (_, res) => {
  const snap = await db.collection("books").orderBy("createdAt", "desc").get();
  const books = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  res.json({ success: true, books });
});

/* ================= APPROVE PAYMENT ================= */
app.post("/approve-payment", async (req, res) => {
  try {
    const { paymentId } = req.body;

    const r = await fetch(`${PI_API_URL}/payments/${paymentId}/approve`, {
      method: "POST",
      headers: {
        Authorization: `Key ${PI_API_KEY}`
      }
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(400).json({ error: t });
    }

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= COMPLETE PAYMENT ================= */
app.post("/complete-payment", authMiddleware, async (req, res) => {
  try {
    const { paymentId, txid, bookId } = req.body;

    const r = await fetch(`${PI_API_URL}/payments/${paymentId}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Key ${PI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ txid })
    });

    if (!r.ok) {
      const t = await r.text();
      return res.status(400).json({ error: t });
    }

    const bookRef = db.collection("books").doc(bookId);
    const bookSnap = await bookRef.get();
    if (!bookSnap.exists) {
      return res.status(404).json({ error: "Book not found" });
    }

    // سجل الشراء
    await db
      .collection("purchases")
      .doc(req.user.uid)
      .collection("books")
      .doc(bookId)
      .set({ purchasedAt: Date.now() });

    // زيادة المبيعات
    await bookRef.update({
      salesCount: admin.firestore.FieldValue.increment(1)
    });

    res.json({ success: true, pdfUrl: bookSnap.data().pdf });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= MY PURCHASES ================= */
app.post("/my-purchases", authMiddleware, async (req, res) => {
  const snap = await db
    .collection("purchases")
    .doc(req.user.uid)
    .collection("books")
    .get();

  const books = [];
  for (const doc of snap.docs) {
    const b = await db.collection("books").doc(doc.id).get();
    if (b.exists) books.push({ id: b.id, ...b.data() });
  }

  res.json({ success: true, books });
});

/* ================= GET PDF ================= */
app.post("/get-pdf", authMiddleware, async (req, res) => {
  const { bookId } = req.body;

  const purchase = await db
    .collection("purchases")
    .doc(req.user.uid)
    .collection("books")
    .doc(bookId)
    .get();

  if (!purchase.exists) {
    return res.status(403).json({ error: "Not purchased" });
  }

  const book = await db.collection("books").doc(bookId).get();
  res.json({ success: true, pdfUrl: book.data().pdf });
});

/* ================= MY SALES ================= */
app.post("/my-sales", authMiddleware, async (req, res) => {
  const snap = await db
    .collection("books")
    .where("ownerUid", "==", req.user.uid)
    .get();

  const books = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  res.json({ success: true, books });
});

/* ================= SERVER ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Backend running on port", PORT);
});

