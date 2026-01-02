import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json());

const PI_API_KEY = process.env.PI_API_KEY;
if (!PI_API_KEY) { console.error("PI_API_KEY missing"); process.exit(1); }

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

app.get("/", (req, res) => res.send("Backend running securely"));

app.post("/approve-payment", async (req, res) => {
  // Your approve code
});

app.post("/complete-payment", async (req, res) => {
  const { paymentId, txid, bookId, userUid } = req.body;
  // Complete Pi payment
  // Then transactionally update Firestore: increment salesCount, add purchase
  // Return pdfUrl to frontend
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server on ${port}`));
