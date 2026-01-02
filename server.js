import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json());

// 🔑 Pi Server API Key من Environment Variable
const PI_API_KEY = process.env.PI_API_KEY;

// حماية إضافية
if (!PI_API_KEY) {
  console.error("❌ PI_API_KEY is missing");
  process.exit(1);
}

// Initialize Firebase Admin SDK من Environment Variable
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (err) {
  console.error("❌ Invalid or missing FIREBASE_SERVICE_ACCOUNT JSON");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Route اختبار
app.get("/", (req, res) => {
  res.send("Pi-backend is running securely ✅");
});

// ================== APPROVE PAYMENT ==================
app.post("/approve-payment", async (req, res) => {
  const { paymentId } = req.body;

  if (!paymentId) {
    return res.status(400).json({ error: "paymentId missing" });
  }

  try {
    const response = await fetch(
      `https://api.minepi.com/v2/payments/${paymentId}/approve`,
      {
        method: "POST",
        headers: {
          Authorization: `Key ${PI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(JSON.stringify(errorData));
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Approve error:", err.message);
    res.status(500).json({ error: "Server error during approval" });
  }
});

// ================== COMPLETE PAYMENT + UPDATE FIRESTORE ==================
app.post("/complete-payment", async (req, res) => {
  const { paymentId, txid, bookId, userUid } = req.body;

  if (!paymentId || !txid || !bookId || !userUid) {
    return res.status(400).json({ error: "Missing required fields: paymentId, txid, bookId, userUid" });
  }

  try {
    // Complete the payment on Pi side
    const response = await fetch(
      `https://api.minepi.com/v2/payments/${paymentId}/complete`,
      {
        method: "POST",
        headers: {
          Authorization: `Key ${PI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ txid })
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(JSON.stringify(errorData));
    }

    const piData = await response.json();

    // Securely update Firestore from backend (bypasses client-side rules)
    const bookRef = db.collection("books").doc(bookId);
    const purchaseRef = db.collection("purchases").doc(userUid).collection("books").doc(bookId);

    await db.runTransaction(async (transaction) => {
      const bookDoc = await transaction.get(bookRef);
      if (!bookDoc.exists) {
        throw new Error("Book does not exist");
      }

      transaction.update(bookRef, {
        salesCount: admin.firestore.FieldValue.increment(1)
      });
      transaction.set(purchaseRef, {
        purchasedAt: Date.now()
      });
    });

    // Return the PDF URL securely to the frontend
    const bookSnap = await bookRef.get();
    const pdfUrl = bookSnap.data().pdf;

    res.json({ success: true, pdfUrl });
  } catch (err) {
    console.error("Complete payment error:", err.message);
    res.status(500).json({ error: "Server error during payment completion" });
  }
});

// ================== SECURE PDF DOWNLOAD (verify purchase) ==================
app.post("/get-pdf", async (req, res) => {
  const { bookId, userUid } = req.body;

  if (!bookId || !userUid) {
    return res.status(400).json({ error: "bookId or userUid missing" });
  }

  try {
    const purchaseSnap = await db.collection("purchases").doc(userUid).collection("books").doc(bookId).get();

    if (!purchaseSnap.exists) {
      return res.status(403).json({ error: "Access denied: You have not purchased this book" });
    }

    const bookSnap = await db.collection("books").doc(bookId).get();
    if (!bookSnap.exists) {
      return res.status(404).json({ error: "Book not found" });
    }

    const pdfUrl = bookSnap.data().pdf;
    res.json({ success: true, pdfUrl });
  } catch (err) {
    console.error("Get PDF error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// ================== CREATE FIREBASE CUSTOM TOKEN (for frontend auth) ==================
app.post("/create-firebase-token", async (req, res) => {
  const { access_token, uid } = req.body;

  if (!access_token || !uid) {
    return res.status(400).json({ error: "access_token or uid missing" });
  }

  try {
    // Optional: Verify Pi access_token (extra security)
    const piRes = await fetch("https://api.minepi.com/v2/me", {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    if (!piRes.ok) throw new Error("Invalid Pi token");
    const piUser = await piRes.json();
    if (piUser.uid !== uid) throw new Error("UID mismatch");

    // Create Firebase custom token
    const customToken = await admin.auth().createCustomToken(uid);
    res.json({ customToken });
  } catch (err) {
    console.error("Firebase token error:", err.message);
    res.status(401).json({ error: "Authentication failed" });
  }
});

// ================== START SERVER ==================
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Secure server running on port ${port}`);
});
