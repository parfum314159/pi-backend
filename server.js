import express from "express";
import admin from "firebase-admin";
import fetch from "node-fetch";
import cors from "cors";
import StellarSdk from "stellar-sdk";
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


/* ================= STELLAR TESTNET ================= */

const serverStellar = new StellarSdk.Horizon.Server(
  "https://api.testnet.minepi.com"
);

const appWallet = StellarSdk.Keypair.fromSecret(
  process.env.PI_WALLET_SECRET
);

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

/* ================= SINGLE BOOK ================= */
app.get("/book/:id", async (req, res) => {
  try {
    const bookId = req.params.id;
    const doc = await db.collection("books").doc(bookId).get();

    if (!doc.exists) {
      return res.status(404).json({ success: false, error: "Book not found" });
    }

    res.json({ success: true, book: { id: doc.id, ...doc.data() } });
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

// 🔹 approve-payment (بدون أي منطق إضافي)
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
    console.error("Approve error:", e.message);
    res.status(500).json({ error: e.message });
  }
});


// 🔹 complete-payment (النسخة الصحيحة)
app.post("/complete-payment", async (req, res) => {
  try {
    const { paymentId, txid } = req.body;

    if (!paymentId || !txid) {
      return res.status(400).json({ error: "Missing payment data" });
    }

    // 1️⃣ جلب بيانات الدفع من Pi
    const paymentRes = await fetch(`${PI_API_URL}/payments/${paymentId}`, {
      method: "GET",
      headers: { Authorization: `Key ${PI_API_KEY}` }
    });

    if (!paymentRes.ok) {
      throw new Error(await paymentRes.text());
    }

    const paymentData = await paymentRes.json();

    // 2️⃣ استخراج البيانات من metadata (مصدر موثوق)
    const bookId = paymentData.metadata?.bookId;
    const userUid = paymentData.metadata?.userUid;

    if (!bookId || !userUid) {
      throw new Error("Missing metadata from Pi payment");
    }

    // 3️⃣ إكمال الدفع
    const completeRes = await fetch(`${PI_API_URL}/payments/${paymentId}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Key ${PI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ txid })
    });

    if (!completeRes.ok) {
      throw new Error(await completeRes.text());
    }

    // 4️⃣ تحديث Firestore (transaction)
    const bookRef = db.collection("books").doc(bookId);

    await db.runTransaction(async (t) => {
      t.update(bookRef, {
        salesCount: admin.firestore.FieldValue.increment(1)
      });

      t.set(
        db.collection("purchases")
          .doc(userUid)
          .collection("books")
          .doc(bookId),
        { purchasedAt: Date.now() }
      );
    });

    // 5️⃣ إرسال رابط الكتاب
    const bookSnap = await bookRef.get();
    res.json({ success: true, pdfUrl: bookSnap.data().pdf });

  } catch (e) {
    console.error("Complete payment error:", e.message);
    res.status(500).json({ error: e.message });
  }
});


// 🔹 معالجة الدفعات المعلقة (اختياري – لكنه آمن)
async function handlePendingPayment(paymentId) {
  try {
    const r = await fetch(`${PI_API_URL}/payments/${paymentId}`, {
      method: "GET",
      headers: { Authorization: `Key ${PI_API_KEY}` }
    });

    if (!r.ok) throw new Error(await r.text());
    const paymentData = await r.json();

    if (!paymentData.txid) return;

    const bookId = paymentData.metadata?.bookId;
    const userUid = paymentData.metadata?.userUid;

    if (!bookId || !userUid) return;

    await fetch(`${PI_API_URL}/payments/${paymentId}/complete`, {
      method: "POST",
      headers: {
        Authorization: `Key ${PI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ txid: paymentData.txid })
    });

    const bookRef = db.collection("books").doc(bookId);

    await db.runTransaction(async (t) => {
      t.update(bookRef, {
        salesCount: admin.firestore.FieldValue.increment(1)
      });

      t.set(
        db.collection("purchases")
          .doc(userUid)
          .collection("books")
          .doc(bookId),
        { purchasedAt: Date.now() }
      );
    });

    console.log("✅ Pending payment resolved:", paymentId);

  } catch (e) {
    console.log("⚠️ Pending resolve failed:", e.message);
  }
}

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
/* ================= AUTO PAYOUT ================= */

app.post("/request-payout", async (req, res) => {
  try {

    const { username, walletAddress } = req.body;

// ================= PAYOUT LOCK =================

const payoutLockRef = db
  .collection("payoutLocks")
  .doc(username);

const existingLock = await payoutLockRef.get();

if (existingLock.exists) {
  return res.status(400).json({
    success: false,
    error: "Payout already processing"
  });
}

// إنشاء القفل
await payoutLockRef.set({
  createdAt: Date.now()
});
    
    if (!username || !walletAddress) {
      return res.status(400).json({
        success: false,
        error: "Missing data"
      });
    }

    // جلب الكتب
    const booksSnap = await db.collection("books")
      .where("owner", "==", username)
      .get();

    let totalEarnings = 0;

    booksSnap.forEach(doc => {
      const book = doc.data();

      const sales = book.salesCount || 0;

      const profit = sales * book.price * 0.7;

      totalEarnings += profit;
    });

    totalEarnings = Number(totalEarnings.toFixed(2));

    if (totalEarnings < 5) {
      return res.status(400).json({
        success: false,
        error: "Minimum payout is 5 Pi"
      });
    }

    // ================= إرسال Pi =================

    const sourceAccount = await serverStellar.loadAccount(
      appWallet.publicKey()
    );

    const fee = await serverStellar.fetchBaseFee();

    const transaction = new StellarSdk.TransactionBuilder(
      sourceAccount,
      {
        fee,
        networkPassphrase: "Pi Testnet"
      }
    )
      .addOperation(
        StellarSdk.Operation.payment({
          destination: walletAddress,
          asset: StellarSdk.Asset.native(),
          amount: totalEarnings.toString()
        })
      )
      .setTimeout(30)
      .build();

    transaction.sign(appWallet);

    const result = await serverStellar.submitTransaction(
      transaction
    );

    // ================= تصفير المبيعات =================

    const batch = db.batch();

    booksSnap.forEach(doc => {
      batch.update(doc.ref, {
        salesCount: 0
      });
    });

    await batch.commit();

    // ================= حفظ السحب =================

    await db.collection("payouts").add({
      username,
      walletAddress,
      amount: totalEarnings,
      txid: result.hash,
      createdAt: Date.now()
    });

    
    // حذف القفل بعد النجاح
await payoutLockRef.delete();

    
    res.json({
      success: true,
      amount: totalEarnings,
      txid: result.hash
    });

  } catch (e) {

try {
  await db.collection("payoutLocks")
    .doc(req.body.username)
    .delete();
} catch {}
    
    console.error("AUTO PAYOUT ERROR:", e);

    res.status(500).json({
      success: false,
      error: e.message
    });
  }
});



/* ================= START ================= */
// حفظ الدفع كـ pending عند approve
app.post("/approve-payment", async (req, res) => {
  const { paymentId, bookId, userUid } = req.body;
  if (!paymentId || !bookId || !userUid || !db) return res.status(400).json({ error: "missing data" });
  try {
    // حفظ الدفع المعلق في مجموعة جديدة
    await db.collection("pendingPayments").doc(paymentId).set({ bookId, userUid, status: "pending", createdAt: Date.now() });

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

// إكمال الدفع (مع حذف من pending)
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
    await db.runTransaction(async (t) => {
      t.update(bookRef, { salesCount: admin.firestore.FieldValue.increment(1) });
      t.set(db.collection("purchases").doc(userUid).collection("books").doc(bookId), { purchasedAt: Date.now() });
    });

    // حذف الدفع من المعلقين بعد إكماله
    await db.collection("pendingPayments").doc(paymentId).delete();

    const bookSnap = await bookRef.get();
    res.json({ success: true, pdfUrl: bookSnap.data().pdf });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// جلب الدفعات المعلقة للمستخدم (للحل التلقائي)
app.get("/pending-payments", async (req, res) => {
  const { userUid } = req.query;
  if (!userUid || !db) return res.status(400).json({ success: false, error: "missing userUid" });
  try {
    const snap = await db.collection("pendingPayments").where("userUid", "==", userUid).get();
    const pendingPayments = snap.docs.map(doc => ({ id: doc.id, bookId: doc.data().bookId }));
    res.json({ success: true, pendingPayments });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// ================= WITHDRAW SIMULATION =================
app.post("/withdraw-simulated", async (req, res) => {
  try {
    const { username, amount } = req.body;
    if (!username || !amount || amount < 5) {
      return res.status(400).json({ success: false });
    }

    const booksSnap = await db
      .collection("books")
      .where("owner", "==", username)
      .get();

    const batch = db.batch();
    booksSnap.forEach(doc => {
      batch.update(doc.ref, { salesCount: 0 });
    });

    await batch.commit();

    await db.collection("payout_requests").add({
      username,
      amount,
      simulated: true,
      createdAt: Date.now()
    });

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false });
  }
});


    



const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Backend running on port", PORT));













