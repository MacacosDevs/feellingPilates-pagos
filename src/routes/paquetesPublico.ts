import { Router } from "express";
import { prisma } from "../lib/prisma.js";

export const paquetesPublicoRouter = Router();

paquetesPublicoRouter.get("/", async (_req, res, next) => {
  try {
    const paquetes = await prisma.paquete.findMany({
      where: { activo: true },
      orderBy: [{ categoria: "asc" }, { orden: "asc" }],
      include: { actividades: true },
    });
    res.json(
      paquetes.map((p) => ({
        id: p.id,
        // null en paquetes de caja: su contenido lo describe `actividades`.
        categoria: p.categoria,
        nombre: p.nombre,
        descripcion: p.descripcion,
        precioCentavos: p.precioCentavos,
        vigenciaDias: p.vigenciaDias,
        unitarioTexto: p.unitarioTexto,
        destacado: p.destacado,
        actividades: p.actividades.map((a) => ({
          tipoActividadId: a.tipoActividadId,
          cantidadClases: a.cantidadClases,
        })),
      })),
    );
  } catch (e) {
    next(e);
  }
});
