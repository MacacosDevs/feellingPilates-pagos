import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// HALLAZGO (ver auditoria/testing-errores/MATRIZ-COBERTURA.md): un compraId o
// paqueteId con formato invalido llegaba sin validar hasta una columna
// @db.Uuid de Prisma, que lanzaba PrismaClientKnownRequestError (P2023) con
// el detalle interno de la query (archivo, linea, stack) en el mensaje --
// manejadorErrores lo reenviaba tal cual en el body de una respuesta 500.
// Corregido en dos capas: (1) manejadorErrores ya no confia en
// status/message de un error que este servicio no construyo a proposito, y
// (2) se valida el formato UUID antes de llegar a Prisma para devolver un
// 400 claro en vez de depender solo del 500 generico de respaldo.

vi.mock("../../src/lib/stripe.js", async () => {
  const { stripeStub } = await import("../mocks/stripeStub.js");
  return { stripe: stripeStub };
});

const { resetStripeStub } = await import("../mocks/stripeStub.js");
const { app } = await import("../../src/app.js");
const { manejadorErrores } = await import("../../src/middleware/errores.js");
const { limpiarBD, crearUsuario } = await import("../helpers/db.js");
const { generarToken } = await import("../helpers/jwt.js");

describe("Contencion de fuga de informacion interna en errores", () => {
  beforeEach(async () => {
    await limpiarBD();
    resetStripeStub();
  });

  it("GET estado-en-vivo con compraId no-UUID responde 400 sin detalle interno de Prisma", async () => {
    const usuarioId = await crearUsuario();
    const token = generarToken({ sub: usuarioId });

    const res = await request(app)
      .get("/api/pagos/compras/no-es-un-uuid/estado-en-vivo")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("compraId invalido");
    expect(res.body.error).not.toMatch(/prisma|\.ts:\d+|node_modules/i);
  });

  it("POST reembolso con compraId no-UUID responde 400 sin detalle interno de Prisma", async () => {
    const adminId = await crearUsuario();
    const token = generarToken({ sub: adminId, permisos: ["pagos.reembolsar"] });

    const res = await request(app)
      .post("/api/pagos/compras/no-es-un-uuid/reembolso")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("compraId invalido");
    expect(res.body.error).not.toMatch(/prisma|\.ts:\d+|node_modules/i);
  });

  it("POST paquetes/intento con un paqueteId no-UUID responde 400 sin detalle interno de Prisma", async () => {
    const usuarioId = await crearUsuario();
    const token = generarToken({ sub: usuarioId });

    const res = await request(app)
      .post("/api/pagos/paquetes/intento")
      .set("Authorization", `Bearer ${token}`)
      .send({ paqueteIds: ["no-es-un-uuid"] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("paqueteId invalido");
    expect(res.body.error).not.toMatch(/prisma|\.ts:\d+|node_modules/i);
  });

  it("body JSON malformado en POST intento sigue respondiendo 400 con el mensaje de sintaxis (no es un leak, sirve para corregir el request)", async () => {
    const usuarioId = await crearUsuario();
    const token = generarToken({ sub: usuarioId });

    const res = await request(app)
      .post("/api/pagos/paquetes/intento")
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/json")
      .send("{invalido");

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/JSON/i);
  });

  it("un error no anticipado (no construido por este servicio) responde 500 generico sin filtrar el mensaje original", async () => {
    // Prueba unitaria del middleware en aislamiento: un error cualquiera (un
    // bug, una libreria de terceros) trae un mensaje con detalle sensible;
    // manejadorErrores no debe reenviarlo.
    const appDePrueba = express();
    appDePrueba.get("/explota", () => {
      throw new Error("SELECT password FROM usuario WHERE id = '123' -- detalle interno sensible");
    });
    appDePrueba.use(manejadorErrores);

    const res = await request(appDePrueba).get("/explota");

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Error interno");
    expect(res.body.error).not.toMatch(/password|SELECT/i);
  });
});
