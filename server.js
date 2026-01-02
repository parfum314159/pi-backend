import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json());

// 🔑 Pi API Key من Environment
const PI_API_KEY = process.env.PI_API_KEY;
if (!PI_API_KEY) {
  console.error("❌ PI_API_KEY missing");
  process.exit(1);
}

// 🔑 Firebase Admin SDK
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});
const db = admin.firestore();

// ------------------ Test Route ------------------
app.get("/", (req, res) => res.send("Pi-backend is running ✅"));

// ------------------ Add Book ------------------
app.post("/add-book", async (req, res) => {
  const { username, book } = req.body;
  if (!username || !book) return res.status(400).json({ error: "Missing username or book" });

  try {
    await db.collection("books").add({ ...book, owner: username, salesCount: 0 });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to add book" });
  }
});

// ------------------ Purchase Book ------------------
app.post("/purchase", async (req, res) => {
  const { username, bookId, paymentId, txid } = req.body;
  if (!username || !bookId || !paymentId || !txid)
    return res.status(400).json({ error: "Missing data" });

  try {
    // الموافقة على الدفع من Pi
    const approveRes = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/approve`, {
      method: "POST",
      headers: { Authorization: `Key ${PI_API_KEY}`, "Content-Type": "application/json" }
    });
    if (!approveRes.ok) throw new Error("Approve failed");

    // إكمال الدفع
    const completeRes = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/complete`, {
      method: "POST",
      headers: { Authorization: `Key ${PI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ txid })
    });
    if (!completeRes.ok) throw new Error("Complete failed");

    // تسجيل الشراء
    await db.collection("purchases").doc(username).collection("books").doc(bookId).set({ purchasedAt: Date.now() });

    // تحديث المبيعات
    const bookRef = db.collection("books").doc(bookId);
    await db.runTransaction(async t => {
      const doc = await t.get(bookRef);
      if (!doc.exists) throw "Book not found";
      t.update(bookRef, { salesCount: (doc.data().salesCount || 0) + 1 });
    });

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------ Rate Book ------------------
app.post("/rate-book", async (req, res) => {
  const { username, bookId, vote } = req.body;
  if (!username || !bookId || !vote) return res.status(400).json({ error: "Missing data" });

  try {
    await db.collection("ratings").doc(bookId).collection("votes").doc(username).set({
      vote,
      votedAt: Date.now(),
      username
    });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to rate book" });
  }
});

// ------------------ Request Payout ------------------
app.post("/request-payout", async (req, res) => {
  const { username, earnings, walletAddress } = req.body;
  if (!username || !earnings || !walletAddress) return res.status(400).json({ error: "Missing data" });

  try {
    await db.collection("payout_requests").add({ username, earnings, walletAddress, requestedAt: Date.now(), status: "pending" });
    // إعادة تعيين المبيعات للكتب الخاصة بالمستخدم
    const booksSnap = await db.collection("books").where("owner", "==", username).get();
    const batch = db.batch();
    booksSnap.forEach(doc => batch.update(doc.ref, { salesCount: 0 }));
    await batch.commit();
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to request payout" });
  }
});

// ------------------ Start Server ------------------
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port", port));
