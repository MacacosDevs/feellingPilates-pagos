import { app } from "./app.js";
import { env } from "./config/env.js";
import { iniciarJobReconciliacion } from "./jobs/reconciliacion.js";

app.listen(env.port, () => {
  console.log(`feellingPilates-pagos escuchando en :${env.port}`);
  iniciarJobReconciliacion();
});
