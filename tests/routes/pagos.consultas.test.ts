import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/stripe.js", async () => {
  const { stripeStub } = await import("../mocks/stripeStub.js");
  return { stripe: stripeStub };
});

const { resetStripeStub } = await import("../mocks/stripeStub.js");
const { app } = await import("../../src/app.js");
const { limpiarBD, crearUsuario, crearPaquete, crearCompra } = await import("../helpers/db.js");
const { generarToken } = await import("../helpers/jwt.js");

describe("GET /api/pagos/mis-paquetes y /mis-compras", () => {
  beforeEach(async () => {
    await limpiarBD();
    resetStripeStub();
  });

  it("sin auth responde 401 en ambos endpoints", async () => {
    const r1 = await request(app).get("/api/pagos/mis-paquetes");
    const r2 = await request(app).get("/api/pagos/mis-compras");
    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
  });

  it("usuario sin compras: mis-paquetes y mis-compras devuelven array vacio, no error", async () => {
    const usuarioId = await crearUsuario();
    const token = generarToken({ sub: usuarioId });

    const r1 = await request(app).get("/api/pagos/mis-paquetes").set("Authorization", `Bearer ${token}`);
    const r2 = await request(app).get("/api/pagos/mis-compras").set("Authorization", `Bearer ${token}`);

    expect(r1.status).toBe(200);
    expect(r1.body).toEqual([]);
    expect(r2.status).toBe(200);
    expect(r2.body).toEqual([]);
  });

  it("un combo cuenta como activo para pilates y bacu_fit a la vez", async () => {
    const usuarioId = await crearUsuario();
    const combo = await crearPaquete({ categoria: "combo", nombre: "Combo Total", vigenciaDias: 30 });
    const enUnMes = new Date(Date.now() + 20 * 86_400_000);
    await crearCompra({ usuarioId, paqueteId: combo.id, estado: "pagada", fechaExpiracion: enUnMes });

    const token = generarToken({ sub: usuarioId });
    const res = await request(app).get("/api/pagos/mis-paquetes").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    const categorias = res.body.map((p: { categoria: string }) => p.categoria).sort();
    expect(categorias).toEqual(["bacu_fit", "pilates"]);
  });

  it("una compra pendiente/fallida no cuenta como paquete activo", async () => {
    const usuarioId = await crearUsuario();
    const paquete = await crearPaquete({ categoria: "pilates" });
    await crearCompra({ usuarioId, paqueteId: paquete.id, estado: "pendiente" });

    const token = generarToken({ sub: usuarioId });
    const res = await request(app).get("/api/pagos/mis-paquetes").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("mis-compras solo devuelve compras del usuario autenticado, no de otros", async () => {
    const usuarioId = await crearUsuario();
    const otroUsuarioId = await crearUsuario();
    const paquete = await crearPaquete();
    await crearCompra({ usuarioId: otroUsuarioId, paqueteId: paquete.id, estado: "pagada" });

    const token = generarToken({ sub: usuarioId });
    const res = await request(app).get("/api/pagos/mis-compras").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
