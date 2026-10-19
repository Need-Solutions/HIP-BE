import cors, { CorsOptions } from "cors";
import { Application } from "express";
import { ENV } from "../config/env";

const allowedOrigins = ENV.CLIENT_URL;
const corsOptions: CorsOptions = {
  credentials: true,
  origin: allowedOrigins,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

const handleCors = (app: Application) => {
  app.use(cors(corsOptions));
};

export { allowedOrigins };
export default handleCors;
