import express from "express";
import admin from "firebase-admin";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ================= FIREBASE =================
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});
const db = admin.firestore();

// ================= PI =================
const PI_API_KEY = process.env.PI_API_KEY;
const PI_API_URL = "https://api.minepi.com/v2";

// ================= ROOT =================
app.get("/", (_, res) => res.send("Backend running"));

// ================= BOOKS =================
app.get("/books", async (_, res) => {
  try {
    const snap = await db.collection("books").orderBy("createdAt", "desc").get();
    const books = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, books });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/book/:id", async (req, res) => {
  try {
    const doc = await db.collection("books").doc(req.params.id).get();
    if (!doc.exists) return res.status(404).json({ success: false, error: "Book not found" });
    res.json({ success: true, book: { id: doc.id, ...doc.data() } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/save-book", async (req, res) => {
  try {
    const { title, price, cover, pdf, owner, ownerUid } = req.body;
    if (!title || !price || !cover || !pdf || !owner || !ownerUid)
      return res.status(400).json({ error: "Missing data" });
    const doc = await db.collection("books").add({
      ...req.body, salesCount: 0, createdAt: Date.now()
    });
    res.json({ success: true, bookId: doc.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= RATINGS =================
app.post("/rate-book", async (req, res) => {
  try {
    const { bookId, voteType, userUid } = req.body;
    if (!bookId || !voteType || !userUid) return res.status(400).json({ error: "Missing data" });
    await db.collection("ratings").doc(bookId).collection("votes").doc(userUid)
      .set({ vote: voteType, votedAt: Date.now() });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/book-ratings", async (req, res) => {
  try {
    const { bookId, userUid } = req.body;
    const snap = await db.collection("ratings").doc(bookId).collection("votes").get();
    let likes = 0, dislikes = 0, userVote = null;
    snap.forEach(d => {
      if (d.data().vote === "like") likes++;
      if (d.data().vote === "dislike") dislikes++;
      if (d.id === userUid) userVote = d.data().vote;
    });
    res.json({ success: true, likes, dislikes, userVote });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ================= PAYMENTS =================
app.post("/approve-payment", async (req, res) => {
  try {
    const { paymentId, bookId, userUid } = req.body;
    if (!paymentId || !bookId || !userUid) return res.status(400).json({ error: "Missing data" });
    await db.collection("pendingPayments").doc(paymentId).set({
      bookId, userUid, status: "pending", createdAt: Date.now()
    });
    const r = await fetch(`${PI_API_URL}/payments/${paymentId}/approve`, {
      method: "POST", headers: { Authorization: `Key ${PI_API_KEY}` }
    });
    if (!r.ok) throw new Error(await r.text());
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/complete-payment", async (req, res) => {
  try {
    const { paymentId, txid } = req.body;
    if (!paymentId || !txid) return res.status(400).json({ error: "Missing data" });
    
    const r = await fetch(`${PI_API_URL}/payments/${paymentId}/complete`, {
      method: "POST",
      headers: { Authorization: `Key ${PI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ txid })
    });
    if (!r.ok) throw new Error(await r.text());
    const paymentData = await r.json();

    // تحديث Firestore
    const { bookId, userUid } = paymentData.metadata;
    const bookRef = db.collection("books").doc(bookId);
    await db.runTransaction(async t => {
      t.update(bookRef, { salesCount: admin.firestore.FieldValue.increment(1) });
      t.set(db.collection("purchases").doc(userUid).collection("books").doc(bookId),
        { purchasedAt: Date.now() });
    });

    // حذف الدفع المعلق
    await db.collection("pendingPayments").doc(paymentId).delete();
    const bookSnap = await bookRef.get();
    res.json({ success: true, pdfUrl: bookSnap.data().pdf });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/pending-payments", async (req, res) => {
  const { userUid } = req.query;
  if (!userUid) return res.status(400).json({ success: false, error: "Missing userUid" });
  const snap = await db.collection("pendingPayments").where("userUid", "==", userUid).get();
  const pendingPayments = snap.docs.map(d => ({ id: d.id, bookId: d.data().bookId }));
  res.json({ success: true, pendingPayments });
});

// ================= START SERVER =================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Backend running on port", PORT));
