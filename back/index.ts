import express from "express";
import cors from "cors";
import propertyRoutes from "./routes/propertyRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import helmet from "helmet";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import compression from "compression";

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

app.use(helmet());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);


app.set("trust proxy", 1);

// -------------------- Compression --------------------
app.use(compression());



app.use(
  cors({
    origin: [
      "http://localhost:3000",
      "http://localhost:3001",
      "https://rms-ze-front.vercel.app",
      "https://rms-front-git-main-draxs-projects-939fc184.vercel.app",
      "https://hampilabs.com",
      "https://sohraa.com",
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization"], // 🔥 REQUIRED
  })
);

app.use(helmet());


app.use(express.json());

app.use("/api/users", userRoutes);
app.use("/api/properties", propertyRoutes);

app.listen(port, () => {
  console.log(`HMS server running on http://localhost:${port}`);
});
