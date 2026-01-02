import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json());

// PI_API_KEY من Environment Variable
const PI_API_KEY = process.env.PI_API_KEY;

if (!PI_API_KEY) {
  console.error("❌ PI_API_KEY is missing");
  process.exit(1);
}

// Firebase Admin من Environment Variable (string JSON)
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (err) {
  console.error("❌ Invalid FIREBASE_SERVICE_ACCOUNT JSON");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// Test route
app.get("/", (req, res) => {
  res.send("Pi-backend is running securely ✅");
});

// Approve payment
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
      const errorData = await response.json();
      throw new Error(JSON.stringify(errorData));
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Approve error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// Complete payment + update Firebase securely
app.post("/complete-payment", async (req, res) => {
  const { paymentId, txid, bookId, userUid } = req.body;

  if (!paymentId || !txid || !bookId || !userUid) {
    return res.status(400).json({ error: "Missing required fields" });
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
      const errorData = await response.json();
      throw new Error(JSON.stringify(errorData));
    }

    const data = await response.json();

    // Update Firestore from backend (bypasses client rules)
    const bookRef = db.collection("books").doc(bookId);
    const purchaseRef = db.collection("purchases").doc(userUid).collection("books").doc(bookId);

    await db.runTransaction(async (t) => {
      const bookDoc = await t.get(bookRef);
      if (!bookDoc.exists) throw new Error("Book not found");

      t.update(bookRef, { salesCount: admin.firestore.FieldValue.increment(1) });
      t.set(purchaseRef, { purchasedAt: Date.now() });
    });

    // Get PDF URL
    const bookSnap = await bookRef.get();
    const pdfUrl = bookSnap.data().pdf;

    res.json({ success: true, pdfUrl });
  } catch (err) {
    console.error("Complete error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// Secure PDF download (verify purchase first)
app.post("/get-pdf", async (req, res) => {
  const { bookId, userUid } = req.body;
  if (!bookId || !userUid) return res.status(400).json({ error: "Missing fields" });

  try {
    const purchaseSnap = await db.collection("purchases").doc(userUid).collection("books").doc(bookId).get();
    if (!purchaseSnap.exists) return res.status(403).json({ error: "Not purchased" });

    const bookSnap = await db.collection("books").doc(bookId).get();
    if (!bookSnap.exists) return res.status(404).json({ error: "Book not found" });

    res.json({ success: true, pdfUrl: bookSnap.data().pdf });
  } catch (err) {
    console.error("Get PDF error:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
