import express from "express";
import admin from "firebase-admin";
import fetch from "node-fetch";
import cors from "cors";

/* ================= APP ================= */
const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

/* ================= FIREBASE ================= */
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  )
});
const db = admin.firestore();

/* ================= PI ================= */
const PI_API_KEY = process.env.PI_API_KEY;
const PI_API_URL = "https://api.minepi.com/v2";

/* ================= ROOT ================= */
app.get("/", (_, res) => res.send("Backend running"));

/* ================= BOOKS ================= */
app.get("/books", async (_, res) => {
  try {
    const snap = await db.collection("books").orderBy("createdAt", "desc").get();
    const books = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, books });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/* ================= SAVE BOOK ================= */
app.post("/save-book", async (req, res) => {
  try {
    const {
      title, price, description, language, pageCount,
      cover, pdf, owner, ownerUid
    } = req.body;

    if (!title || !price || !cover || !pdf || !owner || !ownerUid) {
      return res.status(400).json({ error: "Missing data" });
    }

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
      createdAt: Date.now()
    });

    res.json({ success: true, bookId: doc.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= RATINGS ================= */
app.post("/rate-book", async (req, res) => {
  try {
    const { bookId, voteType, userUid } = req.body;
    if (!bookId || !voteType || !userUid) {
      return res.status(400).json({ error: "Missing data" });
    }

    await db
      .collection("ratings")
      .doc(bookId)
      .collection("votes")
      .doc(userUid)
      .set({ vote: voteType, votedAt: Date.now() });

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/book-ratings", async (req, res) => {
  try {
    const { bookId, userUid } = req.body;
    const snap = await db
      .collection("ratings")
      .doc(bookId)
      .collection("votes")
      .get();

    let likes = 0, dislikes = 0, userVote = null;
    snap.forEach(d => {
      if (d.data().vote === "like") likes++;
      if (d.data().vote === "dislike") dislikes++;
      if (d.id === userUid) userVote = d.data().vote;
    });

    res.json({ success: true, likes, dislikes, userVote });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= PAYMENTS ================= */
app.post("/approve-payment", async (req, res) => {
  try {
    const { paymentId } = req.body;
    const r = await fetch(`${PI_API_URL}/payments/${paymentId}/approve`, {
      method: "POST",
      headers: { Authorization: `Key ${PI_API_KEY}` }
    });
    if (!r.ok) throw new Error(await r.text());
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/complete-payment", async (req, res) => {
  try {
    const { paymentId, txid, bookId, userUid } = req.body;

    const r = await fetch(`${PI_API_URL}/payments/${paymentId}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Key ${PI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ txid })
    });
    if (!r.ok) throw new Error(await r.text());

    const bookRef = db.collection("books").doc(bookId);
    await bookRef.update({
      salesCount: admin.firestore.FieldValue.increment(1)
    });

    await db
      .collection("purchases")
      .doc(userUid)
      .collection("books")
      .doc(bookId)
      .set({ purchasedAt: Date.now() });

    const book = await bookRef.get();
    res.json({ success: true, pdfUrl: book.data().pdf });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
async function handlePendingPayment(paymentId) {
  try {
    // جلب بيانات الدفع
    const r = await fetch(`${PI_API_URL}/payments/${paymentId}`, {
      method: "GET",
      headers: { Authorization: `Key ${PI_API_KEY}` }
    });
    if (!r.ok) throw new Error(await r.text());
    const paymentData = await r.json();

    if (!paymentData.txid) {
      console.log("⚠️ Payment not ready yet or missing txid:", paymentId);
      return;
    }

    // Metadata fallback
    const metadata = paymentData.metadata || {};
    const bookId = metadata.bookId;
    const userUid = metadata.userUid;

    if (!bookId || !userUid) {
      console.log("⚠️ Missing metadata for pending payment:", paymentId);
      return;
    }

    // إكمال الدفع
    const completeRes = await fetch(`${PI_API_URL}/payments/${paymentId}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Key ${PI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ txid: paymentData.txid })
    });
    if (!completeRes.ok) throw new Error(await completeRes.text());

    // تحديث قاعدة البيانات
    const bookRef = db.collection("books").doc(bookId);
    await bookRef.update({ salesCount: admin.firestore.FieldValue.increment(1) });
    await db.collection("purchases").doc(userUid).collection("books").doc(bookId).set({
      purchasedAt: Date.now()
    });

    console.log("✅ Pending payment resolved:", paymentId);

  } catch (e) {
    console.log("⚠️ Failed to resolve pending payment:", paymentId, e.message);
  }
}

app.post("/resolve-pending", async (req, res) => {
  try {
    const { paymentId } = req.body;
    if (!paymentId) return res.status(400).json({ error: "Missing paymentId" });

    await handlePendingPayment(paymentId);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= PURCHASES ================= */
app.post("/my-purchases", async (req, res) => {
  try {
    const { userUid } = req.body;
    const snap = await db
      .collection("purchases")
      .doc(userUid)
      .collection("books")
      .get();

    const books = [];
    for (const d of snap.docs) {
      const b = await db.collection("books").doc(d.id).get();
      if (b.exists) books.push({ id: b.id, ...b.data() });
    }

    res.json({ success: true, books });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= GET PDF ================= */
app.post("/get-pdf", async (req, res) => {
  try {
    const { bookId, userUid } = req.body;

    const p = await db
      .collection("purchases")
      .doc(userUid)
      .collection("books")
      .doc(bookId)
      .get();

    if (!p.exists) return res.status(403).json({ error: "Not purchased" });

    const book = await db.collection("books").doc(bookId).get();
    res.json({ success: true, pdfUrl: book.data().pdf });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= SALES ================= */
app.post("/my-sales", async (req, res) => {
  try {
    const { username } = req.body;
    const snap = await db.collection("books").where("owner", "==", username).get();
    const books = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, books });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= RESET SALES ================= */
app.post("/reset-sales", async (req, res) => {
  try {
    const { username } = req.body;
    const snap = await db.collection("books").where("owner", "==", username).get();
    const batch = db.batch();
    snap.forEach(d => batch.update(d.ref, { salesCount: 0 }));
    await batch.commit();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ================= START ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Backend running on port", PORT));




