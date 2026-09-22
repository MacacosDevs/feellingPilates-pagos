import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PrismaClient } from "@prisma/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const infoPath = path.resolve(__dirname, "../.tmp/test-env.json");
const schemaPath = path.resolve(__dirname, "../../prisma/schema.prisma");

let container: StartedPostgreSqlContainer;

// Corre una vez para toda la suite (fileParallelism:false en vitest.config.ts):
// levanta un Postgres real via Testcontainers, crea el stub de la tabla
// public.usuario que la migracion baseline referencia via FK cross-schema
// (ver prisma/migrations/00000000000000_baseline/migration.sql), y aplica
// las migraciones del servicio con `prisma migrate deploy`.
export async function setup(): Promise<void> {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("feellingpilates_pagos_test")
    .withUsername("test")
    .withPassword("test")
    .start();

  const databaseUrl = `${container.getConnectionUri()}?schema=pagos`;

  const bootstrap = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    // Este servicio no es dueno de la tabla usuario (vive en el schema
    // "public" del backend Java); en produccion ya existe. Aqui creamos solo
    // el minimo necesario para que la FK compra.usuario_id_fkey pueda
    // aplicarse durante la migracion baseline.
    await bootstrap.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS public.usuario (id UUID PRIMARY KEY)`);
  } finally {
    await bootstrap.$disconnect();
  }

  execSync(`npx prisma migrate deploy --schema="${schemaPath}"`, {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
    shell: true,
  });

  fs.mkdirSync(path.dirname(infoPath), { recursive: true });
  fs.writeFileSync(infoPath, JSON.stringify({ databaseUrl }), "utf-8");
}

export async function teardown(): Promise<void> {
  fs.rmSync(infoPath, { force: true });
  await container?.stop();
}
