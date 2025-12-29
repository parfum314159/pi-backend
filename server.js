import express from "express";
import fetch from "node-fetch";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

const PI_API_KEY = "rirfrpwufllqrsfglgjirmzlupczahsigogivq5zv7rupau0cnplf3q8vpkx2bij";

app.post("/approve-payment", async (req, res) => {
  const { paymentId } = req.body;

  try {
    const r = await fetch(
      `https://api.minepi.com/v2/payments/${paymentId}/approve`,
      {
        method: "POST",
        headers: {
          Authorization: `Key ${PI_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );
    const data = await r.json();
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port", port));
