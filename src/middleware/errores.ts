import type { NextFunction, Request, Response } from "express";
import { ErrorPago } from "../errores.js";

// Handler final de Express. El status por defecto (500) solo deberia
// dispararse por bugs no anticipados; los casos esperados (404/400/403/502)
// ya traen su propio status en la clase del error.
export function manejadorErrores(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const error = err as { status?: number; message?: string; origen?: string };
  const status = error.status ?? 500;

  if (status >= 500) {
    console.error("[error]", err);
  }

  const cuerpo: Record<string, unknown> = { error: error.message ?? "Error interno" };
  if (err instanceof ErrorPago) {
    cuerpo.origen = err.origen;
  }
  res.status(status).json(cuerpo);
}
