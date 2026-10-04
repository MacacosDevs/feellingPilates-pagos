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
// levanta un Postgres real via Testcontainers, crea stubs de las tablas de
// "public" que las migraciones referencian via FK cross-schema (usuario en el
// baseline; salon y tipo_actividad en columnas_caja), y aplica
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
    // el minimo necesario para que las FKs cross-schema puedan aplicarse
    // durante las migraciones (salon y tipo_actividad igual, ver columnas_caja).
    for (const tabla of ["usuario", "salon", "tipo_actividad"]) {
      await bootstrap.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS public.${tabla} (id UUID PRIMARY KEY)`);
    }
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
