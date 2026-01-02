import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json());

// PI_API_KEY from env
const PI_API_KEY = process.env.PI_API_KEY;

if (!PI_API_KEY) {
  console.error("❌ PI_API_KEY is missing");
  process.exit(1);
}

// Initialize Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: "spicy-97f54"
});
const db = admin.firestore();

// Rate limiting (simple in-memory, for production use redis)
const rateLimit = new Map();
app.use((req, res, next) => {
  const ip = req.ip;
  const now = Date.now();
  const window = 15 * 60 * 1000; // 15 min
  const limit = 100;

  if (!rateLimit.has(ip)) rateLimit.set(ip, []);
  const requests = rateLimit.get(ip).filter(t => now - t < window);
  rateLimit.set(ip, [...requests, now]);

  if (requests.length >= limit) {
    return res.status(429).json({ error: "Too many requests" });
  }
  next();
});

// Test route
app.get("/", (req, res) => {
  res.send("Pi-backend is running ✅");
});

// Approve payment
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
    console.error("Approve error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Complete payment and update Firebase
app.post("/complete-payment", async (req, res) => {
  const { paymentId, txid, bookId, userUid } = req.body; // Add bookId and userUid from frontend metadata

  if (!paymentId || !txid || !bookId || !userUid) {
    return res.status(400).json({ error: "Missing parameters" });
  }

  try {
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

    const data = await response.json();

    // Securely update Firebase from backend
    const bookRef = db.collection("books").doc(bookId);
    const purchaseRef = db.collection("purchases").doc(userUid).collection("books").doc(bookId);

    await admin.firestore().runTransaction(async (transaction) => {
      const bookDoc = await transaction.get(bookRef);
      if (!bookDoc.exists) throw new Error("Book not found");

      const newSales = (bookDoc.data().salesCount || 0) + 1;
      transaction.update(bookRef, { salesCount: newSales });
      transaction.set(purchaseRef, { purchasedAt: Date.now() });
    });

    // Get PDF URL securely (only after purchase)
    const bookSnap = await bookRef.get();
    const pdfUrl = bookSnap.data().pdf;

    res.json({ success: true, data, pdfUrl }); // Send PDF URL back to frontend
  } catch (err) {
    console.error("Complete error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// New route for secure PDF download (verify purchase before serving URL or stream)
app.post("/get-pdf", async (req, res) => {
  const { bookId, userUid } = req.body;

  if (!bookId || !userUid) {
    return res.status(400).json({ error: "Missing parameters" });
  }

  try {
    const purchaseDoc = await db.collection("purchases").doc(userUid).collection("books").doc(bookId).get();
    if (!purchaseDoc.exists) {
      return res.status(403).json({ error: "You haven't purchased this book" });
    }

    const bookDoc = await db.collection("books").doc(bookId).get();
    if (!bookDoc.exists) {
      return res.status(404).json({ error: "Book not found" });
    }

    const pdfUrl = bookDoc.data().pdf;
    res.json({ success: true, pdfUrl });
  } catch (err) {
    console.error("Get PDF error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
