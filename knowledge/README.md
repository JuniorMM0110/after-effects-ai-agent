# Motion Knowledge

AE AI separa el conocimiento en cuatro capas:

1. `curated/` — reglas validadas manualmente y de mayor confianza.
2. `synthesized/` — recetas consolidadas a partir de varias fuentes/recetas.
3. `recipes/` — análisis aprendidos de una fuente concreta.
4. `motion-sources.json` — catálogo liviano de enlaces pendientes o de referencia.

Los videos, proyectos .aep, ZIP y otros assets pesados nunca se incluyen dentro del plugin.

## Flujo de análisis

1. `npm run motion:knowledge -- export-pending` crea la cola de fuentes pendientes.
2. Un agente con navegador/Work analiza cada tutorial usando `knowledge/analysis-prompt.md`.
3. `npm run motion:knowledge -- import-analysis archivo.json` valida e importa una receta aprendida.
4. `npm run motion:knowledge -- export-synthesis "parallax camera 3d"` genera un paquete con recetas aprendidas + conocimiento curado relevante.
5. El agente sintetiza ese paquete usando `knowledge/synthesis-prompt.md`.
6. `npm run motion:knowledge -- import-synthesis archivo.json` valida la receta consolidada.
7. `npm run build:motion-knowledge` compila todo al runtime.

En ejecución normal, AE AI recupera solo unas pocas recetas relevantes. El orden de confianza es:
`curated → synthesized → learned → source`.

Una fuente ya analizada deja de aparecer como enlace duplicado en la búsqueda; se muestra su receta aprendida.
