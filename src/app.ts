import cors from "cors";
import express from "express";
import { env } from "./config/env.js";
import { manejadorErrores } from "./middleware/errores.js";
import { pagosRouter } from "./routes/pagos.js";
import { paquetesPublicoRouter } from "./routes/paquetesPublico.js";

export const app = express();

app.use(cors({ origin: env.corsOrigenesPermitidos }));

// El webhook necesita el body crudo (ver routes/pagos.ts), asi que se monta
// ANTES del express.json() global para que este no lo consuma primero.
app.use("/api/pagos/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.use("/api/pagos", pagosRouter);
app.use("/api/publico/paquetes", paquetesPublicoRouter);

app.use(manejadorErrores);
