import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/stripe.js", async () => {
  const { stripeStub } = await import("../mocks/stripeStub.js");
  return { stripe: stripeStub };
});

const { stripeStub, resetStripeStub, errorConexionStripe, errorServidorStripe } = await import("../mocks/stripeStub.js");
const { app } = await import("../../src/app.js");
const { limpiarBD, crearUsuario } = await import("../helpers/db.js");
const { generarToken } = await import("../helpers/jwt.js");

describe("GET /api/pagos/admin/payouts", () => {
  beforeEach(async () => {
    await limpiarBD();
    resetStripeStub();
  });

  it("sin el permiso pagos.ver_finanzas responde 403", async () => {
    const usuarioId = await crearUsuario();
    const token = generarToken({ sub: usuarioId, permisos: [] });

    const res = await request(app).get("/api/pagos/admin/payouts").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(stripeStub.payouts.list).not.toHaveBeenCalled();
  });

  it("stripe.payouts.list exitoso devuelve la lista mapeada", async () => {
    const adminId = await crearUsuario();
    const token = generarToken({ sub: adminId, permisos: ["pagos.ver_finanzas"] });
    stripeStub.payouts.list.mockResolvedValueOnce({
      data: [
        {
          id: "po_1",
          amount: 5000,
          currency: "mxn",
          status: "paid",
          method: "standard",
          arrival_date: 1_700_000_000,
          created: 1_699_900_000,
          description: "Payout semanal",
        },
      ],
    });

    const res = await request(app).get("/api/pagos/admin/payouts").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe("po_1");
    expect(res.body[0].montoCentavos).toBe(5000);
  });

  it("stripe.payouts.list con fallo de red responde 502 origen=stripe_network_error", async () => {
    const adminId = await crearUsuario();
    const token = generarToken({ sub: adminId, permisos: ["pagos.ver_finanzas"] });
    stripeStub.payouts.list.mockRejectedValueOnce(errorConexionStripe());

    const res = await request(app).get("/api/pagos/admin/payouts").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(502);
    expect(res.body.origen).toBe("stripe_network_error");
  });

  it("stripe.payouts.list con 5xx responde 502 origen=stripe_server_error", async () => {
    const adminId = await crearUsuario();
    const token = generarToken({ sub: adminId, permisos: ["pagos.ver_finanzas"] });
    stripeStub.payouts.list.mockRejectedValueOnce(errorServidorStripe(502));

    const res = await request(app).get("/api/pagos/admin/payouts").set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(502);
    expect(res.body.origen).toBe("stripe_server_error");
  });
});
