import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["tests/setup/globalSetup.ts"],
    setupFiles: ["tests/setup/testEnv.ts"],
    hookTimeout: 120_000,
    testTimeout: 30_000,
    // Todos los archivos comparten un unico Postgres de Testcontainers y
    // truncan las mismas tablas antes de cada test: correr archivos en
    // paralelo produciria interferencia entre ellos.
    fileParallelism: false,
  },
});
