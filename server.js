import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import admin from "firebase-admin";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PI_API_KEY = process.env.PI_API_KEY;
if (!PI_API_KEY) {
  console.error("❌ PI_API_KEY is missing!");
  process.exit(1);
}

// Firebase Admin Initialization with private_key fix
let db = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    let serviceAccountStr = process.env.FIREBASE_SERVICE_ACCOUNT;
    // Fix escaped newlines
    serviceAccountStr = serviceAccountStr.replace(/\\n/g, '\n');
    const serviceAccount = JSON.parse(serviceAccountStr);
    admin.initializeApp({
      credential: admin.credential.cert(service
