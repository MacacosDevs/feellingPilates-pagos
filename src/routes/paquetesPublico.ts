import { Router } from "express";
import { prisma } from "../lib/prisma.js";

export const paquetesPublicoRouter = Router();

paquetesPublicoRouter.get("/", async (_req, res, next) => {
  try {
    const paquetes = await prisma.paquete.findMany({
      where: { activo: true },
      orderBy: [{ categoria: "asc" }, { orden: "asc" }],
    });
    res.json(
      paquetes.map((p) => ({
        id: p.id,
        categoria: p.categoria,
        nombre: p.nombre,
        descripcion: p.descripcion,
        precioCentavos: p.precioCentavos,
        vigenciaDias: p.vigenciaDias,
        unitarioTexto: p.unitarioTexto,
        destacado: p.destacado,
      })),
    );
  } catch (e) {
    next(e);
  }
});
