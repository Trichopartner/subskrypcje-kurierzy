import pkg from "@prisma/client";

import type { PrismaClient as PrismaClientType } from "@prisma/client";

const { PrismaClient } = pkg;

const prismaClientSingleton = (): PrismaClientType => {
  return new PrismaClient({
    datasourceUrl: process.env.DATABASE_URL,
  });
};

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClientType | undefined;
}

const prisma = globalThis.prismaGlobal ?? prismaClientSingleton();

export default prisma;

if (process.env.NODE_ENV !== "production") {
  globalThis.prismaGlobal = prisma;
}
