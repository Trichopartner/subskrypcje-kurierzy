import prisma from "../db.server";
import { appLog } from "./appLogger.server";

export type DatabaseHealthResult = {
  ok: boolean;
  reason?: string;
  sessionCount?: number;
  error?: string;
};

export const checkDatabaseHealth = async (): Promise<DatabaseHealthResult> => {
  if (!process.env.DATABASE_URL?.trim()) {
    return {
      ok: false,
      reason: "DATABASE_URL_MISSING",
      error: "Zmienna DATABASE_URL nie jest ustawiona na serwerze (Vercel → Environment Variables).",
    };
  }

  try {
    const sessionCount = await prisma.session.count();
    return { ok: true, sessionCount };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appLog.error("dbHealth:check-failed", { message });

    return {
      ok: false,
      reason: "DATABASE_CONNECTION_OR_SCHEMA_ERROR",
      error: message,
    };
  }
};
