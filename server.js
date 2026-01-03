import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import fetch from "node-fetch";
import dotenv from "dotenv";
import bodyParser from "body-parser";
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));
app.use(bodyParser.json());

// ====== Firebase Admin Setup ======
let db = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        db = admin.firestore();
        console.log("✅ Firebase Admin initialized");
    } catch (err) {
        console.error("Firebase Admin init failed:", err.message);
    }
} else {
    console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT not set");
}

// ====== Pi API Key ======
const PI_API_KEY = process.env.PI_API_KEY;
if (!PI_API_KEY) {
    console.error("❌ PI_API_KEY missing");
    process.exit(1);
}

// ====== Middleware: Verify Pi Token ======
async function verifyPiToken(req, res, next) {
    const token = req.headers.authorization;
    if (!token) return res.status(401).json({ error: "Missing authorization header" });

    try {
        // Verify with Pi API (sandbox/mainnet)
        const response = await fetch(`https://api.minepi.com/v2/accounts/verify`, {
            method: "POST",
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
        });
        if (!response.ok) throw new Error("Token invalid");
        const data = await response.json();
        req.user = { username: data.username, uid: data.uid };
        next();
    } catch (err) {
        return res.status(401).json({ error: "Unauthorized: " + err.message });
    }
}

// ====== Test Server ======
app.get("/", (req,res)=>res.send("✅ Backend running"));

// ====== Endpoints ======

// GET all books
app.get("/books", async (req,res)=>{
    try {
        const snap = await db.collection("books").get();
        const books = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.json({ success: true, books });
    } catch(err){
        res.status(500).json({ error: err.message });
    }
});

// POST: Save book
app.post("/save-book", verifyPiToken, async (req,res)=>{
    const { title, price, description, language, pageCount, cover, pdf } = req.body;
    if (!title || !price || !cover || !pdf) return res.status(400).json({ error: "Missing fields" });

    try {
        const docRef = await db.collection("books").add({
            title, price: Number(price), description: description||"", language: language||"", pageCount: pageCount||"Unknown",
            cover, pdf, owner: req.user.username, ownerUid: req.user.uid, salesCount: 0, createdAt: Date.now()
        });
        res.json({ success: true, bookId: docRef.id });
    } catch(err){
        res.status(500).json({ error: err.message });
    }
});

// POST: Approve payment
app.post("/approve-payment", verifyPiToken, async (req,res)=>{
    const { paymentId } = req.body;
    if (!paymentId) return res.status(400).json({ error: "paymentId missing" });

    try {
        const response = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/approve`, {
            method: "POST",
            headers: { Authorization: `Key ${PI_API_KEY}` }
        });
        if (!response.ok) throw new Error(await response.text());
        res.json({ success:true });
    } catch(err){
        res.status(500).json({ error: err.message });
    }
});

// POST: Complete payment
app.post("/complete-payment", verifyPiToken, async (req,res)=>{
    const { paymentId, txid, bookId } = req.body;
    if (!paymentId || !txid || !bookId) return res.status(400).json({ error: "Missing data" });

    try {
        const response = await fetch(`https://api.minepi.com/v2/payments/${paymentId}/complete`, {
            method: "POST",
            headers: { Authorization: `Key ${PI_API_KEY}` },
            body: JSON.stringify({ txid })
        });
        if (!response.ok) throw new Error(await response.text());

        const bookRef = db.collection("books").doc(bookId);
        await db.runTransaction(async (t)=>{
            t.update(bookRef, { salesCount: admin.firestore.FieldValue.increment(1) });
        });

        const bookSnap = await bookRef.get();
        res.json({ success:true, pdfUrl: bookSnap.data().pdf });
    } catch(err){
        res.status(500).json({ error: err.message });
    }
});

// POST: Get user purchases
app.post("/purchases", verifyPiToken, async (req,res)=>{
    try {
        const purchasesSnap = await db.collection("purchases").doc(req.user.uid).collection("books").get();
        const purchases = purchasesSnap.docs.map(doc=>doc.id);
        const books = await Promise.all(purchases.map(async bookId=>{
            const snap = await db.collection("books").doc(bookId).get();
            return { id: bookId, ...snap.data() };
        }));
        res.json({ success:true, purchases: books });
    } catch(err){
        res.status(500).json({ error: err.message });
    }
});

// POST: Get user sales
app.post("/sales", verifyPiToken, async (req,res)=>{
    try {
        const snap = await db.collection("books").where("ownerUid","==",req.user.uid).get();
        const sales = snap.docs.map(doc=>({ id: doc.id, ...doc.data() }));
        res.json({ success:true, sales });
    } catch(err){
        res.status(500).json({ error: err.message });
    }
});

// POST: Reset sales (admin or owner)
app.post("/reset-sales", verifyPiToken, async (req,res)=>{
    try {
        const snap = await db.collection("books").where("ownerUid","==",req.user.uid).get();
        const batch = db.batch();
        snap.forEach(doc=>batch.update(doc.ref,{ salesCount:0 }));
        await batch.commit();
        res.json({ success:true });
    } catch(err){
        res.status(500).json({ error: err.message });
    }
});

// POST: Get PDF after purchase
app.post("/get-pdf", verifyPiToken, async (req,res)=>{
    const { bookId } = req.body;
    try {
        const purchaseSnap = await db.collection("purchases").doc(req.user.uid).collection("books").doc(bookId).get();
        if (!purchaseSnap.exists) return res.status(403).json({ error: "Not purchased" });
        const bookSnap = await db.collection("books").doc(bookId).get();
        res.json({ success:true, pdfUrl: bookSnap.data().pdf });
    } catch(err){
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`🚀 Server running on port ${PORT}`));
