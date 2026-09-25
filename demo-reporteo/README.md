# Vista de prueba manual — Reportes

```bash
./e2e up reporteo       # el stack
./e2e demo reporteo     # → http://localhost:7790
```

**No es la pantalla del CMS.** Ésa la construye el equipo de frontend en
`BCB_EstrellaRoja_Administrador`; el contrato que consume está en
`ER/_reporteo-docs/05-contrato-para-el-cms.md`.

Esto sirve para probar la cadena a mano sin esperar la pantalla real, y para ver la
petición y la respuesta cuando algo no cuadra. Le pega directo al adapter (`:8097`), que en
local corre con CORS abierto y `JWT_BYPASS=true`.

Lo que sí replica del comportamiento real, porque es lo que hay que probar:

- Los controles **cambian según la plantilla**: rango obligatorio, opcional (vacío = hoy) o
  sin fechas, y los filtros propios que declara cada una.
- El flujo asíncrono completo: `202` → polling → `302` a la descarga.
- `EMPTY` se muestra como resultado sin filas, **no** como error.
- Los códigos de error del DCU con el mensaje que les toca.
