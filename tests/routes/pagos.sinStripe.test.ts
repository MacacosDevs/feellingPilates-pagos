import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";

// Ambiente sin claves de Stripe (como QA). A diferencia del resto de la suite,
// aqui NO se mockea src/lib/stripe.js: se prueba el modulo real, que antes
// tumbaba el proceso al importarse con `new Stripe("")`. Debe asignarse antes
// de importar app/env (env.ts lee process.env al importarse).
process.env.STRIPE_SECRET_KEY = "";

const { app } = await import("../../src/app.js");
const { reconciliarComprasPendientes } = await import("../../src/services/pagoService.js");
const { prisma } = await import("../../src/lib/prisma.js");
const { limpiarBD, crearUsuario, crearPaquete, crearCompra } = await import("../helpers/db.js");
const { generarToken } = await import("../helpers/jwt.js");

describe("sin STRIPE_SECRET_KEY", () => {
  beforeEach(async () => {
    await limpiarBD();
  });

  it("el servicio arranca y las rutas que no usan Stripe siguen respondiendo", async () => {
    await crearPaquete();

    const res = await request(app).get("/api/publico/paquetes");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("crear intento de pago responde 503 sin dejar Compras huerfanas", async () => {
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete();
    const token = generarToken({ sub: usuarioId });

    const res = await request(app)
      .post("/api/pagos/paquetes/intento")
      .set("Authorization", `Bearer ${token}`)
      .send({ paqueteIds: [paquete.id] });

    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/STRIPE_SECRET_KEY/);
    expect(await prisma.compra.count()).toBe(0);
  });

  it("payouts responde 503, no un 502 de Stripe", async () => {
    const adminId = await crearUsuario();
    const token = generarToken({ sub: adminId, permisos: ["pagos.ver_finanzas"] });

    const res = await request(app).get("/api/pagos/admin/payouts").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(503);
    expect(res.body.origen).toBeUndefined();
  });

  it("webhook responde 503 en vez de 'firma invalida'", async () => {
    const res = await request(app)
      .post("/api/pagos/webhook")
      .set("Content-Type", "application/json")
      .set("Stripe-Signature", "t=1,v1=firma-de-prueba")
      .send("{}");

    expect(res.status).toBe(503);
  });

  it("la reconciliacion no toca compras pendientes", async () => {
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete();
    const compra = await crearCompra({ usuarioId, paqueteId: paquete.id, stripePaymentIntentId: "pi_123" });

    await reconciliarComprasPendientes();

    const despues = await prisma.compra.findUniqueOrThrow({ where: { id: compra.id } });
    expect(despues.estado).toBe("pendiente");
  });
});
