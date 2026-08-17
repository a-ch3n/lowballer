import { PrismaClient } from "@prisma/client";

/* Reuse one PrismaClient across hot reloads in dev — otherwise each edit
   spawns a new client and exhausts the database's connection limit. */
const globalForPrisma = globalThis;

export const prisma = globalForPrisma.prisma || new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
