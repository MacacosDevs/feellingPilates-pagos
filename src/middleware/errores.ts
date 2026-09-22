import type { NextFunction, Request, Response } from "express";
import { ErrorPago, NoAutorizadoError, RecursoNoEncontradoError, ValidacionError } from "../errores.js";

type ErrorConocido = ValidacionError | RecursoNoEncontradoError | NoAutorizadoError | ErrorPago;

function esErrorConocido(err: unknown): err is ErrorConocido {
  return (
    err instanceof ValidacionError ||
    err instanceof RecursoNoEncontradoError ||
    err instanceof NoAutorizadoError ||
    err instanceof ErrorPago
  );
}

// Handler final de Express. Solo se confia en el status/mensaje de un error
// que este servicio construyo a proposito (ver errores.ts): cualquier otro
// error no anticipado (un bug, una excepcion de Prisma, de una libreria,
// etc.) puede traer un mensaje con detalles internos -- ruta de archivo,
// query, stack -- que nunca debe llegar al cliente tal cual. Ver hallazgo:
// un compraId/paqueteId con formato invalido llegaba sin validar hasta
// Prisma, que lanzaba PrismaClientKnownRequestError con ese detalle interno,
// y este handler lo reenviaba directo en el body de la respuesta 500.
export function manejadorErrores(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (esErrorConocido(err)) {
    if (err.status >= 500) {
      console.error("[error]", err);
    }
    const cuerpo: Record<string, unknown> = { error: err.message };
    if (err instanceof ErrorPago) {
      cuerpo.origen = err.origen;
    }
    res.status(err.status).json(cuerpo);
    return;
  }

  // express.json() (body-parser) lanza un SyntaxError seguro de mostrar
  // (solo describe el problema de sintaxis del JSON enviado, sin datos
  // internos) con status 400 y expose:true -- se preserva ese mensaje
  // porque le sirve al cliente para corregir su request.
  const posibleErrorDeParseo = err as { status?: number; type?: string; expose?: boolean; message?: string };
  if (posibleErrorDeParseo.type === "entity.parse.failed" && posibleErrorDeParseo.status === 400 && posibleErrorDeParseo.expose) {
    res.status(400).json({ error: posibleErrorDeParseo.message ?? "JSON invalido" });
    return;
  }

  console.error("[error]", err);
  res.status(500).json({ error: "Error interno" });
}
