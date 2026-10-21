import mongoose, { type ClientSession } from "mongoose";
import { AppError } from "../errors/app.error";

export async function transaction<T>(
  run: (session: ClientSession) => Promise<T>,
) {
  try {
    return await mongoose.connection.transaction(run, {
      readConcern: { level: "snapshot" },
      writeConcern: { w: "majority" },
    });
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoServerError && error.code === 20)
      throw new AppError(
        503,
        "transactions_unavailable",
        "Checkout requires a MongoDB replica set. Check the database configuration.",
      );
    throw error;
  }
}
