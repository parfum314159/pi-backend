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

// ✅ 1) APPROVE PAYMENT
app.post("/approve-payment", async (req, res) => {
  try {
    const { paymentId } = req.body;
    if (!paymentId) {
      return res.status(400).json({ error: "Missing paymentId" });
    }

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


// ✅ 2) COMPLETE PAYMENT (NORMAL FLOW)
app.post("/complete-payment", async (req, res) => {
  try {
    const { paymentId, txid, bookId, userUid } = req.body;

    if (!paymentId || !txid || !bookId || !userUid) {
      return res.status(400).json({ error: "Missing data" });
    }

    // 🔒 منع التكرار
    const completedRef = db.collection("completed_payments").doc(paymentId);
    const completedSnap = await completedRef.get();
    if (completedSnap.exists) {
      return res.json({ success: true, message: "Payment already completed" });
    }

    // 🔹 إكمال الدفع في Pi
    const r = await fetch(`${PI_API_URL}/payments/${paymentId}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Key ${PI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ txid })
    });

    if (!r.ok) throw new Error(await r.text());

    // 🔹 تحديث المبيعات
    const bookRef = db.collection("books").doc(bookId);
    await bookRef.update({
      salesCount: admin.firestore.FieldValue.increment(1)
    });

    // 🔹 تسجيل الشراء
    await db
      .collection("purchases")
      .doc(userUid)
      .collection("books")
      .doc(bookId)
      .set({ purchasedAt: Date.now() });

    // 🔹 تسجيل أن الدفع اكتمل
    await completedRef.set({
      paymentId,
      bookId,
      userUid,
      completedAt: Date.now()
    });

    const bookSnap = await bookRef.get();
    res.json({ success: true, pdfUrl: bookSnap.data().pdf });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ✅ 3) HANDLE PENDING PAYMENT (AUTO RECOVERY)
async function handlePendingPayment(paymentId) {
  try {
    const r = await fetch(`${PI_API_URL}/payments/${paymentId}`, {
      method: "GET",
      headers: { Authorization: `Key ${PI_API_KEY}` }
    });
    if (!r.ok) throw new Error(await r.text());

    const paymentData = await r.json();

    if (!paymentData.txid) {
      console.log("⏳ Payment still pending:", paymentId);
      return;
    }

    const metadata = paymentData.metadata || {};
    const { bookId, userUid } = metadata;

    if (!bookId || !userUid) {
      console.log("⚠️ Missing metadata for payment:", paymentId);
      return;
    }

    // 🔒 منع التكرار
    const completedRef = db.collection("completed_payments").doc(paymentId);
    const completedSnap = await completedRef.get();
    if (completedSnap.exists) return;

    // 🔹 إكمال الدفع
    const completeRes = await fetch(`${PI_API_URL}/payments/${paymentId}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Key ${PI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ txid: paymentData.txid })
    });

    if (!completeRes.ok) throw new Error(await completeRes.text());

    // 🔹 تحديث قاعدة البيانات
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

    await completedRef.set({
      paymentId,
      bookId,
      userUid,
      completedAt: Date.now()
    });

    console.log("✅ Pending payment resolved:", paymentId);

  } catch (e) {
    console.error("⚠️ Failed to resolve pending payment:", paymentId, e.message);
  }
}


// ✅ 4) RESOLVE PENDING ENDPOINT
app.post("/resolve-pending", async (req, res) => {
  try {
    const { paymentId } = req.body;
    if (!paymentId) {
      return res.status(400).json({ error: "Missing paymentId" });
    }

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
      await completedRef.set({
  paymentId,
  bookId,
  userUid,
  completedAt: Date.now()
});
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
/* ================= PAYOUT REQUEST ================= */
app.post("/request-payout", async (req, res) => {
  try {
    const { username, walletAddress } = req.body;

    if (!username || !walletAddress) {
      return res.status(400).json({ error: "Missing data" });
    }

    const userRef = db.collection("users").doc(username);
    const userSnap = await userRef.get();

    // 🔹 جلب كتب المستخدم
    const booksSnap = await db
      .collection("books")
      .where("owner", "==", username)
      .get();

    if (booksSnap.empty) {
      return res.status(400).json({ error: "No books found" });
    }

    let totalEarnings = 0;
    const batch = db.batch();

    booksSnap.forEach(doc => {
      const book = doc.data();
      const sales = book.salesCount || 0;
      const price = book.price || 0;

      // 🔹 أرباح المؤلف (70%)
      const profit = Number((sales * price * 0.7).toFixed(2));
      totalEarnings += profit;

      // 🔹 تصفير المبيعات (سيتم بعد إنشاء الطلب)
      batch.update(doc.ref, { salesCount: 0 });
    });

    const payoutAmount = Number(totalEarnings.toFixed(2));

    // 🔒 الحد الأدنى للسحب
    if (payoutAmount < 5) {
      return res.status(400).json({ error: "Minimum payout is 5 Pi" });
    }

    // 🔹 منع إرسال نفس المبلغ القديم فقط
    if (userSnap.exists && userSnap.data().lastPayoutAmount === payoutAmount) {
      return res.status(400).json({ error: "Duplicate payout attempt" });
    }

    const now = admin.firestore.Timestamp.now();

    // 🔹 إنشاء طلب payout
    await db.collection("payout_requests").add({
      username,
      walletAddress,
      amount: payoutAmount,
      currency: "PI",
      status: "pending",
      requestedAt: now,
      approvedAt: null
    });

    // 🔹 تحديث بيانات المستخدم فقط مع آخر مبلغ وتاريخ
    await userRef.set({
      lastPayoutAmount: payoutAmount,
      lastPayoutAt: now
    }, { merge: true });

    // 🔹 تصفير الأرباح بعد إنشاء الطلب
    await batch.commit();

    res.json({
      success: true,
      amount: payoutAmount
    });

  } catch (err) {
    console.error("Payout error:", err);
    res.status(500).json({ error: "Server error" });
  }
});


/* ================= START ================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Backend running on port", PORT));










