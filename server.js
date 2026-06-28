import express from "express";
import admin from "firebase-admin";
import fetch from "node-fetch";
import cors from "cors";
import cloudinary from 'cloudinary';

cloudinary.v2.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

const app = express();

const allowedOrigins = ["https://spicylibrary.online"];
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) callback(null, true);
    else callback(new Error("Not allowed by CORS"));
  }
};

app.use(cors(corsOptions));
app.use(express.json({ limit: "35mb" }));

admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
});
const db = admin.firestore();

const PI_API_KEY = process.env.PI_API_KEY;
const PI_API_URL = "https://api.minepi.com/v2";

/* ================= PI AUTH MIDDLEWARE ================= */
async function verifyPiUser(req, res) {
  const { accessToken, userUid } = req.body;
  if (!accessToken || !userUid) { res.status(400).json({ error: "Missing data" }); return null; }
  const response = await fetch("https://api.minepi.com/v2/me", {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!response.ok) { res.status(401).json({ error: "Invalid access token" }); return null; }
  const piUser = await response.json();
  if (piUser.uid !== userUid) { res.status(403).json({ error: "User mismatch" }); return null; }
  return piUser;
}

app.get("/", (_, res) => res.send("Backend running"));

/* ======================================================
 * ============= BOOKS ENDPOINTS (بدون تغيير) ===========
 * ====================================================== */

app.get("/books", async (_, res) => {
  try {
    const snap = await db.collection("books").where("approved", "==", true).orderBy("createdAt", "desc").get();
    const books = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ success: true, books });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get("/book", async (req, res) => {
  try {
    const bookId = req.query.id;
    if (!bookId) return res.status(400).json({ success: false, error: "Missing book ID" });
    const doc = await db.collection("books").doc(bookId).get();
    if (!doc.exists || !doc.data().approved) return res.status(404).json({ success: false, error: "Book not found" });
    res.set({ "Cache-Control": "no-store, no-cache, must-revalidate, private", "Pragma": "no-cache", "Expires": "0" });
    res.json({ success: true, book: { id: doc.id, ...doc.data() } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/upload-cover", async (req, res) => {
  try {
    const { file, accessToken, userUid } = req.body;
    if (!file || !accessToken || !userUid) return res.status(400).json({ error: "Missing data" });
    const piUser = await verifyPiUser(req, res);
    if (!piUser) return;
    const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
    const matches = file.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!matches) return res.status(400).json({ success: false, error: "Invalid image format" });
    const base64Data = matches[2];
    const fileSize = Buffer.byteLength(base64Data, "base64");
    if (fileSize > MAX_IMAGE_SIZE) return res.status(400).json({ error: "Image exceeds 5MB limit" });
    if (!file.startsWith("data:image/")) return res.status(400).json({ error: "Only images allowed" });
    const result = await cloudinary.v2.uploader.upload(file, { folder: "books/covers" });
    res.json({ success: true, url: result.secure_url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/upload-pdf", async (req, res) => {
  try {
    const { file, accessToken, userUid } = req.body;
    if (!file || !accessToken || !userUid) return res.status(400).json({ error: "Missing data" });
    const piUser = await verifyPiUser(req, res);
    if (!piUser) return;
    const MAX_SIZE = 20 * 1024 * 1024;
    const matches = file.match(/^data:application\/pdf;base64,(.+)$/);
    if (!matches) return res.status(400).json({ success: false, error: "Invalid PDF format" });
    const base64Data = matches[1];
    const fileSize = Buffer.byteLength(base64Data, "base64");
    if (fileSize > MAX_SIZE) return res.status(400).json({ error: "PDF exceeds 20MB limit" });
    if (!file.startsWith("data:application/pdf")) return res.status(400).json({ error: "Only PDF files allowed" });
    const result = await cloudinary.v2.uploader.upload(file, {
      folder: "books/pdfs", resource_type: "raw",
      public_id: `book_${Date.now()}`, format: "pdf"
    });
    res.json({ success: true, url: result.secure_url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/save-book", async (req, res) => {
  try {
    const { title, price, description, language, pageCount, cover, pdf, owner, ownerUid, accessToken } = req.body;
    if (!accessToken) return res.status(401).json({ error: "Missing access token" });
    const piAuth = await fetch("https://api.minepi.com/v2/me", {
      method: "GET", headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!piAuth.ok) return res.status(401).json({ error: "Invalid access token" });
    const piUser = await piAuth.json();
    if (piUser.uid !== ownerUid) return res.status(403).json({ error: "User mismatch" });
    if (!title || !price || !cover || !pdf || !owner || !ownerUid) return res.status(400).json({ error: "Missing data" });
    if (!cover.includes("cloudinary.com") || !pdf.includes("cloudinary.com")) return res.status(400).json({ error: "Invalid file URLs" });
    const bookPrice = Number(price);
    if (isNaN(bookPrice) || bookPrice <= 0) return res.status(400).json({ error: "Invalid price" });
    const doc = await db.collection("books").add({
      title, price: bookPrice, description: description || "", language: language || "",
      pageCount: pageCount || "Unknown", cover, pdf,
      owner: piUser.username, ownerUid: piUser.uid,
      likes: 0, dislikes: 0, salesCount: 0, withdrawableEarnings: 0,
      approved: false, reviewed: false, reviewMessage: "", createdAt: Date.now()
    });
    await db.doc("stats/platform").set({ totalBooks: admin.firestore.FieldValue.increment(1) }, { merge: true });
    res.json({ success: true, bookId: doc.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/my-notifications", async (req, res) => {
  try {
    const { userUid, accessToken } = req.body;
    if (!userUid || !accessToken) return res.status(400).json({ error: "Missing data" });
    const piUser = await verifyPiUser(req, res);
    if (!piUser) return;
    const snap = await db.collection("books").where("ownerUid", "==", userUid).where("reviewed", "==", true).get();
    const notifications = snap.docs.map(doc => ({
      id: doc.id, title: doc.data().title,
      approved: doc.data().approved, reviewMessage: doc.data().reviewMessage || ""
    }));
    res.json({ success: true, notifications });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/book-ratings", async (req, res) => {
  try {
    const { bookId, userUid, accessToken } = req.body;
    if (!bookId || !userUid || !accessToken) return res.status(400).json({ success: false, error: "Missing data" });
    const piUser = await verifyPiUser(req, res);
    if (!piUser) return;
    const voteDoc = await db.collection("ratings").doc(bookId).collection("votes").doc(userUid).get();
    res.json({ success: true, userVote: voteDoc.exists ? voteDoc.data().vote : null });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post("/rate-book", async (req, res) => {
  try {
    const { bookId, voteType, userUid, accessToken } = req.body;
    if (!bookId || !voteType || !userUid || !accessToken) return res.status(400).json({ error: "Missing data" });
    const piUser = await verifyPiUser(req, res);
    if (!piUser) return;
    const voteRef = db.collection("ratings").doc(bookId).collection("votes").doc(userUid);
    const oldVote = await voteRef.get();
    const bookRef = db.collection("books").doc(bookId);
    await db.runTransaction(async (t) => {
      const bookSnap = await t.get(bookRef);
      if (!bookSnap.exists) throw new Error("Book not found");
      let likes = bookSnap.data().likes || 0;
      let dislikes = bookSnap.data().dislikes || 0;
      if (oldVote.exists) {
        const previous = oldVote.data().vote;
        if (previous === "like") likes--;
        if (previous === "dislike") dislikes--;
      }
      if (voteType === "like") likes++;
      if (voteType === "dislike") dislikes++;
      t.update(bookRef, { likes, dislikes });
      t.set(voteRef, { vote: voteType, votedAt: Date.now() });
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/add-comment", async (req, res) => {
  try {
    const { bookId, userUid, accessToken, text } = req.body;
    if (!bookId || !userUid || !accessToken || !text) return res.status(400).json({ error: "Missing data" });
    const piUser = await verifyPiUser(req, res);
    if (!piUser) return;
    const commentRef = db.collection("books").doc(bookId).collection("comments").doc(userUid);
    const existingComment = await commentRef.get();
    if (existingComment.exists) return res.status(400).json({ success: false, error: "You already commented on this book" });
    await commentRef.set({ userUid, username: piUser.username, text, createdAt: Date.now() });
    return res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/comments", async (req, res) => {
  try {
    const bookId = req.query.bookId;
    if (!bookId) return res.status(400).json({ error: "Missing bookId" });
    const snap = await db.collection("books").doc(bookId).collection("comments").orderBy("createdAt", "desc").get();
    const comments = snap.docs.map(d => d.data());
    res.json({ success: true, comments });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/has-comment", async (req, res) => {
  try {
    const { bookId, userUid } = req.query;
    if (!bookId || !userUid) return res.status(400).json({ success: false });
    const doc = await db.collection("books").doc(bookId).collection("comments").doc(userUid).get();
    res.json({ success: true, commented: doc.exists });
  } catch (e) { res.status(500).json({ success: false }); }
});

/* ================= PAYMENTS - APPROVE ================= */
app.post("/approve-payment", async (req, res) => {
  const { paymentId } = req.body;
  if (!paymentId) return res.status(400).json({ error: "missing paymentId" });
  try {
    const paymentInfo = await fetch(`${PI_API_URL}/payments/${paymentId}`, {
      method: "GET", headers: { Authorization: `Key ${PI_API_KEY}` }
    });
    const paymentData = await paymentInfo.json();
    const bookId = paymentData.metadata?.bookId;
    const userUid = paymentData.metadata?.userUid;
    const existingPurchase = await db.collection("purchases").doc(userUid).collection("books").doc(bookId).get();
    if (existingPurchase.exists) return res.status(400).json({ error: "Book already purchased" });
    if (!bookId || !userUid) throw new Error("Missing metadata");
    await db.collection("pendingPayments").doc(paymentId).set({
      bookId, userUid, status: "pending", createdAt: Date.now()
    });
    const response = await fetch(`${PI_API_URL}/payments/${paymentId}/approve`, {
      method: "POST", headers: { Authorization: `Key ${PI_API_KEY}` }
    });
    if (!response.ok) throw new Error(await response.text());
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ================= PAYMENTS - COMPLETE ================= */
app.post("/complete-payment", async (req, res) => {
  const { paymentId, txid } = req.body;
  if (!paymentId || !txid) return res.status(400).json({ error: "missing data" });
  try {
    const paymentInfo = await fetch(`${PI_API_URL}/payments/${paymentId}`, {
      method: "GET", headers: { Authorization: `Key ${PI_API_KEY}`, "Content-Type": "application/json" }
    });
    if (!paymentInfo.ok) throw new Error(await paymentInfo.text());
    const paymentData = await paymentInfo.json();
    const bookId = paymentData.metadata?.bookId;
    const userUid = paymentData.metadata?.userUid;
    if (!bookId || !userUid) throw new Error("Missing payment metadata");
    const response = await fetch(`${PI_API_URL}/payments/${paymentId}/complete`, {
      method: "POST",
      headers: { Authorization: `Key ${PI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ txid })
    });
    if (!response.ok) throw new Error(await response.text());
    const bookRef = db.collection("books").doc(bookId);
    const purchaseRef = db.collection("purchases").doc(userUid).collection("books").doc(bookId);
    await db.runTransaction(async (t) => {
      const existingPurchase = await t.get(purchaseRef);
      if (existingPurchase.exists) throw new Error("Book already purchased");
      const bookSnap = await t.get(bookRef);
      const price = Number(bookSnap.data().price || 0);
      const sellerProfit = price * 0.7;
      const platformProfit = price * 0.3;
      t.update(bookRef, {
        salesCount: admin.firestore.FieldValue.increment(1),
        withdrawableEarnings: admin.firestore.FieldValue.increment(sellerProfit)
      });
      t.set(db.doc("stats/platform"), { platformProfit: admin.firestore.FieldValue.increment(platformProfit) }, { merge: true });
      t.set(purchaseRef, { purchasedAt: Date.now() });
    });
    await db.collection("pendingPayments").doc(paymentId).delete();
    const bookSnap = await bookRef.get();
    res.json({ success: true, pdfUrl: bookSnap.data().pdf });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ================= PURCHASES ================= */
app.post("/my-purchases", async (req, res) => {
  try {
    const { userUid, accessToken } = req.body;
    if (!userUid || !accessToken) return res.status(400).json({ error: "Missing data" });
    const piUser = await verifyPiUser(req, res);
    if (!piUser) return;
    const snap = await db.collection("purchases").doc(userUid).collection("books").orderBy("purchasedAt", "desc").get();
    const books = [];
    for (const d of snap.docs) {
      const b = await db.collection("books").doc(d.id).get();
      if (b.exists) books.push({ id: b.id, ...b.data() });
    }
    res.json({ success: true, books });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/get-pdf", async (req, res) => {
  try {
    const { bookId, userUid, accessToken } = req.body;
    if (!bookId || !userUid || !accessToken) return res.status(400).json({ error: "Missing data" });
    const piUser = await verifyPiUser(req, res);
    if (!piUser) return;
    const p = await db.collection("purchases").doc(userUid).collection("books").doc(bookId).get();
    if (!p.exists) return res.status(403).json({ error: "Not purchased" });
    const book = await db.collection("books").doc(bookId).get();
    if (!book.exists) return res.status(404).json({ error: "Book not found" });
    res.json({ success: true, pdfUrl: book.data().pdf });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/my-sales", async (req, res) => {
  try {
    const { userUid, accessToken } = req.body;
    if (!userUid || !accessToken) return res.status(400).json({ error: "Missing data" });
    const piUser = await verifyPiUser(req, res);
    if (!piUser) return;
    const snap = await db.collection("books").where("ownerUid", "==", userUid).get();
    const books = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ success: true, books });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/check-purchase", async (req, res) => {
  try {
    const { userUid, bookId, accessToken } = req.body;
    if (!userUid || !bookId || !accessToken) return res.status(400).json({ error: "Missing data" });
    const piUser = await verifyPiUser(req, res);
    if (!piUser) return;
    const purchaseDoc = await db.collection("purchases").doc(userUid).collection("books").doc(bookId).get();
    res.json({ success: true, purchased: purchaseDoc.exists });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/pending-payments", async (req, res) => {
  const userUid = String(req.query.userUid || "");
  if (!userUid) return res.status(400).json({ success: false, error: "missing userUid" });
  try {
    const snap = await db.collection("pendingPayments").where("userUid", "==", userUid).get();
    const pendingPayments = snap.docs.map(doc => ({ id: doc.id, bookId: doc.data().bookId }));
    res.json({ success: true, pendingPayments });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

/* ================================================================
 * =================== PAYOUT SYSTEM (A2U صحيح) ==================
 *
 * المنطق الصحيح لـ A2U في Pi Network:
 * - السيرفر فقط هو من ينشئ ويرسل ويُكمل دفعة A2U
 * - Pi.createPayment() في SDK هي للمستخدم يدفع للتطبيق فقط (U2A)
 * - onIncompletePaymentFound لا يُطلق لدفعات A2U
 * - الدفعات المعلقة تُعالج من السيرفر عبر /payments/incomplete_server_payments
 *
 * الخطوات الصحيحة:
 * 1. /request-payout:  يحسب المبلغ → يحل المعلق → ينشئ دفعة → يرسل → يُكمل → يصفّر
 * 2. /resolve-incomplete-payouts: يحل الدفعات المعلقة (يُستدعى عند بدء التطبيق)
 * 3. /cancel-incomplete-payouts: يلغي الدفعات المعلقة (للحالات الطارئة)
 * ================================================================ */

/* ================= HELPER: حل الدفعات المعلقة ================= */
async function resolveIncompletePayout(payment) {
  const paymentId = payment.identifier;
  const userUid   = payment.metadata?.userUid;
  const amount    = payment.amount;

  if (!userUid) {
    console.warn(`Incomplete payout ${paymentId} has no userUid in metadata — skipping`);
    return { skipped: true };
  }

  // إذا لم تكن هناك معاملة بلوكشين بعد → ألغِها
  if (!payment.transaction?.txid) {
    console.log(`Cancelling incomplete payout ${paymentId} (no blockchain tx yet)`);
    try {
      const cancelRes = await fetch(`${PI_API_URL}/payments/${paymentId}/cancel`, {
        method: "POST",
        headers: { Authorization: `Key ${PI_API_KEY}`, "Content-Type": "application/json" }
      });
      // سواء نجح الإلغاء أو لا، نمسح القفل
      console.log(`Cancel result for ${paymentId}:`, cancelRes.status);
    } catch (e) {
      console.warn(`Failed to cancel payment ${paymentId}:`, e.message);
    }
    // مسح القفل من Firestore في كلا الحالتين
    await db.collection("payoutLocks").doc(userUid).delete().catch(() => {});
    await db.collection("pendingPayouts").doc(paymentId).delete().catch(() => {});
    return { cancelled: true, paymentId };
  }

  // إذا كانت هناك معاملة بلوكشين موجودة → أكملها
  const txid = payment.transaction.txid;
  console.log(`Completing incomplete payout ${paymentId} with txid ${txid}`);

  const completeRes = await fetch(`${PI_API_URL}/payments/${paymentId}/complete`, {
    method: "POST",
    headers: { Authorization: `Key ${PI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ txid })
  });

  if (!completeRes.ok) {
    const errText = await completeRes.text();
    console.error(`Failed to complete payout ${paymentId}:`, errText);
    throw new Error(errText);
  }

  // تصفير الأرباح وتسجيل السحب
  const booksSnap = await db.collection("books").where("ownerUid", "==", userUid).get();
  const batch = db.batch();
  booksSnap.forEach(doc => batch.update(doc.ref, { withdrawableEarnings: 0 }));
  await batch.commit();

  const payoutRef = db.collection("payouts").doc(paymentId);
  const payoutDoc = await payoutRef.get();
  if (!payoutDoc.exists) {
    await payoutRef.set({
      userUid, amount: Number(amount), txid, paidAt: Date.now(), resolvedFromIncomplete: true
    });
    await db.doc("stats/platform").set(
      { totalPayouts: admin.firestore.FieldValue.increment(Number(amount)) },
      { merge: true }
    );
  }

  await db.collection("pendingPayouts").doc(paymentId).delete().catch(() => {});
  await db.collection("payoutLocks").doc(userUid).delete().catch(() => {});

  return { completed: true, paymentId, txid, amount };
}

/* ================================================================
 * /request-payout
 * السيرفر ينفذ كل خطوات A2U كاملةً في طلب واحد:
 * 1. يحل أي دفعات معلقة أولاً
 * 2. يحسب المبلغ ويتحقق من الحد الأدنى
 * 3. ينشئ دفعة Pi A2U
 * 4. يرسل المعاملة على البلوكشين
 * 5. يُكمل الدفعة
 * 6. يصفّر الأرباح ويحفظ السجل
 * ================================================================ */
app.post("/request-payout", async (req, res) => {
  const { userUid, accessToken } = req.body;

  if (!userUid || !accessToken) {
    return res.status(400).json({ success: false, error: "Missing data" });
  }

  // التحقق من هوية المستخدم
  const piUser = await verifyPiUser(req, res);
  if (!piUser) return;

  /* ── الخطوة 1: حل أي دفعات A2U معلقة على مستوى التطبيق ── */
  try {
    const incompleteRes = await fetch(`${PI_API_URL}/payments/incomplete_server_payments`, {
      method: "GET",
      headers: { Authorization: `Key ${PI_API_KEY}` }
    });
    if (incompleteRes.ok) {
      const incompleteData = await incompleteRes.json();
      const payments = incompleteData.incomplete_server_payments || [];

      // نعالج فقط المعلقات الخاصة بهذا المستخدم
      const userPending = payments.filter(p => p.metadata?.userUid === userUid && p.metadata?.type === "payout");

      for (const payment of userPending) {
        try {
          await resolveIncompletePayout(payment);
        } catch (e) {
          console.error("Error resolving incomplete payout:", e.message);
        }
      }
    }
  } catch (e) {
    console.warn("Could not fetch incomplete payments:", e.message);
    // لا نوقف العملية — نكمل
  }

  /* ── الخطوة 2: التحقق من القفل ── */
  const payoutLockRef = db.collection("payoutLocks").doc(userUid);
  const existingLock  = await payoutLockRef.get();

  if (existingLock.exists) {
    const createdAt = existingLock.data().createdAt || 0;
    const ageMs     = Date.now() - createdAt;
    // إذا القفل أقل من 5 دقائق → رفض
    if (ageMs < 5 * 60 * 1000) {
      return res.status(400).json({ success: false, error: "Payout already processing, please wait a moment" });
    }
    // إذا القفل قديم جداً → احذفه ونكمل
    await payoutLockRef.delete();
  }

  /* ── الخطوة 3: حساب الأرباح ── */
  const booksSnap = await db.collection("books").where("ownerUid", "==", userUid).get();
  let totalEarnings = 0;
  booksSnap.forEach(doc => { totalEarnings += Number(doc.data().withdrawableEarnings || 0); });

  if (totalEarnings < 5) {
    return res.status(400).json({ success: false, error: "Minimum payout is 5 Pi" });
  }

  const amount = parseFloat(totalEarnings.toFixed(7)); // Pi يقبل حتى 7 خانات عشرية

  /* ── الخطوة 4: وضع القفل ── */
  await payoutLockRef.set({ createdAt: Date.now(), amount, status: "processing" });

  let paymentId = null;

  try {
    /* ── الخطوة 5: إنشاء دفعة A2U ── */
    const createRes = await fetch(`${PI_API_URL}/payments`, {
      method: "POST",
      headers: { Authorization: `Key ${PI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        payment: {
          amount,
          memo: "Spicy Library - Author Earnings Payout",
          metadata: { type: "payout", userUid, username: piUser.username },
          uid: userUid
        }
      })
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      await payoutLockRef.delete();
      return res.status(500).json({ success: false, error: "Failed to create payment: " + errText });
    }

    const createData = await createRes.json();
    paymentId = createData.identifier;

    if (!paymentId) {
      await payoutLockRef.delete();
      return res.status(500).json({ success: false, error: "No paymentId returned from Pi" });
    }

    // حفظ في Firestore
    await db.collection("pendingPayouts").doc(paymentId).set({
      userUid, username: piUser.username, amount,
      status: "created", createdAt: Date.now()
    });

    /* ── الخطوة 6: إرسال المعاملة على البلوكشين ── */
    // ملاحظة: Pi API v2 يتعامل مع الـ submit تلقائياً بعد approve في A2U
    // نحتاج فقط approve ثم Pi يرسل على البلوكشين
    // نحن نستطع استخدام approve ثم نتحقق من الـ txid

    // للـ A2U، نحتاج approve أولاً (اختياري، لأنه تلقائي، لكن نفعله صراحةً)
    const approveRes = await fetch(`${PI_API_URL}/payments/${paymentId}/approve`, {
      method: "POST",
      headers: { Authorization: `Key ${PI_API_KEY}` }
    });
    // approve قد يُرجع 200 حتى لو لم يكن ضرورياً في A2U

    /* ── الخطوة 7: انتظار البلوكشين والحصول على txid ── */
    // Pi يرسل المعاملة على البلوكشين تلقائياً بعد إنشاء الدفعة A2U
    // نحتاج أن ننتظر ونتحقق من حالة الدفعة للحصول على txid
    let txid = null;
    let attempts = 0;
    const maxAttempts = 15; // ننتظر حتى 30 ثانية

    while (!txid && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000)); // ننتظر ثانيتين
      attempts++;

      const checkRes = await fetch(`${PI_API_URL}/payments/${paymentId}`, {
        method: "GET",
        headers: { Authorization: `Key ${PI_API_KEY}` }
      });

      if (checkRes.ok) {
        const checkData = await checkRes.json();
        if (checkData.transaction?.txid) {
          txid = checkData.transaction.txid;
          break;
        }
        // إذا اكتملت بالفعل
        if (checkData.status?.developer_completed) {
          txid = checkData.transaction?.txid || "already_completed";
          break;
        }
        // إذا ألغيت
        if (checkData.status?.cancelled) {
          throw new Error("Payment was cancelled by Pi Network");
        }
      }
    }

    if (!txid) {
      // حفظ paymentId لمعالجته لاحقاً
      await db.collection("pendingPayouts").doc(paymentId).update({ status: "awaiting_txid" });
      await payoutLockRef.delete();
      return res.status(202).json({
        success: false,
        pending: true,
        paymentId,
        error: "Payment is being processed on blockchain. It will complete automatically."
      });
    }

    /* ── الخطوة 8: إكمال الدفعة ── */
    const completeRes = await fetch(`${PI_API_URL}/payments/${paymentId}/complete`, {
      method: "POST",
      headers: { Authorization: `Key ${PI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ txid })
    });

    if (!completeRes.ok) {
      const errText = await completeRes.text();
      throw new Error("Failed to complete payment: " + errText);
    }

    /* ── الخطوة 9: تصفير الأرباح وتسجيل السحب ── */
    const batch = db.batch();
    booksSnap.forEach(doc => batch.update(doc.ref, { withdrawableEarnings: 0 }));
    await batch.commit();

    await db.collection("payouts").add({ userUid, amount, txid, paidAt: Date.now() });
    await db.doc("stats/platform").set(
      { totalPayouts: admin.firestore.FieldValue.increment(amount) },
      { merge: true }
    );

    await db.collection("pendingPayouts").doc(paymentId).delete().catch(() => {});
    await payoutLockRef.delete().catch(() => {});

    return res.json({ success: true, txid, amount });

  } catch (err) {
    console.error("Payout error:", err.message);
    // مسح القفل دائماً عند الخطأ
    await payoutLockRef.delete().catch(() => {});
    if (paymentId) {
      await db.collection("pendingPayouts").doc(paymentId)
        .update({ status: "error", error: err.message }).catch(() => {});
    }
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ================================================================
 * /resolve-incomplete-payouts
 * يُستدعى عند بدء التطبيق أو يدوياً لحل كل الدفعات المعلقة
 * ================================================================ */
app.post("/resolve-incomplete-payouts", async (req, res) => {
  const { userUid, accessToken } = req.body;
  if (!userUid || !accessToken) return res.status(400).json({ error: "Missing data" });

  const piUser = await verifyPiUser(req, res);
  if (!piUser) return;

  try {
    const incompleteRes = await fetch(`${PI_API_URL}/payments/incomplete_server_payments`, {
      method: "GET",
      headers: { Authorization: `Key ${PI_API_KEY}` }
    });

    if (!incompleteRes.ok) {
      return res.status(500).json({ success: false, error: "Failed to fetch incomplete payments" });
    }

    const incompleteData = await incompleteRes.json();
    const payments = incompleteData.incomplete_server_payments || [];

    // نعالج فقط المعلقات الخاصة بهذا المستخدم من نوع payout
    const userPending = payments.filter(
      p => p.metadata?.userUid === userUid && p.metadata?.type === "payout"
    );

    if (userPending.length === 0) {
      // لا يوجد معلق → امسح القفل إن وجد
      await db.collection("payoutLocks").doc(userUid).delete().catch(() => {});
      return res.json({ success: true, resolved: 0, message: "No pending payouts found" });
    }

    const results = [];
    for (const payment of userPending) {
      try {
        const result = await resolveIncompletePayout(payment);
        results.push(result);
      } catch (e) {
        results.push({ error: e.message, paymentId: payment.identifier });
      }
    }

    return res.json({ success: true, resolved: results.length, results });

  } catch (err) {
    console.error("Resolve incomplete payouts error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ================================================================
 * /force-unlock-payout
 * يُستدعى إذا علق المستخدم ولا يستطيع السحب
 * يتحقق أولاً من وجود معلق حقيقي، وإلا يحذف القفل
 * ================================================================ */
app.post("/force-unlock-payout", async (req, res) => {
  const { userUid, accessToken } = req.body;
  if (!userUid || !accessToken) return res.status(400).json({ error: "Missing data" });

  const piUser = await verifyPiUser(req, res);
  if (!piUser) return;

  try {
    // أولاً: حاول حل المعلقات
    const incompleteRes = await fetch(`${PI_API_URL}/payments/incomplete_server_payments`, {
      method: "GET", headers: { Authorization: `Key ${PI_API_KEY}` }
    });

    if (incompleteRes.ok) {
      const incompleteData = await incompleteRes.json();
      const payments = (incompleteData.incomplete_server_payments || [])
        .filter(p => p.metadata?.userUid === userUid && p.metadata?.type === "payout");

      for (const payment of payments) {
        try { await resolveIncompletePayout(payment); } catch (e) { console.error(e); }
      }
    }

    // احذف القفل في كل الأحوال
    await db.collection("payoutLocks").doc(userUid).delete().catch(() => {});
    // احذف pendingPayouts القديمة لهذا المستخدم
    const pendingSnap = await db.collection("pendingPayouts").where("userUid", "==", userUid).get();
    const batch = db.batch();
    pendingSnap.forEach(doc => batch.delete(doc.ref));
    if (!pendingSnap.empty) await batch.commit();

    return res.json({ success: true, message: "Payout lock cleared" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

/* ================= PLATFORM STATS ================= */
app.get("/platform-stats", async (req, res) => {
  try {
    const statsDoc = await db.doc("stats/platform").get();
    const stats = statsDoc.exists ? statsDoc.data() : {};
    const approvedBooks = await db.collection("books").where("approved", "==", true).get();
    const reviewedBooks = await db.collection("books").where("reviewed", "==", true).get();
    stats.approvedBooks = approvedBooks.size;
    stats.reviewedBooks = reviewedBooks.size;
    await db.doc("stats/platform").set({ approvedBooks: approvedBooks.size, reviewedBooks: reviewedBooks.size }, { merge: true });
    res.json({ success: true, stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Backend running on port", PORT));
